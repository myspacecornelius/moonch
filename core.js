/* Pure, dependency-free helpers. No requests, model calls, or arbitrary code evaluation. */
(function (scope) {
  'use strict';
  const VERSION = 2, SUPPORTED_VERSIONS = [1, 2];
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => globalThis.crypto?.randomUUID?.() || 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const words = s => String(s).trim().split(/\s+/u).filter(Boolean).length;
  const classifications = ['unclassified', 'model-error', 'method-dictated', 'trap-named', 'permissive-grading', 'breadth-not-depth', 'plain-lookup', 'grader-leniency', 'task-ambiguity', 'version-mismatch', 'runtime-error', 'refusal', 'unsupported-claim', 'no-root-failure'];
  const lanes = ['net-new', 'historical'], behaviors = ['', 'solve', 'reconcile', 'push-back'], modeClasses = ['', 'strict-error', 'judgment-call'];
  const SET = {total: 5, historical: 3, netNew: 2, shortlist: 10};
  const SCAFFOLD = ' [hypothesis: edit before use]', SCAFFOLD_RE = / \[hypothesis: edit before use\]/g;
  function source() { return {id:uid(), title:'', file:'', page:'', cell:'', date:'', authority:'', version:'', excerpt:'', reviewStatus:'pending', suppliedToSolver:false}; }
  function root() { return {id:uid(), title:'New candidate', lane:'net-new', modeId:'', libraryRecord:'', mechanism:'period_alignment', causalGroup:'', sourceIds:[], governingRule:'', facts:'', triggeringCondition:'', correctInterpretation:'', wrongInterpretation:'', detectionMethod:'', correctiveAction:'', expectedBehavior:'', classification:'', duplicateCheck:'', acceptableVariations:'', toleranceRationale:'', ambiguity:'', assumptions:'', resolution:'', reviewStatus:'pending', checks:{teaching:false,doubleCount:false,outcomeIrrelevant:false,unsupported:false}, outputs:[], headlineCorrect:'', headlineWrong:''}; }
  function output() { return {id:uid(),label:'',unit:'',correct:'',wrong:'',absTolerance:'0',relTolerance:'0',direction:'at-least',threshold:'',calculation:'',sourceIds:[]}; }
  function blank() { const r=root(); r.causalGroup=r.id; return {schemaVersion:VERSION,kind:'finance-task-design',title:'Untitled finance task',task:{id:'',type:'',industry:'',activity:''},versions:{prompt:'draft-1',workbook:'draft-1',evaluator:'draft-1'},business:{objective:'',deliverable:'',decision:'',prompt:''},thesis:'',guidance:'',library:null,sources:[],roots:[r],experiments:[],gates:{},notes:'',oracle:{kind:'cash',inputs:{},result:null},updatedAt:''}; }
  const isObject = v => v && typeof v==='object' && !Array.isArray(v);
  function fail(message) { throw new Error(message); }
  function str(v,path,max=20000) { if(typeof v!=='string'||v.length>max) fail(path+' must be text (maximum '+max+' characters).'); return v; }
  const opt=(v,path,max)=>v===undefined?'':str(v,path,max); // Fields added after schema 1 default to empty on import.
  function obj(v,path) { if(!isObject(v)) fail(path+' must be an object.'); return v; }
  function arr(v,path,max=500) { if(!Array.isArray(v)||v.length>max) fail(path+' must be an array of at most '+max+' items.'); return v; }
  function bool(v,path) { if(typeof v!=='boolean') fail(path+' must be true or false.'); return v; }
  function enumValue(v,values,path) { if(!values.includes(v)) fail(path+' has an unsupported value.'); return v; }
  const optEnum=(v,values,path,fallback)=>v===undefined?fallback:enumValue(v,values,path);
  function stringFields(v,keys,path) { const o={}; keys.forEach(k=>o[k]=str(v[k],path+'.'+k)); return o; }
  function optFields(v,keys,path,max) { const o={}; keys.forEach(k=>o[k]=opt(v[k],path+'.'+k,max)); return o; }
  function safeTree(v,depth=0) {
    if(depth>20) fail('JSON is nested too deeply.');
    if(isObject(v)) Object.entries(v).forEach(([k,x])=>{if(['__proto__','prototype','constructor'].includes(k)) fail('Unsafe JSON key.'); safeTree(x,depth+1);});
    if(Array.isArray(v)) v.forEach(x=>safeTree(x,depth+1));
  }
  function decimal(v,label='Value',allowNegative=true) {
    if((typeof v!=='string'&&typeof v!=='number')||!String(v).trim()||!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(v).trim())) fail(label+' must be a finite decimal number; do not use commas or units.');
    const n=Number(v); if(!Number.isFinite(n)||Math.abs(n)>1e15||(!allowNegative&&n<0)) fail(label+' is out of range.'); return n;
  }
  function date(v,label) { if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(Date.parse(v))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v) fail(label+' must be a valid date.'); return v; }
  function checkIds(items,label) { const ids=items.map(x=>x.id); if(ids.some(x=>typeof x!=='string'||! /^[A-Za-z0-9_-]{1,120}$/.test(x))||new Set(ids).size!==ids.length) fail(label+' IDs must be unique and contain only letters, numbers, underscores, or hyphens.'); }
  function refs(ids,all,label) { arr(ids,label); ids.forEach(id=>{str(id,label);if(!all.has(id))fail(label+' references a missing source.');}); if(new Set(ids).size!==ids.length)fail(label+' contains duplicate anchors.'); return [...ids]; }
  function parseProject(raw) {
    if(typeof raw==='string'&&raw.length>5_000_000)fail('Project exceeds the 5 MB import limit.');
    let p; try{p=typeof raw==='string'?JSON.parse(raw):clone(raw);}catch{fail('File is not valid JSON.');} safeTree(p);obj(p,'Project');
    if(!SUPPORTED_VERSIONS.includes(p.schemaVersion)||p.kind!=='finance-task-design')fail('This is not a supported Finance Task Studio project (schema 1 or 2).');
    const out={schemaVersion:VERSION,kind:p.kind,title:str(p.title,'Title'),task:optFields(obj(p.task??{},'Task'),['id','type','industry','activity'],'Task',500),versions:stringFields(obj(p.versions,'Versions'),['prompt','workbook','evaluator'],'Versions'),business:stringFields(obj(p.business,'Business'),['objective','deliverable','decision','prompt'],'Business'),thesis:opt(p.thesis,'Thesis'),guidance:opt(p.guidance,'Grader guidance'),library:p.library==null?null:parseLibrary(p.library),sources:[],roots:[],experiments:[],gates:{},notes:str(p.notes,'Notes'),oracle:null,updatedAt:str(p.updatedAt,'Updated time')};
    if(p.exportPolicy!==undefined){obj(p.exportPolicy,'Export policy');promptLimit(p);out.exportPolicy={businessPromptMaxWords:44,reason:p.exportPolicy.reason};}
    obj(p.gates||{},'Review gates');Object.entries(p.gates||{}).forEach(([key,v])=>{obj(v,'Gate');out.gates[str(key,'Gate ID',100)]={status:enumValue(v.status,['pending','addressed','needs-work','not-applicable'],'Gate status'),notes:str(v.notes,'Gate notes')};});
    out.sources=arr(p.sources,'Sources').map((s,i)=>{obj(s,'Source');return {...stringFields(s,['id','title','file','page','cell','date','authority','version','excerpt'],'Source '+i),reviewStatus:enumValue(s.reviewStatus,['pending','reviewed','superseded'],'Source review'),suppliedToSolver:bool(s.suppliedToSolver,'Solver availability')};});
    checkIds(out.sources,'Source'); const sourceIds=new Set(out.sources.map(s=>s.id));
    out.roots=arr(p.roots,'Roots',50).map((r,i)=>{obj(r,'Root');const a={...stringFields(r,['id','title','mechanism','causalGroup','governingRule','facts','correctInterpretation','wrongInterpretation','acceptableVariations','toleranceRationale','ambiguity','assumptions','resolution','headlineCorrect','headlineWrong'],'Root '+i),...optFields(r,['modeId','triggeringCondition','detectionMethod','correctiveAction','duplicateCheck'],'Root '+i),libraryRecord:opt(r.libraryRecord,'Root '+i+'.libraryRecord',20000),lane:optEnum(r.lane,lanes,'Root lane','net-new'),expectedBehavior:optEnum(r.expectedBehavior,behaviors,'Expected behavior',''),classification:optEnum(r.classification,modeClasses,'Mode classification',''),reviewStatus:enumValue(r.reviewStatus,['pending','reviewed'],'Root review'),sourceIds:refs(r.sourceIds,sourceIds,'Root anchors'),checks:{},outputs:[]};obj(r.checks,'Checks');['teaching','doubleCount','outcomeIrrelevant','unsupported'].forEach(k=>a.checks[k]=bool(r.checks[k],'Check '+k));
      a.outputs=arr(r.outputs,'Outputs',50).map(o=>{obj(o,'Output');return {...stringFields(o,['id','label','unit','correct','wrong','absTolerance','relTolerance','threshold','calculation'],'Output'),direction:enumValue(o.direction,['at-least','at-most'],'Direction'),sourceIds:refs(o.sourceIds,sourceIds,'Output anchors')};});checkIds(a.outputs,'Output');return a;});
    if(!out.roots.length)fail('A project needs at least one candidate root.');checkIds(out.roots,'Root');
    out.experiments=arr(p.experiments,'Experiments',1000).map(e=>{
      obj(e,'Experiment'); const x={...stringFields(e,['id','runId','date','model','score','scoreMax','evidence','notes'],'Experiment'),snapshot:str(e.snapshot,'Experiment snapshot',4000000),versions:stringFields(obj(e.versions,'Experiment versions'),['prompt','workbook','evaluator'],'Experiment versions'),classification:enumValue(e.classification,classifications,'Run classification'),rootFailures:arr(e.rootFailures,'Root failures',50).map(x=>str(x,'Root failure'))}; validateExperiment(x);return x;
    }); checkIds(out.experiments,'Experiment');
    const o=obj(p.oracle,'Calculator');out.oracle={kind:enumValue(o.kind,['cash','ceiling','dividend','fixed'],'Calculator'),inputs:{},result:null};obj(o.inputs,'Calculator inputs');Object.entries(o.inputs).forEach(([k,v])=>out.oracle.inputs[str(k,'Input key',80)]=str(v,'Calculator input',10000));
    // Calculator results are always recomputed, never trusted on import.
    if(Object.keys(out.oracle.inputs).length)try{out.oracle.result=calculate(out.oracle.kind,out.oracle.inputs);}catch{}
    return out;
  }
  /* Historical failure-mode library: the saved JSON of the activity's library pull. Accepts the endpoint shape {activity, count, modes} or a previously saved normalized library. The app never fetches it. */
  function parseLibrary(raw) {
    let c;try{c=typeof raw==='string'?JSON.parse(raw):clone(raw);}catch{fail('Failure-mode library is not valid JSON.');}safeTree(c);obj(c,'Library');
    const modes=arr(c.modes,'Library modes',500).map((m,i)=>{obj(m,'Library mode '+i);const pick=(...keys)=>{for(const k of keys)if(m[k]!==undefined&&m[k]!==null)return m[k];return '';};
      const text=(v,label)=>typeof v==='number'||typeof v==='boolean'?String(v):str(v,label,10000);
      const num=v=>{if(v===''||v===null||v===undefined||typeof v==='boolean')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
      const modeId=text(pick('mode_id','modeId','id'),'Mode ID').trim();if(!modeId)fail('Library mode '+i+' has no mode_id.');
      const record=isObject(m.record)?m.record:m;if(JSON.stringify(record).length>20000)fail('Library mode '+modeId+' record is too large.');
      const overused=pick('overused');
      return {modeId,name:text(pick('name','title','mode_name'),'Mode name').trim(),mechanism:text(pick('mechanism','description'),'Mechanism').trim(),detection:text(pick('grader_detection_guidance','detection_guidance','grader_guidance','detection'),'Detection guidance').trim(),category:text(pick('category'),'Category').trim(),status:text(pick('status'),'Status').trim().toLowerCase(),uses:num(pick('uses','use_count')),avgTaskScore:num(pick('avg_task_score','avgTaskScore','average_task_score')),usageShare:num(pick('usage_share','usageShare')),overused:overused===true||String(overused).trim().toLowerCase()==='true',record:clone(record)};});
    if(new Set(modes.map(m=>m.modeId)).size!==modes.length)fail('Library mode IDs must be unique.');
    return {kind:'finance-failure-mode-library',schemaVersion:1,activity:opt(c.activity,'Library activity',500),count:typeof c.count==='number'?c.count:modes.length,pulledAt:opt(c.pulledAt??c.pulled_at,'Library pull date',100),modes};
  }
  /* Stage A ranking: approved, uses above zero, numeric average score; lowest average first, then most uses, then not overused, then lowest usage share, then Mode ID. Fewer than ten eligible is reported, never padded. */
  function rankLibrary(modes) {
    const eligible=modes.filter(m=>m.status==='approved'&&m.uses!==null&&m.uses>0&&m.avgTaskScore!==null);
    const key=m=>[m.avgTaskScore,-m.uses,m.overused?1:0,m.usageShare===null?Infinity:m.usageShare,m.modeId];
    eligible.sort((a,b)=>{const x=key(a),y=key(b);for(let i=0;i<x.length;i++){if(x[i]<y[i])return -1;if(x[i]>y[i])return 1;}return 0;});
    return {eligible,shortlist:eligible.slice(0,SET.shortlist),complete:eligible.length>=SET.shortlist};
  }
  /* Deterministic text hygiene for generated artifacts: dashes, curly quotes, zero-width characters, repeated spaces. Idempotent. */
  const CLEAN=[[/\s*—\s*/g,', '],[/–/g,'-'],[/[“”]/g,'"'],[/[‘’]/g,"'"],[/[​‌‍﻿]/g,''],[/ {2,}/g,' ']];
  function cleanText(text) { let t=String(text),replacements=0;for(const [re,good] of CLEAN){t=t.replace(re,()=>{replacements++;return good;});}return {text:t,replacements}; }
  const cleanLines=text=>String(text).split('\n').map(line=>{const indent=line.match(/^\s*/)[0];return indent+cleanText(line.slice(indent.length)).text;}).join('\n'); // Structural indentation is kept; only the content is cleaned.
  /* Grader-guidance lint. Exact tokens are blockers; wording patterns are labeled heuristics. It cannot judge finance substance. */
  function lintGuidance(text) {
    const t=String(text),items=[];const add=(level,code,message,match='')=>items.push({level,code,message:message+(match?' Found: "'+match+'".':''),rootId:null,heuristic:level!=='blocker'});
    const first=re=>{const m=t.match(re);return m?m[0]:'';};
    if(!t.trim()){add('blocker','guidance-empty','Grader guidance is empty.');return items;}
    const n=words(t);if(n>=800)add('blocker','guidance-length','Grader guidance is '+n+' words; 800 or more is returned.');else if(n>500)add('review','guidance-long','Grader guidance is '+n+' words; keep it near 500 words of plain prose.');
    const scoring=/\b(penali[sz]e[sd]?|penalty|partial credit|full credit|no credit|deduct(?:ion|ions|ed|s)?|point bands?|pass\/fail|pass or fail|reward(?:s|ed|ing)?|smaller miss)\b/i;if(scoring.test(t))add('blocker','guidance-scoring','Scoring or grading language is not allowed in grader guidance.',first(scoring));
    const scoringSoft=/\b(scor(?:e|es|ed|ing)|grading|(?<!basis |percentage |bps |decimal )points?)\b/i;if(scoringSoft.test(t))add('review','guidance-scoring-word','Wording may read as scoring instructions; describe the failure mode instead.',first(scoringSoft));
    const rubric=/\b(rubric|weightings?)\b|\b\d{1,3}\s?%\s*(?:weight|of (?:the )?(?:score|grade|total))\b/i;if(rubric.test(t))add('blocker','guidance-rubric','Weighted rubrics are not allowed.',first(rubric));
    const categoryPercent=/\b[A-Z][a-z]+ \d{1,3}%(?=[\s,.;)]|$)/;if(categoryPercent.test(t))add('review','guidance-category-percent','A capitalized word followed by a percentage can read as a weighted rubric; confirm it is a financial figure.',first(categoryPercent));
    const lines=t.split(/\r?\n/);for(let i=0;i<lines.length;i++){const line=lines[i].trim();if(!line)continue;if(!lines.slice(i+1).some(x=>x.trim()))break;if(/^#{1,6}\s/.test(line)||/^\*\*[^*]+\*\*:?$/.test(line)||/:$/.test(line)&&words(line)<=5||(words(line)<=5&&/^[A-Z]/.test(line)&&!/[.!?,]$/.test(line)&&!/\d$/.test(line))){add('review','guidance-titled-section','Titled sections are not allowed; write plain prose.',line.slice(0,60));break;}}
    for(const m of t.matchAll(/(?<![&\w])([A-Z]{1,3}\d{1,5}(?::[A-Z]{1,3}\d{1,5})?)\b/g)){const ref=m[1];if(!ref.includes(':')&&/^(?:Q[1-4]|H[12]|[A-Z]{2,}\d{2,}|[A-Z]\d{4})$/.test(ref))continue;add('review','guidance-cell-reference','Raw cell references are not allowed; name the tab or section instead.',ref);break;}
    const jargon=/\b(SAF|GAF|golden (?:answer|file|score)s?|ground truth|Mercor|Jericho|attempt agent|grader agent|MGP|difftest)\b/i;if(jargon.test(t))add('blocker','guidance-jargon','Internal jargon is not allowed in grader guidance.',first(jargon));
    const unicode=/[—–→←⇒↑↓×÷]/;if(unicode.test(t))add('blocker','guidance-unicode','Em or en dashes, arrows, and multiplication or division signs are not allowed.',first(unicode));
    const ai=/\bAI\b|\b(A\.I\.|Claude|LLM|GPT|ChatGPT|language model|model-generated|prompt(?:s|ed|ing)?)\b/i;if(ai.test(t))add('blocker','guidance-ai-mention','Mentions of AI, models, or prompts are not allowed.',first(ai));
    const vague=/\b(calculations? (?:are|is|were) (?:wrong|incorrect)|numbers? (?:are|is|were) (?:wrong|incorrect|off)|incorrect (?:values|figures|numbers)|check (?:all|the) (?:math|calculations|formulas))\b/i;if(vague.test(t))add('review','guidance-vague','Name the specific finance mistake; a generic failure mode is returned.',first(vague));
    return items;
  }
  const lower=s=>{s=String(s).trim().replace(/\s+/g,' ');return s?s[0].toLowerCase()+s.slice(1):'';};
  const sentence=s=>{s=String(s).trim().replace(/\s+/g,' ');return s?s.replace(/[.!?]+$/,'')+'.':'';};
  const behaviorLabel=v=>({solve:'solve',reconcile:'reconcile','push-back':'push back'})[v]||'(pending)';
  const classLabel=v=>({'strict-error':'strict error','judgment-call':'judgment-call divergence'})[v]||'(pending)';
  /* Deterministic grader-guidance draft from the recorded failure modes: orientation, governing files, one plain sentence group per mode, a few anchors. The author rewrites it; no model is involved. */
  function generateGuidance(p) {
    const b=p.business;if(!b.objective.trim()||!b.deliverable.trim())fail('Enter a business objective and deliverable first.');
    const roots=p.roots.filter(r=>r.wrongInterpretation.trim());if(!roots.length)fail('Record at least one plausible wrong approach first.');
    const outputs=p.roots.flatMap(r=>r.outputs).filter(o=>o.label.trim());
    const parts=[sentence('The request is '+b.deliverable.trim()+' to support '+(b.decision.trim()||'the stated decision')+', assessing '+b.objective.trim())+(outputs.length?' The outputs that matter are '+[...new Set(outputs.map(o=>o.label.trim()))].join(', ')+'.':'')];
    const files=p.sources.filter(s=>s.suppliedToSolver&&s.file.trim());if(files.length)parts.push('Work from '+files.map(s=>s.file.trim()+(s.page.trim()?' ('+s.page.trim()+')':'')).join(', ')+'.'+(files.some(s=>s.authority.trim())?' Where documents disagree, '+lower(files.find(s=>s.authority.trim()).authority)+'.':''));
    roots.forEach(r=>parts.push([sentence('A tempting mistake is to '+lower(r.wrongInterpretation)),r.correctInterpretation.trim()?sentence('The correct treatment is to '+lower(r.correctInterpretation)):'',r.detectionMethod.trim()?sentence('To check it, '+lower(r.detectionMethod)):'',r.headlineWrong.trim()?sentence('If missed, '+lower(r.headlineWrong)):''].filter(Boolean).join(' ')));
    const anchors=outputs.filter(o=>String(o.correct).trim()).map(o=>o.label.trim()+' should come to '+String(o.correct).trim()+(o.unit.trim()?' '+o.unit.trim():''));if(anchors.length)parts.push('A few anchors where only one answer is right: '+anchors.slice(0,6).join('; ')+'.');
    const cleaned=cleanText(parts.join('\n\n').replace(SCAFFOLD_RE,''));return {text:cleaned.text,wordCount:words(cleaned.text),lint:lintGuidance(cleaned.text)};
  }
  /* Private author-side record for each failure mode in the net-new record contract shape. */
  function failureModeRecords(p) {
    const hist=p.roots.filter(r=>r.lane==='historical'),fresh=p.roots.filter(r=>r.lane==='net-new'),t=p.task,v=x=>String(x||'').trim()||'(pending)';
    const lines=['FAILURE MODE SET (PRIVATE, AUTHOR-SIDE)','Project: '+p.title,'Task: '+([t.id,t.type,t.industry,t.activity].filter(x=>x.trim()).join(' | ')||'(pending)'),'Final failure-mode set: '+p.roots.length+' of '+SET.total+' ('+hist.length+' historical, '+fresh.length+' net-new)','Historical Mode IDs: '+(hist.map(r=>r.modeId.trim()||'(missing)').join(', ')||'none'),'Thesis: '+v(p.thesis),''];
    p.roots.forEach((r,i)=>{const consequence=[r.headlineWrong.trim(),...r.outputs.map(o=>{try{const c=compare(o);return o.label+': wrong '+c.wrong+' versus correct '+c.correct+(o.unit.trim()?' '+o.unit.trim():'')+' (difference '+c.delta+(c.decisionChanges?', decision changes':'')+')';}catch{return o.label.trim()?o.label+': comparison incomplete':'';}})].filter(Boolean).join(' ');
      lines.push('['+(i+1)+'] '+r.title+' ('+(r.lane==='historical'?'historical, Mode ID '+(r.modeId.trim()||'missing'):'net-new')+')','Deliverable context: '+v([p.business.deliverable,p.business.objective].filter(x=>x.trim()).join('; ')),'Failure or judgment point: '+v(r.governingRule),'Triggering condition: '+v(r.triggeringCondition||r.facts),'Plausible wrong approach: '+v(r.wrongInterpretation),'Consequence: '+v(consequence),'Detection method: '+v(r.detectionMethod),'Corrective action: '+v(r.correctiveAction||r.correctInterpretation),'Expected model behavior: '+behaviorLabel(r.expectedBehavior),'Classification: '+classLabel(r.classification),'Causal group: '+v(r.causalGroup)+' (count every consequence of this root once)',...(r.lane==='net-new'?['Duplicate check against the historical shortlist: '+v(r.duplicateCheck)]:[]),'');});
    return cleanLines(lines.join('\n'));
  }
  /* Persistent working document in the derivative-build shape. Unknown items stay marked pending; nothing is invented. */
  function workingDocument(p) {
    const a=audit(p),blockers=a.filter(x=>x.level==='blocker'),reviews=a.filter(x=>x.level==='review'),hist=p.roots.filter(r=>r.lane==='historical'),fresh=p.roots.filter(r=>r.lane==='net-new'),rank=p.library?rankLibrary(p.library.modes):null,t=p.task,v=x=>String(x||'').trim()||'<pending>';
    const locked=p.roots.length===SET.total&&hist.length===SET.historical&&fresh.length===SET.netNew;const title=id=>p.roots.find(r=>r.id===id)?.title;
    const lines=['# Derivative Task Build: '+p.title,'Status: '+(locked?'Five failure modes recorded; '+blockers.length+' completeness items open.':'Locking the failure-mode set: '+hist.length+' of '+SET.historical+' historical, '+fresh.length+' of '+SET.netNew+' net-new.'),'Scope: Task claim through expert submission to the reviewer queue. Testing Task is included through its existing expert-facing gates.','',
      'Selected task:','  Task ID: '+v(t.id),'  Task type: '+v(t.type),'  Industry: '+v(t.industry),'  Activity: '+v(t.activity),'  Files: '+(p.sources.filter(s=>s.file.trim()).map(s=>s.file.trim()+(s.suppliedToSolver?' (solver)':' (evaluator only)')).join(', ')||'<pending>'),'  Versions: prompt '+p.versions.prompt+', workbook '+p.versions.workbook+', evaluator '+p.versions.evaluator,'',
      'Starting point:','  Historical shortlist: '+(rank?(rank.complete?'':'(only '+rank.eligible.length+' eligible; do not pad) ')+(rank.shortlist.map((m,i)=>(i+1)+'. '+m.modeId+' '+m.name+' (avg '+m.avgTaskScore+', uses '+m.uses+', share '+(m.usageShare===null?'n/a':m.usageShare)+', overused '+(m.overused?'yes':'no')+')').join('; ')||'none eligible'):'<library not imported>'),'  Historical selections: '+(hist.map(r=>r.modeId.trim()||'<missing ID>').join(', ')||'<pending>')+' ('+hist.length+' of '+SET.historical+')','  Net-new candidates: '+(fresh.map(r=>r.title).join('; ')||'<pending>')+' ('+fresh.length+' of '+SET.netNew+')','  Duplicate check: '+(fresh.map(r=>r.title+': '+v(r.duplicateCheck)).join('; ')||'<pending>'),'  Final failure-mode set: '+(locked?p.roots.map(r=>r.title+(r.lane==='historical'?' ['+v(r.modeId)+']':' [net-new]')).join('; '):'<not yet five>'),'',
      'Task blueprint:','  Failure mode thesis: '+v(p.thesis),'  Source files used: '+(p.sources.filter(s=>s.suppliedToSolver).map(s=>s.file.trim()).filter(Boolean).join(', ')||'<pending>'),'  Traps by mode: '+(p.roots.map(r=>r.title+': '+v(r.triggeringCondition||r.facts)).join('; ')),'  Grader guidance: '+(p.guidance.trim()?words(p.guidance)+' words; '+lintGuidance(p.guidance).filter(x=>x.level==='blocker').length+' lint blockers':'<pending>'),'',
      'Artifacts:','  Scenario and prompt: '+(p.business.prompt.trim()?words(p.business.prompt)+' words':'<pending>'),'  Deterministic cleanup: '+(cleanText(p.guidance).replacements+cleanText(p.business.prompt).replacements+cleanText(p.thesis).replacements?'pending':'clean'),'',
      'QA:','  Completeness findings: '+blockers.length+' blockers, '+reviews.length+' review items (structural; not a difficulty score)','  Actual runs recorded: '+p.experiments.length,'',
      'Open loops:',...(blockers.length?blockers.map(b=>'  - '+(b.rootId?(title(b.rootId)||b.rootId)+': ':'')+b.message):['  - none from structural checks; author review still required'])];
    return cleanLines(lines.join('\n'))+'\n';
  }
  /* Fill blank record fields from a catalog mechanism, marked as hypotheses. Never overwrites author text. */
  function scaffoldRoot(r,m) {
    if(!m)fail('Select a catalog mechanism first.');let n=0;const fill=(k,v)=>{if(!String(r[k]).trim()&&String(v||'').trim()){r[k]=String(v).trim()+SCAFFOLD;n++;}};
    fill('triggeringCondition',(m.requirements||[]).join('; '));fill('wrongInterpretation',m.wrongReading);fill('correctiveAction',m.designQuestion);fill('headlineWrong',m.decisionImpact);return n;
  }
  function compare(o) {
    const correct=decimal(o.correct,'Correct output'), wrong=decimal(o.wrong,'Wrong output'), abs=decimal(o.absTolerance,'Absolute tolerance',false), rel=decimal(o.relTolerance,'Relative tolerance',false);
    if(rel>1)fail('Relative tolerance is a fraction between 0 and 1.');
    const tolerance=Math.max(abs,Math.abs(correct)*rel),delta=wrong-correct;
    let correctDecision=null,wrongDecision=null;
    if(String(o.threshold).trim()) { const threshold=decimal(o.threshold,'Decision threshold'); correctDecision=o.direction==='at-most'?correct<=threshold:correct>=threshold;wrongDecision=o.direction==='at-most'?wrong<=threshold:wrong>=threshold; }
    return {correct,wrong,delta,tolerance,distinct:Math.abs(delta)>tolerance,correctDecision,wrongDecision,decisionChanges:correctDecision!==null&&correctDecision!==wrongDecision};
  }
  function cash(i) {
    const facility=decimal(i.facility,'Facility',false),restrictedFraction=decimal(i.fraction,'Restricted availability fraction',false);if(restrictedFraction>1)fail('Availability fraction must be between 0 and 1.');
    date(i.asOf,'As-of date'); date(i.clearDate,'Clearance date'); date(i.releaseDate,'Release date');if(i.releaseDate<=i.clearDate)fail('Release date must be after clearance. Confirm the business-day calendar manually.');
    const eligible=facility*(i.asOf<i.releaseDate?restrictedFraction:1),draw=decimal(i.fundedDraw,'Confirmed funded draw',false);if(draw>eligible+1e-9)fail('Confirmed funded draw exceeds the entered eligible facility amount.');
    const opening=decimal(i.opening,'Opening usable cash',false),other=decimal(i.otherInflows,'Other confirmed inflows',false),outflows=decimal(i.outflows,'Due cash outflows',false),fundedCash=opening+draw+other;
    return {label:'Actual cash bridge',value:Math.max(0,outflows-fundedCash),unit:i.unit||'currency units',details:{eligibleFacility:eligible,confirmedFundedDraw:draw,fundedCash,dueOutflows:outflows,endingCash:fundedCash-outflows},formula:'bridge = max(0, due outflows − opening usable cash − confirmed funded draw − other confirmed inflows)',caveat:'Availability is not funding. Unpaid debt is not a cash inflow. Release date and bank holiday calendar require source review.'};
  }
  function scaled(value,scale,label) {
    const s=String(value).trim();if(!/^\d+(?:\.\d+)?$/.test(s))fail(label+' must be a non-negative decimal.'); const [a,b='']=s.split('.');if(b.length>scale||a.length>16)fail(label+' has too many digits.');return BigInt(a+b.padEnd(scale,'0'));
  }
  function ceiling(i) {
    const lines=String(i.constraints||'').split('\n').map(x=>x.trim()).filter(Boolean);if(!lines.length)fail('Enter at least one maximum permissible price.');
    const scaledValues=lines.map(x=>scaled(x,8,'Price bound'));const min=scaledValues.reduce((a,b)=>a<b?a:b);const cents=min/1000000n;const value=bigNumber(cents,'Price in cents')/100;
    return {label:'Joint whole-cent price ceiling',value,unit:i.unit||'per share',details:{bindingBound:lines[scaledValues.findIndex(x=>x===min)],constraintCount:lines.length,oneCentHigherFeasible:(cents+1n)*1000000n<=min},formula:'maximum feasible whole-cent price = floor(min(all upper bounds) × 100) ÷ 100',caveat:'Only upper-bound constraints are supported. Supply independently derived joint bounds; this helper does not infer rights, a cap table, or missing terms.'};
  }
  function bigNumber(v,label) {if(v>BigInt(Number.MAX_SAFE_INTEGER)||v< -BigInt(Number.MAX_SAFE_INTEGER))fail(label+' exceeds the exact integer range supported by this helper.');return Number(v);}
  function dividend(i) {
    const budget=scaled(i.budget,4,'Cash budget'), price=scaled(i.price,4,'Price'), div=scaled(i.dividend,4,'Dividend per share');if(price<=0n)fail('Price must be greater than zero.');
    const shares=String(i.loanShares||'').trim();if(!/^\d{1,15}$/.test(shares))fail('Record-date shares on loan must be a non-negative whole number.');
    const obligation=BigInt(shares)*div, remaining=budget-obligation, retained=remaining>0n?remaining/price:0n,omitted=budget/price;
    return {label:'Affordable whole-share trade after obligation',value:bigNumber(retained,'Share count'),unit:'shares',details:{recordDateObligation:bigNumber(obligation,'Scaled obligation')/10000,remainingCash:bigNumber(remaining,'Scaled cash')/10000,omittingObligationShares:bigNumber(omitted,'Share count'),shareDifference:bigNumber(omitted-retained,'Share difference'),cashShortfall:bigNumber(remaining<0n?-remaining:0n,'Scaled shortfall')/10000},formula:'floor(max(0, cash budget − record-date shares on loan × dividend per share) ÷ trade price)',caveat:'Illustrative cash-constrained sizing only. Confirm entitlement, contractual treatment, eligibility date, commissions, and other binding caps from sources.'};
  }
  function fixed(i) { const a=decimal(i.a,'Non-circular component'),b=decimal(i.b,'Feedback coefficient');if(Math.abs(b)>=1)fail('This helper requires |b| < 1 for the affine fixed point.');const value=a/(1-b);if(!Number.isFinite(value)||Math.abs(value)>1e15)fail('Fixed-point output exceeds supported range.');return {label:'Affine fixed-point result',value,unit:i.unit||'currency units',details:{residual:value-(a+b*value)},formula:'x = a + b × x; therefore x = a ÷ (1 − b)',caveat:'Supports only this stated affine equation. Does not validate or derive the governing carve-out equation.'}; }
  function calculate(kind,i) { return ({cash,ceiling,dividend,fixed}[kind]||(()=>fail('Unknown calculator.')))(i); }
  function generatePrompt(b) {const objective=b.objective.trim().replace(/[.!?]+$/,''),deliverable=b.deliverable.trim().replace(/[.!?]+$/,''),decision=b.decision.trim().replace(/[.!?]+$/,'');if(!objective||!deliverable||!decision)fail('Enter a business objective, deliverable, and decision first.');const prompt=`Assess ${objective} using the supplied materials. Update ${deliverable} and recommend ${decision}.`;if(words(prompt)>40)fail('The generated prompt exceeds 40 words. Shorten the business fields; no text was silently truncated.');return prompt;}
  function snapshot(p) { return JSON.stringify({versions:p.versions,business:p.business,sources:p.sources,roots:p.roots,guidance:p.guidance}); }
  function promptLimit(p) { const policy=p.exportPolicy;if(!policy)return 40;if(policy.businessPromptMaxWords!==44||typeof policy.reason!=='string'||!policy.reason.trim()||policy.reason.length>2000)fail('Prompt exception requires a 44-word limit and an explicit authorization reason.');return 44; }
  function validateExperiment(e) {
    if(!e.runId.trim()||!e.model.trim()||!e.evidence.trim())fail('An actual run ID, model label, and evidence location are required.');date(e.date,'Run date');
    if(Object.values(e.versions).some(x=>!x.trim()))fail('All three run versions are required.');
    if(e.score.trim()||e.scoreMax.trim()) { const s=decimal(e.score,'Score',false),max=decimal(e.scoreMax,'Score maximum',false);if(max<=0||s>max)fail('Score must be between zero and the positive score maximum.'); }
    return e;
  }
  function audit(p) {
    const items=[]; const add=(level,code,message,rootId=null,heuristic=false)=>items.push({level,code,message,rootId,heuristic});
    if(!p.business.prompt.trim())add('blocker','prompt-empty','Write a solver-facing business prompt.');else if(words(p.business.prompt)>promptLimit(p))add('blocker','prompt-length','Business prompt is over '+promptLimit(p)+' words.');if(p.exportPolicy)add('note','prompt-exception','Explicit project exception: '+p.exportPolicy.reason);
    if(Object.values(p.versions).some(x=>!x.trim()))add('blocker','version-empty','Set prompt, workbook, and evaluator version labels.');
    if(/\b(trap|pitfall|gotcha|fixed.point|remember to|be sure to|use the formula|do not forget|round down)\b/i.test(p.business.prompt))add('review','teaching-language','Prompt may name the mechanism or dictate a method; inspect the wording.',null,true);
    const grouped={};p.roots.forEach(r=>{if(r.causalGroup.trim())(grouped[r.causalGroup]??=[]).push(r);});Object.values(grouped).filter(x=>x.length>1).forEach(x=>add('review','same-root','Candidates '+x.map(r=>r.title).join(', ')+' share one causal group. Count that failure once, even if several outputs change.'));
    // Failure-mode set: exactly five, three historical from the imported shortlist and two net-new with a duplicate check.
    const hist=p.roots.filter(r=>r.lane==='historical'),fresh=p.roots.filter(r=>r.lane==='net-new'),rank=p.library?rankLibrary(p.library.modes):null;
    if(p.roots.length!==SET.total)add('review','set-size','A derivative build locks exactly '+SET.total+' failure modes ('+SET.historical+' historical, '+SET.netNew+' net-new); this project has '+p.roots.length+'.');
    else{if(hist.length!==SET.historical)add('review','historical-count','Exactly '+SET.historical+' historical modes are required; this project has '+hist.length+'.');if(fresh.length!==SET.netNew)add('review','net-new-count','Exactly '+SET.netNew+' net-new modes are required; this project has '+fresh.length+'.');}
    if(rank&&!rank.complete)add('review','shortlist-short','Only '+rank.eligible.length+' eligible historical modes were returned; the build requires '+SET.shortlist+'. State the count and stop rather than padding.');
    if(p.library&&p.task.activity.trim()&&p.library.activity.trim()&&p.library.activity.trim().toLowerCase()!==p.task.activity.trim().toLowerCase())add('review','library-activity','Imported library activity does not match the task activity.');
    if(!p.thesis.trim())add('review','thesis-empty','Write the failure mode thesis connecting the five modes.');
    if(p.guidance.trim())lintGuidance(p.guidance).forEach(x=>add(x.level,x.code,x.message,null,x.heuristic));else add('note','guidance-empty','No grader guidance drafted yet.');
    p.roots.forEach(r=>{
      if(!r.causalGroup.trim())add('blocker','group-empty','Assign one causal group to this root.',r.id);
      for(const k of ['governingRule','facts','correctInterpretation','wrongInterpretation','acceptableVariations','toleranceRationale','headlineCorrect','headlineWrong','triggeringCondition','detectionMethod','correctiveAction'])if(!r[k].trim())add('blocker','missing-'+k,'Complete '+k.replace(/([A-Z])/g,' $1').toLowerCase()+'.',r.id);
      if(!r.expectedBehavior)add('blocker','missing-expectedBehavior','State the expected model behavior: solve, reconcile, or push back.',r.id);
      if(!r.classification)add('blocker','missing-classification','Classify the mode as a strict error or a judgment-call divergence.',r.id);
      if(r.lane==='historical'){if(!r.modeId.trim())add('blocker','mode-id-empty','A historical mode needs its library Mode ID.',r.id);else if(!rank)add('review','mode-id-unverified','Historical Mode ID is not verified against an imported library.',r.id);else if(!rank.shortlist.some(m=>m.modeId===r.modeId.trim()))add('blocker','mode-id-unlisted','Mode ID '+r.modeId+' is not in the ten-mode historical shortlist.',r.id);}
      else if(!r.duplicateCheck.trim())add('review','duplicate-check','Record how this net-new mode differs from each shortlisted historical mode.',r.id);
      if(Object.values(r).some(v=>typeof v==='string'&&v.includes(SCAFFOLD.trim())))add('review','scaffold-unedited','Scaffolded hypothesis text is still present; replace it with task-specific facts.',r.id);
      if(!r.sourceIds.length)add('blocker','anchors-empty','Attach governing source anchors.',r.id);
      const allAnchorIds=new Set([...r.sourceIds,...r.outputs.flatMap(o=>o.sourceIds)]);const anchors=p.sources.filter(s=>allAnchorIds.has(s.id));anchors.forEach(s=>{if(s.reviewStatus!=='reviewed')add('review','source-unreviewed',s.title+': source has not been marked reviewed for this version.',r.id);if(!s.excerpt||!s.file||(!s.page&&!s.cell)||!s.version||!s.authority||!s.date)add('blocker','anchor-incomplete',s.title+': record excerpt, file, page or cell, version, authority, and date.',r.id);if(!s.suppliedToSolver)add('blocker','source-unavailable',s.title+': not marked supplied to solver. Correctness cannot depend on evaluator-only evidence.',r.id);});
      if(r.ambiguity.trim())add('blocker','ambiguity','Unresolved ambiguity is recorded; resolve it or accept multiple defensible answers.',r.id);
      if(r.assumptions.trim()&&!r.resolution.trim())add('review','assumptions','Assumptions have no documented source resolution.',r.id);
      if(r.reviewStatus!=='reviewed')add('review','human-review','Interpretation still requires author review. Semantic correctness is not checked automatically.',r.id);
      Object.entries(r.checks).filter(([,v])=>v).forEach(([k])=>add('blocker','manual-'+k,({teaching:'Author flagged teaching or answer leakage.',doubleCount:'Author flagged same-root double counting.',outcomeIrrelevant:'Author flagged no material decision consequence.',unsupported:'Author flagged an unsupported assumption.'})[k],r.id));
      if(!r.outputs.length)add('blocker','outputs-empty','Add recomputed economic outputs.',r.id);
      let anyDistinct=false,anyThreshold=false,anyDecisionChange=false;
      r.outputs.forEach(o=>{try{const c=compare(o);anyDistinct ||= c.distinct;anyThreshold ||= c.correctDecision!==null;anyDecisionChange ||= c.decisionChanges;if(!c.distinct)add('review','within-tolerance',o.label+': outputs are within the stated tolerance.',r.id);if(!o.calculation.trim()||!o.sourceIds.length)add('blocker','output-evidence',o.label+': document the calculation and its input anchors.',r.id);}catch(e){add('blocker','invalid-output',(o.label||'Output')+': '+e.message,r.id);}});
      if(r.outputs.length&&!anyDistinct)add('review','no-economic-gap','No output differs beyond tolerance.',r.id);
      if(anyThreshold&&!anyDecisionChange)add('review','no-threshold-change','Entered numeric thresholds do not change the decision. Explain another material consequence or redesign.',r.id);
      if(r.headlineCorrect.trim()&&r.headlineCorrect.trim().toLowerCase()===r.headlineWrong.trim().toLowerCase())add('review','same-headline','Correct and wrong interpretations have the same headline. Review materiality.',r.id,true);
      if(r.outputs.some(o=>String(o.correct).length>=3&&p.business.prompt.includes(String(o.correct))))add('review','numeric-leak','Prompt repeats a reference number. Review whether it reveals an answer or is a legitimate input.',r.id,true);
    });
    Object.entries(p.gates||{}).forEach(([id,g])=>{if(g.status==='needs-work')add('review','gate-open','Author review gate '+id+' needs work. '+g.notes);if(['addressed','not-applicable'].includes(g.status)&&!g.notes.trim())add('review','gate-rationale','Record evidence or rationale for review gate '+id+'.');});
    if(!p.experiments.length)add('note','untested','No actual runs recorded. Difficulty and failure rate are unknown.');else if(!p.experiments.some(e=>e.snapshot&&e.snapshot===snapshot(p)))add('note','current-untested','No recorded run has a matching current design snapshot. Earlier results do not establish current difficulty.');
    return items;
  }
  function solverDraft(p) {
    if(!p.business.prompt.trim()||words(p.business.prompt)>promptLimit(p))fail('Solver export requires a non-empty business prompt of at most '+promptLimit(p)+' words.');
    const seen=new Set();const manifest=p.sources.filter(s=>s.suppliedToSolver).filter(s=>{const key=s.file+'\u0000'+s.version;if(seen.has(key))return false;seen.add(key);return true;}).map(s=>({file:s.file,version:s.version}));
    return {kind:'solver-draft',schemaVersion:VERSION,versions:{prompt:p.versions.prompt,workbook:p.versions.workbook},businessPrompt:p.business.prompt,wordCount:words(p.business.prompt),suppliedFileManifest:manifest,notice:'User-reviewable draft. Attach the listed files separately. Only the authored prompt and explicit file manifest are included.'};
  }
  function evaluatorDraft(p) { const hist=p.roots.filter(r=>r.lane==='historical'),fresh=p.roots.filter(r=>r.lane==='net-new');return {kind:'evaluator-draft',schemaVersion:VERSION,title:p.title,task:clone(p.task),versions:clone(p.versions),notice:'Grader-only draft for author review. No automatic semantic verification, human attestation, official FailureAnalysis, or GraderAnalysis is generated. Count each causal group once; accept source-supported variation within justified tolerances. Do not force a failure.',failureModeSet:{total:p.roots.length,historical:hist.map(r=>({title:r.title,modeId:r.modeId})),netNew:fresh.map(r=>r.title),locked:p.roots.length===SET.total&&hist.length===SET.historical&&fresh.length===SET.netNew,thesis:p.thesis,library:p.library?{activity:p.library.activity,count:p.library.count,pulledAt:p.library.pulledAt,shortlist:rankLibrary(p.library.modes).shortlist.map(m=>m.modeId)}:null},graderGuidance:{text:p.guidance,wordCount:words(p.guidance),lint:lintGuidance(p.guidance)},sourceAnchors:clone(p.sources),rootRecords:clone(p.roots),checks:audit(p),authorReviewGates:clone(p.gates||{}),experiments:clone(p.experiments),calculator:clone(p.oracle),...(p.exportPolicy?{exportPolicy:clone(p.exportPolicy)}:{})}; }
  function catalogExport(c) { return clone(c); } // Deliberately accepts catalog only, never a project.
  function parseCatalog(raw) {let c;try{c=typeof raw==='string'?JSON.parse(raw):clone(raw);}catch{fail('Catalog is not valid JSON.');}safeTree(c);obj(c,'Catalog');if(c.schemaVersion!==1||c.kind!=='finance-research-catalog')fail('Unsupported catalog schema.');const out={schemaVersion:1,kind:c.kind,updatedAt:str(c.updatedAt,'Catalog date'),sources:[],mechanisms:[]};out.sources=arr(c.sources,'Research sources').map(s=>({...stringFields(s,['id','title','url','version','status','summary','limits'],'Research source'),claims:arr(s.claims||[],'Research claims').map(x=>str(x,'Claim'))}));checkIds(out.sources,'Research source');out.sources.forEach(s=>{enumValue(s.status,['pending','verified','partially-verified','unavailable'],'Research status');if(!/^https?:\/\//.test(s.url))fail('Research source URL must use https or http.');});out.mechanisms=arr(c.mechanisms,'Mechanisms').map(m=>({...stringFields(m,['id','title','description','designQuestion','status'],'Mechanism'),sourceIds:refs(m.sourceIds,new Set(out.sources.map(s=>s.id)),'Research mechanism sources')}));out.mechanisms.forEach((m,i)=>{const raw=c.mechanisms[i];for(const k of ['requirements','fairness','leakage','evidence'])m[k]=arr(raw[k]||[],k).map(x=>str(x,k));for(const k of ['wrongReading','decisionImpact'])m[k]=str(raw[k]||'',k);});checkIds(out.mechanisms,'Mechanism');return out; }
  const api={VERSION,SET,SCAFFOLD,clone,uid,words,classifications,lanes,behaviors,modeClasses,source,root,output,blank,parseProject,parseLibrary,rankLibrary,cleanText,lintGuidance,generateGuidance,failureModeRecords,workingDocument,scaffoldRoot,decimal,date,compare,calculate,generatePrompt,snapshot,promptLimit,validateExperiment,audit,solverDraft,evaluatorDraft,catalogExport,parseCatalog};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.FinanceCore=api;
})(typeof window!=='undefined'?window:globalThis);
