/* Pipeline page: a task link (or a folder) in, a tested set of traps out (window.FinancePipeline = {render, afterRender, handleEvent}).
   It drives the companion's /api/pipeline routes (backend/pipeline). Rules this file keeps:
   - It makes no request of its own. Every call goes through window.FinanceAgents.link / get / post (agents.js), which loads the session
     code, sends it on every POST and only accepts relative paths under /api/. Opened from disk the page makes no request at all.
   - It never supplies a command, a binary path or an argument list: it sends the task link or a folder path, numbers, a model and an effort
     from the lists the companion reports, and the four acknowledgements.
   - Every dynamic string is escaped by the html tag below. No inline style attributes, no form submission, no browser storage: the task
     link is not kept anywhere (it leaves the page's state when the run starts and it is never shown back, in a message or otherwise).
   - Every field of the companion's answers is read in adapt() and adaptExport() and nowhere else, so aligning the page with the
     orchestrator is a change to those two functions. The rest of the file reads the view model they return. */
(function(){
  'use strict';
  const W=window;

  const OFFLINE_MESSAGE='The Pipeline needs the companion: run npm start.';
  const POLL_MS=2000;
  /* Display copies of backend/pipeline/constants.cjs (tests/pipeline-page.test.cjs checks that the two agree). The companion enforces its own. */
  const RULES=Object.freeze({screenBar:0.40,testBar:0.45,screenPilots:2,testPilots:5,testNeed:4,maxRedesigns:3,defaultCapUsd:60,maxCapUsd:200});
  const CAP_MIN_USD=1;
  /* The total cap the form starts with: the companion's (GET /api/pipeline config.defaultCapUsd) once it has reported one, else RULES.defaultCapUsd. */
  let defaultCap=RULES.defaultCapUsd;
  /* The design mode the form starts with: the companion's default once it has reported one, else the new mode (a task made from the world files). */
  let defaultMode='new';
  /* The golden answer, graded against the revised guideline, must score at least this (the companion's calibration rule). */
  const CALIBRATION_MIN=0.9;
  /* The spending cap of one pilot (the same range the Agents page and the companion use). */
  const PILOT_CAP=Object.freeze({defaultUsd:3,minUsd:0.05,maxUsd:20});
  const WITHHELD_TEXT='Withheld while a round runs';
  /* The wait after a link import, before classify: the owner checks the fetched files against the task page (waiting.kind). */
  const CONFIRM_KIND='confirm-files';
  const ACCEPT_LABEL='Start even if a world or task file has to be withheld (the pilots will not get it)';
  const ID_RE=/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
  const KEY_RE=/^[a-z0-9-]{1,40}$/;
  /* The first three are the Agents page's, word for word. The fourth is this pipeline's (MODEL_READS_TASK_TEXT in backend/pipeline/constants.cjs, which the
     tests compare): the models that classify, design and grade read the task. */
  const ACKNOWLEDGEMENTS=Object.freeze([
    {id:'shell-access',label:'Shell access as me',text:'Each pilot is a Claude Code agent that can run shell commands as my user account on this computer.'},
    {id:'network',label:'Network use by the agent runtime',text:'The agent runtime (the claude program) sends the packet files, your prompt and the fixed text before it to Anthropic over the network. This page itself only talks to the companion on this computer.'},
    {id:'isolation-by-audit',label:'Isolation by audit only',text:'There is no operating system sandbox. Pilots are told to stay inside their own folder and every tool call is checked afterwards. A call outside the folder discards that run. It is detected, not blocked.'},
    {id:'model-reads-task',label:'Model reads the task',text:'The classifier, the trap designer and the simulated grader are Claude Code runs that send the task text, the grader guideline and the golden answer to Anthropic. The trap designer is an agent with the same tools as a pilot (Bash, Read, Write, Edit, Glob and Grep) in its own working folder, held to that folder by the same after-the-fact audit and not by a sandbox. The reviewers of a new design are Claude Code runs too: the blind reviewer reads a copy of the packet with the Read, Glob and Grep tools, and the others have no tools. When reference documents are used, the trap designer reads them and they are sent to Anthropic as well.'}
  ]);
  const barText=x=>x.toFixed(2);
  const HAPPENS=mode=>(mode==='harden'?'What will happen: the task is imported and its files classified, a model hardens the task (its own prompt, grader guideline and golden answer) in a working copy':'What will happen: the task is imported and its files classified, a model builds a new task from the world files (a prompt, a grader guideline, a golden answer and a brief) in a working copy, and the design is checked before any pilot runs: the answer set is graded, then a blind reviewer and a second review look for a better-supported answer')+', two blind pilots run a screen that both must score below '+barText(barOf('screen'))+', then, only if the screen passes, five pilots run a test in which at least '+RULES.testNeed+' of '+RULES.testPilots+' must score below '+barText(barOf('test'))+'. Each round stops as soon as its result is decided, and the pilots that are no longer needed are stopped.'+(mode==='harden'?'':' Every low score is explained before it counts: a pilot counts only when the harness can show why its answer is wrong under the supplied sources.')+' A failed screen or test sends the designer back, up to '+RULES.maxRedesigns+' redesigns, and the run stops when the total cap would be exceeded or when you press Stop.';

  /* ---------- Escaping and markup. Interpolated values are escaped unless they are the result of html. ---------- */
  const ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'};
  const esc=x=>String(x==null?'':x).replace(/[&<>"'`]/g,c=>ESC[c]);
  class Raw{constructor(t){this.text=t;}}
  function part(value){
    if(value instanceof Raw)return value.text;
    if(Array.isArray(value))return value.map(part).join('');
    if(value===false||value===true||value==null)return '';
    return esc(value);
  }
  function html(strings,...values){
    let out=strings[0];
    values.forEach((value,i)=>{out+=part(value)+strings[i+1];});
    return new Raw(out);
  }
  const pill=(label,kind='')=>html`<span class="pill ${kind}">${label}</span>`;
  const $=selector=>document.querySelector(selector);

  /* ---------- The companion's answers: the view model, and the only code that reads their fields ---------- */
  const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const isWithheld=v=>isObj(v)&&v.withheld===true;
  const WITHHELD=Object.freeze({withheld:true});
  const text=v=>typeof v==='string'?v:typeof v==='number'&&Number.isFinite(v)?String(v):'';
  const num=v=>{const n=typeof v==='string'&&v.trim()?Number(v):v;return typeof n==='number'&&Number.isFinite(n)?n:null;};
  const arr=v=>Array.isArray(v)?v:[];
  const nameList=v=>arr(v).map(x=>isObj(x)?text(x.name||x.file||x.title||x.id):text(x)).filter(Boolean);
  /* A value that is text (or a number), or the withheld marker the companion keeps in place of a private value while a round runs. */
  const cell=v=>isWithheld(v)?WITHHELD:text(v);
  function ref(v){
    if(isWithheld(v))return {kind:'withheld',name:''};
    if(isObj(v)&&text(v.section))return {kind:'section',name:text(v.section)};
    if(isObj(v)&&text(v.file))return {kind:'file',name:text(v.file)};
    return null;
  }
  /* GET /api/pipeline/:id (backend/pipeline/service.cjs _view; each row of GET /api/pipeline has id, stage, createdAt, message, spentUsd, capUsd,
     redesigns). Fields read, all optional:
       id, label, stage, redacted, message, summary, error, createdAt, capUsd, spentUsd, pilotCapUsd, model, effort, redesigns, config.acceptMissing
       waiting: { kind ('needs-sign-in' | 'needs-person' | 'confirm-files'), message }
       source: { kind ('url' | 'folder'), origin, path, name }
       import: { fileCount, facts: { world, task, withheld, other }, page: { origin, path }, toggle: { found, label, flipped, filesBefore, filesAfter, learned },
                 skipped: [{ name, why }], files: [{ name, group }], notes: [text] (places the loader could not fully cover) }
       classification: { prompt, guideline, goldenAnswer: each { section } | { file }, worldFiles, taskFiles, other, goldenSuspects, unscanned: names,
                         withheld: [{ name, why }], warnings: [{ name, why }], notes }
       design: { attempt, repaired, traps: [{ id, title, mechanism, files, decoy, correctValue, wrongValue }], newFiles: [{ name }],
                 editedFiles: [{ name, reason, beforeBytes, bytes, diff }], prompt, guideline, goldenAnswer, gold: { decision, figures: [{ label, value, tolerance }] },
                 fingerprints: [{ id, label, tokens, figures }], notes (checks on the files), calibration: { score, verdict, reason },
                 fairness: { status ('ok' | 'unfair' | 'unusable'), unfair: [{ item, why }] }, guidelineDiff, rubricChanges: [{ change, reason }],
                 unscanned: [{ name, kind ('new' | 'edited') }] (designer files whose text could not be checked for guideline or golden-answer passages) }
                 a diff (guidelineDiff, editedFiles[].diff): { available, kind ('text' | 'binary'), added, removed, before, after, truncated, lines: [{ op, text }] } or text
       attempts: every design attempt, the last one the current one: [{ n, outcome, repaired, note, traps: [{ id, title }], calibration, fairness: { status, count },
                 rejection: { kind ('design' | 'checks'), reasons } | null, screen, test }] where
                 screen, test: { passed, replacementRound, replacementSkipped, stoppedEarly: { afterPilot, score } | null,
                 pilots: [{ n, replacement, state, valid, score (the average when regraded), stoppedEarly: true | { reason } | a reason (a pilot stopped because it was not needed), stoppedReason,
                 regrade: { first, second, average } | null, outputs: { count, readable }, audit: { status } }] }
       config (GET /api/pipeline, and the config of each pipeline): { screenBar, testBar } (the bars a screen pilot and a test pilot must score below)
       GET /api/pipeline: config: { defaultCapUsd, classifyCapUsd, designCapUsd, repairCapUsd, fairnessCapUsd, graderCapUsd, goldenMin, regradeBand, screenRegradeBand, testRegradeBand, headroom,
                 minCap: { fixedUsd, perPilotUsd, pilots, headroom } }
     Any private value may be { withheld: true } instead of its content (redact.cjs): trap titles and files, edited file names, reasons, diffs, calibration, fairness,
     rubric changes, the designer's notes. The page also copes with a marker in any other field named above. The view model keeps the marker (WITHHELD) wherever a
     text may be withheld; plain() turns it into the page's words. */
  /* ---- designer v2 (the 'new' mode): what the view carries, each field null when it is absent, WITHHELD when the companion withholds it while a round runs ---- */
  const bool=v=>typeof v==='boolean'?v:null;
  const numList=v=>arr(v).map(num).filter(x=>x!==null);
  const LOW_KEYS=['lowScorers','intended','otherValid','permittedAlternative','graderDefect','ambiguous','toolFailure','unsupported','counted'];
  function adaptLows(l){
    if(isWithheld(l))return WITHHELD;
    if(!isObj(l))return null;
    const out={};
    LOW_KEYS.forEach(k=>{out[k]=num(l[k])||0;});
    return out;
  }
  /* The diagnosis of one pilot that scored below its bar: { class, claimed, counts, note, application: { pass, failed } | null } */
  function adaptAdjudication(a){
    if(isWithheld(a))return WITHHELD;
    if(!isObj(a))return null;
    return {class:text(a.class),claimed:text(a.claimed),counts:a.counts===true,note:cell(a.note),application:isObj(a.application)?{pass:a.application.pass===true,failed:arr(a.application.failed).map(text).filter(Boolean)}:null};
  }
  const REVIEW_STATUSES=['pending','passed','rejected','incomplete','not-reached'];
  /* The fairness record of the new mode ({ status, stage1, stage2, repairs }), told from the old fairness review ({ status: ok | unfair | unusable }) by its shape. */
  const isReview=f=>isObj(f)&&!isWithheld(f)&&(f.stage1!==undefined||f.stage2!==undefined||typeof f.repairs==='number'||REVIEW_STATUSES.includes(f.status));
  const HIT_KINDS=['passage','unreadable','more'];
  /* The supersession hits of an application check: how many (a count in an older companion), or the list { id, kind ('passage' | 'unreadable' | 'more'), document, snippet }.
     The snippet is not kept; a 'more' entry carries how many more there were (its count, or the number its snippet opens with). */
  function adaptHits(h){
    if(Array.isArray(h)){
      const list=h.filter(isObj).map(x=>({kind:HIT_KINDS.includes(x.kind)?x.kind:'passage',document:cell(x.document),count:num(x.count)!==null?num(x.count):/^\s*(\d+)\s+more\b/.test(text(x.snippet))?Number(/^\s*(\d+)/.exec(text(x.snippet))[1]):null}));
      return {count:list.filter(x=>x.kind==='passage').length,list};
    }
    return {count:num(h)||0,list:[]};
  }
  const nameList2=l=>isWithheld(l)?WITHHELD:arr(l).map(x=>isObj(x)?text(x.name):text(x)).filter(Boolean);
  function adaptCheck(c){
    if(isWithheld(c))return WITHHELD;
    if(!isObj(c))return null;
    const k=isObj(c.checks)?c.checks:{},d=isObj(c.dates)?c.dates:null;
    return {pass:c.pass===true,failed:arr(c.failed).map(text).filter(Boolean),checks:{governs:k.governs===true,inForce:k.inForce===true,notSuperseded:k.notSuperseded===true,excludes:k.excludes===true},dates:d?{effective:cell(d.effective),decision:cell(d.decision)}:null,hits:adaptHits(c.hits),unscanned:nameList2(c.unscanned)};
  }
  /* The checks of the brief's own clauses: { pass, count, failures: [{ trap (from 1), part ('rule' | 'whyRejected'), failed }], unscanned }. An older companion sent { pass, failed, checks, hits }. */
  function adaptBriefCheck(c){
    if(isWithheld(c))return WITHHELD;
    if(!isObj(c))return null;
    if(!Array.isArray(c.failures)){
      const failed=arr(c.failed).map(text).filter(Boolean);
      return {pass:c.pass===true,count:null,failures:failed.length?[{trap:null,part:'',failed}]:[],unscanned:[]};
    }
    return {pass:c.pass===true,count:num(c.count),failures:c.failures.filter(isObj).map(f=>({trap:num(f.trap),part:text(f.part),failed:arr(f.failed).map(text).filter(Boolean)})),unscanned:nameList2(c.unscanned)};
  }
  function adaptReview(f){
    if(isWithheld(f))return WITHHELD;
    if(!isReview(f))return null;
    const s1=f.stage1,s2=f.stage2;
    return {status:text(f.status),repairs:num(f.repairs)||0,
      stage1:isWithheld(s1)?WITHHELD:isObj(s1)?{state:text(s1.state),tries:num(s1.tries)||0,runs:num(s1.runs)||0,discarded:num(s1.discarded)||0}:null,
      stage2:isWithheld(s2)?WITHHELD:isObj(s2)?{disposition:text(s2.disposition),objectionClass:text(s2.objectionClass),evaluations:num(s2.evaluations)||0,application:adaptCheck(s2.application),briefApplication:adaptBriefCheck(s2.briefApplication),cut:nameList2(s2.cut)}:null};
  }
  function adaptAnswerSet(s){
    if(isWithheld(s))return WITHHELD;
    if(!isObj(s))return null;
    return {goldenMin:num(s.goldenMin),alternativeMin:num(s.alternativeMin),passed:bool(s.passed),answers:arr(s.answers).filter(isObj).map(a=>({name:cell(a.name),kind:a.kind==='golden'?'golden':'alternative',file:text(a.file),threshold:num(a.threshold),score:num(a.score),grades:numList(a.grades),passed:bool(a.passed),unstable:a.unstable===true,
      runs:arr(a.runs).filter(isObj).map(r=>({why:text(r.why),grades:numList(r.grades),score:num(r.score),passed:bool(r.passed),unstable:r.unstable===true}))}))};
  }
  /* The difficulty result, apart from the fairness result: { status, screen, test } with each stage { passed, explained, belowBar, of, need, lows } */
  function adaptDifficulty(d){
    if(isWithheld(d))return WITHHELD;
    if(!isObj(d))return null;
    const one=x=>isWithheld(x)?WITHHELD:isObj(x)?{passed:bool(x.passed),explained:num(x.explained),belowBar:num(x.belowBar),of:num(x.of),need:num(x.need),lows:adaptLows(x.lows)}:null;
    return {status:text(d.status),screen:one(d.screen),test:one(d.test)};
  }
  const sha12=x=>{const t=text(x);return t?t.slice(0,12):'';};
  function adaptFreeze(list){
    if(isWithheld(list))return WITHHELD;
    return arr(list).filter(isObj).map((f,i)=>{
      const pilot=isObj(f.pilot)?f.pilot:{},grader=isObj(f.grader)?f.grader:{},budget=isObj(f.budget)?f.budget:{};
      return {n:num(f.n)||i+1,at:text(f.at),reason:cell(f.reason),packetSha256:sha12(f.packetSha256),packetFiles:num(f.packetFiles),promptSha256:sha12(f.promptSha256),guidelineSha256:sha12(f.guidelineSha256),goldenSha256:sha12(f.goldenSha256),answerSetSha256:sha12(f.answerSetSha256),
        answers:arr(f.answers).filter(isObj).map(a=>({name:text(a.name),sha256:sha12(a.sha256)})),pilot:{model:text(pilot.model),effort:text(pilot.effort),capUsd:num(pilot.capUsd)},grader:{model:text(grader.model),effort:text(grader.effort)},budget:{totalCapUsd:num(budget.totalCapUsd),designCapUsd:num(budget.designCapUsd),pilotCapUsd:num(budget.pilotCapUsd)}};
    });
  }
  /* The guideline-only repair: { stage, outcome (pending | applied | failed), classes, changed, reason, regrade: { before, after, passed }, recounted: { passed, explained } } */
  function adaptRepair(r){
    if(isWithheld(r))return WITHHELD;
    if(!isObj(r))return null;
    const side=l=>arr(l).filter(isObj).map(a=>({name:text(a.name),grades:numList(a.grades),score:num(a.score),passed:bool(a.passed),unstable:a.unstable===true}));
    const g=isObj(r.regrade)?r.regrade:null,c=isObj(r.recounted)?r.recounted:null;
    return {stage:text(r.stage),outcome:text(r.outcome),classes:arr(r.classes).map(text).filter(Boolean),changed:arr(r.changed).map(text).filter(Boolean),reason:cell(r.reason),regrade:g?{before:side(g.before),after:side(g.after),passed:bool(g.passed)}:null,recounted:c?{passed:bool(c.passed),explained:num(c.explained)}:null};
  }
  function adaptDiagnostic(d){
    if(isWithheld(d))return WITHHELD;
    if(!isObj(d))return null;
    return {passed:bool(d.passed),results:arr(d.results).filter(isObj).map(x=>({name:cell(x.name),file:text(x.file),band:x.band==='high'||x.band==='low'?x.band:'',score:num(x.score),ok:x.ok===true}))};
  }
  function adaptTaskType(t){
    if(isWithheld(t))return WITHHELD;
    if(!isObj(t))return null;
    return {workflow:cell(t.workflow),why:cell(t.why),referenceEntries:isWithheld(t.referenceEntries)?WITHHELD:arr(t.referenceEntries).map(text).filter(Boolean)};
  }
  const figureList=l=>arr(l).filter(isObj).map(f=>({label:text(f.label),value:num(f.value),tolerance:num(f.tolerance)||0}));
  function adaptBrief(b){
    if(isWithheld(b))return WITHHELD;
    if(!isObj(b))return null;
    const d=isObj(b.decision)?b.decision:{},path=x=>{const o=isObj(x)?x:{};return {reasoning:text(o.reasoning),action:text(o.action),figures:figureList(o.figures)};};
    return {taskType:adaptTaskType(b.taskType),decision:{ask:text(d.ask),mandate:text(d.mandate),authorityFile:text(d.authorityFile),effectiveDate:text(d.effectiveDate),decisionDate:text(d.decisionDate)},
      files:arr(b.files).filter(isObj).map(f=>({name:text(f.name),role:text(f.role)})),
      traps:arr(b.traps).filter(isObj).map((t,i)=>{
        const rule=isObj(t.rule)?t.rule:{},w=isObj(t.whyTempting)?t.whyTempting:{},c=isObj(t.consequence)?t.consequence:{},a=isObj(t.strongestAlternative)?t.strongestAlternative:{};
        return {id:text(t.id)||'trap-'+(i+1),primary:t.primary===true,rule:{file:text(rule.file),clause:text(rule.clause)},correctPath:path(t.correctPath),wrongPath:path(t.wrongPath),changesDecision:text(t.changesDecision),whyTempting:{kind:text(w.kind),source:text(w.source)},consequence:text(c.source),strongestAlternative:{answer:text(a.answer),whyRejected:text(a.whyRejected)}};
      }),
      permittedAlternatives:arr(b.permittedAlternatives).filter(isObj).map(a=>({answer:text(a.answer),support:text(a.support),file:text(a.file)})),permittedAlternativesReason:text(b.permittedAlternativesReason),
      controls:arr(b.controls).filter(isObj).map(c=>({scenario:text(c.scenario),trap:text(c.trap),action:text(c.action),changesDecision:c.changesDecision===true,figures:figureList(c.figures)}))};
  }
  /* design.alternatives: the permitted alternatives the design keeps, [{ name, file, answer }] */
  const adaptAlternatives=l=>isWithheld(l)?WITHHELD:arr(l).filter(isObj).map(a=>({name:text(a.name),file:text(a.file),answer:cell(a.answer)}));
  /* config.references.default (and GET /api/pipeline's limits): how many reference files there are and their names; problems is a count, or a list */
  function adaptRefDefault(r){
    if(!isObj(r))return null;
    /* problems is how many there are (an older companion sent the list itself); problemList says what they are, each a short plain sentence */
    const old=Array.isArray(r.problems)?r.problems.map(text).filter(Boolean):[],listed=Array.isArray(r.problemList)?r.problemList.map(text).filter(Boolean):[];
    const list=listed.length?listed:old;
    return {exists:r.exists===true,found:num(r.found)||0,names:arr(r.names).map(text).filter(Boolean),bytes:num(r.bytes)||0,problems:{count:Array.isArray(r.problems)?old.length:Math.max(num(r.problems)||0,0),list}};
  }
  /* the view's references: { source, found, names, bytes, files, unscanned, scannedChars, truncated } */
  function adaptReferences(r){
    if(!isObj(r))return null;
    const names=isWithheld(r.names)?WITHHELD:arr(r.names).map(text).filter(Boolean);
    return {source:text(r.source),found:num(r.found)||0,names,bytes:num(r.bytes)||0,unscanned:nameList2(r.unscanned),partial:nameList2(r.partial),truncated:r.truncated===true};
  }
  function adaptStage(v){
    if(!isObj(v))return null;
    const se=v.stoppedEarly;
    /* { afterPilot, score } of a round that was stopped as soon as its result was decided (null: it was not) */
    const stoppedEarly=isWithheld(se)?WITHHELD:isObj(se)?{afterPilot:num(se.afterPilot),score:isWithheld(se.score)?WITHHELD:num(se.score)}:null;
    return {passed:typeof v.passed==='boolean'?v.passed:null,replacementRound:v.replacementRound===true,replacementSkipped:v.replacementSkipped===true,stoppedEarly,
      explained:num(v.explained),lows:adaptLows(v.lows),unexplained:isWithheld(v.unexplained)?WITHHELD:Array.isArray(v.unexplained)?v.unexplained.filter(isObj).map(x=>({pilot:text(x.pilot),class:text(x.class),score:num(x.score)})):null,
      recount:isWithheld(v.recount)?WITHHELD:isObj(v.recount)?{changes:arr(v.recount.changes).filter(isObj).map(x=>({pilot:text(x.pilot),from:num(x.from),to:num(x.to)}))}:null,pilots:arr(v.pilots).map((p,i)=>{
      const q=isObj(p)?p:{},audit=isObj(q.audit)?text(q.audit.status):'',rg=q.regrade,o=q.outputs;
      /* a pilot stopped because the round no longer needed it: true, or { reason }, or the reason itself; the reason may also be stoppedReason, or reason on a pilot that has no score */
      const pe=q.stoppedEarly,stopped=isWithheld(pe)?WITHHELD:pe===true||isObj(pe)||(typeof pe==='string'&&pe!=='')?{reason:isObj(pe)?cell(pe.reason):typeof pe==='string'?pe:cell(q.stoppedReason!==undefined?q.stoppedReason:q.stopReason!==undefined?q.stopReason:num(q.score)===null?q.reason:'')}:null;
      const regrade=isWithheld(rg)?WITHHELD:isObj(rg)&&num(rg.first)!==null&&num(rg.second)!==null?{first:num(rg.first),second:num(rg.second),average:num(rg.average)}:null;
      /* the score that counts is score, which the companion sets to the average of a regraded pilot's two */
      return {n:num(q.n)||i+1,replacement:q.replacement===true,state:text(q.state),score:q.valid===false?null:num(q.score)??(isObj(regrade)&&!isWithheld(regrade)?regrade.average:null),regrade,stoppedEarly:stopped,audit:audit.toUpperCase(),id:text(q.id),adjudication:adaptAdjudication(q.adjudication),countsTowardPass:typeof q.countsTowardPass==='boolean'?q.countsTowardPass:null,toolFailure:q.toolFailure===true,regraded:q.regraded===true,
        previous:isWithheld(q.previous)?WITHHELD:isObj(q.previous)?{score:num(q.previous.score),belowBar:typeof q.previous.belowBar==='boolean'?q.previous.belowBar:null,countsTowardPass:typeof q.previous.countsTowardPass==='boolean'?q.previous.countsTowardPass:null,class:isObj(q.previous.adjudication)?text(q.previous.adjudication.class):''}:null,
        outputs:isWithheld(o)?WITHHELD:isObj(o)&&num(o.count)!==null?{count:num(o.count),readable:num(o.readable)||0}:null};
    })};
  }
  /* A list of names or titles in which any entry may be withheld: strings, and WITHHELD for each entry (or for the whole list) that is. */
  const nameCells=v=>isWithheld(v)?[WITHHELD]:arr(v).map(x=>isWithheld(x)?WITHHELD:isObj(x)?(isWithheld(x.name)||isWithheld(x.title)?WITHHELD:text(x.name||x.file||x.title||x.id)):text(x)).filter(x=>x!=='');
  /* A line diff: the companion's { available, kind, added, removed, before, after, truncated, lines: [{ op, text }] } or plain text, as { text, ... }; the
     withheld marker; or null when none was sent. op is ' ', '-' or '+'. */
  function diffCell(v){
    if(isWithheld(v))return WITHHELD;
    const none={text:'',added:null,removed:null,truncated:false,available:true,kind:'',before:null,after:null};
    if(typeof v==='string')return {...none,text:v};
    if(!isObj(v)||!Array.isArray(v.lines))return null;
    return {...none,text:v.lines.filter(isObj).map(l=>(l.op==='+'||l.op==='-'?l.op:' ')+text(l.text)).join('\n'),added:num(v.added),removed:num(v.removed),truncated:v.truncated===true,available:v.available!==false,kind:text(v.kind),before:num(v.before),after:num(v.after)};
  }
  const sizeCell=v=>isWithheld(v)?WITHHELD:typeof v==='string'&&v?v:typeof v==='number'&&Number.isFinite(v)?(v>0?'+':v<0?'−':'')+Math.abs(v).toLocaleString('en-US')+(Math.abs(v)===1?' byte':' bytes'):null;
  const adaptCalibration=c=>isWithheld(c)?WITHHELD:isObj(c)?{score:isWithheld(c.score)?WITHHELD:num(c.score),verdict:cell(c.verdict),reason:cell(c.reason)}:null;
  /* The fairness review: { status, unfair: [{ item, why }] } in a design, { status, count } in an attempt. */
  function adaptFairness(f){
    if(isWithheld(f))return WITHHELD;
    if(isReview(f))return null;
    if(!isObj(f)||isWithheld(f.unfair))return isObj(f)?WITHHELD:null;
    const status=['ok','unfair','unusable'].includes(f.status)?f.status:'',list=Array.isArray(f.unfair)?f.unfair.filter(x=>isObj(x)||typeof x==='string').map(x=>isObj(x)?{item:cell(x.item),why:cell(x.why)}:{item:x,why:''}):null;
    if(list===null&&!status)return null;
    const items=list||[];
    return {status:status||(items.length?'unfair':'ok'),unfair:items,count:num(f.count)??items.length};
  }
  function adaptDesign(d){
    /* a design of the new mode carries a brief or a task type; its fairness is the review record, not the old fairness review */
    const newDesign=isObj(d.brief)||isObj(d.taskType);
    const traps=isWithheld(d.traps)?null:arr(d.traps).filter(isObj).map((t,i)=>({id:text(t.id)||'trap-'+(i+1),title:isWithheld(t.title)?WITHHELD:text(t.title)||text(t.id)||'Trap '+(i+1),mechanism:cell(t.mechanism),files:isWithheld(t.files)||arr(t.files).some(isWithheld)?WITHHELD:nameList(t.files),decoy:cell(t.decoy),correct:cell(t.correctValue),wrong:cell(t.wrongValue)}));
    const gold=isWithheld(d.gold)?WITHHELD:isObj(d.gold)?{decision:cell(d.gold.decision),figures:arr(d.gold.figures).filter(isObj).map(f=>({label:text(f.label),value:cell(f.value),tolerance:text(f.tolerance)}))}:null;
    const prints=isWithheld(d.fingerprints)?WITHHELD:arr(d.fingerprints).filter(isObj).map(f=>({id:text(f.id),label:text(f.label),tokens:arr(f.tokens).map(text).filter(Boolean),figures:arr(f.figures).map(x=>isObj(x)?[text(x.label),text(x.value)].filter(Boolean).join(' '):text(x)).filter(Boolean)}));
    const rub=d.rubricChanges;
    const edited=isWithheld(d.editedFiles)?WITHHELD:arr(d.editedFiles).map(e=>isObj(e)?{name:isWithheld(e.name)?WITHHELD:text(e.name),reason:cell(e.reason),diff:diffCell(e.diff),size:sizeCell(e.sizeChange!==undefined?e.sizeChange:num(e.bytes)!==null&&num(e.beforeBytes)!==null?e.bytes-e.beforeBytes:isObj(e.diff)&&num(e.diff.before)!==null&&num(e.diff.after)!==null?e.diff.after-e.diff.before:undefined)}:{name:typeof e==='string'?e:'',reason:'',diff:null,size:null}).filter(e=>e.name!=='');
    return {attempt:num(d.attempt),traps:traps||[],trapsWithheld:traps===null,newFiles:nameCells(d.newFiles),notes:isWithheld(d.notes)?WITHHELD:arr(d.notes).map(text).filter(Boolean),edited,
      prompt:cell(d.prompt),guideline:cell(d.guideline),golden:cell(d.goldenAnswer),gold,fingerprints:prints,
      repaired:isWithheld(d.repaired)?WITHHELD:d.repaired===true,calibration:adaptCalibration(d.calibration),fairness:newDesign?null:adaptFairness(d.fairness),review:newDesign||isReview(d.fairness)?adaptReview(d.fairness):null,
      taskType:adaptTaskType(d.taskType),brief:adaptBrief(d.brief),alternatives:adaptAlternatives(d.alternatives),answerSet:adaptAnswerSet(d.answerSet),freeze:adaptFreeze(d.freeze),
      guidelineDiff:diffCell(d.guidelineDiff),
      unscanned:isWithheld(d.unscanned)?WITHHELD:arr(d.unscanned).map(x=>isWithheld(x)?{name:WITHHELD,kind:''}:isObj(x)?{name:cell(x.name),kind:x.kind==='new'||x.kind==='edited'?x.kind:''}:{name:text(x),kind:''}).filter(x=>isWithheld(x.name)||x.name!==''),
      rubricChanges:isWithheld(rub)?WITHHELD:Array.isArray(rub)?rub.filter(x=>isObj(x)||typeof x==='string').map(x=>isObj(x)?{change:cell(x.change),reason:cell(x.reason)}:{change:x,reason:''}):null};
  }
  function adapt(raw,fallbackId){
    if(!isObj(raw))return null;
    const imp=isObj(raw.import)?raw.import:{},cls=isObj(raw.classification)?raw.classification:{},des=isObj(raw.design)?raw.design:{},src=isObj(raw.source)?raw.source:{};
    const tog=isObj(imp.toggle)&&!isWithheld(imp.toggle)?imp.toggle:null,page=isObj(imp.page)?imp.page:{},facts=isObj(imp.facts)?imp.facts:{};
    const lists={world:nameList(cls.worldFiles),task:nameList(cls.taskFiles),other:nameList(cls.other)};
    const withheld=arr(cls.withheld).map(x=>isObj(x)?{name:text(x.name),why:text(x.why)}:{name:text(x),why:''}).filter(x=>x.name);
    const count=(k,key)=>num(facts[k])??(cls[key]?(k==='withheld'?withheld:lists[k]).length:null);
    const w=raw.waiting,waiting=isObj(w)?{kind:text(w.kind),message:cell(w.message)}:null;
    const cfg=isObj(raw.config)?adaptConfig(raw.config):null;
    const design=adaptDesign(des),stage=typeof raw.stage==='string'&&raw.stage?raw.stage:'import';
    const reasonList=r=>isWithheld(r)?[WITHHELD]:arr(r).map(cell).filter(x=>x!=='');
    const attempts=arr(raw.attempts).filter(isObj).map((a,i,all)=>({n:num(a.n)||i+1,traps:nameCells(a.traps),outcome:text(a.outcome),repaired:isWithheld(a.repaired)?WITHHELD:a.repaired===true,note:cell(a.note),
      calibration:adaptCalibration(a.calibration),fairness:a.mode==='new'?null:adaptFairness(a.fairness),mode:a.mode==='new'?'new':'harden',validation:text(a.validation),review:a.mode==='new'||isReview(a.fairness)?adaptReview(a.fairness):null,difficulty:adaptDifficulty(a.difficulty),answerSet:adaptAnswerSet(a.answerSet),freeze:adaptFreeze(a.freeze),guidelineRepair:adaptRepair(a.guidelineRepair),diagnostic:adaptDiagnostic(a.diagnostic),taskType:adaptTaskType(a.taskType),
      rejection:isWithheld(a.rejection)?WITHHELD:isObj(a.rejection)?{kind:text(a.rejection.kind),reasons:reasonList(a.rejection.reasons)}:null,
      screen:adaptStage(a.screen),test:adaptStage(a.test),current:i===all.length-1}));
    const last=attempts[attempts.length-1];
    const folder=src.kind==='folder';
    return {id:text(raw.id)||fallbackId||'',label:text(raw.label),stage,ended:['done','failed','stopped','budget'].includes(stage),redacted:raw.redacted===true,message:text(raw.message),
      createdAt:text(raw.createdAt),capUsd:num(raw.capUsd),spentUsd:num(raw.spentUsd)||0,pilotCapUsd:num(raw.pilotCapUsd),
      model:text(raw.model),effort:text(raw.effort),redesigns:num(raw.redesigns)||0,summary:text(raw.summary),
      error:isObj(raw.error)?text(raw.error.message):text(raw.error),waiting,acceptMissing:isObj(raw.config)&&raw.config.acceptMissing===true,bars:{screen:cfg?cfg.screenBar:null,test:cfg?cfg.testBar:null},
      hasImport:isObj(raw.import),hasClassification:isObj(raw.classification),hasDesign:isObj(raw.design),
      designMode:isObj(raw.config)&&raw.config.designMode==='new'||attempts.some(a=>a.mode==='new')?'new':'harden',fairnessSet:isObj(raw.config)&&raw.config.fairnessSet===true,keepAsWorld:isObj(raw.config)?arr(raw.config.keepAsWorld).map(text).filter(Boolean):[],
      references:adaptReferences(raw.references),verdict:isObj(raw.result)?text(raw.result.verdict):'',validation:isObj(raw.result)?text(raw.result.validation):'',
      source:{folder,origin:folder?'':text(src.origin)||text(page.origin),path:folder?'':text(src.origin)?text(src.path):text(page.path),name:text(src.name),pageOrigin:folder?text(page.origin):'',pagePath:folder?text(page.path):''},
      files:{total:num(imp.fileCount)??(Array.isArray(imp.files)?imp.files.length:null),world:count('world','worldFiles'),task:count('task','taskFiles'),withheld:count('withheld','withheld'),other:count('other','other')},
      skipped:isWithheld(imp.skipped)?WITHHELD:arr(imp.skipped).map(x=>isWithheld(x)?{name:WITHHELD,why:''}:isObj(x)?{name:cell(x.name),why:cell(x.why)}:{name:text(x),why:''}).filter(x=>isWithheld(x.name)||x.name!==''),
      fileList:isWithheld(imp.files)?WITHHELD:Array.isArray(imp.files)?imp.files.map(x=>isWithheld(x)?{name:WITHHELD,group:''}:isObj(x)?{name:cell(x.name),group:cell(x.group)}:{name:text(x),group:''}).filter(x=>isWithheld(x.name)||x.name!==''):null,
      keptFiles:isWithheld(imp.keepAsWorld)?WITHHELD:arr(imp.keepAsWorld).map(x=>isObj(x)?{name:text(x.name),present:x.present!==false,warning:cell(x.warning)}:{name:text(x),present:true,warning:''}).filter(x=>x.name!==''),
      importNotes:isWithheld(imp.notes)?WITHHELD:arr(imp.notes).map(cell).filter(x=>isWithheld(x)||x!==''),
      toggle:isWithheld(imp.toggle)?WITHHELD:tog?{found:tog.found===true,label:text(tog.label),flipped:tog.flipped===true,learned:tog.learned===true,before:num(tog.filesBefore),after:num(tog.filesAfter)}:null,
      cls:{any:!!(cls.prompt||cls.guideline||cls.goldenAnswer||cls.worldFiles||cls.taskFiles||arr(cls.keptAsWorld).length||arr(cls.warnings).length||arr(cls.goldenSuspects).length||arr(cls.unscanned).length),prompt:ref(cls.prompt),guideline:ref(cls.guideline),golden:ref(cls.goldenAnswer),...lists,withheld,notes:arr(cls.notes).map(text).filter(Boolean),
        warnings:isWithheld(cls.warnings)?[{name:WITHHELD,why:''}]:arr(cls.warnings).map(x=>isObj(x)?{name:cell(x.name),why:cell(x.why)}:{name:typeof x==='string'?x:'',why:''}).filter(x=>isWithheld(x.name)||x.name),
        goldenSuspects:nameCells(cls.goldenSuspects),unscanned:nameCells(cls.unscanned),kept:isWithheld(cls.keptAsWorld)?WITHHELD:arr(cls.keptAsWorld).map(x=>isObj(x)?{name:text(x.name),why:cell(x.why)}:{name:text(x),why:''}).filter(x=>x.name!=='')},
      design,screen:last?last.screen:null,test:last?last.test:null,attempts};
  }
  /* The answer to POST /api/pipeline/:id/export: { name, zipBase64 } (it also has size, sha256 and files). */
  function adaptExport(d,id){
    const o=isObj(d)?d:{},b64=text(o.zipBase64).replace(/\s+/g,''),given=text(o.name);
    return {base64:b64,name:/^[\w.-]{1,120}_PRIVATE\.zip$/.test(given)?given:id+'_pipeline_PRIVATE.zip'};
  }
  const adaptStart=d=>text(isObj(d)?d.id:'');
  /* The rules GET /api/pipeline reports: the caps of the calls that are not pilots, the golden answer's minimum score, the band of scores that is graded again and the
     headroom a reservation includes. */
  function adaptConfig(c){
    const o=isObj(c)?c:{},bandOf=b=>Array.isArray(b)&&b.length===2&&b.every(x=>num(x)!==null)?b.map(num):null,band=bandOf(o.regradeBand);
    /* the minimum cap of one full attempt: every part a number, none negative, at least one pilot, a headroom of at least 1 */
    const capParts=m=>{const k=isObj(m)?m:{},parts=[num(k.fixedUsd),num(k.perPilotUsd),num(k.pilots),num(k.headroom)];return parts.every(x=>x!==null&&x>=0)&&parts[2]>=1&&parts[3]>=1?{fixedUsd:parts[0],perPilotUsd:parts[1],pilots:parts[2],headroom:parts[3]}:null;};
    const minCap=capParts(o.minCap),byMode=isObj(o.minCapByMode)?o.minCapByMode:{};
    const pass=x=>{const n=num(x);return n!==null&&n>0&&n<=1?n:null;};
    const dflt=num(o.defaultCapUsd),defaultCapUsd=dflt!==null&&money(String(dflt),CAP_MIN_USD,RULES.maxCapUsd)!==null?dflt:null;
    const modes=arr(o.designModes).filter(x=>x==='new'||x==='harden'),first=modes.includes('new')?'new':modes[0]||null;
    return {blindReviewCapUsd:num(o.blindReviewCapUsd),revealReviewCapUsd:num(o.revealReviewCapUsd),applicationCapUsd:num(o.applicationCapUsd),adjudicationCapUsd:num(o.adjudicationCapUsd),designModes:modes,defaultDesignMode:o.defaultDesignMode==='new'||o.defaultDesignMode==='harden'?o.defaultDesignMode:first,fairnessSetCapUsd:num(o.fairnessSetCapUsd),minCapFairnessSetUsd:num(o.minCapFairnessSetUsd),minCapByMode:{new:capParts(byMode.new),harden:capParts(byMode.harden)},alternativeMin:num(o.alternativeMin),
      references:adaptRefDefault(isObj(o.references)?o.references.default:null),screenBar:pass(o.screenBar),testBar:pass(o.testBar),screenRegradeBand:bandOf(o.screenRegradeBand),testRegradeBand:bandOf(o.testRegradeBand),defaultCapUsd,classifyCapUsd:num(o.classifyCapUsd),designCapUsd:num(o.designCapUsd),repairCapUsd:num(o.repairCapUsd),fairnessCapUsd:num(o.fairnessCapUsd),graderCapUsd:num(o.graderCapUsd),goldenMin:num(o.goldenMin),regradeBand:band,headroom:num(o.headroom),minCap};
  }
  const adaptList=d=>(Array.isArray(d)?d:arr(isObj(d)?d.pipelines:null)).map(x=>adapt(x)).filter(v=>v&&ID_RE.test(v.id));

  /* ---------- State ---------- */
  const S={
    phase:'idle',          // idle | checking | ready | offline
    offlineNote:'',
    status:null,           // {models, efforts} from /api/status
    rules:adaptConfig(null),  // the default cap, the caps, the golden minimum, the regrade band, the headroom and the minimum cap GET /api/pipeline reports
    form:blankForm(),
    formOpen:true,
    list:[],               // view models of every pipeline the companion holds, newest first
    id:null,run:null,      // the pipeline being shown
    working:'',            // start | stop | continue | export
    msg:{text:'',error:false},
    timer:null,mounted:false,
    ctx:{download:null}
  };
  /* The bar a pilot of a stage must score below: the pipeline's own config (config.screenBar, config.testBar), else the companion's, else the spec's (0.40, 0.45). */
  function barOf(kind,v){
    const own=v&&v.bars?v.bars[kind]:null,listed=S.rules[kind+'Bar'];
    return own!==null&&own!==undefined?own:listed!==null&&listed!==undefined?listed:RULES[kind+'Bar'];
  }
  function blankForm(){return {designMode:defaultMode,modeTouched:false,keepAsWorld:'',fairnessSet:false,noReferences:false,acceptMissing:false,capTouched:false,source:'url',url:'',dir:'',cap:String(defaultCap),pilotCap:PILOT_CAP.defaultUsd.toFixed(2),model:'',effort:'',acks:{}};}

  /* ---------- Small helpers ---------- */
  const isLocal=()=>{try{return location.protocol==='http:'&&location.hostname==='127.0.0.1';}catch{return false;}};
  const agents=()=>W.FinanceAgents&&typeof W.FinanceAgents.get==='function'&&typeof W.FinanceAgents.post==='function'?W.FinanceAgents:null;
  const get=path=>agents().get(path);
  const post=(path,body)=>agents().post(path,body);
  const pipePath=(id,tail='')=>{
    if(typeof id!=='string'||!ID_RE.test(id))throw new Error('That pipeline id is not valid.');
    return '/api/pipeline/'+id+tail;
  };
  const usd=n=>'USD '+(Math.round(Number(n)*100)/100).toFixed(2);
  const timeText=iso=>{const t=Date.parse(iso);return Number.isFinite(t)?new Date(t).toLocaleString():text(iso);};
  const plural=(n,one,many)=>n+' '+(n===1?one:many||one+'s');
  const messageOf=error=>String((error&&error.message)||error||'unknown error');
  const isActive=()=>S.list.some(v=>!v.ended)||!!(S.run&&!S.run.ended);
  /* A cap typed as dollars in whole cents, or null. */
  function money(value,min,max){
    const t=String(value==null?'':value).trim();
    if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(t))return null;
    const n=Math.round(Number(t)*100)/100;
    return n>=min&&n<=max?n:null;
  }
  const capValue=()=>money(S.form.cap,CAP_MIN_USD,RULES.maxCapUsd);
  const pilotCapValue=()=>money(S.form.pilotCap,PILOT_CAP.minUsd,PILOT_CAP.maxUsd);
  function linkOk(value){
    const t=String(value||'').trim();
    if(!t||t.length>2048||/\s/.test(t))return false;
    try{const u=new URL(t);return u.protocol==='https:'&&!!u.hostname&&!u.username&&!u.password;}catch{return false;}
  }
  const dirOk=value=>{const t=String(value||'').trim();return t.length>1&&t.length<=1024&&t[0]==='/'&&!/[\u0000-\u001f\u007f]/.test(t);};
  function normalizeChoices(list){
    const out=[];
    arr(list).forEach(item=>{
      if(typeof item==='string'&&item){out.push({id:item,isDefault:false});return;}
      if(isObj(item)){const id=item.id||item.model||item.effort||item.value||item.name;if(typeof id==='string'&&id)out.push({id,isDefault:!!(item.default||item.isDefault)});}
    });
    return out;
  }
  const pickDefault=(choices,preferred)=>(choices.find(c=>c.isDefault)||choices.find(c=>c.id===preferred)||choices[0]).id;
  function normalizeStatus(data){
    const a=isObj(data)?data.agents:null;
    if(!isObj(a))throw new Error('This companion has no agent support.');
    const models=normalizeChoices(a.models),efforts=normalizeChoices(a.efforts);
    if(!models.length||!efforts.length)throw new Error('The companion did not report model and effort choices.');
    return {models:models.map(m=>m.id),efforts:efforts.map(m=>m.id),defaultModel:pickDefault(models,'claude-opus-5-5'),defaultEffort:pickDefault(efforts,'medium')};
  }

  /* ---------- Stages ---------- */
  const STEPS=[['import','Import'],['classify','Classify'],['design','Design'],['screen','Screen'],['test','Test'],['done','Done']];
  const STAGES={
    import:[0,'Import: opening the task and downloading its files.'],
    classify:[1,'Classify: sorting the captured files and text.'],
    design:[2,'Design: building the hardest traps in a working copy.'],
    redesign:[2,'Design: strengthening the traps after a failed stage.'],
    screen:[3,'Screen: two blind pilots are working.'],
    'grade-screen':[3,'Screen: grading the two answers.'],
    test:[4,'Test: five blind pilots are working.'],
    'grade-test':[4,'Test: grading the five answers.'],
    done:[5,'Done: the 5-pilot test passed.'],
    failed:[-1,'Failed: the pipeline ended without a passing design.'],
    stopped:[-1,'Stopped: you pressed Stop.'],
    budget:[-1,'Stopped: the next step would pass the total cap.']
  };
  /* Where a run that ended early (a failure, Stop, the cap) ended, from what the view holds. The companion records the last attempt only as it goes:
     - an attempt is pushed when the designer starts; its screen is set when the screen round starts, its test when the test round starts (before any pilot);
     - the design is set (design.attempt) when an attempt passes its checks, so a design that was accepted and has no screen yet is waiting for the screen;
     - the classification is stored before the checks that can still fail the classify step, and the import only when it is complete;
     - redesigns counts a redesign from the moment its feedback is prepared, one ahead of the attempts until the next attempt starts. */
  function reachedStep(v){
    const n=v.attempts.length,last=n?v.attempts[n-1]:null;
    if(last){
      if(v.redesigns>=n)return 2;                                  // between attempts: the feedback for the next design
      if(v.test)return 4;                                          // the test round started (even if no pilot is in yet)
      if(v.screen)return v.screen.passed===true?4:3;               // a passed screen has the test next; a screen that is open or failed is the screen
      return v.design.attempt!==null&&v.design.attempt===last.n?3:2; // an accepted design has the screen next; else the design itself
    }
    if(v.design.traps.length||v.design.attempt!==null||v.design.newFiles.length)return 2;
    if(v.hasClassification||v.cls.any)return v.stage==='failed'?1:2; // a failed run with a classification failed in a classify check; Stop and the cap come after it
    return v.hasImport?1:0;                                          // an import without a classification: the classify step was reached
  }
  function stepOf(v){const s=STAGES[v.stage];return s&&s[0]>=0?s[0]:reachedStep(v);}
  function stageLine(v){
    if(!v)return '';
    if(v.waiting&&!v.ended){
      /* the bar stays in view and is read out: a short message is carried whole, a long one is shown whole in the card below and the bar points to it */
      if(v.waiting.kind===CONFIRM_KIND)return 'Waiting for you: check the files';
      if(isWithheld(v.waiting.message))return 'Waiting for you: '+waitTitle(v.waiting.kind)+'.';
      const m=typeof v.waiting.message==='string'?v.waiting.message:'';
      return 'Waiting for you: '+(!m?'the task page needs your help in the Chrome window.':m.length<=STAGE_MESSAGE_MAX?m:waitTitle(v.waiting.kind)+'. The whole message is in the card below.');
    }
    if(v.stage==='budget')return 'Stopped at the cap, in the '+STEPS[stepOf(v)][1]+' step: the next call would pass the total cap, so it was not started.';
    const known=STAGES[v.stage];
    let line=known?known[1]:'Working ('+v.stage+').';
    /* a pilot stage says what its pilots must score */
    if(known&&known[0]===3)line=line.replace(/\.$/,' (both must score below '+barText(barOf('screen',v))+').');
    if(known&&known[0]===4)line=line.replace(/\.$/,' ('+RULES.testNeed+' of '+RULES.testPilots+' must score below '+barText(barOf('test',v))+').');
    return line+(v.redesigns>0&&!v.ended?' Redesign '+v.redesigns+' of '+RULES.maxRedesigns+'.':'');
  }
  function stepStates(v){
    const cur=stepOf(v);
    return STEPS.map(([id,label],i)=>{
      let s;
      if(v.stage==='done'||i<cur)s='done';
      else if(i===cur)s=v.ended?'stopped':v.waiting?'waiting':'active';
      else s='todo';
      return {id,label,s};
    });
  }
  const STEP_CAPTION={done:'Done',active:'In progress',waiting:'Waiting for you',stopped:'Stopped here',todo:'Not reached yet'};
  const STEP_MARK={done:'✓',active:'●',waiting:'●',stopped:'!'};
  /* The caption under a step: the redesign count while the design step is open, and for the step a run ended in, why (the cap, or Stop or a failure). */
  function stepCaption(v,s){
    if(s.s==='stopped')return v.stage==='budget'?'Stopped at the cap':'Stopped here';
    if(s.id==='design'&&v.redesigns>0&&s.s!=='todo')return s.s==='done'?'Done':'Redesign '+v.redesigns+' of '+RULES.maxRedesigns;
    return STEP_CAPTION[s.s];
  }
  /* The state of one stage result is the companion's verdict (res.passed) and nothing else: until it has decided, the stage is in progress, whatever the scores so
     far say (a pilot without a usable score gets a replacement round before the stage is decided). The count below the bar is worked out from the scores. */
  const endedWithoutScore=p=>p.audit==='DISCARDED'||['failed','cancelled'].includes(p.state);
  function stageVerdict(res,kind){
    const need=kind==='test'?RULES.testNeed:RULES.screenPilots,of=kind==='test'?RULES.testPilots:RULES.screenPilots;
    const below=res.pilots.filter(p=>p.score!==null&&p.score<barOf(kind,S.run)).length;
    return {status:res.passed===true?'passed':res.passed===false?'failed':'running',below,need,of};
  }
  const scoresText=res=>res&&res.pilots.length?res.pilots.map(p=>p.score===null?(p.stoppedEarly?'not needed':'no score'):p.score.toFixed(2)).join(', '):'';
  const STATUS_LABEL={passed:'passed',failed:'failed',running:'in progress',stopped:'stopped'};
  const STATUS_KIND={passed:'green',failed:'red',running:'violet',stopped:'amber'};

  /* ---------- Painting ---------- */
  /* Replace an element's markup only when it changed, and put keyboard focus back on the same control afterwards. */
  function setHtml(el,markup,force){
    if(!el)return false;
    const t=markup instanceof Raw?markup.text:String(markup);
    if(!force&&el.plHtml===t)return false;
    const active=document.activeElement,key=active&&el.contains&&el.contains(active)?active.getAttribute('data-pl-key'):null;
    el.innerHTML=t;
    el.plHtml=t;
    if(key&&KEY_RE.test(key)){
      const next=el.querySelector('[data-pl-key="'+key+'"]');
      if(next&&!next.disabled)next.focus({preventScroll:true});
    }
    return true;
  }
  function focusKey(key){
    if(!KEY_RE.test(key||''))return false;
    const el=document.querySelector('#pl-root [data-pl-key="'+key+'"]');
    if(el&&!el.disabled&&typeof el.focus==='function'){el.focus({preventScroll:true});return true;}
    return false;
  }
  /* source 'poll' marks a message that the next good poll takes back; an answer to the person's own action stays until the stage changes. */
  function say(t,isError,source){
    const message=String(t||'');
    S.msg={text:message&&isError&&!/^(failed|error)\b|^[^:]{0,40}\bfailed\b/i.test(message)?'Failed: '+message:message,error:!!isError,source:source||''};
    paintMsg();
  }
  function paintMsg(){
    const el=$('#pl-msg');
    if(!el)return;
    el.textContent=S.msg.text;
    el.className='pl-msg'+(S.msg.error?' error':'');
  }
  /* The stage line is a persistent live region: only its words change, so a screen reader hears a change of stage and not each poll. */
  function paintStage(){
    const el=$('#pl-stage'),bar=$('#pl-bar'),line=stageLine(S.run);
    if(bar)bar.className='pl-bar'+(S.run?'':' is-empty');
    if(el&&el.textContent!==line)el.textContent=line;
  }

  /* ---------- Start card ---------- */
  const calMin=()=>S.rules.goldenMin!==null?S.rules.goldenMin:CALIBRATION_MIN;
  /* The worst case of the pilot stages from the caps typed, then the caps of every other call as the companion reports them, and what a reservation includes. */
  /* The caps of the checks that are part of every attempt: the blind review, the second review, the application checks and the adjudications in the new mode (when the companion says them), else the one fairness review. */
  function reviewCaps(r){
    if(S.form.designMode==='new'){
      const list=[r.blindReviewCapUsd!==null?'the blind review '+usd(r.blindReviewCapUsd):'',r.revealReviewCapUsd!==null?'the second review '+usd(r.revealReviewCapUsd):'',r.applicationCapUsd!==null?'each application check '+usd(r.applicationCapUsd):'',r.adjudicationCapUsd!==null?'each adjudication of a low score '+usd(r.adjudicationCapUsd):''].filter(Boolean);
      if(list.length)return list;
    }
    return r.fairnessCapUsd!==null?['the fairness review '+usd(r.fairnessCapUsd)]:[];
  }
  function limitsText(){
    const cap=capValue(),pilot=pilotCapValue(),r=S.rules;
    if(cap===null||pilot===null)return 'Set the caps to see the worst case of the pilot stages.';
    const others=[r.classifyCapUsd!==null?'the classifier '+usd(r.classifyCapUsd):'',r.designCapUsd!==null?'the designer '+usd(r.designCapUsd)+(r.repairCapUsd!==null?' and one repair turn '+usd(r.repairCapUsd):''):'',...reviewCaps(r),r.graderCapUsd!==null?'each grader call '+usd(r.graderCapUsd):''].filter(Boolean);
    const head=r.headroom!==null&&r.headroom>1?' Before each step the run reserves its worst case with '+Math.round((r.headroom-1)*100)+'% headroom on top, and stops when that would pass the total cap.':'';
    return 'Each pilot is capped at '+usd(pilot)+', so a '+RULES.screenPilots+'-pilot screen can cost up to '+usd(pilot*RULES.screenPilots)+' and a '+RULES.testPilots+'-pilot test up to '+usd(pilot*RULES.testPilots)+'. The '+RULES.testPilots+' test pilots run only when both screen pilots score below '+barText(barOf('screen'))+', and a round stops as soon as its result is decided.'+(others.length?' The other calls are capped too: '+others.join(', ')+'.':' The classifier, designer and grader runs cost extra.')+' The total cap of '+usd(cap)+' covers everything.'+head;
  }
  /* The least total cap that lets one full attempt start: the companion's formula (config.minCap) with the pilot cap typed in the form, rounded up to the cent.
     Null when the companion reported no minCap or the pilot cap is not a valid amount. */
  function minTotalCap(){
    const r=S.rules,mode=S.form.designMode,pilot=pilotCapValue();
    /* the parts of the chosen mode (config.minCapByMode); config.minCap is the parts of the default mode */
    const m=r.minCapByMode[mode]||(mode===(r.defaultDesignMode||'new')?r.minCap:null);
    if(!m||pilot===null)return null;
    /* the optional diagnostic suite adds its cost to the fixed part, in the new mode */
    const extra=mode==='new'&&S.form.fairnessSet?(r.minCapFairnessSetUsd!==null?r.minCapFairnessSetUsd:r.fairnessSetCapUsd||0):0;
    const cents=m.headroom*(m.fixedUsd+extra+m.pilots*(pilot+m.perPilotUsd))*100;
    return Math.ceil(Math.round(cents*1e6)/1e6)/100;
  }
  const capMinText=()=>{const m=minTotalCap(),cap=capValue();return m===null?'':'If the screen passes, one full attempt (screen and test) can cost up to '+usd(m)+'.'+(S.form.designMode==='new'?' The reviews and the adjudication of low scores are part of every attempt.':' The fairness review is part of every attempt.')+(cap!==null&&cap<m?' With this total cap the run may stop at the cap before the '+RULES.testPilots+'-pilot test.':'');};
  function paintCapMin(){
    const el=$('#pl-cap-min'),t=capMinText();
    if(el&&el.textContent!==t)el.textContent=t;
  }
  const MODE_LABEL={new:'New task from the world files',harden:'Harden the existing task'};
  const MODE_NOTE={new:'The designer starts from the world files alone and writes the prompt, the grader guideline, the golden answer and a brief of what the traps rest on. The design is checked before any pilot runs.',harden:'The designer hardens the prompt, the grader guideline and the golden answer the task already has, as the Pipeline did before.'};
  const MAX_KEEP=50;
  /* The names typed in the keep-as-world field: separated by commas, trimmed, no empty one, none twice. */
  function keepNames(){
    const seen=new Set();
    return String(S.form.keepAsWorld||'').split(',').map(x=>x.trim()).filter(x=>x!==''&&!seen.has(x)&&seen.add(x));
  }
  const keepNameOk=n=>n.length<=300&&!/[\u0000-\u001f\u007f]/.test(n)&&!/^[\\/]/.test(n)&&!/(^|[\\/])\.\.([\\/]|$)/.test(n);
  /* The default reference folder as the start form shows it: null when the companion did not say (nothing is shown then). */
  const refDefault=()=>S.rules.references;
  const refProblems=()=>{const r=refDefault();return r&&r.problems.count>0?r:null;};
  function refsLineHtml(){
    const r=refDefault();
    if(!r)return '';
    if(r.problems.count>0){
      return html`<p class="pl-refs pl-refs-problem" id="pl-refs">Reference documents: the default folder has ${plural(r.problems.count,'problem')}, so a start is refused. Fix the folder, or start without it.</p>${r.problems.list.length?html`<ul class="pl-names pl-refs-list">${r.problems.list.map(x=>html`<li>${x}</li>`)}</ul>`:''}
        <label class="check pl-no-refs"><input type="checkbox" data-pl-in="noReferences" data-pl-key="no-references" ${S.form.noReferences?'checked':''}><span><strong>Start without the reference folder</strong>The designer then works from the world files and its own list of ideas.</span></label>`;
    }
    if(r.found>0)return html`<p class="pl-refs" id="pl-refs">Reference documents: ${plural(r.found,'file')} found in the default folder (${r.names.join(', ')}). The designer and the reviewers read them and their text is sent to Anthropic. Pilots never see them.</p>`;
    return html`<p class="pl-refs" id="pl-refs">Reference documents: none found in the default folder. The designer works from the world files and its own list of ideas.</p>`;
  }
  function startWhy(){
    const f=S.form;
    if(isActive())return 'A pipeline is running. Start another when it has ended.';
    if(f.source==='url'){
      if(!f.url.trim())return 'Enter the task link, or choose a folder.';
      if(!linkOk(f.url))return 'The task link must be an https address, without a user name or password.';
    }else{
      if(!f.dir.trim())return 'Enter the folder path, or use a task link.';
      if(!dirOk(f.dir))return 'Enter the full path of the folder, starting with /.';
    }
    if(capValue()===null)return 'The total cap must be from '+usd(CAP_MIN_USD)+' to '+usd(RULES.maxCapUsd)+', in whole cents.';
    if(pilotCapValue()===null)return 'The cap per pilot must be from '+usd(PILOT_CAP.minUsd)+' to '+usd(PILOT_CAP.maxUsd)+', in whole cents.';
    if(capValue()<pilotCapValue())return 'The total cap must be at least the cap of one pilot.';
    if(!f.model||!f.effort)return 'Choose a model and an effort.';
    if(f.designMode==='new'){
      if(refProblems()&&!f.noReferences)return 'The reference folder has problems, so the companion would refuse the start. Fix it, or tick Start without the reference folder.';
      const keep=keepNames();
      if(keep.length>MAX_KEEP)return 'Keep at most '+MAX_KEEP+' files as world files.';
      if(keep.some(n=>!keepNameOk(n)))return 'Each file to keep as a world file must be a plain file name, without a leading slash or ..';
    }
    if(!ACKNOWLEDGEMENTS.every(a=>f.acks[a.id]))return 'Tick all four acknowledgements to enable the button.';
    return '';
  }
  /* The fields of the new mode only (the harden mode hides them and does not send them). */
  function newModeFieldsHtml(){
    const f=S.form,cap=S.rules.fairnessSetCapUsd;
    return html`<fieldset class="pl-new-fields"><legend>For a new task</legend>
      ${refsLineHtml()}
      <label class="field">Keep these files as world files (optional)<input type="text" id="pl-keep" data-pl-in="keepAsWorld" data-pl-key="keep-as-world" value="${f.keepAsWorld}" maxlength="4000" autocomplete="off" spellcheck="false" placeholder="Atlas_Parent_Answer.xlsx, Meridian_Notes.txt" aria-describedby="pl-keep-hint"><small id="pl-keep-hint"><strong>Warning:</strong> the pilots get these files, and so does the designer, even if the names look like answers or grading material. Use it only for a file that is real evidence, such as the answer of a parent task. Separate names with commas.</small></label>
      <label class="check pl-fairness-set"><input type="checkbox" data-pl-in="fairnessSet" data-pl-key="fairness-set" ${f.fairnessSet?'checked':''}><span><strong>Also run the diagnostic answers${cap!==null?' (adds up to '+usd(cap)+' per attempt)':''}</strong>The designer writes up to six answers, some that should score high and some low, and each is graded once to check that the guideline tells them apart. Off by default.</span></label>
    </fieldset>`;
  }
  function startFormHtml(){
    const f=S.form,st=S.status,locked=isActive();
    if(!S.formOpen){
      return html`<div class="card-title"><div><div class="eyebrow">Start</div><h2>Start a pipeline</h2></div><button type="button" data-pl="new" data-pl-key="new" ${locked?'disabled':''}>New pipeline</button></div>
        <p class="muted pl-compact">${locked?'A pipeline is running. You can start another when it has ended.':'The latest pipeline is shown below. You can start another one from a task link or a folder.'}</p>`;
    }
    return html`<div class="card-title"><div><div class="eyebrow">Start</div><h2>Start a pipeline</h2></div>${S.run?html`<button type="button" class="small" data-pl="cancel-new" data-pl-key="cancel-new">Cancel</button>`:''}</div>
      <p class="muted">Paste the link of a task page, or give a folder you already downloaded. One approval covers the whole run, and a total cap in USD stops it. Nothing starts until you press Approve and start.</p>
      <fieldset class="pl-source"><legend>Where the task comes from</legend>
        <label class="check"><input type="radio" name="pl-source" value="url" data-pl-in="source" data-pl-key="source-url" ${f.source==='url'?'checked':''}><span><strong>Task link</strong>The companion opens the task page in its own Chrome window, turns on the option that shows all files and downloads them. You sign in there once.</span></label>
        <label class="check"><input type="radio" name="pl-source" value="dir" data-pl-in="source" data-pl-key="source-dir" ${f.source==='dir'?'checked':''}><span><strong>Folder on this computer</strong>Works offline: the files you downloaded by hand, with an optional page.json beside them.</span></label>
      </fieldset>
      ${f.source==='url'
        ?html`<label class="field">Task link (https)<input type="text" inputmode="url" id="pl-url" data-pl-in="url" data-pl-key="url" value="${f.url}" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="Paste the task link" aria-describedby="pl-url-hint"><small id="pl-url-hint">The link goes to the companion only. It is not saved in this browser and it is not shown again once the run has started.</small></label>`
        :html`<label class="field">Folder path<input type="text" id="pl-dir" data-pl-in="dir" data-pl-key="dir" value="${f.dir}" maxlength="1024" autocomplete="off" spellcheck="false" placeholder="/Users/you/Downloads/task" aria-describedby="pl-dir-hint"><small id="pl-dir-hint">Paste the full path (Finder: select the folder, Option-Command-C). Unzip a task ZIP outside this project first.</small></label>`}
      <label class="field pl-mode">What to design<select data-pl-in="designMode" data-pl-key="design-mode" aria-describedby="pl-mode-note">${['new','harden'].filter(m=>!S.rules.designModes.length||S.rules.designModes.includes(m)).map(m=>html`<option value="${m}" ${m===f.designMode?'selected':''}>${MODE_LABEL[m]}</option>`)}</select><small id="pl-mode-note">${MODE_NOTE[f.designMode]||''}</small></label>
      <div class="field-row three">
        <label class="field">Total cap (USD)<input type="text" inputmode="decimal" id="pl-cap" data-pl-in="cap" data-pl-key="cap" value="${f.cap}" maxlength="6" autocomplete="off" spellcheck="false" aria-describedby="pl-cap-hint pl-cap-min"><small id="pl-cap-hint">The run stops before a step that could pass it. ${usd(CAP_MIN_USD)} to ${usd(RULES.maxCapUsd)}.</small><small id="pl-cap-min" class="pl-cap-min">${capMinText()}</small></label>
        <label class="field">Model<select data-pl-in="model" data-pl-key="model">${st.models.map(m=>html`<option value="${m}" ${m===f.model?'selected':''}>${m}</option>`)}</select></label>
        <label class="field">Effort<select data-pl-in="effort" data-pl-key="effort">${st.efforts.map(m=>html`<option value="${m}" ${m===f.effort?'selected':''}>${m}</option>`)}</select></label>
      </div>
      <div class="field-row three">
        <label class="field">Cap per pilot (USD)<input type="text" inputmode="decimal" id="pl-pilot-cap" data-pl-in="pilotCap" data-pl-key="pilot-cap" value="${f.pilotCap}" maxlength="6" autocomplete="off" spellcheck="false" aria-describedby="pl-pilot-hint"><small id="pl-pilot-hint">Passed to each pilot as its own spending cap. ${usd(PILOT_CAP.minUsd)} to ${usd(PILOT_CAP.maxUsd)}.</small></label>
      </div>
      ${f.designMode==='new'?newModeFieldsHtml():''}
      <label class="check pl-accept"><input type="checkbox" data-pl-in="acceptMissing" data-pl-key="accept-missing" ${f.acceptMissing?'checked':''}><span><strong>${ACCEPT_LABEL}</strong>Off by default: the run stops when the classifier called a file a world or task file and the pilots would not get it, and says which.</span></label>
      <fieldset class="pl-acks"><legend>Required before the run starts</legend>${ACKNOWLEDGEMENTS.map(a=>html`<label class="check"><input type="checkbox" data-pl-in="ack" data-id="${a.id}" data-pl-key="ack-${a.id}" ${f.acks[a.id]?'checked':''}><span><strong>${a.label}</strong>${a.text}</span></label>`)}</fieldset>`;
  }
  function startFootHtml(){
    if(!S.formOpen)return '';
    const why=startWhy();
    return html`<div class="pl-start-row"><button type="button" class="primary" data-pl="start" data-pl-key="start" aria-describedby="pl-why" ${why||S.working?'disabled':''}>Approve and start</button><p id="pl-why" class="pl-why">${why}</p></div>
      <p class="pl-happens">${HAPPENS(S.form.designMode)}</p>
      <p class="footnote pl-limits">${limitsText()}</p>`;
  }

  /* ---------- Run: picker, spend, actions, waiting ---------- */
  function pickerHtml(){
    if(S.list.length<2)return '';
    return html`<label class="field pl-pick">Show pipeline<select data-pl-in="pick" data-pl-key="pick">${S.list.map(v=>html`<option value="${v.id}" ${v.id===S.id?'selected':''}>${v.id} · ${(STAGES[v.stage]||[0,v.stage])[1].split(':')[0]}${v.createdAt?' · '+timeText(v.createdAt):''}</option>`)}</select></label>`;
  }
  function spendHtml(){
    const v=S.run;
    if(!v)return '';
    const cap=v.capUsd;
    return html`${v.message&&!v.ended?html`<p class="pl-progress">${v.message}</p>`:''}<p class="pl-spend-line"><strong>Spent</strong> ${usd(v.spentUsd)}${cap?' of '+usd(cap):''}</p>
      ${cap?html`<progress class="pl-meter" max="${cap}" value="${Math.min(v.spentUsd,cap)}" aria-label="Spent against the total cap"></progress>`:''}
      <p class="pl-meta muted">Pipeline <code>${v.id}</code>${v.model?' · '+v.model:''}${v.effort?' · '+v.effort:''}${v.pilotCapUsd?' · '+usd(v.pilotCapUsd)+' per pilot':''}${v.acceptMissing?' · withheld files accepted':''}${v.createdAt?' · started '+timeText(v.createdAt):''}</p>`;
  }
  /* The companion exports any ended pipeline that made a design, and refuses while a round runs (then the answer is redacted). */
  const canExport=v=>!!v&&v.ended&&!v.redacted&&v.hasDesign;
  function actionsHtml(){
    const v=S.run;
    if(!v)return '';
    return html`${v.ended?'':html`<button type="button" class="danger" data-pl="stop" data-pl-key="stop" ${S.working==='stop'?'disabled':''}>Stop</button>`}${canExport(v)?html`<button type="button" data-pl="export" data-pl-key="export" ${S.working==='export'?'disabled':''}>Export private zip</button>`:''}`;
  }
  const STAGE_MESSAGE_MAX=240;
  const waitTitle=kind=>kind==='needs-sign-in'?'Sign in':kind==='needs-person'?'Your action is needed in the Chrome window':kind===CONFIRM_KIND?'Check the files':'The task page needs you';
  /* The files the import fetched, for the owner to check against the task page: a compact list that scrolls (and can be scrolled from the keyboard). */
  function fetchedFilesHtml(v){
    const list=v.fileList,total=v.files.total;
    if(isWithheld(list))return html`<h3>Files</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    if(list===null||!list.length)return html`<h3>Files${total!==null?' ('+total+')':''}</h3><p class="muted">${total===0?'The import fetched no file.':'The companion sent no list of the files.'}</p>`;
    return html`<h3>${plural(total!==null?total:list.length,'file')} fetched</h3>
      <div class="pl-files-box" role="region" aria-label="Files fetched from the task page" tabindex="0"><ul class="pl-files">${list.map(x=>html`<li><span class="pl-file-name">${inline(x.name)}</span>${isWithheld(x.group)||x.group!==''?html` <span class="pl-file-group muted">${inline(x.group)}</span>`:''}</li>`)}</ul></div>`;
  }
  function confirmFilesHtml(v){
    const w=v.waiting,t=v.toggle;
    return html`<div class="card-title"><div><div class="eyebrow">Waiting for you</div><h2>${waitTitle(w.kind)}</h2></div>${pill('Paused','amber')}</div>
      <p class="pl-wait-message">${isWithheld(w.message)?inline(w.message):w.message||'Compare the files below with the task page in the Chrome window. If a file is missing, press Stop, fix the page or download it yourself, and start again.'}</p>
      ${importNotesHtml(v)}
      ${keptFilesHtml(v)}
      ${fetchedFilesHtml(v)}
      ${isWithheld(v.skipped)?html`<h3>Skipped</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`:v.skipped.length?html`<h3>Skipped (${v.skipped.length})</h3>${skippedList(v)}`:''}
      ${t?html`<h3>Show all files</h3><p class="pl-toggle-line">${toggleLine(t)}</p>`:''}
      <div class="actions pl-confirm-actions"><button type="button" data-pl="continue" data-pl-key="continue" ${S.working==='continue'?'disabled':''}>Every file is there: continue</button><button type="button" class="danger" data-pl="stop" data-pl-key="wait-stop" ${S.working==='stop'?'disabled':''}>Stop</button></div>`;
  }
  function waitHtml(){
    const v=S.run;
    if(!v||!v.waiting||v.ended)return '';
    if(v.waiting.kind===CONFIRM_KIND)return confirmFilesHtml(v);
    const w=v.waiting,title=waitTitle(w.kind);
    return html`<div class="card-title"><div><div class="eyebrow">Waiting for you</div><h2>${title}</h2></div>${pill('Paused','amber')}</div>
      <p class="pl-wait-message">${isWithheld(w.message)?inline(w.message):w.message||'Finish what the Chrome window asks for, then press Continue.'}</p>
      <div class="actions"><button type="button" data-pl="continue" data-pl-key="continue" ${S.working==='continue'?'disabled':''}>Continue</button></div>`;
  }
  function withheldNoteHtml(){
    const v=S.run;
    return v&&v.redacted?html`<div class="notice neutral" role="note">A round is running, so this page does not show the prompt, the grader guideline, the golden answer, the gold, the fingerprints or the trap values. They appear when no round is running.</div>`:'';
  }

  /* ---------- Run: timeline and results ---------- */
  function timelineHtml(){
    const v=S.run;
    if(!v)return '';
    const states=stepStates(v);
    return html`<ol class="pl-steps" aria-label="Pipeline stages">${states.map((s,i)=>html`<li class="pl-step is-${s.s}"${s.s==='active'||s.s==='waiting'||s.s==='stopped'?new Raw(' aria-current="step"'):''}><span class="pl-step-mark" aria-hidden="true">${STEP_MARK[s.s]||String(i+1)}</span><span class="pl-step-text"><strong>${s.label}</strong><small>${stepCaption(v,s)}</small></span></li>`)}</ol>`;
  }
  /* The files the import skipped, with the reason for each; collapsed in the import card, open in the wait card. */
  function skippedList(v){return html`<ul class="pl-names">${v.skipped.map(x=>html`<li>${inline(x.name)}${x.why!==''?html` <span class="muted">${inline(x.why)}</span>`:''}</li>`)}</ul>`;}
  function skippedHtml(v){
    if(isWithheld(v.skipped))return html`<p class="pl-withheld">Skipped files: ${WITHHELD_TEXT}</p>`;
    return v.skipped.length?html`<details><summary>Skipped (${v.skipped.length})</summary>${skippedList(v)}</details>`:'';
  }
  /* What happened to the option that shows all files, in words. */
  function toggleText(t){
    return isWithheld(t)?inline(t)
      :t.learned&&t.flipped?'Turned on from what you showed for this site. '+(t.label?'Label: \u201C'+t.label+'\u201D. ':'')
      :t.found&&t.flipped?'Found and turned on'+(t.label?' (\u201C'+t.label+'\u201D)':'')+'.'
      :t.learned?'Learned from you for this site.'
      :t.found?'Found'+(t.label?' (\u201C'+t.label+'\u201D)':'')+', but not turned on.':'Not found on the page.';
  }
  const toggleLine=t=>html`${toggleText(t)}${!isWithheld(t)&&t.before!==null&&t.after!==null?' '+plural(t.before,'file')+' offered before, '+t.after+' after.':''}`;
  /* The places the loader could not fully cover (caps it hit, pages it did not follow, frames it could not read, a request still pending), as a notice. */
  /* The files the owner asked to keep as world files (keepAsWorld): each with the warning the companion gives. They go to the designer and to the pilots. */
  function keptFilesHtml(v){
    const k=v.keptFiles;
    if(isWithheld(k))return html`<p class="pl-withheld">Files kept as world files: ${WITHHELD_TEXT}</p>`;
    if(!k.length)return '';
    return html`<div class="notice pl-warning pl-kept" role="note"><strong>You asked to keep ${plural(k.length,'file')} as world files</strong><p class="pl-warning-lead">The designer and the pilots get ${k.length===1?'this file':'these files'}, even if the name looks like an answer or grading material.</p><ul class="pl-names">${k.map(x=>html`<li><strong>${x.name}</strong>${!isWithheld(x.warning)&&x.warning===''?'':html` <span class="muted">${inline(x.warning)}</span>`}${x.present?'':html` <span class="pl-missing">Not among the files that were fetched.</span>`}</li>`)}</ul></div>`;
  }
  function importNotesHtml(v){
    if(isWithheld(v.importNotes))return html`<p class="pl-withheld">Places the loader could not fully cover: ${WITHHELD_TEXT}</p>`;
    if(!v.importNotes.length)return '';
    return html`<div class="notice pl-warning pl-notes" role="note"><strong>The loader could not fully cover these places</strong><p class="pl-warning-lead">Check them against the task page before you trust that every file is here.</p><ul class="pl-names">${v.importNotes.map(n=>html`<li>${inline(n)}</li>`)}</ul></div>`;
  }
  function importHtml(){
    const v=S.run;
    if(!v)return '';
    const f=v.files,t=v.toggle,known=Object.values(f).some(n=>n!==null);
    if(!v.hasImport&&!v.source.origin&&!v.source.folder&&!known&&!t)return '';
    const counts=[f.total!==null?plural(f.total,'file')+' in all':'',f.world!==null?f.world+' world':'',f.task!==null?f.task+' task':'',f.withheld!==null?f.withheld+' withheld':'',f.other!==null?f.other+' other':''].filter(Boolean).join(' · ');
    const where=v.source.origin?v.source.origin+v.source.path:v.source.folder?(v.source.name?'Folder “'+v.source.name+'” on this computer':'A folder on this computer'):v.hasImport?'A folder on this computer':'';
    return html`<div class="card-title"><div><div class="eyebrow">Import</div><h2>What was captured</h2></div></div>
      <dl class="history-details">
        ${where?html`<dt>Source</dt><dd>${where}</dd>`:''}
        ${v.source.pageOrigin?html`<dt>Task page</dt><dd>${v.source.pageOrigin+v.source.pagePath} <span class="muted">from the folder’s page.json</span></dd>`:''}
        ${counts?html`<dt>Files</dt><dd>${counts}</dd>`:''}
        ${t?html`<dt>Show all files</dt><dd>${toggleLine(t)}</dd>`:''}
      </dl>
      ${importNotesHtml(v)}
      ${keptFilesHtml(v)}
      ${skippedHtml(v)}
      <p class="footnote">Withheld files (the grader guideline, the golden answer, and any evaluator, audit or run-evidence file) are never copied into what the pilots see.</p>`;
  }
  const refText=(r,mode)=>!r?(mode==='new'?'Not needed: the designer writes a new one':'Not found'):r.kind==='withheld'?WITHHELD_TEXT:r.kind==='section'?'Section \u201C'+r.name+'\u201D':r.kind==='file'?'File \u201C'+r.name+'\u201D':'\u201C'+r.name+'\u201D';
  function nameBlock(label,items){
    return items.length?html`<h3>${label} (${items.length})</h3><ul class="pl-names">${items.map(n=>html`<li>${n.name}${n.why?html` <span class="muted">${n.why}</span>`:''}</li>`)}</ul>`:'';
  }
  const named=list=>list.map(name=>({name,why:''}));
  const joined=list=>list.map(plain).join(', ');
  function classHtml(){
    const v=S.run;
    if(!v||!v.cls.any)return '';
    const c=v.cls;
    return html`<div class="card-title"><div><div class="eyebrow">Classify</div><h2>What each part of the task is</h2></div>${c.warnings.length?pill(plural(c.warnings.length,'warning'),'amber'):''}</div>
      ${c.warnings.length?html`<div class="notice pl-warning" role="note"><strong>Warning: check this before you trust the classification</strong><p class="pl-warning-lead">The classifier called each of these a world or task file, but the pilots will not get it.</p><ul class="pl-names">${c.warnings.map(w=>html`<li>${isWithheld(w.name)?inline(w.name):w.name}${w.why===''?'':html`: ${inline(w.why)}`}</li>`)}</ul></div>`:''}
      <dl class="history-details"><dt>Business prompt</dt><dd>${refText(c.prompt,v.designMode)}</dd><dt>Grader guideline</dt><dd>${refText(c.guideline,v.designMode)}</dd><dt>Golden answer</dt><dd>${refText(c.golden,v.designMode)}</dd></dl>
      ${isWithheld(c.kept)?'':c.kept.length?html`<p class="pl-class-note pl-kept-note">Kept as world files because you asked, although the name looks like an answer or grading material: ${c.kept.map(x=>plain(x.name)+(x.why!==''?' ('+plain(x.why)+')':'')).join(', ')}.</p>`:''}
      ${c.goldenSuspects.length?html`<p class="pl-class-note">These files look like the golden answer: ${joined(c.goldenSuspects)}.${c.golden===null?' None was identified as the golden answer.':''}</p>`:''}
      ${c.unscanned.length?html`<p class="pl-class-note">The text of these files could not be checked for guideline or golden-answer passages: ${joined(c.unscanned)}.</p>`:''}
      ${c.notes.length?html`<ul class="pl-names">${c.notes.map(n=>html`<li>${n}</li>`)}</ul>`:''}
      ${c.world.length||c.task.length||c.other.length||c.withheld.length?html`<details><summary>File lists</summary>${nameBlock('World files',named(c.world))}${nameBlock('Task files',named(c.task))}${nameBlock('Other files',named(c.other))}${nameBlock('Withheld from the pilots',c.withheld)}</details>`:''}`;
  }
  const plain=x=>isWithheld(x)?WITHHELD_TEXT:String(x);
  const inline=x=>isWithheld(x)?html`<span class="pl-withheld">${WITHHELD_TEXT}</span>`:x;
  const valueText=x=>isWithheld(x)?html`<span class="pl-withheld">${WITHHELD_TEXT}</span>`:x?html`<span>${x}</span>`:html`<span class="muted">Not given</span>`;
  const blockText=x=>isWithheld(x)?html`<p class="pl-withheld">${WITHHELD_TEXT}</p>`:x?html`<pre class="pl-text">${x.length>8000?x.slice(0,8000)+'\n[shortened for this page]':x}</pre>`:html`<p class="muted">Not given</p>`;
  /* A score to two decimals; one that rounds onto the bar shows its extra digits so the yes or no (or the pass or fail) is never a surprise. */
  function scoreFmt(x,bar=RULES.testBar){
    const two=x.toFixed(2);
    return two===bar.toFixed(2)&&x!==bar?two+' ('+x.toFixed(4)+')':two;
  }
  /* A line diff: added, removed and hunk lines are marked by their own first character and, as well, by a class. */
  function diffBlock(x){
    if(isWithheld(x))return html`<p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    const counts=x.added!==null&&x.removed!==null?html`<p class="muted pl-diff-count">${plural(x.added,'line')} added, ${x.removed} removed.</p>`:'';
    if(!x.available)return html`<p class="muted">The original is not available as text, so there is no line comparison.</p>`;
    if(x.kind==='binary')return html`<p class="muted">This file is not compared line by line.${x.before!==null&&x.after!==null?' It had '+x.before.toLocaleString('en-US')+(x.before===1?' byte':' bytes')+' and has '+x.after.toLocaleString('en-US')+'.':''}</p>`;
    if(!x.text)return html`${counts}<p class="muted">No line changed.</p>`;
    const body=x.text.length>8000?x.text.slice(0,8000)+'\n[shortened for this page]':x.text;
    const lines=body.replace(/\n$/,'').split('\n');
    return html`${counts}<pre class="pl-text pl-diff">${lines.map((line,i)=>html`<span class="${line.startsWith('+')?'pl-diff-add':line.startsWith('-')?'pl-diff-del':line.startsWith('@@')?'pl-diff-hunk':'pl-diff-same'}">${line}${i<lines.length-1?'\n':''}</span>`)}</pre>${x.truncated?html`<p class="muted">Only the first lines of the diff are shown.</p>`:''}`;
  }
  function trapHtml(t){
    return html`<li class="pl-trap"><strong>${inline(t.title)}</strong>${isWithheld(t.files)?html` <span class="muted">Files: ${inline(t.files)}</span>`:t.files.length?html` <span class="muted">Files: ${t.files.join(', ')}</span>`:''}
      <details><summary>Trap details</summary><dl class="history-details"><dt>Mechanism</dt><dd>${valueText(t.mechanism)}</dd><dt>Decoy</dt><dd>${valueText(t.decoy)}</dd><dt>Correct value</dt><dd>${valueText(t.correct)}</dd><dt>Wrong value</dt><dd>${valueText(t.wrong)}</dd></dl></details></li>`;
  }
  function goldHtml(d){
    const g=d.gold,p=d.fingerprints;
    return html`<details><summary>Gold and fingerprints</summary>
      <h3>Gold</h3>${isWithheld(g)?blockText(WITHHELD):g?html`<dl class="history-details"><dt>Decision</dt><dd>${valueText(g.decision)}</dd>${g.figures.map(f=>html`<dt>${f.label||'Figure'}</dt><dd>${valueText(f.value)}${f.tolerance?html` <span class="muted">tolerance ${f.tolerance}</span>`:''}</dd>`)}</dl>`:html`<p class="muted">Not given</p>`}
      <h3>Fingerprints</h3>${isWithheld(p)?blockText(WITHHELD):p&&p.length?html`<ul class="pl-names">${p.map(f=>html`<li><strong>${f.label||f.id}</strong>${f.tokens.length?html` <span class="muted">Tokens: ${f.tokens.join(', ')}</span>`:''}${f.figures.length?html` <span class="muted">Figures: ${f.figures.join(', ')}</span>`:''}</li>`)}</ul>`:html`<p class="muted">Not given</p>`}</details>`;
  }
  function newFilesHtml(d){
    return html`<h3>New files${isWithheld(d.newFiles[0])&&d.newFiles.length===1?'':' ('+d.newFiles.length+')'}</h3>${d.newFiles.length?html`<ul class="pl-names">${d.newFiles.map(n=>html`<li>${inline(n)}</li>`)}</ul>`:html`<p class="muted">The designer added no new file.</p>`}`;
  }
  function editedHtml(d){
    if(isWithheld(d.edited))return html`<h3>Edited world files</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    return html`<h3>Edited world files (${d.edited.length})</h3>${d.edited.length?html`<ul class="pl-edits">${d.edited.map(e=>html`<li class="pl-edit"><span class="pill amber">Edited world file</span> <strong>${inline(e.name)}</strong>${e.size!==null?html` <span class="pl-edit-size">Size change: ${inline(e.size)}</span>`:''}<span class="pl-edit-reason">${isWithheld(e.reason)?inline(e.reason):e.reason||'No reason was given.'}</span>${e.diff!==null?html`<details class="pl-diff-box"><summary>What changed in ${typeof e.name==='string'?e.name:'this file'}</summary>${diffBlock(e.diff)}</details>`:''}</li>`)}</ul>`:html`<p class="muted">No existing world file was edited. The originals are never changed.</p>`}`;
  }
  /* The golden answer, graded against the revised guideline, has to score at least the companion's minimum (calMin) before any pilot runs. */
  function calibrationHtml(d){
    const c=d.calibration,min=calMin();
    if(c===null)return '';
    if(isWithheld(c))return html`<h3>Calibration</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    const ok=typeof c.score==='number'&&c.score>=min;
    const head=isWithheld(c.score)?html`<p class="pl-withheld">${WITHHELD_TEXT}</p>`
      :c.score===null?html`<p class="muted">The golden answer has not been graded against the revised grader guideline yet.</p>`
      :html`<p>${pill(ok?'Calibration passed':'Calibration failed',ok?'green':'red')} The golden answer scored <strong>${scoreFmt(c.score,min)}</strong> against the revised grader guideline. It needs ${min.toFixed(2)} or more.</p>`;
    const said=isWithheld(c.verdict)||c.verdict||isWithheld(c.reason)||c.reason;
    return html`<h3>Calibration</h3>${head}${said?html`<p class="muted">Grader verdict: ${valueText(c.verdict)}. Reason: ${valueText(c.reason)}</p>`:''}`;
  }
  /* The fairness review's own status: ok, unfair (its items follow) or unusable (it gave no usable answer). */
  function fairnessHtml(d){
    const f=d.fairness;
    if(f===null)return '';
    if(isWithheld(f))return html`<h3>Fairness review</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    if(f.status==='unusable')return html`<h3>Fairness review</h3><p>${pill('No usable answer','amber')} The fairness review gave no usable answer.</p>`;
    if(f.status==='ok'&&!f.unfair.length)return html`<h3>Fairness review</h3><p>${pill('No unfair item','green')} The fairness review found no unfair item.</p>`;
    const n=Math.max(f.unfair.length,f.count);
    return html`<h3>Fairness review</h3><p>${pill(plural(n,'unfair item'),'amber')} The fairness review flagged ${f.unfair.length?'these':'an item'}.</p>${f.unfair.length?html`<ul class="pl-edits">${f.unfair.map(x=>html`<li class="pl-unfair"><strong>${isWithheld(x.item)?inline(x.item):x.item||'An item'}</strong><span class="pl-edit-reason">${isWithheld(x.why)?inline(x.why):x.why||'No reason was given.'}</span></li>`)}</ul>`:''}`;
  }
  /* What the designer changed in the grader guideline: the rubric changes it listed and the line diff against the original. Collapsed. */
  function guidelineChangesHtml(d){
    const diff=d.guidelineDiff,rub=d.rubricChanges;
    if(diff===null&&rub===null)return '';
    const rubric=rub===null?'':isWithheld(rub)?html`<h3>Rubric changes</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`
      :html`<h3>Rubric changes (${rub.length})</h3>${rub.length?html`<ul class="pl-names">${rub.map(r=>html`<li>${isWithheld(r.change)?inline(r.change):r.change||'A change'}${r.reason!==''?html` <span class="muted">Why: ${inline(r.reason)}</span>`:''}</li>`)}</ul>`:html`<p class="muted">The designer listed no rubric change.</p>`}`;
    return html`<details class="pl-changes"><summary>What the designer changed in the grader guideline</summary>${rubric}${diff===null?'':html`<h3>Line changes</h3>${diffBlock(diff)}`}</details>`;
  }
  /* New or edited files of the designer whose text the companion could not read as text, so it could not look for passages of the guideline or the golden answer. */
  function unscannedHtml(d){
    if(isWithheld(d.unscanned))return html`<p class="pl-class-note pl-unscanned">New or edited files whose text could not be checked for guideline or golden-answer passages: ${inline(d.unscanned)}.</p>`;
    if(!d.unscanned.length)return '';
    return html`<p class="pl-class-note pl-unscanned">The text of these new or edited files could not be checked for guideline or golden-answer passages: ${d.unscanned.map((x,i)=>html`${i?', ':''}${inline(x.name)}${x.kind?' ('+x.kind+')':''}`)}.</p>`;
  }
  /* ---- the new mode: the brief, the fairness and difficulty results, the answer set, the freeze records ---- */
  const REVIEW_WORDS={pending:'In progress',passed:'Passed',rejected:'Rejected','not-reached':'Not reached',incomplete:'Did not finish'};
  const REVIEW_KIND={pending:'violet',passed:'green',rejected:'red','not-reached':'',incomplete:'amber'};
  const DISPOSITION_WORDS={no_alternative:'no other answer was found',excluded_by_clause:'the other answer is ruled out by a clause of the files',permitted:'the files allow the other answer, so it was added to the guideline',equivalent_result:'the other answer reaches the same result',unresolved:'the files do not settle which answer is right'};
  const OBJECTION_WORDS={overlooked_dependency:'an overlooked dependency',permitted_discretion:'permitted discretion',missing_requirement:'a missing requirement',conflicting_authority:'conflicting authority',inaccessible_evidence:'inaccessible evidence',rubric_requirement_absent_from_packet:'a rubric requirement the files do not state',equivalent_result:'an equivalent result',none:'none'};
  const CHECK_WORDS={governs:'it does not govern this decision',inForce:'it is not shown to be in force',notSuperseded:'it may be superseded',excludes:'it does not rule the other answer out',unusable:'the check gave no usable answer'};
  const WHY_WORDS={money:'money',time:'time',effort:'effort',accountability:'accountability'};
  const CHANGES_WORDS={required_conclusion:'changes the required conclusion',required_calculation:'changes a required calculation',neither:'changes neither'};
  const ROLE_WORDS={authority:'authority',evidence:'evidence',decoy:'decoy',baseline:'baseline'};
  const SCENARIO_WORDS={baseline:'Baseline',primary_wrong:'The primary wrong path',secondary_wrong:'A secondary wrong path',combined_wrong:'All wrong paths together'};
  const gradesText=g=>g.length?g.map(x=>x.toFixed(2)).join(', '):'no grade';
  const figuresText=l=>l.length?l.map(f=>(f.label!==''?f.label+': ':'')+(f.value!==null?f.value:'')+(f.tolerance?' (within '+f.tolerance+')':'')).join('; '):'';
  /* The latest attempt of the new mode, the one the checks card shows. */
  const lastNew=v=>{const a=v.attempts[v.attempts.length-1];return a&&a.mode==='new'?a:null;};
  /* The checks did not finish: the cap, Stop or an error came before every mandatory check of the design was done. */
  const incompleteHtml=()=>html`<div class="notice pl-incomplete" role="note"><strong>The checks did not finish.</strong> Nothing here counts as a pass: a design passes only after every check of it has finished.</div>`;
  function taskTypeHtml(d){
    const t=d.taskType;
    if(t===null)return '';
    if(isWithheld(t))return html`<p class="pl-task-type pl-withheld">Task type: ${WITHHELD_TEXT}</p>`;
    const refs=isWithheld(t.referenceEntries)?html` Reference entries: ${inline(t.referenceEntries)}`:t.referenceEntries.length?' Reference entries it draws on: '+t.referenceEntries.join('; ')+'.':'';
    return html`<p class="pl-task-type"><strong>Task type:</strong> ${inline(t.workflow)}.${t.why===''&&!isWithheld(t.why)?'':html` <span class="muted">Why: ${inline(t.why)}</span>`}${refs===''?'':html`<span class="muted">${refs}</span>`}</p>`;
  }
  function refsSummaryHtml(v){
    const r=v.references;
    if(!r||r.source==='none'||(r.found===0&&!isWithheld(r.names)))return '';
    const names=isWithheld(r.names)?inline(r.names):r.names.join(', ');
    /* what the leak scan did not cover whole: files that were left out or cut short by its cap, or whose text could not be read, and files it read only in part */
    const un=isWithheld(r.unscanned)?html` Not checked for leaked passages: ${inline(r.unscanned)}`:r.unscanned.length?' Not checked for leaked passages (their text could not be read, or the scan cap left them out): '+r.unscanned.join(', ')+'.':'';
    const part=isWithheld(r.partial)?html` Checked for leaked passages only in part: ${inline(r.partial)}`:r.partial.length?' Checked for leaked passages only in part: '+r.partial.join(', ')+'.':'';
    const cut=r.truncated&&!isWithheld(r.partial)&&!r.partial.length?' Only the first part of their text was checked for leaked passages.':'';
    return html`<p class="pl-refs-summary">Reference documents used: ${plural(r.found,'file')} (${names}). Pilots never see them.${cut}${part}${un}</p>`;
  }
  function briefHtml(){
    const v=S.run;
    if(!v)return '';
    const b=v.design.brief;
    if(b===null)return '';
    const head=html`<div class="card-title"><div><div class="eyebrow">Brief</div><h2>What the traps rest on</h2></div>${v.design.attempt?pill('Attempt '+v.design.attempt,'violet'):''}</div>`;
    if(isWithheld(b))return html`${head}<p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    const set=v.design.answerSet,score=file=>{const x=set&&!isWithheld(set)?set.answers.find(a=>a.file===file):null;return x&&x.score!==null?x:null;};
    const alts=v.design.alternatives;
    const path=x=>html`<strong>${x.action}</strong><small class="pl-brief-why">${x.reasoning}</small>${x.figures.length?html`<small class="pl-brief-figures">${figuresText(x.figures)}</small>`:''}`;
    return html`${head}
      <dl class="history-details pl-brief-decision"><dt>Task type</dt><dd>${isWithheld(b.taskType)?inline(b.taskType):html`${inline(b.taskType.workflow)}${b.taskType.why!==''||isWithheld(b.taskType.why)?html` <span class="muted">${inline(b.taskType.why)}</span>`:''}`}</dd><dt>The decision</dt><dd>${b.decision.ask}</dd><dt>The mandate</dt><dd>${b.decision.mandate}</dd><dt>Governing file</dt><dd>${b.decision.authorityFile}${b.decision.effectiveDate!==''?html` <span class="muted">in force from ${b.decision.effectiveDate}</span>`:''}</dd>${b.decision.decisionDate!==''?html`<dt>Decision date</dt><dd>${b.decision.decisionDate}</dd>`:''}</dl>
      ${b.files.length?html`<p class="muted pl-brief-files">Files and their roles: ${b.files.map(f=>f.name+' ('+(ROLE_WORDS[f.role]||f.role)+')').join(', ')}.</p>`:''}
      <div class="table-wrap"><table class="pl-table pl-brief-table"><caption class="sr-only">The brief of the design, one row for each trap</caption><thead><tr><th scope="col">Trap</th><th scope="col">Rule</th><th scope="col">Correct path</th><th scope="col">Wrong path</th><th scope="col">Why it is tempting</th><th scope="col">Strongest alternative</th></tr></thead><tbody>${b.traps.map(t=>html`<tr><th scope="row">${t.id}${t.primary?html` <span class="pill violet">Primary</span>`:''}<small class="pl-brief-why">The wrong path ${CHANGES_WORDS[t.changesDecision]||t.changesDecision}.</small></th>
        <td data-label="Rule"><strong>${t.rule.file}</strong><small class="pl-brief-why">${t.rule.clause}</small></td>
        <td data-label="Correct path">${path(t.correctPath)}</td>
        <td data-label="Wrong path">${path(t.wrongPath)}</td>
        <td data-label="Why it is tempting"><strong>${WHY_WORDS[t.whyTempting.kind]||t.whyTempting.kind}</strong><small class="pl-brief-why">${t.whyTempting.source}</small><small class="pl-brief-why">What it costs: ${t.consequence}</small></td>
        <td data-label="Strongest alternative"><strong>${t.strongestAlternative.answer}</strong><small class="pl-brief-why">Ruled out by: ${t.strongestAlternative.whyRejected}</small></td></tr>`)}</tbody></table></div>
      ${b.controls.length?html`<h3>Controls</h3><ul class="pl-names">${b.controls.map(c=>html`<li><strong>${SCENARIO_WORDS[c.scenario]||c.scenario}${c.trap!==''?' ('+c.trap+')':''}:</strong> ${c.action}${figuresText(c.figures)!==''?html` <span class="muted">${figuresText(c.figures)}</span>`:''}</li>`)}</ul>`:''}
      <h3>Permitted alternatives</h3>
      ${isWithheld(alts)?html`<p class="pl-withheld">${WITHHELD_TEXT}</p>`:b.permittedAlternatives.length?html`<ul class="pl-names pl-alternatives">${b.permittedAlternatives.map(a=>{const sc=score(a.file);return html`<li><strong>${a.answer}</strong> <span class="muted">Allowed because: ${a.support}</span>${sc?html` <span class="pl-alt-score">Its answer scored ${sc.score.toFixed(2)} against the guideline${sc.threshold!==null?' (it needs '+sc.threshold.toFixed(2)+')':''}${sc.unstable?', and the grades were unstable':''}.</span>`:''}</li>`;})}</ul>`:html`<p class="muted">None.${b.permittedAlternativesReason!==''?' '+b.permittedAlternativesReason:''}</p>`}`;
  }
  const PART_WORDS={rule:'the rule clause',whyRejected:'why the alternative is rejected'};
  /* The lines under a check: the files that could not be read as text, so that no later document that replaces the clause could be looked for in them, and a note when
     more passages were found than are listed. */
  function hitLinesHtml(c){
    const out=[],h=c.hits||{count:0,list:[]},covered=new Set(h.list.filter(x=>x.kind==='unreadable').map(x=>plain(x.document)));
    h.list.forEach(x=>{
      if(x.kind==='unreadable')out.push(html`<li class="pl-hit-unreadable"><strong>${inline(x.document)}</strong>: This file could not be read as text, so it could not be checked for a later document that replaces it.</li>`);
      else if(x.kind==='more')out.push(html`<li class="pl-hit-more">More passages were found than are shown here${x.count!==null?' ('+x.count+' more)':''}.</li>`);
    });
    const left=isWithheld(c.unscanned)?null:c.unscanned.filter(n=>!covered.has(n));
    if(isWithheld(c.unscanned))out.push(html`<li class="pl-hit-unscanned">Files that could not be read as text: ${inline(c.unscanned)}</li>`);
    else if(left.length)out.push(html`<li class="pl-hit-unscanned">These files could not be read as text, so they could not be checked for a later document that replaces the clause: ${left.join(', ')}.</li>`);
    return out.length?html`<ul class="pl-hit-list">${out}</ul>`:'';
  }
  function checkLineHtml(c,label){
    if(c===null)return '';
    if(isWithheld(c))return html`<li>${label}: ${inline(c)}</li>`;
    const dates=c.dates&&!(isWithheld(c.dates.effective)&&isWithheld(c.dates.decision))&&(plain(c.dates.effective)!==''||plain(c.dates.decision)!=='')?html` In force from ${inline(c.dates.effective)}; decision on ${inline(c.dates.decision)}.`:'';
    const hits=c.hits.count>0?' '+plural(c.hits.count,'place')+' in the files '+(c.hits.count===1?'mentions':'mention')+' a change of a document.':'';
    const lines=hitLinesHtml(c);
    return c.pass?html`<li class="pl-check-pass">${label}: passed. The clause governs this decision, is in force, is not superseded and rules the other answer out.${dates}${hits}${lines}</li>`
      :html`<li class="pl-check-fail">${label}: failed. ${c.failed.map(k=>CHECK_WORDS[k]||k).join('; ')}.${dates}${hits}${lines}</li>`;
  }
  /* The checks of the brief's own clauses (the rule of each trap, and the clause that rules out its strongest alternative): how many were made, and for each failure the trap, the part and what failed. */
  function briefCheckHtml(b,label){
    if(b===null)return '';
    if(isWithheld(b))return html`<li>${label}: ${inline(b)}</li>`;
    const made=b.count!==null?' '+plural(b.count,'check')+' made.':'';
    const lines=[];
    b.failures.forEach(f=>lines.push(html`<li class="pl-brief-failure">${f.trap!==null?'Trap '+f.trap:'A trap'}, ${PART_WORDS[f.part]||(f.part!==''?f.part:'a clause')}: ${f.failed.length?f.failed.map(k=>CHECK_WORDS[k]||k).join('; '):'it did not pass'}.</li>`));
    if(isWithheld(b.unscanned))lines.push(html`<li class="pl-hit-unscanned">Files that could not be read as text: ${inline(b.unscanned)}</li>`);
    else if(b.unscanned.length)lines.push(html`<li class="pl-hit-unscanned">These files could not be read as text, so they could not be checked for a later document that replaces a clause: ${b.unscanned.join(', ')}.</li>`);
    const list=lines.length?html`<ul class="pl-hit-list">${lines}</ul>`:'';
    return b.pass?html`<li class="pl-check-pass">${label}: passed.${made}${list}</li>`:html`<li class="pl-check-fail">${label}: failed.${made}${list}</li>`;
  }
  /* Files the reviewers were shown only in part (a long file is cut to what they can read). */
  function cutHtml(s2){
    if(s2===null||isWithheld(s2))return '';
    if(isWithheld(s2.cut))return html`<p class="pl-cut">The reviewers saw these files only in part: ${inline(s2.cut)}</p>`;
    return s2.cut.length?html`<p class="pl-cut">The reviewers saw these files only in part: ${s2.cut.join(', ')}.</p>`:'';
  }
  function reviewHtml(a){
    const r=a.review;
    if(r===null)return '';
    const lead=html`<h3>Fairness: could another answer be better supported?</h3><p class="muted">Decided first, from the files and the reviews alone. A pilot's score never decides it.</p>`;
    if(isWithheld(r))return html`${lead}<p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    const s1=r.stage1,s2=r.stage2;
    const one=isWithheld(s1)?html`<li>Blind review: ${inline(s1)}</li>`:s1===null?html`<li>Blind review: not run.</li>`
      :html`<li>Blind review: ${s1.state==='ok'?'a reader with only the prompt and the files gave an answer':s1.state==='unusable'?'no usable answer':'running'}${s1.tries?' ('+plural(s1.tries,'try','tries')+(s1.discarded?', '+s1.discarded+' discarded':'')+')':''}.</li>`;
    const two=isWithheld(s2)?html`<li>Second review: ${inline(s2)}</li>`:s2===null?html`<li>Second review: not run.</li>`
      :html`<li>Second review: ${DISPOSITION_WORDS[s2.disposition]||s2.disposition||'no decision'}${s2.objectionClass!==''?' (objection: '+(OBJECTION_WORDS[s2.objectionClass]||s2.objectionClass)+')':''}${s2.evaluations>1?'; it ran '+s2.evaluations+' times':''}.</li>`;
    return html`${lead}<p>${pill(REVIEW_WORDS[r.status]||r.status||'No result',REVIEW_KIND[r.status]||'')} ${r.repairs>0?plural(r.repairs,'repair turn')+' used.':'No repair turn used.'}</p>
      <ul class="pl-names pl-review">${one}${two}${isWithheld(s2)||s2===null?'':html`${checkLineHtml(s2.application,'Application check of the clause that rules the other answer out')}${briefCheckHtml(s2.briefApplication,'Application check of the clauses the brief rests on')}`}</ul>${cutHtml(s2)}`;
  }
  function difficultyHtml(a){
    const d=a.difficulty;
    if(d===null)return '';
    const lead=html`<h3>Difficulty: do the pilots fail for the intended reason?</h3><p class="muted">Decided by the pilots. A low score counts only when the harness can explain why the answer is wrong under the supplied files.</p>`;
    if(isWithheld(d))return html`${lead}<p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    const line=(label,x,kind)=>{
      if(x===null)return html`<li>${label}: not run.</li>`;
      if(isWithheld(x))return html`<li>${label}: ${inline(x)}</li>`;
      const lows=isWithheld(x.lows)?html` Counts by class: ${inline(x.lows)}`:x.lows!==null?' Low scores: '+x.lows.lowScorers+'; by diagnosis: '+LOW_WORDS.map(([k,w])=>x.lows[k]+' '+w).join(', ')+'.':'';
      return html`<li>${label}: ${x.passed===true?'passed':x.passed===false?'failed':'not decided'}. ${x.belowBar!==null?x.belowBar+' of '+x.of+' below '+barText(barOf(kind,S.run))+'; ':''}${x.explained!==null?x.explained+' count toward the pass':''}${x.need!==null?' ('+x.need+' needed)':''}.${lows}</li>`;
    };
    return html`${lead}<p>${pill(d.status==='passed'?'Passed':d.status==='failed'?'Failed':'Not decided',d.status==='passed'?'green':d.status==='failed'?'red':'violet')}</p><ul class="pl-names pl-difficulty">${line('Screen',d.screen,'screen')}${line('Test',d.test,'test')}</ul>`;
  }
  function answerSetHtml(a){
    const s=a.answerSet;
    if(s===null)return '';
    const lead=html`<h3>Answer set: can the guideline grade the fixed answers?</h3><p class="muted">The golden answer needs ${(s&&!isWithheld(s)&&s.goldenMin!==null?s.goldenMin:calMin()).toFixed(2)} or more, and each permitted alternative ${(s&&!isWithheld(s)&&s.alternativeMin!==null?s.alternativeMin:(S.rules.alternativeMin!==null?S.rules.alternativeMin:0.85)).toFixed(2)} or more. Each is graded twice, and a third time when the two grades fall on both sides of the line.</p>`;
    if(isWithheld(s))return html`${lead}<p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    if(!s.answers.length)return html`${lead}<p class="muted">No answer has been graded yet.</p>`;
    return html`${lead}<div class="table-wrap"><table class="pl-table pl-answers"><caption class="sr-only">The fixed answers graded against the guideline</caption><thead><tr><th scope="col">Answer</th><th scope="col">Needs</th><th scope="col">Grades</th><th scope="col">Score</th><th scope="col">Result</th></tr></thead><tbody>${s.answers.map(x=>html`<tr><th scope="row">${x.kind==='golden'?'Golden answer':'Permitted alternative'}${x.kind==='golden'?'':html` <small class="pl-answer-name">${inline(x.name)}</small>`}</th><td data-label="Needs">${x.threshold!==null?x.threshold.toFixed(2):''}</td><td data-label="Grades">${gradesText(x.grades)}</td><td data-label="Score">${x.score!==null?scoreFmt(x.score,x.threshold!==null?x.threshold:0.9):'No score'}</td><td data-label="Result">${x.passed===true?html`<span class="pl-yes"><span aria-hidden="true">\u2713</span> Passed</span>`:x.passed===false?html`<span class="pl-no"><span aria-hidden="true">\u2715</span> Failed</span>`:html`<span class="muted">Not graded</span>`}${x.unstable?html`<small class="pl-unstable"><strong>Unstable:</strong> the grades fell on both sides of the line, so a third grade decided. All grades: ${gradesText(x.grades)}.</small>`:''}${x.runs.length>1?html`<small class="pl-runs">${x.runs.map((r,i)=>'Grading '+(i+1)+(r.why!==''?' ('+r.why+')':'')+': '+(r.score!==null?r.score.toFixed(2):'no score')+(r.unstable?' (unstable)':'')).join('; ')}.</small>`:''}</td></tr>`)}</tbody></table></div>`;
  }
  function freezeHtml(a){
    const f=a.freeze;
    if(isWithheld(f))return html`<h3>Freeze records</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    if(!f.length)return '';
    return html`<h3>Freeze records</h3><p class="muted">What was tested, fixed before the pilots ran. The export lists the sha256 of every file it ships, so the packet that was tested can be compared with it.</p>
      <ol class="pl-freeze">${f.map(x=>html`<li><strong>Freeze ${x.n}${isWithheld(x.reason)||x.reason!==''?html` (${inline(x.reason)})`:''}</strong>${x.at!==''?html` <span class="muted">${timeText(x.at)}</span>`:''}
        <small class="pl-freeze-hashes">Packet ${x.packetSha256}${x.packetFiles!==null?' ('+plural(x.packetFiles,'file')+')':''}; prompt ${x.promptSha256}; guideline ${x.guidelineSha256}; golden answer ${x.goldenSha256}; answer set ${x.answerSetSha256}.</small>
        <small class="pl-freeze-run">Pilots: ${x.pilot.model} at ${x.pilot.effort}${x.pilot.capUsd!==null?', '+usd(x.pilot.capUsd)+' each':''}. Grader: ${x.grader.model} at ${x.grader.effort}. Budget: ${x.budget.totalCapUsd!==null?usd(x.budget.totalCapUsd)+' in all':''}${x.budget.designCapUsd!==null?', '+usd(x.budget.designCapUsd)+' for the designer':''}.</small></li>`)}</ol>`;
  }
  function repairHtml(a){
    const r=a.guidelineRepair;
    if(r===null)return '';
    if(isWithheld(r))return html`<h3>Guideline repair</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    const what=r.outcome==='applied'?'applied':r.outcome==='failed'?'not used':'in progress';
    const side=l=>l.map(x=>x.name+' '+gradesText(x.grades)+(x.unstable?' (unstable)':'')).join('; ');
    return html`<h3>Guideline repair</h3><p>The ${r.stage||'stage'} failed on low scores that were the guideline's fault, not the packet's${r.classes.length?' ('+r.classes.map(classLabel).join(', ')+')':''}. The designer repaired the guideline and the golden answer once: ${pill(what,r.outcome==='applied'?'green':r.outcome==='failed'?'amber':'violet')}${r.changed.length?html` Changed: ${r.changed.join(', ')}.`:''}${r.reason!==''?html` ${inline(r.reason)}`:''}</p>
      ${r.regrade?html`<p class="muted pl-regrade">Fixed answers graded again with the revised guideline. Before: ${side(r.regrade.before)||'none'}. After: ${side(r.regrade.after)||'none'}.</p>`:''}
      ${r.recounted?html`<p class="muted pl-recounted">The ${r.stage||'stage'} was counted again: ${r.recounted.passed===true?'passed':r.recounted.passed===false?'failed':'not decided'}${r.recounted.explained!==null?', '+r.recounted.explained+' count toward the pass':''}.</p>`:''}`;
  }
  function diagnosticHtml(a){
    const d=a.diagnostic;
    if(d===null)return '';
    if(isWithheld(d))return html`<h3>Diagnostic answers</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`;
    return html`<h3>Diagnostic answers</h3><p>${pill(d.passed===true?'The guideline told them apart':d.passed===false?'It did not':'Not decided',d.passed===true?'green':d.passed===false?'red':'violet')}</p>${d.results.length?html`<div class="table-wrap"><table class="pl-table pl-diag"><caption class="sr-only">The diagnostic answers and their grades</caption><thead><tr><th scope="col">Answer</th><th scope="col">Should score</th><th scope="col">Score</th><th scope="col">As designed</th></tr></thead><tbody>${d.results.map(x=>html`<tr><th scope="row">${inline(x.name)}</th><td data-label="Should score">${x.band==='high'?'high':x.band==='low'?'low':''}</td><td data-label="Score">${x.score!==null?x.score.toFixed(2):'No score'}</td><td data-label="As designed">${x.ok?'Yes':'No'}</td></tr>`)}</tbody></table></div>`:''}`;
  }
  function checksHtml(){
    const v=S.run;
    if(!v)return '';
    const a=lastNew(v);
    if(!a)return '';
    const shown=a.review!==null||a.answerSet!==null||a.difficulty!==null||a.freeze.length>0||isWithheld(a.freeze)||a.validation!=='';
    if(!shown)return '';
    const VAL={complete:['Checks complete','green'],pending:['Checks in progress','violet'],incomplete:['Checks did not finish','amber'],failed:['Rejected by a check','red']}[a.validation];
    const incomplete=a.validation==='incomplete'||v.validation==='incomplete'||v.verdict==='incomplete';
    return html`<div class="card-title"><div><div class="eyebrow">Checks</div><h2>Fairness and difficulty</h2></div>${VAL?pill(VAL[0],VAL[1]):''}</div>
      <p class="muted">Two separate results for attempt ${a.n}. A design must be fair and hard, and each is decided its own way.</p>
      ${incomplete?incompleteHtml():''}
      ${reviewHtml(a)}${difficultyHtml(a)}${answerSetHtml(a)}${repairHtml(a)}${diagnosticHtml(a)}${freezeHtml(a)}`;
  }
  function designHtml(){
    const v=S.run;
    if(!v)return '';
    const d=v.design;
    if(!d.traps.length&&!d.trapsWithheld&&!d.newFiles.length&&!d.edited.length&&d.calibration===null&&d.fairness===null&&!isWithheld(d.unscanned)&&!d.unscanned.length&&d.taskType===null&&!(v.references&&v.references.source!=='none'))return '';
    const repaired=d.repaired===true?html`<p class="muted pl-repaired">The designer needed one repair turn to fix its files.</p>`:isWithheld(d.repaired)?html`<p class="muted pl-repaired">Whether a repair turn was needed: ${inline(d.repaired)}</p>`:'';
    return html`<div class="card-title"><div><div class="eyebrow">Design</div><h2>The traps</h2></div>${d.attempt?pill('Attempt '+d.attempt,'violet'):v.redesigns>0?pill('Attempt '+(v.redesigns+1),'violet'):''}</div>
      ${taskTypeHtml(d)}
      ${refsSummaryHtml(v)}
      ${d.trapsWithheld?html`<p class="pl-withheld">${WITHHELD_TEXT}</p>`:d.traps.length?html`<ol class="pl-traps">${d.traps.map(trapHtml)}</ol>`:html`<p class="muted">No trap has been recorded yet.</p>`}
      ${newFilesHtml(d)}
      ${editedHtml(d)}
      ${calibrationHtml(d)}
      ${fairnessHtml(d)}
      ${repaired}
      ${unscannedHtml(d)}
      ${isWithheld(d.notes)?html`<h3>Checks on the designer’s files</h3><p class="pl-withheld">${WITHHELD_TEXT}</p>`:d.notes.length?html`<h3>Checks on the designer’s files</h3><ul class="pl-names">${d.notes.map(n=>html`<li>${n}</li>`)}</ul>`:''}
      ${guidelineChangesHtml(d)}
      <details><summary>Revised prompt, grader guideline and golden answer</summary><h3>Prompt</h3>${blockText(d.prompt)}<h3>Grader guideline</h3>${blockText(d.guideline)}<h3>Golden answer</h3>${blockText(d.golden)}</details>
      ${goldHtml(d)}`;
  }
  /* A pilot stopped because the round no longer needed it, and has no score: not a failure. (An early stop that is withheld says nothing about this pilot.) */
  const notNeeded=p=>p.score===null&&p.stoppedEarly!==null&&!isWithheld(p.stoppedEarly);
  function auditPill(p){
    if(notNeeded(p)&&p.audit!=='CLEAN'&&p.audit!=='DISCARDED')return pill('Not needed');
    if(p.audit==='CLEAN')return pill('CLEAN','green');
    if(p.audit==='DISCARDED')return pill('DISCARDED','red');
    return ['failed','cancelled'].includes(p.state)?pill('Not audited','amber'):pill('Pending');
  }
  /* What a pilot wrote besides its answer: how many files, and how many the grader could read. */
  function outputsNote(p){
    const o=p.outputs;
    if(isWithheld(o))return html`<small class="pl-outputs">${inline(o)}</small>`;
    return o&&o.count>0?html`<small class="pl-outputs">${plural(o.count,'file')}, ${o.readable===0?'none':o.readable} read</small>`:'';
  }
  function scoreCell(p,decided,cut,bar){
    let main;
    if(notNeeded(p)){
      const why=p.stoppedEarly.reason;
      return html`Stopped: not needed${why!==''&&why!==undefined?html`<small class="pl-stopped-reason">${inline(why)}</small>`:''}`;
    }
    if(p.score===null){
      main=p.audit==='DISCARDED'?'No score (discarded)':['failed','cancelled'].includes(p.state)?'No score ('+p.state+')':cut?'No score (the run ended)':decided?'No usable score':p.state==='completed'?'Waiting for the grader':p.state==='queued'?'Queued':'Running';
    }else main=scoreFmt(p.score,bar);
    const early=isWithheld(p.stoppedEarly)?html`<small class="pl-stopped-reason">Early stop: ${inline(p.stoppedEarly)}</small>`:'';
    /* a saved answer graded again after the guideline repair: what it scored before */
    const again=p.regraded&&isWithheld(p.previous)?html`<small class="pl-regraded">Graded again after the guideline repair: ${inline(p.previous)}</small>`:p.regraded&&p.previous&&p.previous.score!==null?html`<small class="pl-regraded">Graded again after the guideline repair (it was ${scoreFmt(p.previous.score,bar)})</small>`:'';
    if(isWithheld(p.regrade))return html`${main}<small class="pl-regraded">Graded twice: ${inline(p.regrade)}</small>${early}${again}`;
    return p.regrade?html`${main}<small class="pl-regraded">Graded twice: ${scoreFmt(p.regrade.first,bar)}, ${scoreFmt(p.regrade.second,bar)}</small>${early}${again}`:html`${main}${early}${again}`;
  }
  function belowHtml(p,decided,cut,bar){
    if(notNeeded(p))return html`<span class="muted">Not needed</span>`;
    if(p.score===null&&cut)return html`<span class="muted">Not counted</span>`;
    if(p.score!==null)return p.score<bar?html`<span class="pl-yes"><span aria-hidden="true">✓</span> Yes</span>`:html`<span class="pl-no"><span aria-hidden="true">✕</span> No</span>`;
    if(decided)return html`<span class="pl-no"><span aria-hidden="true">✕</span> No, a pilot without a score counts against the design</span>`;
    return endedWithoutScore(p)?html`<span class="muted">Replacement pending</span>`:html`<span class="muted">Pending</span>`;
  }
  /* The band of scores that is graded a second time in a stage: its own (screenRegradeBand, testRegradeBand), else the one regradeBand the companion reports. */
  const regradeBandOf=kind=>S.rules[kind+'RegradeBand']||S.rules.regradeBand;
  /* ---- the new mode: which low scores count toward a pass, and why ---- */
  const CLASS_LABEL={intended:'the intended error',other_valid_error:'another valid error',permitted_alternative:'a permitted alternative (the answer is acceptable)',grader_defect:'a grader defect',ambiguous:'ambiguous',tool_failure:'a tool failure',unsupported:'not supported by the files'};
  const classLabel=c=>CLASS_LABEL[c]||(c!==''?c:'not diagnosed');
  const pilotName=id=>{const m=/^p(\d+)$/.exec(String(id||''));return m?'Pilot '+m[1]:(String(id||'')||'A pilot');};
  /* The column "Counts toward the pass" of a stage table in the new mode: the diagnosis of a pilot, and whether it counts. A low score that does not count is marked with its class. */
  function countsCell(p,bar){
    if(notNeeded(p))return html`<span class="muted">Not needed</span>`;
    if(p.toolFailure)return html`<span class="muted">Tool failure: another pilot replaces it</span>`;
    const adj=p.adjudication,note=adj&&!isWithheld(adj)&&adj.note!==''&&!isWithheld(adj.note)?html`<small class="pl-diagnosis-note">${adj.note}</small>`:'';
    const cls=isWithheld(adj)?html`<small class="pl-diagnosis">${inline(adj)}</small>`:adj?html`<small class="pl-diagnosis">Diagnosis: ${classLabel(adj.class)}</small>${note}`:'';
    if(p.score===null)return html`<span class="muted">Waiting for a score</span>`;
    if(p.score>=bar)return html`<span class="muted">Does not count: the score is not below ${barText(bar)}</span>`;
    if(p.countsTowardPass===true)return html`<span class="pl-counts"><span aria-hidden="true">\u2713</span> Counts</span>${cls}`;
    if(p.countsTowardPass===false)return html`<span class="pl-nocount"><span aria-hidden="true">!</span> Low score that does not count</span>${cls||html`<small class="pl-diagnosis">Diagnosis: not diagnosed</small>`}`;
    return html`<span class="muted">Waiting for the diagnosis</span>${cls}`;
  }
  const LOW_WORDS=[['intended','intended'],['otherValid','another valid error'],['permittedAlternative','permitted alternative'],['graderDefect','grader defect'],['ambiguous','ambiguous'],['toolFailure','tool failure'],['unsupported','not supported']];
  /* The counts by class of a stage, the low scores that do not count, a recount, and a warning when a pass rests on a repair. */
  function lowsHtml(res,kind,rep){
    const out=[];
    const L=res.lows;
    if(isWithheld(L))out.push(html`<p class="pl-withheld pl-lows">Counts by class: ${WITHHELD_TEXT}</p>`);
    else if(L!==null)out.push(html`<p class="pl-lows">Low scores: ${L.lowScorers}. By diagnosis: ${LOW_WORDS.map(([k,w])=>L[k]+' '+w).join(', ')}. Counted toward the pass: ${L.counted}.</p>`);
    const U=res.unexplained;
    if(isWithheld(U))out.push(html`<p class="pl-withheld pl-unexplained-line">Low scores that do not count: ${WITHHELD_TEXT}</p>`);
    else if(U!==null&&U.length)out.push(html`<div class="notice pl-unexplained" role="note"><strong>${plural(U.length,'low score')} did not count toward the pass</strong><p class="pl-warning-lead">A low score counts only when the harness can show why the answer is wrong under the supplied files.</p><ul class="pl-names">${U.map(x=>html`<li>${pilotName(x.pilot)}${x.score!==null?' scored '+scoreFmt(x.score,barOf(kind,S.run)):''}: ${classLabel(x.class)}</li>`)}</ul></div>`);
    const R=res.recount;
    if(isWithheld(R))out.push(html`<p class="pl-withheld pl-recount">Counted again: ${WITHHELD_TEXT}</p>`);
    else if(R!==null)out.push(html`<p class="pl-recount">Counted again after the guideline repair, with the saved answers graded again${R.changes.length?': '+R.changes.map(x=>pilotName(x.pilot)+' '+(x.from!==null?scoreFmt(x.from,barOf(kind,S.run)):'no score')+' to '+(x.to!==null?scoreFmt(x.to,barOf(kind,S.run)):'no score')).join(', '):''}.</p>`);
    const repaired=rep&&!isWithheld(rep)&&rep.outcome==='applied'&&rep.stage===kind;
    if(res.passed===true&&((R!==null&&!isWithheld(R))||repaired))out.push(html`<div class="notice pl-leaned" role="note"><strong>This pass rests on a repair.</strong> The guideline was repaired and the saved answers were graded again before the ${kind} was counted again.</div>`);
    return out.length?html`${out}`:'';
  }
  /* A round that was stopped as soon as its result was decided: after which pilot, with what score, and what that meant. */
  function earlyStopHtml(res,kind,bar){
    const e=res.stoppedEarly;
    if(e===null)return '';
    if(isWithheld(e))return html`<p class="pl-early-stop">Early stop: ${inline(e)}</p>`;
    const who=e.afterPilot!==null?'pilot '+e.afterPilot:'a pilot';
    const score=e.score===null?'':isWithheld(e.score)?html` scored ${inline(e.score)}`:' scored '+scoreFmt(e.score,bar);
    const why=res.passed===false?': the '+kind+' cannot pass':res.passed===true&&kind==='test'?': '+RULES.testNeed+' pilots are below '+barText(bar)+', so the test has passed':'';
    return html`<p class="pl-early-stop">Stopped after ${who}${score}${why}.</p>`;
  }
  function stageHtml(kind){
    const v=S.run;
    if(!v)return '';
    const res=v[kind],isTest=kind==='test',title=isTest?RULES.testPilots+'-pilot test':RULES.screenPilots+'-pilot screen',label=isTest?'Test':'Screen';
    const bar=barOf(kind,v),barS=barText(bar),isNew=v.designMode==='new';
    const rule=isTest?'The test succeeds when at least '+RULES.testNeed+' of '+RULES.testPilots+' pilots score below '+barS+'. It runs only when the screen has passed, and it stops as soon as '+(RULES.testPilots-RULES.testNeed+1)+' pilots score '+barS+' or more (it cannot pass) or '+RULES.testNeed+' are below (it has passed).':'The screen passes when both pilots score below '+barS+'. If the first pilot to finish scores '+barS+' or more, the other is stopped and the designer starts again.';
    const active=STAGES[v.stage]&&STAGES[v.stage][0]===(isTest?4:3)&&!v.ended;
    /* a run that ended in this step before its round started has no result to show: say that it did not start, and why */
    const here=v.ended&&v.stage!=='done'&&stepOf(v)===(isTest?4:3);
    if(!res&&!active&&!here)return '';
    if(!res&&!active)return html`<div class="card-title"><div><div class="eyebrow">${label}</div><h2>${title}</h2></div>${pill('Not started','amber')}</div><p class="muted">${rule}</p><p class="pl-not-started">${v.stage==='budget'?'The '+kind+' was not started: the next call would have passed the total cap'+(v.capUsd?' of '+usd(v.capUsd):'')+', and '+usd(v.spentUsd)+' was spent.':v.stage==='stopped'?'The run was stopped before the '+kind+' started.':'The run ended before the '+kind+' started.'}</p>`;
    if(!res)return html`<div class="card-title"><div><div class="eyebrow">${label}</div><h2>${title}</h2></div>${pill('In progress','violet')}</div><p class="muted">${rule}</p><p>The pilots are starting.</p>`;
    const sv=stageVerdict(res,kind),cut=v.ended&&res.passed===null,status=cut?'stopped':sv.status;
    return html`<div class="card-title"><div><div class="eyebrow">${label}</div><h2>${title}</h2></div>${pill(label+' '+STATUS_LABEL[status],STATUS_KIND[status])}</div>
      <p class="muted">${rule}${isNew?' A low score counts toward the pass only when the harness can explain why the answer is wrong under the supplied files.':''} Scores come from the simulated grader, run against the revised grader guideline.</p>
      ${res.pilots.length?html`<div class="table-wrap"><table class="pl-table"><caption class="sr-only">${title}: score of each pilot against the bar of ${barS}</caption><thead><tr><th scope="col">Pilot</th><th scope="col">Score</th><th scope="col">Below ${barS}</th>${isNew?html`<th scope="col">Counts toward the pass</th>`:''}<th scope="col">Audit</th></tr></thead><tbody>${res.pilots.map(p=>html`<tr><th scope="row">Pilot ${p.n}${p.replacement?' (replacement)':''}${outputsNote(p)}</th><td data-label="Score">${scoreCell(p,res.passed!==null,cut,bar)}</td><td data-label="Below ${barS}">${belowHtml(p,res.passed!==null,cut,bar)}</td>${isNew?html`<td data-label="Counts toward the pass">${countsCell(p,bar)}</td>`:''}<td data-label="Audit">${auditPill(p)}</td></tr>`)}</tbody></table></div>
        <p class="pl-tally">${sv.below} of ${sv.of} below ${barS}${isNew?'; '+(res.explained!==null?res.explained:res.pilots.filter(q=>q.countsTowardPass===true).length)+' count toward the pass':''}${isTest?'; '+sv.need+' needed':'; both needed'}.</p>
        ${earlyStopHtml(res,kind,bar)}
        ${isNew?lowsHtml(res,kind,v.attempts.length?v.attempts[v.attempts.length-1].guidelineRepair:null):''}
        ${res.replacementRound?html`<p class="muted pl-stage-note">A replacement round ran for the pilots without a usable score.</p>`:''}${res.replacementSkipped?html`<p class="muted pl-stage-note">No replacement round was run because it could not change the result.</p>`:''}
        ${regradeBandOf(kind)&&res.pilots.some(p=>p.regrade!==null)?html`<p class="muted pl-stage-note">A score from ${regradeBandOf(kind)[0].toFixed(2)} to ${regradeBandOf(kind)[1].toFixed(2)} is graded a second time and the two scores are averaged.</p>`:''}${cut?html`<p class="muted pl-stage-note">The ${kind} ended before it was decided, so it has no result.</p>`:''}`:cut?html`<p class="pl-not-started">The ${kind} ended before any pilot finished, so it has no result.</p>`:html`<p>The pilots are starting.</p>`}`;
  }
  /* Every outcome service.cjs records; one it does not know is shown as sent. */
  const OUTCOMES={'in-progress':'In progress',passed:'Passed','screen-failed':'Screen failed','test-failed':'Test failed',rejected:'Rejected before any pilot',stopped:'Stopped',budget:'Stopped at the cap',failed:'Failed'};
  const REJECTION_KIND={design:'The designer\u2019s files did not pass the design checks.',checks:'The design did not pass the calibration or the fairness check.',review:'The reviews found an answer the files support better, or could not settle which answer they support.','answer-set':'The guideline did not grade the fixed answers (the golden answer or a permitted alternative) as required.',diagnostic:'The guideline did not grade the diagnostic answers as the design says.'};
  function outcomeCell(a){
    const rej=a.rejection;
    return html`${OUTCOMES[a.outcome]||a.outcome||'Not recorded'}${isWithheld(rej)?html`<small class="pl-rejection">${inline(rej)}</small>`:rej?html`<small class="pl-rejection">${REJECTION_KIND[rej.kind]||''}</small>${rej.reasons.length?html`<ul class="pl-cell-list">${rej.reasons.map(r=>html`<li>${inline(r)}</li>`)}</ul>`:''}`:''}${a.note!==''?html`<small class="pl-rejection">${inline(a.note)}</small>`:''}`;
  }
  /* What an attempt's design checks found: the calibration, the fairness review, and whether a repair turn was used. */
  function checksCell(a){
    const parts=[],min=calMin(),c=a.calibration,f=a.fairness;
    if(c!==null)parts.push(isWithheld(c)?html`Calibration: ${inline(c)}`:isWithheld(c.score)?html`Calibration: ${inline(c.score)}`:c.score===null?'Calibration: no usable score':'Calibration: '+scoreFmt(c.score,min)+(c.score>=min?', passed':', failed'));
    if(f!==null)parts.push(isWithheld(f)?html`Fairness review: ${inline(f)}`:f.status==='unusable'?'Fairness review: no usable answer':f.status==='ok'&&!f.count?'Fairness review: no unfair item':'Fairness review: '+plural(f.count,'unfair item'));
    if(a.review!==null)parts.push(isWithheld(a.review)?html`Fairness: ${inline(a.review)}`:'Fairness: '+(REVIEW_WORDS[a.review.status]||a.review.status||'no result').toLowerCase()+(a.review.stage2&&!isWithheld(a.review.stage2)&&a.review.stage2.disposition!==''?' ('+(DISPOSITION_WORDS[a.review.stage2.disposition]||a.review.stage2.disposition)+')':''));
    if(a.answerSet!==null)parts.push(isWithheld(a.answerSet)?html`Answer set: ${inline(a.answerSet)}`:'Answer set: '+(a.answerSet.passed===true?'graded as required':a.answerSet.passed===false?'not graded as required':'not decided')+(a.answerSet.answers.some(x=>x.unstable)?', with an unstable grade':''));
    if(a.guidelineRepair!==null&&!isWithheld(a.guidelineRepair))parts.push('Guideline repair: '+(a.guidelineRepair.outcome==='applied'?'applied':a.guidelineRepair.outcome==='failed'?'not used':'in progress'));
    if(a.validation==='incomplete')parts.push('The checks did not finish');
    if(a.repaired===true)parts.push('A repair turn was used');
    else if(isWithheld(a.repaired))parts.push(html`Repair turn: ${inline(a.repaired)}`);
    return parts.length?html`<ul class="pl-cell-list">${parts.map(x=>html`<li>${x}</li>`)}</ul>`:'Not recorded';
  }
  function redesignsHtml(){
    const v=S.run;
    if(!v||(v.attempts.length<2&&!v.redesigns))return '';
    const sum=(res,kind)=>{if(!res||(!res.pilots.length&&res.passed===null))return 'Not run';const sv=stageVerdict(res,kind);return (sv.status==='passed'?'Passed':sv.status==='failed'?'Failed':v.ended?'Stopped':'In progress')+(res.pilots.length?' ('+scoresText(res)+')':'');};
    return html`<div class="card-title"><div><div class="eyebrow">Redesigns</div><h2>Redesign attempts</h2></div>${pill(v.redesigns+' of '+RULES.maxRedesigns+' used',v.redesigns>=RULES.maxRedesigns?'amber':'violet')}</div>
      <p class="muted">When a screen or a test does not pass, or the design fails a check before any pilot runs, the designer is told what was wrong, strengthens or swaps traps, and tries again. At most ${RULES.maxRedesigns} redesigns.</p>
      ${v.attempts.length?html`<div class="table-wrap"><table class="pl-table"><caption class="sr-only">Every design attempt with its screen and test results</caption><thead><tr><th scope="col">Attempt</th><th scope="col">Traps</th><th scope="col">Screen</th><th scope="col">Test</th><th scope="col">Outcome</th><th scope="col">Design checks</th></tr></thead><tbody>${v.attempts.map(a=>html`<tr><th scope="row">Attempt ${a.n}${a.current?' (latest)':''}</th><td data-label="Traps">${a.traps.length?a.traps.map(plain).join(', '):'Not recorded'}</td><td data-label="Screen">${sum(a.screen,'screen')}</td><td data-label="Test">${sum(a.test,'test')}</td><td data-label="Outcome">${outcomeCell(a)}</td><td data-label="Design checks">${checksCell(a)}</td></tr>`)}</tbody></table></div>`:''}`;
  }
  /* The companion writes the result sentence itself (how many pilots scored below the bar, which stage failed, what the cap stopped); this page's own words are the fallback. */
  function verdictHtml(){
    const v=S.run;
    if(!v||!v.ended)return '';
    const below=v.test?stageVerdict(v.test,'test').below:null;
    let data={
      done:['The test passed','Passed','green',below!==null?below+' of '+RULES.testPilots+' test pilots scored below '+barText(barOf('test',v))+(v.designMode==='new'&&v.test&&v.test.explained!==null?' and '+v.test.explained+' of them counted toward the pass':'')+'. The new files, the revised task text and the score table are ready to export.':'The '+RULES.testPilots+'-pilot test passed. The new files, the revised task text and the score table are ready to export.'],
      failed:['No passing design','Failed','red','The screen or the test did not pass within '+RULES.maxRedesigns+' redesigns, or the run could not continue.'],
      stopped:['Stopped by you','Stopped','amber','You pressed Stop. What was spent so far is shown above.'],
      budget:['Stopped at the cap','Cap reached','amber','The worst case of the next step would have passed the total cap'+(v.capUsd?' of '+usd(v.capUsd):'')+', so it was not started.']
    }[v.stage];
    /* Designer v2: the cap, Stop or an error came before every check of the design had finished, so nothing counts as a pass. */
    const incomplete=v.verdict==='incomplete'||v.validation==='incomplete';
    if(v.stage==='budget'&&v.verdict==='incomplete')data=['The checks did not finish','Incomplete','amber','The total cap was reached before the checks of the design had finished.'];
    const lastA=v.attempts.length?v.attempts[v.attempts.length-1]:null,rep=lastA&&lastA.guidelineRepair&&!isWithheld(lastA.guidelineRepair)?lastA.guidelineRepair:null;
    const leaned=v.stage==='done'&&rep&&rep.outcome==='applied'?html`<div class="notice pl-leaned" role="note"><strong>This pass rests on a repair.</strong> The guideline and the golden answer were repaired, and the saved answers were graded again, before the ${rep.stage||'stage'} was counted again.</div>`:'';
    /* The companion names its start option in its message (acceptMissing); the page says it with the words of the box. */
    const friendly=t=>String(t).replace(/with acceptMissing/g,'with the box \u201CStart even if a world or task file has to be withheld\u201D ticked').replace(/\bacceptMissing\b/g,'the \u201CStart even if a world or task file has to be withheld\u201D box');
    const needsAccept=v.stage==='failed'&&/acceptMissing/.test(v.summary+' '+v.error);
    /* The step the cap stopped in, what was spent, and what to do: the companion's sentence says what the next call would have cost. */
    const capNote=v.stage==='budget'?html`<p class="pl-budget-note">Stopped in the ${STEPS[stepOf(v)][1]} step${v.capUsd?' with '+usd(v.spentUsd)+' of '+usd(v.capUsd)+' spent':''}. To go further, start a new pipeline with a higher total cap.</p>`:'';
    return html`<div class="card-title"><div><div class="eyebrow">Result</div><h2>${data[0]}</h2></div>${pill(data[1],data[2])}</div>
      <p>${friendly(v.summary||data[3])}</p>${capNote}${incomplete?incompleteHtml():''}${leaned}${v.error&&v.error!==v.summary?html`<p class="pl-error">Reason: ${friendly(v.error)}</p>`:''}
      ${needsAccept?html`<div class="notice pl-accept-note" role="note"><strong>Some files would be withheld from the pilots.</strong> To go on without them, tick \u201C${ACCEPT_LABEL}\u201D in the start form, then start again. <button type="button" class="small" data-pl="accept-form" data-pl-key="accept-form">Open the start form</button></div>`:''}
      <p class="muted">Spent ${usd(v.spentUsd)}${v.capUsd?' of '+usd(v.capUsd):''}. Redesigns used: ${v.redesigns} of ${RULES.maxRedesigns}.</p>`;
  }

  /* ---------- Regions ---------- */
  const REGIONS={'start-form':startFormHtml,'start-foot':startFootHtml,picker:pickerHtml,spend:spendHtml,actions:actionsHtml,wait:waitHtml,withheld:withheldNoteHtml,timeline:timelineHtml,import:importHtml,classify:classHtml,design:designHtml,brief:briefHtml,checks:checksHtml,screen:()=>stageHtml('screen'),test:()=>stageHtml('test'),redesigns:redesignsHtml,verdict:verdictHtml};
  function paint(name){
    if(S.phase!=='ready'||!REGIONS[name])return;
    const el=$('#pl-'+name);
    if(!el)return;
    try{setHtml(el,REGIONS[name]());}
    catch(error){el.innerHTML='<p class="pl-error" role="alert">This part of the page could not be drawn: '+esc(messageOf(error))+'</p>';el.plHtml=null;}
  }
  function paintRun(){['picker','spend','actions','wait','withheld','timeline','import','classify','design','brief','checks','screen','test','redesigns','verdict'].forEach(paint);paintStage();}
  function paintStart(){paint('start-form');paint('start-foot');}
  function paintAll(){paintStart();paintRun();paintMsg();}
  function offlineHtml(){
    return html`<section class="card pl-offline" role="status"><p>${OFFLINE_MESSAGE}</p>${S.offlineNote?html`<p class="muted">${S.offlineNote}</p>`:''}</section>`;
  }
  function pageInner(){
    if(S.phase==='offline')return offlineHtml();
    if(S.phase!=='ready')return html`<section class="card" aria-busy="true" role="status"><p>Checking for the local companion.</p></section>`;
    return html`<div class="dash-heading"><div><div class="eyebrow">Pipeline</div><h1>From a task link to a tested set of traps.</h1><p>Paste a task link. The Studio captures every file, a model builds the hardest traps in a working copy, two blind pilots screen them and five pilots test them. It all runs through the companion on this computer, after one approval and under one spending cap.</p></div></div>
      <p id="pl-msg" class="pl-msg" role="status" aria-live="polite" aria-atomic="true"></p>
      <section id="pl-start" class="card pl-start" aria-label="Start a pipeline"><div id="pl-start-form"></div><div id="pl-start-foot"></div></section>
      <div id="pl-picker"></div>
      <div id="pl-bar" class="pl-bar is-empty"><p id="pl-stage" class="pl-stage" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p><div id="pl-spend" class="pl-spend"></div><div id="pl-actions" class="pl-actions"></div></div>
      <section id="pl-wait" class="card pl-wait" role="status" aria-live="polite" aria-label="Waiting for you"></section>
      <div id="pl-withheld"></div>
      <section id="pl-timeline" class="card pl-timeline" aria-label="Stages"></section>
      <section id="pl-import" class="card" aria-label="Import"></section>
      <section id="pl-classify" class="card" aria-label="Classification"></section>
      <section id="pl-design" class="card" aria-label="Traps"></section>
      <section id="pl-brief" class="card" aria-label="Brief"></section>
      <section id="pl-checks" class="card" aria-label="Fairness and difficulty"></section>
      <section id="pl-screen" class="card" aria-label="Screen"></section>
      <section id="pl-test" class="card" aria-label="Test"></section>
      <section id="pl-redesigns" class="card" aria-label="Redesigns"></section>
      <section id="pl-verdict" class="card pl-verdict" aria-label="Result"></section>`;
  }
  function paintRoot(){setHtml($('#pl-root'),pageInner(),true);}

  /* ---------- Loading ---------- */
  function remember(v){
    if(!v)return;
    const at=S.list.findIndex(x=>x.id===v.id);
    if(at>=0)S.list[at]=v;else S.list.unshift(v);
  }
  async function refreshRun(id){
    const v=adapt(await get(pipePath(id)),id);
    if(!v)throw new Error('The companion returned no usable pipeline.');
    v.id=id;
    remember(v);
    if(S.id===id)S.run=v;
    return v;
  }
  async function loadList(){
    const answer=await get('/api/pipeline');
    const list=adaptList(answer);
    if(isObj(answer)&&isObj(answer.config)){
      S.rules=adaptConfig(answer.config);
      defaultCap=S.rules.defaultCapUsd!==null?S.rules.defaultCapUsd:RULES.defaultCapUsd;
      if(!S.form.capTouched)S.form.cap=String(defaultCap);   /* the form follows the companion's default until a cap has been typed */
      defaultMode=S.rules.defaultDesignMode||'new';
      if(!S.form.modeTouched)S.form.designMode=defaultMode;
    }
    list.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    if(S.run&&!list.some(v=>v.id===S.run.id))list.unshift(S.run);
    S.list=S.run?list.map(v=>v.id===S.run.id?S.run:v):list;
  }
  async function selectRun(id){
    if(!ID_RE.test(id||'')||id===S.id)return;
    S.id=id;S.run=S.list.find(v=>v.id===id)||null;
    paintAll();
    try{await refreshRun(id);}catch(error){say(messageOf(error),true);}
    paintAll();schedulePoll();
  }

  /* ---------- Polling every 2 s while the pipeline is running ---------- */
  const pollWanted=()=>S.mounted&&S.phase==='ready'&&(isActive()||(!!S.id&&!S.run)||!!(S.run&&S.run.redacted));
  function schedulePoll(){
    clearTimeout(S.timer);
    S.timer=null;
    if(pollWanted())S.timer=setTimeout(pollOnce,POLL_MS);
  }
  async function pollOnce(){
    S.timer=null;
    if(!S.mounted||S.phase!=='ready')return;
    if(document.hidden||S.working){schedulePoll();return;}
    const before=S.run?S.run.stage:'';
    try{
      if(S.id)await refreshRun(S.id);
      await loadList();
      if(S.msg.source==='poll'||(S.run&&S.run.stage!==before&&!S.msg.error))say('');
      paintStart();paintRun();
    }catch(error){say(messageOf(error),true,'poll');}
    finally{schedulePoll();}
  }

  /* ---------- Actions ---------- */
  const activeKey=()=>{const el=document.activeElement;return el&&typeof el.getAttribute==='function'?el.getAttribute('data-pl-key'):null;};
  async function work(name,fn){
    if(S.working)return;
    const keep=activeKey();
    S.working=name;
    paint('start-foot');paint('actions');paint('wait');
    try{await fn();}
    catch(error){say(messageOf(error),true);}
    finally{
      S.working='';paintStart();paintRun();schedulePoll();
      if(keep&&(!document.activeElement||document.activeElement===document.body))focusKey(keep);
    }
  }
  /* What only the new mode sends; the harden mode sends none of it (the companion answers 400 if it did). */
  function newModeBody(){
    const f=S.form;
    if(f.designMode!=='new')return {};
    const keep=keepNames();
    return {...(keep.length?{keepAsWorld:keep}:{}),...(f.fairnessSet?{fairnessSet:true}:{}),...(refProblems()&&f.noReferences?{referencesDir:false}:{})};
  }
  async function startPipeline(){
    const why=startWhy();
    if(why){say(why,true);return;}
    const f=S.form,body={...(f.source==='url'?{url:f.url.trim()}:{sourceDir:f.dir.trim()}),capUsd:capValue(),model:f.model,effort:f.effort,pilotCapUsd:pilotCapValue(),acceptMissing:f.acceptMissing===true,acknowledgements:ACKNOWLEDGEMENTS.map(a=>a.id),designMode:f.designMode,...newModeBody()};
    let started='';
    await work('start',async()=>{
      let answer;
      try{answer=await post('/api/pipeline/start',body);}
      catch(error){await loadList().catch(()=>{});throw error;}   /* a refusal usually means another pipeline runs: learn which */
      const id=adaptStart(answer);
      if(!ID_RE.test(id))throw new Error('The companion did not return a pipeline id.');
      /* The link, the acknowledgements and the withheld-files choice are spent: none stays in the page. */
      f.url='';f.dir='';f.acks={};f.acceptMissing=false;f.keepAsWorld='';f.fairnessSet=false;f.noReferences=false;
      S.formOpen=false;S.id=id;S.run=null;started=id;
      say('Started. The pipeline runs on the companion and this page follows it.');
      await refreshRun(id);
      await loadList();
    });
    if(started){paintAll();focusEl('#pl-stage');}
  }
  async function stopPipeline(){
    const v=S.run;
    if(!v||v.ended)return;
    await work('stop',async()=>{
      await post(pipePath(v.id,'/stop'),{});
      say('Stop requested. The run ends after the call that is in progress.');
      await refreshRun(v.id);
    });
  }
  async function continuePipeline(){
    const v=S.run;
    if(!v||!v.waiting)return;
    await work('continue',async()=>{
      await post(pipePath(v.id,'/continue'),{});
      say('Continuing.');
      await refreshRun(v.id);
    });
  }
  function saveBytes(name,bytes){
    if(typeof S.ctx.download==='function'){S.ctx.download(name,bytes,'application/zip');return;}
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'})),a=document.createElement('a');
    a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function exportPipeline(){
    const v=S.run;
    if(!v||!canExport(v))return;
    await work('export',async()=>{
      const out=adaptExport(await post(pipePath(v.id,'/export'),{}),v.id);
      if(!out.base64||!/^[A-Za-z0-9+/]+={0,2}$/.test(out.base64))throw new Error('The companion did not return a file.');
      const bin=atob(out.base64),bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
      saveBytes(out.name,bytes);
      say('Downloaded '+out.name+'. It holds private task material and the revised answers, so keep it private.');
    });
  }
  function focusEl(selector){try{const el=$(selector);if(el&&typeof el.focus==='function')el.focus({preventScroll:false});}catch{/* focus is a courtesy */}}
  function openForm(){
    if(isActive())return;
    S.formOpen=true;
    paintStart();
    focusKey(S.form.source==='url'?'url':'dir');
  }
  function closeForm(){
    S.formOpen=false;
    paintStart();
    focusKey('new');
  }

  /* ---------- Events (delegated on the document; only this page's own elements count) ---------- */
  const CLICK={start:startPipeline,stop:stopPipeline,continue:continuePipeline,export:exportPipeline,new:openForm,'cancel-new':closeForm,'accept-form':()=>{openForm();focusKey('accept-missing');}};
  const INPUT={
    source(el){
      if(el.value!=='url'&&el.value!=='dir')return;
      S.form.source=el.value;
      paintStart();
      focusKey(el.value==='url'?'source-url':'source-dir');
    },
    url(el){S.form.url=String(el.value==null?'':el.value).slice(0,2048);paint('start-foot');},
    dir(el){S.form.dir=String(el.value==null?'':el.value).slice(0,1024);paint('start-foot');},
    cap(el){S.form.cap=String(el.value==null?'':el.value).trim().slice(0,6);S.form.capTouched=true;paint('start-foot');paintCapMin();},
    pilotCap(el){S.form.pilotCap=String(el.value==null?'':el.value).trim().slice(0,6);paint('start-foot');paintCapMin();},
    model(el){if(S.status&&S.status.models.includes(el.value)){S.form.model=el.value;paint('start-foot');}},
    effort(el){if(S.status&&S.status.efforts.includes(el.value)){S.form.effort=el.value;paint('start-foot');}},
    ack(el){S.form.acks[el.dataset.id]=!!el.checked;paint('start-foot');},
    acceptMissing(el){S.form.acceptMissing=!!el.checked;},
    designMode(el){
      if(el.value!=='new'&&el.value!=='harden')return;
      S.form.designMode=el.value;S.form.modeTouched=true;
      paintStart();
      focusKey('design-mode');
    },
    keepAsWorld(el){S.form.keepAsWorld=String(el.value==null?'':el.value).slice(0,4000);paint('start-foot');},
    fairnessSet(el){S.form.fairnessSet=!!el.checked;paint('start-foot');paintCapMin();},
    noReferences(el){S.form.noReferences=!!el.checked;paint('start-foot');},
    pick(el){selectRun(el.value);}
  };
  /* A text field answers input events only (its change event also fires when a repaint removes it); choices answer change events. */
  const FIELD_EVENT={source:'change',url:'input',dir:'input',cap:'input',pilotCap:'input',model:'change',effort:'change',ack:'change',acceptMissing:'change',designMode:'change',keepAsWorld:'input',fairnessSet:'change',noReferences:'change',pick:'change'};
  function handleEvent(e){
    const target=e&&e.target;
    if(!target||typeof target.closest!=='function')return;
    const mine=el=>!!el&&!!el.closest('#pl-root');
    if(e.type==='click'){
      const el=target.closest('[data-pl]');
      if(!el||!mine(el)||el.disabled)return;
      const handler=CLICK[el.dataset.pl];
      if(handler){try{const done=handler(el);if(done&&typeof done.catch==='function')done.catch(error=>say(messageOf(error),true));}catch(error){say(messageOf(error),true);}}
      return;
    }
    if(e.type!=='input'&&e.type!=='change')return;
    const el=target.closest('[data-pl-in]');
    if(!el||!mine(el)||FIELD_EVENT[el.dataset.plIn]!==e.type)return;
    const handler=INPUT[el.dataset.plIn];
    if(handler){try{handler(el);}catch(error){say(messageOf(error),true);}}
  }
  ['click','input','change'].forEach(type=>document.addEventListener(type,handleEvent));

  /* ---------- Lifecycle ---------- */
  async function boot(){
    const A=agents();
    if(!isLocal()){S.phase='offline';S.offlineNote='';paintRoot();return;}
    if(!A||typeof A.link!=='function'){S.phase='offline';S.offlineNote='The Pipeline page needs agents.js, which did not load. The other views still work.';paintRoot();return;}
    S.phase='checking';
    paintRoot();
    try{
      const link=await A.link();
      if(!link.local){S.phase='offline';S.offlineNote='';paintRoot();return;}
      if(!link.ok){S.phase='offline';S.offlineNote=link.error||'';paintRoot();return;}
      S.status=normalizeStatus(await get('/api/status'));
      if(!S.status.models.includes(S.form.model))S.form.model=S.status.defaultModel;
      if(!S.status.efforts.includes(S.form.effort))S.form.effort=S.status.defaultEffort;
      await loadList();
      const pick=S.list.find(v=>!v.ended)||S.list[0]||null;
      S.id=pick?pick.id:null;S.run=pick;
      S.formOpen=!pick;
      S.phase='ready';
      if(pick)await refreshRun(pick.id).catch(error=>say(messageOf(error),true,'poll'));   /* one unreadable pipeline must not take the page down */
    }catch(error){
      S.phase='offline';
      S.offlineNote=error&&error.status===404?'This companion has no pipeline support. Update the companion and run npm start again.':messageOf(error);
      paintRoot();
      return;
    }
    paintRoot();
    paintAll();
    schedulePoll();
  }
  function render(ctx){
    S.ctx={...S.ctx,download:ctx&&typeof ctx.download==='function'?ctx.download:S.ctx.download};
    if(!isLocal())S.phase='offline';
    return `<div id="pl-root" class="pl-root">${pageInner().text}</div>`;
  }
  /* The dashboard calls this after each of its own renders, with true while the Pipeline view is showing. */
  function afterRender(active){
    if(!active){
      S.mounted=false;
      clearTimeout(S.timer);S.timer=null;
      return;
    }
    S.mounted=true;
    if(S.phase==='idle'||S.phase==='offline')boot();
    else if(S.phase==='ready'){
      paintAll();
      schedulePoll();
    }
  }

  W.FinancePipeline={render,afterRender,handleEvent,adapt,adaptExport,RULES,CALIBRATION_MIN,ACKNOWLEDGEMENTS,offlineMessage:OFFLINE_MESSAGE};
})();
