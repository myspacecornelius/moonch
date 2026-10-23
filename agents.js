/* Agents page: drives the local companion's /api/agents routes (docs/local-agents.md sections 5 and 9).
   Rules this file keeps:
   - It talks only to relative URLs under /api/ and only when served by the companion on 127.0.0.1.
   - It never supplies a command, a binary path or an argument list. It sends a folder path to read, file paths to include,
     text, numbers and choices from the allowlists the companion reports.
   - Every dynamic string is escaped by the html template tag below. There is no other way to build markup here.
   - No inline style attributes (the page CSP forbids them) and no form submission. */
(function(){
  'use strict';

  const OFFLINE_MESSAGE='Local agents need the companion: run npm start.';
  const POLL_MS=1500;
  const DEFAULT_PROMPT_WORDS=120;     /* the prompt-length review cue in core.js; used only when the project is not available */
  const PACKAGE_DIGEST_CHARS=90000;   /* the companion refuses a review prompt over 120 KiB */
  const ID_RE=/^[a-z0-9-]{4,64}$/;
  const FINGERPRINT_ID_RE=/^[a-z0-9-]{2,40}$/;
  const DEFAULT_PILOTS=5;             /* a full round by default, capped by the maxPilotsPerRound the companion reports */
  /* The spending cap per pilot (--max-budget-usd). Display and form checks only: the companion enforces the same range
     (BUDGET_USD in backend/agents/constants.cjs) and refuses anything else. */
  const BUDGET={pilotDefault:3,minUsd:0.05,maxUsd:20};
  const TIME_LIMIT_MINUTES=50;        /* the companion's time limit per pilot */
  /* The in-progress form is kept in this browser's localStorage under this key, so a reload does not lose it. Nothing is
     written while a round is running, and a successful launch removes it: from then on the companion holds the round. */
  const DRAFT_KEY='finance-studio.agents.draft.v1';
  const DRAFT_SAVE_MS=400;
  const BASE_TITLE=(()=>{try{return document.title||'Finance Task Studio';}catch{return 'Finance Task Studio';}})();
  const RUNNING_TOOL_LESS='A round is running. The simulated grader and the author review wait until it has ended, because their text would be on a command line that a running pilot can read.';
  const RUNNING_NEXT='A round is running. Start the next round when it has ended: while a round runs, the companion withholds the gold and the prompt from this page.';
  const ACKNOWLEDGEMENTS=[
    {id:'shell-access',label:'Shell access as me',text:'Each pilot is a Claude Code agent that can run shell commands as my user account on this computer.'},
    {id:'network',label:'Network use by the agent runtime',text:'The agent runtime (the claude program) sends the packet files, your prompt and the fixed text before it to Anthropic over the network. This page itself only talks to the companion on this computer.'},
    {id:'isolation-by-audit',label:'Isolation by audit only',text:'There is no operating system sandbox. Pilots are told to stay inside their own folder and every tool call is checked afterwards. A call outside the folder discards that run. It is detected, not blocked.'}
  ];
  const ISOLATION_STATEMENT='Isolation is by instruction and audit, not by an operating system sandbox. A pilot is a Claude Code agent with shell access, running as you. Any read or write outside its own folder is detected after the fact and the run is marked DISCARDED. It is not blocked.';
  const SHELL_STATEMENT='Each pilot can run shell commands as your user account on this computer.';
  const NETWORK_STATEMENT='The agent runtime (the claude program) contacts Anthropic over the network. This page only talks to the companion on this computer.';
  const GAF_SENTENCE='Matches production only if the production solver sees this file.';
  const FIGURE_NOTE='Type a value the way an answer would show it: 12450, 12,450, $12,450, (1,200) for -1,200, 3.2x or 12%. A percentage is kept as 12, not 0.12, and a tolerance is the same kind of number.';
  const PACKET_PATH_HINT='Unzip the task ZIP outside this project, then paste the full path of its filesystem folder (Finder: select it, Option-Command-C).';
  /* Said wherever the prompt is shown, because the writer's prompt is not all a pilot reads (PILOT_PROMPT_PREFIX in backend/agents/rounds.cjs). The text itself comes from the companion. */
  const PREFIX_HEADING='Pilots also see this fixed text before your prompt';
  const VERDICTS=[
    {id:'matches-frozen-gold',label:'Matches the frozen gold'},
    {id:'fingerprint',label:'Lands on a frozen fingerprint'},
    {id:'unclear',label:'Unclear, or neither'}
  ];
  const VIOLATION_CAUSES=Object.freeze({
    abs:'An absolute path outside the pilot folder.',
    'bare-root':'A command used the bare root directory (/).',
    dotdot:'A relative path with .. segments that resolves outside the pilot folder.',
    home:'A reference to the home directory.',
    'harness-spill':'The agent runtime pointed the agent at a file in its own configuration area (for example a large output file). That path is outside the pilot folder, so the run is discarded. This is a known cause and not necessarily misbehaviour. The run is kept for reading; start a new round to run it again.',
    'bare-cd':'cd with no argument moves to the home directory.',
    loopback:'A tool call reached for this computer itself over the network (localhost, a 127.x.x.x address, or the port of this companion). A pilot can read round data from the companion that way, so the run is discarded.',
    runtime:'A tool call started the agent runtime (the claude program) again, or wrote code that does. That process runs under your sign-in with no spending cap, and its own tool calls are not audited, so the run is discarded.',
    'machine-search':'A command searched the whole computer for files (mdfind, locate and similar). Pilots work only with the files in their own folder, so the run is discarded.'
  });
  /* What the spending cap covers, in the settings and the approval dialog (backend/agents/rounds.cjs STATEMENTS.cap). */
  const CAP_STATEMENT='The cap applies to each pilot process the Studio starts. It is not a ceiling on everything a pilot can start: a claude process that a pilot starts from its own shell has no cap and its tool calls are not audited. The audit discards a run whose tool calls start one, after the fact.';
  /* The ship bar frozen with the gold (SHIP_BAR in backend/agents/constants.cjs, which refuses anything else): whole numbers,
     1 <= wrong <= of <= 20, suggested as 5 of 6. */
  const SHIP_BAR={maxRuns:20,suggestWrong:5,suggestOf:6};
  /* The pilot gate's instrument: what a pilot run scores on the platform's grading when the writer's verdict is correct (matches
     the frozen gold) or wrong (lands on a frozen fingerprint). Measured on the writer's own earlier tasks; it is not a property of
     any new task, and it matched a platform batch once. The ranges give the projected batch mean, the points decide which ten-run
     batches average 0.60 or lower. stop: correct verdicts in a row after which the design is not worth more pilots. */
  const GATE=Object.freeze({correct:{low:0.82,high:0.90,point:0.86},wrong:{low:0.13,high:0.32,point:0.25},batch:10,mean:0.60,stop:3});
  /* A calibration grades the writer's own reference answer, which should score about 0.98. Below 0.95 it is the guidance that
     needs work, and no pilot score means anything until it has had it. */
  const CALIBRATION={expected:0.98,floor:0.95};
  const causeOf=kind=>Object.prototype.hasOwnProperty.call(VIOLATION_CAUSES,kind)?VIOLATION_CAUSES[kind]:null;

  /* ---------- Escaping and markup. Interpolated values are escaped unless they are the result of html or raw. ---------- */
  const ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'};
  const esc=x=>String(x==null?'':x).replace(/[&<>"'`]/g,c=>ESC[c]);
  class Raw{constructor(text){this.text=text;}}
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
  /* One kind per state, at every place a state is shown (status strip, round and runs cards, pilots table, drawer).
     green is a pass (with its check glyph), red a failure, amber a stop or a warning; violet marks a live or settled step and
     the default (neutral) kind a plain label. Counting or selecting something is never green. */
  const STATUS_KIND={draft:'',queued:'',frozen:'violet',approved:'violet',running:'violet',completed:'green',finished:'green',failed:'red',cancelled:'amber'};
  const statusKind=state=>Object.prototype.hasOwnProperty.call(STATUS_KIND,state)?STATUS_KIND[state]:'';
  const $=selector=>document.querySelector(selector);

  /* ---------- State ---------- */
  const S={
    phase:'idle',            // idle | checking | ready | offline
    offlineNote:'',
    nonce:'',
    status:null,             // normalized agents block of /api/status
    ctx:{package:null,notify:null,download:null},
    packet:{dir:'',inspectedDir:'',files:null,gafVisible:true,error:''},
    prompt:'',
    label:'',
    task:'',                 // the task name typed in Settings: metadata stored with the round, not part of the freeze signature
    config:blankConfig(),
    fz:blankFreezeForm(),
    rounds:[],
    roundId:null,
    round:null,
    sigs:{},                 // round id -> input signature at creation, to flag a freeze that no longer matches the form
    commands:{},             // round id -> the command line (prompt elided) the companion showed at approval
    approvals:{},            // round id -> {summary,hash} from the freeze answer, which keeps them while another round runs
    preflights:{},           // round id -> the last pre-flight result {state,ok,message,version,signIn}
    carry:null,              // {from: round id} after "Start next round", until a round made from it is launched
    draftInclude:null,       // {dir,paths}: the include boxes of a restored draft, applied at the next inspect of that folder
    draftTimer:null,
    draftSavedAt:'',
    working:'',
    overlay:null,
    returnKey:null,
    msg:{text:'',error:false},
    timer:null,
    mounted:false,
    pending:null,            // {roundId,n,step,at,bad}: what openRun / openRound asked for, applied when this view is mounted and ready
    applying:false,
    noncePromise:null,       // one shared /api/status request while the nonce is loaded for link, get and post
    design:{views:{},busy:false}  // the pilot gate's reads of other rounds: round id -> {at: its row's lastActivityAt, view}
  };
  function blankFigure(){return {label:'',value:'',tolerance:''};}
  function blankFingerprint(n){return {id:'fp-'+n,label:'',tokens:'',figures:[]};}
  function blankBar(){return {on:false,wrong:String(SHIP_BAR.suggestWrong),of:String(SHIP_BAR.suggestOf)};}
  function blankFreezeForm(){return {decision:'',notes:'',figures:[blankFigure()],fingerprints:[blankFingerprint(1)],bar:blankBar(),errors:[]};}
  /* atOnce 0 means every pilot at once (one wave); a number below the pilot count runs that many at a time. */
  function blankConfig(model='',effort=''){return {model,effort,count:DEFAULT_PILOTS,atOnce:0,budget:BUDGET.pilotDefault.toFixed(2)};}

  /* ---------- Small helpers ---------- */
  const isLocal=()=>{try{return location.protocol==='http:'&&location.hostname==='127.0.0.1';}catch{return false;}};
  const wordsOf=text=>{
    const C=window.FinanceCore;
    return C&&C.words?C.words(text):String(text).trim().split(/\s+/u).filter(Boolean).length;
  };
  function currentProject(){
    try{return window.FinanceAuthoring?window.FinanceAuthoring.getProject():null;}catch{return null;}
  }
  function promptLimit(){
    try{
      const project=currentProject(),C=window.FinanceCore;
      return C&&C.promptLimit&&project?C.promptLimit(project):DEFAULT_PROMPT_WORDS;
    }catch{return DEFAULT_PROMPT_WORDS;}
  }
  function bytesText(n){
    n=Number(n);
    if(!Number.isFinite(n))return '';
    if(n<1024)return n+' B';
    if(n<1048576)return (n/1024).toFixed(1)+' KB';
    return (n/1048576).toFixed(1)+' MB';
  }
  function timeText(iso){
    const t=Date.parse(iso);
    return Number.isFinite(t)?new Date(t).toLocaleString():String(iso||'');
  }
  function elapsedText(run){return spanText(run.startedAt,run.endedAt);}
  function spanText(startIso,endIso){
    const start=Date.parse(startIso);
    if(!Number.isFinite(start))return '-';
    const end=endIso?Date.parse(endIso):Date.now();
    const seconds=Math.max(0,Math.round(((Number.isFinite(end)?end:Date.now())-start)/1000));
    return Math.floor(seconds/60)+'m '+String(seconds%60).padStart(2,'0')+'s';
  }
  /* The spending cap typed in the settings, as a number of dollars in whole cents inside the allowed range, or NaN. */
  function budgetNumber(text){
    const value=String(text==null?'':text).trim();
    if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(value))return NaN;
    const n=Number(value);
    return n>=BUDGET.minUsd&&n<=BUDGET.maxUsd?Math.round(n*100)/100:NaN;
  }
  const usd=n=>'USD '+(Math.round(Number(n)*100)/100).toFixed(2);
  const roundMax=(count,budget)=>usd(Math.round(Number(budget)*100)*Number(count)/100);
  /* How many pilots run at the same time for a config, and how many waves that makes. */
  function atOnceOf(cfg){
    const count=Number(cfg&&cfg.count)||1,asked=Number(cfg&&(cfg.concurrency!==undefined?cfg.concurrency:cfg.atOnce));
    return Number.isInteger(asked)&&asked>=1&&asked<count?asked:count;
  }
  function pacingText(cfg){
    const count=Number(cfg&&cfg.count)||1,atOnce=atOnceOf(cfg),waves=Math.ceil(count/atOnce);
    return atOnce===count?'all '+count+' at once, one wave: the round ends within about '+TIME_LIMIT_MINUTES+' minutes'
      :atOnce+' at a time, '+waves+' waves: the round can take up to about '+(waves*TIME_LIMIT_MINUTES)+' minutes';
  }
  const shortHash=h=>String(h||'').slice(0,12);
  /* The same pattern the companion uses to decide which files belong to the gaf folder (GAF_RE in backend/agents/pilot-folder.cjs;
     tests/agents-page.test.cjs checks that the two stay identical). A name such as gaf-hedge.csv counts, not only a gaf/ folder. */
  const isGaf=path=>/(?:^|[/_ -])gaf(?:[/_. -]|$)/i.test(String(path));
  /* Inside a gaf/ folder a file is included even when its own name has a grading word (Golden_Response.docx), because gaf/
     is what the production solver sees. The shared rule (classifyPath in package-engine.js) withholds that name anywhere
     else, so the packet table marks such a file for a second look. Without the engine nothing is marked. */
  function gafGradingWord(path){
    const E=window.FinancePackageEngine,parts=String(path).split('/');
    if(!E||typeof E.classifyPath!=='function'||!parts.slice(0,-1).some(s=>s.trim().toLowerCase()==='gaf'))return false;
    try{return E.classifyPath(parts[parts.length-1]).role==='evaluator';}catch{return false;}
  }
  const lines=text=>[...new Set(String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean))];
  const shellQuote=arg=>/^[\w@%+=:,./-]+$/.test(arg)?arg:"'"+String(arg).replace(/'/g,"'\\''")+"'";
  function idOk(id){return typeof id==='string'&&ID_RE.test(id);}
  function roundPath(id,tail=''){
    if(!idOk(id))throw new Error('That round id is not valid.');
    return '/api/agents/rounds/'+id+tail;
  }
  function runPath(id,n,tail=''){
    const number=Number(n);
    if(!Number.isInteger(number)||number<1||number>99)throw new Error('That pilot number is not valid.');
    return roundPath(id,'/runs/'+number+tail);
  }
  /* Where the evidence copy of a run's outputs lands once the run has ended (backend/agents/rounds.cjs _copyOutputs). The path is
     relative to the project folder the companion runs from; no absolute path is ever sent to this page. */
  const evidencePath=(roundId,n)=>'private/agent-rounds/'+roundId+'/runs/'+n+'/outputs/';
  /* The task a round belongs to is one line of at most 120 characters, cleaned like the companion cleans it. It is a label for
     grouping rounds: it is stored with the round, it is not in the input signature, so it never makes a freeze stale. */
  const TASK_MAX=120;
  const taskText=value=>String(value==null?'':value).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,TASK_MAX).replace(/[\ud800-\udbff]$/,'');
  const taskKeyOf=value=>{
    const text=taskText(value).replace(/\s+/g,' ');
    try{return text.normalize('NFC').toLowerCase();}catch{return text.toLowerCase();}
  };
  /* The version labels of the project in the task editor, for round.versions. The companion wants all three as non-empty single
     lines of at most 200 characters and refuses the round otherwise, so anything else is left out and the round has no labels. */
  function projectVersions(){
    const project=currentProject(),versions=project&&project.versions;
    if(!versions||typeof versions!=='object')return null;
    const out={};
    for(const key of ['prompt','workbook','evaluator']){
      const text=typeof versions[key]==='string'?versions[key].trim():'';
      if(!text||text.length>200||/[\u0000-\u001f\u007f]/.test(text))return null;
      out[key]=text;
    }
    return out;
  }

  /* ---------- Companion calls ---------- */
  class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
  async function api(method,path,body,retried){
    const init={method,cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'}};
    if(method!=='GET'){
      init.headers['Content-Type']='application/json';
      init.headers['x-finance-local']=S.nonce;
      init.body=JSON.stringify(body==null?{}:body);
    }
    let response;
    try{response=await fetch(path,init);}
    catch{throw new ApiError('The companion could not be reached. Is npm start still running?',0);}
    const text=await response.text();
    let data=null;
    if(text){try{data=JSON.parse(text);}catch{data=null;}}
    if(response.status===403&&method!=='GET'&&!retried){await loadStatus();return api(method,path,body,true);}
    if(!response.ok){
      const message=data&&typeof data.error==='string'&&data.error?data.error:'The companion refused the request ('+response.status+').';
      throw new ApiError(message,response.status);
    }
    return data==null?{}:data;
  }
  function normalizeChoices(list){
    const out=[];
    (Array.isArray(list)?list:[]).forEach(item=>{
      if(typeof item==='string'&&item){out.push({id:item,isDefault:false});return;}
      if(item&&typeof item==='object'){
        const id=item.id||item.model||item.effort||item.value||item.name;
        if(typeof id==='string'&&id)out.push({id,isDefault:!!(item.default||item.isDefault)});
      }
    });
    return out;
  }
  function pickDefault(choices,preferred){
    const flagged=choices.find(c=>c.isDefault),named=choices.find(c=>c.id===preferred);
    return (flagged||named||choices[0]).id;
  }
  function normalizeStatus(data){
    const agents=data&&data.agents;
    if(!agents||typeof agents!=='object')throw new ApiError('This companion has no agent support.',0);
    const models=normalizeChoices(agents.models),efforts=normalizeChoices(agents.efforts);
    if(!models.length||!efforts.length)throw new ApiError('The companion did not report model and effort choices.',0);
    const max=Number.isInteger(agents.maxPilotsPerRound)&&agents.maxPilotsPerRound>0?agents.maxPilotsPerRound:5;
    return {runtime:agents.runtime&&typeof agents.runtime==='object'?agents.runtime:{found:false},max,models,efforts,
      defaultModel:pickDefault(models,'claude-opus-5-5'),defaultEffort:pickDefault(efforts,'medium'),
      graderModel:typeof agents.graderModel==='string'&&models.some(m=>m.id===agents.graderModel)?agents.graderModel:''};
  }
  /* The simulated grader offers the companion's grading model first (the writer's grading instrument); pilots keep their own model.
     An older companion names none, and the dialog then starts from the pilot model, as it did before. */
  const graderModel=()=>S.status.graderModel||S.config.model;
  async function loadStatus(){
    const data=await api('GET','/api/status');
    S.nonce=typeof data.nonce==='string'?data.nonce:'';
    S.status=normalizeStatus(data);
    const ids=list=>list.map(c=>c.id);
    if(!ids(S.status.models).includes(S.config.model))S.config.model=S.status.defaultModel;
    if(!ids(S.status.efforts).includes(S.config.effort))S.config.effort=S.status.defaultEffort;
    S.config.count=Math.min(Math.max(1,S.config.count),S.status.max);
    if(S.config.atOnce>=S.config.count)S.config.atOnce=0;
  }

  /* ---------- What other views may ask of this module: link, get, post ---------- */
  /* The nonce, from /api/status, once. Concurrent callers share one request; a failure is not remembered. */
  async function ensureNonce(){
    if(S.nonce)return;
    if(!S.noncePromise){
      S.noncePromise=(async()=>{
        try{const data=await api('GET','/api/status');S.nonce=data&&typeof data.nonce==='string'?data.nonce:'';}
        finally{S.noncePromise=null;}
      })();
    }
    await S.noncePromise;
    if(!S.nonce)throw new ApiError('The companion did not send a session code. Reload the page.',0);
  }
  /* What a view calls first: is this page served by the companion (local) and, if so, is the companion reachable (ok, with the session
     code loaded once). The file edition answers local: false without any network call. It never rejects: a companion that cannot be
     reached answers local: true, ok: false and says why in error. */
  async function link(){
    const base={local:isLocal(),ok:false,offlineMessage:OFFLINE_MESSAGE,error:''};
    if(!base.local)return base;
    try{await ensureNonce();return {...base,ok:true};}
    catch(error){return {...base,error:String(error&&error.message||error)};}
  }
  /* Only a plain path under /api/ is ever requested: no scheme, no host, no fragment, no dot segments. A query is allowed. */
  const API_PATH_RE=/^\/api\/[\w\-.~!$&'()*+,;=:@%/]*(?:\?[\w\-.~!$&'()*+,;=:@%/?]*)?$/;
  function apiTarget(path){
    if(typeof path!=='string'||path.length>2048||!API_PATH_RE.test(path))return '';
    for(const segment of path.split('?')[0].split('/')){
      let decoded;
      try{decoded=decodeURIComponent(segment);}catch{return '';}
      if(decoded==='.'||decoded==='..'||/[\u0000-\u001f\u007f\\/]/.test(decoded))return '';
    }
    return path;
  }
  async function viaApi(method,path,body){
    const target=apiTarget(path);
    if(!target)throw new ApiError('Only paths under /api/ can be requested.',400);
    if(!isLocal())throw new ApiError(OFFLINE_MESSAGE,0);
    if(method!=='GET')await ensureNonce();
    return api(method,target,body);
  }
  const get=path=>viaApi('GET',path);
  const post=(path,body)=>viaApi('POST',path,body);

  function normalizeRound(data){
    const round=data&&data.round&&typeof data.round==='object'?data.round:data;
    if(!round||!idOk(round.id))throw new ApiError('The companion returned no usable round.',0);
    return round;
  }
  async function loadRounds(){
    const data=await api('GET','/api/agents/rounds');
    const list=Array.isArray(data)?data:Array.isArray(data.rounds)?data.rounds:[];
    S.rounds=list.filter(r=>r&&idOk(r.id)).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  }
  async function refreshRound(id){
    const round=normalizeRound(await api('GET',roundPath(id)));
    if(S.roundId===id)S.round=round;
    return round;
  }
  /* Is any round running? The selected round, or any row of the list. While one is, the companion withholds round data
     (redacted: true), and the simulated grader, the author review and "Start next round" wait. */
  const anyRunning=()=>!!((S.round&&S.round.status==='running')||S.rounds.some(r=>r&&r.status==='running'));
  /* The approval summary and its hash: from the round view, or, when a read withheld them because another round is
     running, from the freeze answer that carried them. The companion checks the hash again when it approves. */
  function rememberApproval(data){
    if(data&&idOk(data.id)&&typeof data.summarySha256==='string'&&data.summarySha256)S.approvals[data.id]={summary:data.approvalSummary||null,hash:data.summarySha256};
  }

  /* ---------- Painting ---------- */
  /* Replace an element's markup only when it changed, and put keyboard focus back on the same control afterwards. */
  function setHtml(el,markup,force){
    if(!el)return false;
    const text=markup instanceof Raw?markup.text:String(markup);
    if(!force&&el.agHtml===text)return false;
    const active=document.activeElement;
    const key=active&&el.contains(active)?active.getAttribute('data-ag-key'):null;
    let caret=null;
    if(key&&typeof active.selectionStart==='number'){try{caret=[active.selectionStart,active.selectionEnd];}catch{caret=null;}}
    el.innerHTML=text;
    el.agHtml=text;
    if(key){
      const next=el.querySelector('[data-ag-key="'+CSS.escape(key)+'"]');
      if(next&&!next.disabled){
        next.focus({preventScroll:true});
        if(caret&&typeof next.setSelectionRange==='function'){try{next.setSelectionRange(caret[0],caret[1]);}catch{/* not a text control */}}
      }
    }
    return true;
  }
  const SECTIONS={strip:stripHtml,draft:draftHtml,rail:railHtml,runtime:runtimeHtml,packet:packetHtml,settings:settingsHtml,freeze:freezeHtml,round:roundHtml,runs:runsHtml,'pilot-gate':pilotGateHtml};
  /* The step rail summarises every other section, so it is repainted after any of them (it changes only when its markup does). */
  function paintRail(){setHtml($('#ag-rail'),railHtml());centerCurrentStep();}
  /* On a narrow screen the steps form a scrolling row. Bring the current step into view by moving only that row, never the page. */
  function centerCurrentStep(){
    try{
      const row=$('#ag-rail .ag-steps'),current=row&&row.querySelector&&row.querySelector('[aria-current="step"]');
      if(!current||!(row.scrollWidth>row.clientWidth))return;
      const item=current.parentNode||current;
      row.scrollLeft=Math.max(0,item.offsetLeft-(row.clientWidth-item.offsetWidth)/2);
    }catch{/* nothing to scroll */}
  }
  function paintSection(name){setHtml($('#ag-'+name),SECTIONS[name]());if(name!=='rail')paintRail();if(name==='strip'||name==='runs')updateTitle();}
  /* Every full paint also asks for any round the pilot gate still has to read; that call returns at once when it has them all. */
  function paintAll(){if(S.phase==='ready'){Object.keys(SECTIONS).forEach(paintSection);syncDesign();}}
  /* The tab title counts the pilots of the selected round that have ended, like "(3/5) Agents", while this page shows. */
  function titleText(){
    const runs=runsOf(S.round);
    if(!S.mounted||S.phase!=='ready'||!runs.length)return BASE_TITLE;
    return '('+runs.filter(run=>!isActiveRun(run)).length+'/'+runs.length+') Agents · '+BASE_TITLE;
  }
  function updateTitle(){try{const next=titleText();if(document.title!==next)document.title=next;}catch{/* no title to set */}}
  function paintRoot(){setHtml($('#ag-root'),pageInner(),true);centerCurrentStep();}
  function paintOverlay(){setHtml($('#agents-modal'),overlayHtml());}
  /* The gate and the freeze state live inside the round and freeze cards. Repainting them leaves the parent's cached markup out of date, so clear it. */
  function gates(){
    if(S.phase!=='ready')return;
    const gate=$('#ag-gate'),state=$('#ag-freeze-state');
    if(gate){setHtml(gate,gateHtml());const card=$('#ag-round');if(card)card.agHtml=null;}
    if(state){setHtml(state,freezeStateHtml());const card=$('#ag-freeze');if(card)card.agHtml=null;}
    paintRail();
  }
  const activeKey=()=>{const el=document.activeElement;return el&&el.getAttribute?el.getAttribute('data-ag-key'):null;};
  function focusKey(key){
    if(!key)return false;
    const el=document.querySelector('#agents-modal [data-ag-key="'+CSS.escape(key)+'"]')||document.querySelector('#ag-root [data-ag-key="'+CSS.escape(key)+'"]');
    if(el&&!el.disabled){el.focus({preventScroll:true});return true;}
    return false;
  }
  function say(text,isError){
    S.msg={text:String(text||''),error:!!isError};
    const el=$('#ag-status');
    if(el){el.textContent=S.msg.text;el.classList.toggle('error',S.msg.error);}
  }
  const locked=()=>!!S.working;
  async function work(name,fn){
    if(S.working)return;
    const keep=activeKey();
    S.working=name;
    paintAll();gates();
    try{return await fn();}
    catch(error){say(error.message||String(error),true);throw error;}
    finally{
      S.working='';
      paintAll();gates();
      if(S.overlay)paintOverlay();
      if(keep&&(!document.activeElement||document.activeElement===document.body))focusKey(keep);
    }
  }
  /* Run an action and show its failure in the status region instead of throwing into the event loop. */
  async function guarded(fn){try{await fn();}catch(error){if(!S.msg.error||S.msg.text!==error.message)say(error.message||String(error),true);}}

  /* ---------- Page ---------- */
  function offlineHtml(){
    return html`<section class="card ag-offline" role="status"><p>Local agents need the companion: run <code>npm start</code>.</p>${S.offlineNote?html`<p class="muted">${S.offlineNote}</p>`:''}</section>`;
  }
  function pageInner(){
    if(S.phase==='offline')return offlineHtml();
    if(S.phase!=='ready')return html`<section class="card" aria-busy="true" role="status"><p>Checking for the local companion.</p></section>`;
    return html`<div class="ag-shell">
      <aside class="ag-side"><nav id="ag-rail" class="ag-rail" aria-label="Round steps">${railHtml()}</nav>
        <div id="ag-draft" class="ag-draft">${draftHtml()}</div></aside>
      <div class="ag-main">
        <div class="dash-heading"><div><div class="eyebrow">Local agents</div><h1>Run blind pilots on your packet.</h1><p>Each pilot is a Claude Code agent working in its own folder on this computer. Write the gold before any output, approve the round, then read what the pilots did and classify their answers. Results are directional: no rate or difficulty is computed.</p></div></div>
        <div class="ag-top"><div id="ag-strip" class="ag-strip" aria-label="Selected round">${stripHtml()}</div>
        <div id="ag-status" class="ag-status ${S.msg.error?'error':''}" role="status" aria-live="polite" aria-atomic="true">${S.msg.text}</div></div>
        <section class="card" id="ag-runtime" aria-label="Runtime">${runtimeHtml()}</section>
        <section class="card" id="ag-packet" aria-label="Packet">${packetHtml()}</section>
        <section class="card" id="ag-settings" aria-label="Settings">${settingsHtml()}</section>
        <section class="card" id="ag-freeze" aria-label="Freeze">${freezeHtml()}</section>
        <section class="card" id="ag-round" aria-label="Round">${roundHtml()}</section>
        <section class="card" id="ag-runs" aria-label="Runs">${runsHtml()}</section>
        <section class="card" id="ag-pilot-gate" aria-label="Pilot gate">${pilotGateHtml()}</section>
      </div></div>`;
  }

  /* The step rail: where the round stands, step by step, and the one thing to do next. Each step has a state:
     done, warn (needs attention), active (pilots are running) or todo. The first step that is not done is the current one. */
  const STEPS=[['runtime','Runtime'],['packet','Packet'],['settings','Settings'],['freeze','Freeze'],['round','Approve and launch'],['runs','Runs']];
  function stepStates(){
    const rt=S.status&&S.status.runtime,r=S.round,runs=runsOf(r),c=roundCounts(runs),cfg=S.config;
    const files=S.packet.files,included=files?files.filter(effectiveInclude).length:0,words=wordsOf(S.prompt);
    const budget=budgetNumber(cfg.budget),budgetOk=!Number.isNaN(budget);
    const frozen=!!(r&&r.freeze&&r.status&&r.status!=='draft'),stale=!!(r&&isStale(r)),launched=!!(r&&(r.launchedAt||runs.length));
    const gate=launchGate(),live=c.running+c.waiting>0,over=!!(r&&['finished','failed','cancelled'].includes(r.status));
    const out={};
    out.runtime=rt&&rt.found?{s:'done',t:'Claude Code '+(rt.version||'found'),next:''}:{s:'warn',t:'Not found',next:'Install Claude Code, or set CLAUDE_BIN, then check again.'};
    if(S.packet.error)out.packet={s:'warn',t:'The folder could not be read',next:'Fix the folder path and inspect it again.'};
    else if(files&&included&&words)out.packet={s:'done',t:included+' of '+files.length+' files · '+words+(words===1?' word':' words'),next:''};
    else out.packet={s:'todo',t:!files?'Choose a folder':!included?'Include at least one file':'Write the prompt',next:!files?'Choose the folder that holds the solver files, then inspect it.':!included?'Include at least one file in the packet.':'Write the solver prompt.'};
    /* The defaults are usable, but the step only counts as done once the packet is: the settings are the next thing to look at. */
    out.settings=!budgetOk?{s:'warn',t:'Fix the spending cap',next:'Set a spending cap per pilot.'}:{s:out.packet.s==='done'?'done':'todo',t:cfg.model+' · '+cfg.effort+' · '+cfg.count+(cfg.count===1?' pilot':' pilots')+' · up to '+roundMax(cfg.count,budget),next:'Check the model, effort, pilots and spending cap.'};
    out.freeze=stale?{s:'warn',t:'The form changed since the freeze',next:'Freeze again: that makes a new round.'}:frozen?{s:'done',t:'Frozen',next:''}:{s:'todo',t:'Not frozen yet',next:'Write the gold and freeze it before any run.'};
    out.round=launched?{s:live?'active':'done',t:live?'Running':r.status==='finished'?'Finished':'Launched',next:''}:{s:'todo',t:gate.ok?(gate.resume?'Approved, not launched':'Ready for your approval'):'Waiting for the freeze',next:gate.ok?'Review and approve the round.':'Freeze the gold first.'};
    out.runs=runs.length?{s:live?'active':'done',t:c.done+' of '+runs.length+' finished'+(c.failed?' · '+c.failed+' failed':''),next:live?'':over?'Open a pilot to classify its answer.':''}:{s:'todo',t:'No pilots yet',next:'Pilots appear here once the round is launched.'};
    return out;
  }
  /* Yellow is for one action at a time. Of the buttons that would be primary together (Inspect, Freeze, Review and approve, and the
     rail's Next), only the one that moves the current step forward is: Inspect before a folder is listed, Freeze at the freeze
     step, Review and approve at the launch step, else the rail's Next button. Every other one is a default button. The
     buttons inside a dialog are alone in their dialog and keep their own primary. */
  function primaryId(){
    if(S.phase!=='ready')return '';
    const states=stepStates(),current=STEPS.find(([id])=>states[id].s!=='done');
    if(!current)return '';
    if(current[0]==='packet'&&!S.packet.files)return 'inspect';
    if(current[0]==='freeze')return 'freeze';
    if(current[0]==='round'&&launchGate().ok)return 'open-approve';
    return 'goto-step';
  }
  const primaryClass=id=>primaryId()===id?'primary':'';
  function railHtml(){
    if(S.phase!=='ready')return '';
    const states=stepStates();
    const current=STEPS.find(([id])=>states[id].s!=='done');
    const nextClass=primaryClass('goto-step');
    const mark=(s,i)=>s==='done'?'✓':s==='warn'?'!':s==='active'?'●':String(i+1);
    return html`<ol class="ag-steps">${STEPS.map(([id,label],i)=>html`<li><button type="button" class="ag-step is-${states[id].s}" data-ag="goto-step" data-step="${id}" data-ag-key="step-${id}" ${current&&current[0]===id?new Raw('aria-current="step"'):''}><span class="ag-step-mark" aria-hidden="true">${mark(states[id].s,i)}</span><span class="ag-step-text"><strong>${label}</strong><small>${states[id].t}</small></span></button></li>`)}</ol>
      ${current?html`<div class="ag-next" id="ag-next"><span class="ag-next-label">Next</span><p>${states[current[0]].next||(states[current[0]].s==='active'?'Pilots are running. Their results appear under Runs.':'Continue with '+current[1]+'.')}</p><button type="button" class="small ${nextClass}" data-ag="goto-step" data-step="${current[0]}" data-ag-key="step-next">Go to ${current[1]}</button></div>`:html`<div class="ag-next" id="ag-next"><span class="ag-next-label">All steps done</span><p>Classify each clean pilot, then export the round.</p><button type="button" class="small" data-ag="goto-step" data-step="runs" data-ag-key="step-next">Go to Runs</button></div>`}`;
  }
  /* Scroll to a step's card and put the keyboard on its first control. */
  function goStep(step){
    const card=STEPS.some(([id])=>id===step)?$('#ag-'+step):null;
    if(!card)return;
    let smooth=true;
    try{smooth=!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);}catch{smooth=true;}
    if(typeof card.scrollIntoView==='function')card.scrollIntoView({behavior:smooth?'smooth':'auto',block:'start'});
    const control=card.querySelector&&card.querySelector('input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])');
    if(control&&typeof control.focus==='function')control.focus({preventScroll:true});
  }

  /* Status strip: the selected round at a glance, repainted on every poll. */
  function roundCounts(runs){
    const c={total:runs.length,done:0,running:0,waiting:0,failed:0,cancelled:0};
    runs.forEach(run=>{
      if(run.state==='completed')c.done++;
      else if(run.state==='running')c.running++;
      else if(run.state==='queued')c.waiting++;
      else if(run.state==='failed')c.failed++;
      else if(run.state==='cancelled')c.cancelled++;
    });
    return c;
  }
  function stripHtml(){
    const r=S.round;
    const other=S.rounds.find(x=>x&&x.status==='running'&&(!r||x.id!==r.id));
    const otherNote=other?html`<span class="ag-strip-item ag-strip-other">Round ${other.id} is running.</span>`:'';
    if(!r)return html`<span class="ag-strip-item">No round selected.</span>${otherNote}`;
    const c=roundCounts(runsOf(r));
    return html`<span class="ag-strip-item"><strong>Round ${r.id}</strong> ${pill(r.status||'draft',statusKind(r.status))}</span>
      <span class="ag-strip-item" id="ag-strip-pilots">${c.total?'Pilots '+c.total+': done '+c.done+' · running '+c.running+(c.waiting?' · waiting '+c.waiting:'')+' · failed '+c.failed+(c.cancelled?' · cancelled '+c.cancelled:''):'No pilots started yet'}</span>
      <span class="ag-strip-item" id="ag-strip-elapsed">${r.launchedAt?'Elapsed '+spanText(r.launchedAt,r.endedAt):'Not launched'}</span>${otherNote}`;
  }

  /* The draft kept in this browser, and the button that removes it. */
  function draftHtml(){
    const paused=anyRunning();
    const note=paused?'A round is running, so the form is not saved in this browser until it has ended.'
      :S.draftSavedAt?'Your form is saved in this browser (last saved '+timeText(S.draftSavedAt)+'), so a reload keeps it. Launching a round removes it.'
        :'The form is saved in this browser as you type, so a reload keeps it. Launching a round removes it.';
    return html`<p class="muted">${note}</p><button type="button" class="small" data-ag="clear-draft" data-ag-key="clear-draft" data-ag-lock ${locked()?'disabled':''}>Clear draft</button>`;
  }

  /* 1. Runtime */
  function runtimeHtml(){
    const rt=S.status.runtime;
    if(rt.found){
      return html`<div class="card-title"><div><div class="eyebrow">1 Runtime</div><h2>Claude Code was found</h2></div><div class="actions">${pill('Found','green')}<button type="button" class="small" data-ag="check-runtime" data-ag-key="check-runtime">Check again</button></div></div>
        <dl class="history-details"><dt>Version</dt><dd>${rt.version||'unknown'}</dd><dt>Path</dt><dd>${rt.path||'unknown'}</dd><dt>Found by</dt><dd>${rt.source||'unknown'}</dd><dt>Pilot limit</dt><dd>At most ${S.status.max} per round</dd></dl>
        <p class="footnote">Detection only runs claude --version. It never starts a model.</p>`;
    }
    return html`<div class="card-title"><div><div class="eyebrow">1 Runtime</div><h2>Claude Code was not found</h2></div>${pill('Not found','amber')}</div>
      <div class="notice">Pilots need the claude command. Install Claude Code and sign in from your own terminal, or set CLAUDE_BIN to its path before running npm start, then check again. Nothing here will install or sign in for you.</div>
      <div class="actions"><button type="button" class="small" data-ag="check-runtime" data-ag-key="check-runtime">Check again</button></div>`;
  }

  /* 2. Packet */
  function packetHtml(){
    const p=S.packet,files=p.files,included=files?files.filter(effectiveInclude).length:0,gafCount=files?files.filter(f=>isGaf(f.path)).length:0;
    const words=wordsOf(S.prompt),limit=promptLimit();
    return html`<div class="card-title"><div><div class="eyebrow">2 Packet</div><h2>Choose the solver files and prompt</h2></div>${files?pill(included+' of '+files.length+' files included','violet'):pill('Not inspected')}</div>
      <p class="muted">The companion lists the regular files of the folder you choose (no symlinks). Nothing is copied anywhere until you launch a round, and each pilot gets only the files ticked below. Inside its own folder a pilot finds them under <code>./filesystem/</code>, with the folder structure kept, so choose the folder that is the production <code>filesystem</code> folder itself.</p>
      <div class="ag-row"><label class="field ag-grow">Folder path<input type="text" id="ag-dir" data-ag-in="dir" data-ag-key="dir" value="${p.dir}" maxlength="1024" autocomplete="off" spellcheck="false" placeholder="/Users/you/Downloads/task/filesystem" aria-describedby="ag-path-hint"></label><button type="button" class="${primaryClass('inspect')}" data-ag="inspect" data-ag-key="inspect" data-ag-lock ${locked()?'disabled':''}>Inspect</button></div>
      <p class="footnote" id="ag-path-hint">${PACKET_PATH_HINT}</p>
      ${p.error?html`<div class="notice" role="alert">${p.error}</div>`:''}
      ${files&&files.some(f=>/^filesystem\//.test(f.path))?html`<div class="notice" role="status"><strong>This folder already holds a filesystem/ folder.</strong> Pilots would see ./filesystem/filesystem/..., which is not the production layout. Choose the filesystem folder itself, or go on if this nesting is what you want.</div>`:''}
      ${files?filesTableHtml(files):html`<div class="empty">No folder inspected yet.</div>`}
      <label class="field">Solver prompt<textarea id="ag-prompt" data-ag-in="prompt" data-ag-key="prompt" rows="6" maxlength="20000" spellcheck="true">
${S.prompt}</textarea></label>
      <div class="ag-row"><p id="ag-wordcount" class="ag-count ${words>limit?'over':''}">${wordsText(words,limit)}</p><button type="button" class="small" data-ag="use-project-prompt" data-ag-key="use-project-prompt">Use the project prompt</button></div>
      <p class="footnote" id="ag-prefix-note">${PREFIX_HEADING}. The approval dialog shows it word for word.</p>
      <label class="check"><input type="checkbox" data-ag-in="gaf" data-ag-key="gaf" ${p.gafVisible?'checked':''}><span><strong>The solver can see the gaf/ folder${files?' ('+gafCount+(gafCount===1?' file':' files')+' in this packet)':''}</strong>${GAF_SENTENCE}</span></label>`;
  }
  const wordsText=(words,limit)=>words+' words. Project limit '+limit+(words>limit?'. Over the limit.':'.');
  function effectiveInclude(f){return f.include&&!f.excluded&&(S.packet.gafVisible||!isGaf(f.path));}
  function filesTableHtml(files){
    if(!files.length)return html`<div class="empty">The folder has no regular files.</div>`;
    return html`<div class="table-wrap"><table class="ag-table"><caption class="sr-only">Files in the packet folder</caption><thead><tr><th scope="col">Include</th><th scope="col">File</th><th scope="col">Role</th><th scope="col">Size</th><th scope="col">Note</th></tr></thead><tbody>${files.map((f,i)=>{
      const hidden=isGaf(f.path)&&!S.packet.gafVisible,unusable=!!f.excluded,override=f.include&&!hidden&&!unusable&&!f.defaultInclude;
      const check=!unusable&&f.defaultInclude&&gafGradingWord(f.path);
      return html`<tr><td data-label="Include"><label class="check ag-include"><input type="checkbox" data-ag-in="include" data-i="${i}" data-ag-key="inc-${i}" ${f.include&&!hidden&&!unusable?'checked':''} ${hidden||unusable?'disabled':''} aria-label="${(f.defaultInclude?'Include ':'Include anyway, override: ')+f.path}">${f.defaultInclude?'':html`<small>override</small>`}</label></td>
        <td data-label="File"><code class="ag-path">${f.path}</code>${override?pill('Override','amber'):''}${hidden?pill('Hidden: gaf/ is off'):''}${unusable?pill('Cannot be used','amber'):''}${check?pill('Check: grading word in a gaf/ file','amber'):''}</td>
        <td data-label="Role">${f.role}</td><td data-label="Size">${bytesText(f.bytes)}</td><td data-label="Note">${f.reason||(check?'Included because it is in gaf/, which the production solver sees. Its name has a grading word, which withholds a file anywhere else: make sure pilots should see it.':f.defaultInclude?'':'Excluded by default')}</td></tr>`;
    })}</tbody></table></div>`;
  }
  function normalizeFile(f){
    const excluded=!!(f&&f.excluded),defaultInclude=!excluded&&f&&f.defaultInclude===true;
    return {path:String(f&&f.path||''),bytes:Number(f&&f.bytes)||0,sha256:String(f&&f.sha256||''),role:String(f&&(f.inferredRole||f.role)||'unknown'),defaultInclude,reason:String(f&&f.reason||''),include:defaultInclude,excluded};
  }
  function setGaf(on){
    S.packet.gafVisible=!!on;
    (S.packet.files||[]).forEach(f=>{if(isGaf(f.path)&&!f.excluded)f.include=!!on;});
    paintSection('packet');gates();
  }
  function updateWordCount(){
    const el=$('#ag-wordcount');
    if(!el)return;
    const words=wordsOf(S.prompt),limit=promptLimit();
    el.textContent=wordsText(words,limit);
    el.classList.toggle('over',words>limit);
  }

  /* 3. Settings: everything the freeze fixes besides the packet and the gold, so it is chosen before freezing. */
  function settingsHtml(){
    const st=S.status,cfg=S.config,budget=budgetNumber(cfg.budget);
    return html`<div class="card-title"><div><div class="eyebrow">3 Settings</div><h2>Model, effort, pilots and spending cap</h2></div>${pill(cfg.count+(cfg.count===1?' pilot':' pilots')+(atOnceOf(cfg)===cfg.count?' · one wave':' · '+Math.ceil(cfg.count/atOnceOf(cfg))+' waves'))}</div>
      <p class="muted">Choose these before you freeze: freezing fixes them for the round it creates. Change one afterwards and the freeze no longer matches, so you freeze again, which creates a new round.</p>
      <div class="field-row three">
        <label class="field">Model<select data-ag-in="model" data-ag-key="model">${st.models.map(m=>html`<option value="${m.id}" ${m.id===cfg.model?'selected':''}>${m.id}</option>`)}</select></label>
        <label class="field">Effort<select data-ag-in="effort" data-ag-key="effort">${st.efforts.map(m=>html`<option value="${m.id}" ${m.id===cfg.effort?'selected':''}>${m.id}</option>`)}</select></label>
        <div class="field"><span id="ag-count-label">Pilots (1 to ${st.max})</span><div class="ag-stepper" role="group" aria-labelledby="ag-count-label">
          <button type="button" class="small" data-ag="count-dec" data-ag-key="count-dec" aria-label="Fewer pilots" ${cfg.count<=1?'disabled':''}>-</button>
          <input type="number" id="ag-count" data-ag-in="count" data-ag-key="count" min="1" max="${st.max}" step="1" value="${cfg.count}" aria-labelledby="ag-count-label">
          <button type="button" class="small" data-ag="count-inc" data-ag-key="count-inc" aria-label="More pilots" ${cfg.count>=st.max?'disabled':''}>+</button></div></div>
      </div>
      <div class="field-row three">
        <label class="field">Pilots at a time<select id="ag-atonce" data-ag-in="atonce" data-ag-key="atonce"><option value="0" ${atOnceOf(cfg)===cfg.count?'selected':''}>All ${cfg.count} at once</option>${Array.from({length:Math.max(0,cfg.count-1)},(_,i)=>i+1).map(n=>html`<option value="${n}" ${cfg.atOnce===n?'selected':''}>${n} at a time</option>`)}</select><small>All at once ends the round within one time limit (${TIME_LIMIT_MINUTES} minutes). Fewer at a time takes longer.</small></label>
        <label class="field">Spending cap per pilot (USD)<input type="text" inputmode="decimal" id="ag-budget" data-ag-in="budget" data-ag-key="budget" value="${cfg.budget}" maxlength="6" autocomplete="off" spellcheck="false"><small>Passed to each pilot as --max-budget-usd. From ${BUDGET.minUsd.toFixed(2)} to ${BUDGET.maxUsd.toFixed(2)}.</small></label>
        <div class="field"><span>Round maximum spend</span><strong id="ag-roundmax" class="ag-spend">${spendText()}</strong><small>The pilots times the cap per pilot. The runtime stops a pilot that reaches its cap.</small></div>
      </div>
      <p class="footnote" id="ag-cap-note">${CAP_STATEMENT}</p>
      <p id="ag-budget-error" class="ag-why" role="alert">${Number.isNaN(budget)?'The spending cap per pilot must be a number of US dollars from '+BUDGET.minUsd.toFixed(2)+' to '+BUDGET.maxUsd.toFixed(2)+', in whole cents.':''}</p>
      <div class="field-row">
        <label class="field">Task<input type="text" id="ag-task" data-ag-in="task" data-ag-key="task" list="ag-task-list" value="${S.task}" maxlength="${TASK_MAX}" autocomplete="off" spellcheck="false" placeholder="Task name, for example Atlas" aria-describedby="ag-task-note"></label>
        <label class="field">Round label (optional)<input type="text" data-ag-in="label" data-ag-key="label" value="${S.label}" maxlength="120" autocomplete="off" placeholder="Pilot round"></label>
      </div>
      <datalist id="ag-task-list">${knownTasks().map(name=>html`<option value="${name}"></option>`)}</datalist>
      <p class="footnote" id="ag-task-note">The task groups this round with the others for the same task package. It is stored with the round when you freeze. Changing it later does not make the freeze stale and does not change a round that already exists.</p>`;
  }
  /* The task names of the rounds the companion holds, one per name (compared without case or extra spaces), for the Task field's suggestions. */
  function knownTasks(){
    const seen=new Map();
    S.rounds.forEach(r=>{
      const name=taskText(r&&r.task).replace(/\s+/g,' ');
      if(name&&!seen.has(taskKeyOf(name)))seen.set(taskKeyOf(name),name);
    });
    return [...seen.values()].sort((a,b)=>a.localeCompare(b)).slice(0,100);
  }
  function spendText(){
    const budget=budgetNumber(S.config.budget);
    return Number.isNaN(budget)?'Not set: fix the cap per pilot':roundMax(S.config.count,budget)+' ('+S.config.count+' × '+usd(budget)+')';
  }
  function updateSpend(){
    const el=$('#ag-roundmax'),error=$('#ag-budget-error');
    if(el)el.textContent=spendText();
    if(error)error.textContent=Number.isNaN(budgetNumber(S.config.budget))?'The spending cap per pilot must be a number of US dollars from '+BUDGET.minUsd.toFixed(2)+' to '+BUDGET.maxUsd.toFixed(2)+', in whole cents.':'';
    const card=$('#ag-settings');if(card)card.agHtml=null;
  }

  /* 4. Freeze */
  function freezeHtml(){
    const f=S.fz;
    return html`<div class="card-title"><div><div class="eyebrow">4 Freeze</div><h2>Freeze the gold before any run</h2></div></div>
      <p class="muted">Write down what a correct answer says and which wrong answers you expect, before you see any output. Freezing stores a hash and a time stamp, and a content hash of the gold and fingerprints alone, which stays the same when the same content is frozen again. It also fixes the packet, prompt and settings for this round: change any of them afterwards and you must freeze again, which creates a new round.</p>
      <label class="field">Gold decision keywords or phrase<input type="text" data-ag-in="decision" data-ag-key="decision" value="${f.decision}" maxlength="500" autocomplete="off" placeholder="What a correct answer must say, as typed"><small>Separate alternatives with a semicolon; any one of them counts. Used only for the heuristic suggestion. You make the final call on every run.</small></label>
      <h3>Gold figures</h3>
      <p class="footnote" id="ag-figure-note">${FIGURE_NOTE}</p>
      <div class="ag-figlist">${f.figures.map((fig,j)=>figureRowHtml('gfig',0,j,fig,'gold figure'))}</div>
      <div class="actions"><button type="button" class="small" data-ag="add-gfig" data-ag-key="add-gfig">Add a gold figure</button></div>
      <label class="field">Gold notes (optional)<textarea data-ag-in="notes" data-ag-key="notes" rows="3" maxlength="4000">
${f.notes}</textarea></label>
      <h3>Fingerprints of expected wrong answers</h3>
      <div class="ag-fplist">${f.fingerprints.map((fp,i)=>fingerprintHtml(fp,i))}</div>
      <div class="actions"><button type="button" class="small" data-ag="add-fp" data-ag-key="add-fp">Add a fingerprint</button></div>
      <h3>Ship bar (optional)</h3>
      ${shipBarHtml()}
      <div id="ag-freeze-state">${freezeStateHtml()}</div>`;
  }
  /* The ship bar is decided before the first run and frozen with the gold, inside the content hash, so it cannot be moved once
     verdicts come in. The Pilot gate card reads it. */
  function shipBarHtml(){
    const b=S.fz.bar,off=b.on?'':'disabled';
    return html`<label class="check"><input type="checkbox" data-ag-in="bar-on" data-ag-key="bar-on" ${b.on?'checked':''}><span><strong>Freeze a ship bar with the gold</strong>Decide now, before any run, how many wrong answers this design needs before it ships. It is frozen with the gold and covered by the content hash, so it cannot move once verdicts come in.</span></label>
      <div class="field-row" id="ag-ship-bar"><label class="field">At least this many wrong<input type="number" data-ag-in="bar" data-f="wrong" data-ag-key="bar-wrong" min="1" max="${SHIP_BAR.maxRuns}" step="1" value="${b.wrong}" ${off}></label>
        <label class="field">Of this many runs<input type="number" data-ag-in="bar" data-f="of" data-ag-key="bar-of" min="1" max="${SHIP_BAR.maxRuns}" step="1" value="${b.of}" ${off}><small>Whole numbers, at most ${SHIP_BAR.maxRuns} runs. A usual bar is ${SHIP_BAR.suggestWrong} of ${SHIP_BAR.suggestOf}.</small></label></div>`;
  }
  const barText=bar=>'at least '+bar.wrong+' wrong of '+bar.of;
  function figureRowHtml(kind,i,j,fig,word){
    const base=`${kind}-${i}-${j}`;
    return html`<div class="ag-figrow">
      <label class="field">Label<input type="text" data-ag-in="fig" data-kind="${kind}" data-i="${i}" data-j="${j}" data-f="label" data-ag-key="${base}-label" value="${fig.label}" maxlength="120" autocomplete="off"></label>
      <label class="field">Value<input type="text" inputmode="decimal" data-ag-in="fig" data-kind="${kind}" data-i="${i}" data-j="${j}" data-f="value" data-ag-key="${base}-value" value="${fig.value}" maxlength="40" autocomplete="off"></label>
      <label class="field">Tolerance (absolute, same unit as the value)<input type="text" inputmode="decimal" data-ag-in="fig" data-kind="${kind}" data-i="${i}" data-j="${j}" data-f="tolerance" data-ag-key="${base}-tolerance" value="${fig.tolerance}" maxlength="40" autocomplete="off" placeholder="0"></label>
      <button type="button" class="small danger" data-ag="remove-fig" data-kind="${kind}" data-i="${i}" data-j="${j}" data-ag-key="${base}-remove" aria-label="Remove ${word} ${j+1}">Remove</button></div>`;
  }
  function fingerprintHtml(fp,i){
    return html`<fieldset class="ag-fp"><legend>Fingerprint ${i+1}</legend>
      <div class="field-row"><label class="field">Id<input type="text" data-ag-in="fp" data-i="${i}" data-f="id" data-ag-key="fp-${i}-id" value="${fp.id}" maxlength="40" autocomplete="off" spellcheck="false"><small>Lower case letters, digits and hyphens.</small></label>
      <label class="field">Label<input type="text" data-ag-in="fp" data-i="${i}" data-f="label" data-ag-key="fp-${i}-label" value="${fp.label}" maxlength="160" autocomplete="off"></label></div>
      <label class="field">Tokens, one per line<textarea data-ag-in="fp" data-i="${i}" data-f="tokens" data-ag-key="fp-${i}-tokens" rows="3" maxlength="4000" spellcheck="false">
${fp.tokens}</textarea><small>A hit needs every token (or every figure) of the fingerprint. Numbers match with thousands separators removed.</small></label>
      <details ${fp.figures.length?'open':''}><summary>Figures for this fingerprint (optional)</summary>
        <div class="ag-figlist">${fp.figures.map((fig,j)=>figureRowHtml('pfig',i,j,fig,'fingerprint figure'))}</div>
        <div class="actions"><button type="button" class="small" data-ag="add-pfig" data-i="${i}" data-ag-key="add-pfig-${i}">Add a figure</button></div></details>
      <div class="actions"><button type="button" class="small danger" data-ag="remove-fp" data-i="${i}" data-ag-key="remove-fp-${i}" aria-label="Remove fingerprint ${i+1}">Remove fingerprint</button></div></fieldset>`;
  }
  function figList(kind,i){
    if(kind==='gfig')return S.fz.figures;
    const fp=S.fz.fingerprints[i];
    return kind==='pfig'&&fp?fp.figures:null;
  }
  /* Every freeze version of a round, oldest first: the original, then each post-hoc version stored beside it. */
  function freezeVersions(r){
    const list=[];
    if(r&&r.freeze)list.push(r.freeze);
    if(r&&Array.isArray(r.postHocFreezes))r.postHocFreezes.forEach(v=>{if(v&&typeof v==='object')list.push(v);});
    return list;
  }
  /* The fingerprints a pilot can be matched to: those of the original freeze, plus any a post-hoc version added. The latest wording wins. */
  function knownFingerprints(r){
    const byId=new Map();
    freezeVersions(r).forEach(v=>(Array.isArray(v.fingerprints)?v.fingerprints:[]).forEach(fp=>{
      if(fp&&typeof fp.id==='string')byId.set(fp.id,{...fp,postHoc:!!v.postHoc&&!(byId.has(fp.id)&&!byId.get(fp.id).postHoc)});
    }));
    return [...byId.values()];
  }
  function freezeStateHtml(){
    const r=S.round,fr=r&&r.freeze,stale=r&&isStale(r),versions=freezeVersions(r);
    const afterDraft=r&&r.status&&!['draft','frozen'].includes(r.status);      /* approved or later: the freeze cannot be edited any more */
    const wasLaunched=!!(r&&(r.launchedAt||runsOf(r).length));               /* only a launched round can take a post-hoc version */
    /* The form is known to match the round only when this page froze it from the form (a signature it kept). */
    const known=!!(r&&S.sigs[r.id]),settled=!!(fr&&!afterDraft&&!stale&&known);
    return html`${S.fz.errors.length?html`<div class="notice" role="alert"><strong>Fix before freezing</strong><ul class="plain-list">${S.fz.errors.map(e=>html`<li>${e}</li>`)}</ul></div>`:''}
      ${r&&r.carriedFrom?carryHtml(r):''}
      ${fr?versions.map(v=>html`<div class="notice neutral"><strong>${v.postHoc?'Post-hoc freeze version ':'Frozen '}${v.version?'(version '+v.version+')':''}</strong>
        <dl class="history-details"><dt>Round</dt><dd>${r.id}</dd><dt>${v.postHoc?'Saved at':'Frozen at'}</dt><dd>${timeText(v.frozenAt)}</dd><dt>Freeze SHA-256</dt><dd>${v.sha256}</dd>${v.contentSha256?html`<dt>Content SHA-256</dt><dd>${v.contentSha256} <small>(gold and fingerprints${v.shipBar?' and the ship bar':''}, without the time stamp)</small></dd>`:''}${v.shipBar?html`<dt>Ship bar</dt><dd>${barText(v.shipBar)} runs</dd>`:''}${v.postHoc?html`<dt>Label</dt><dd>Post-hoc: written after launch, stored beside the original freeze</dd>`:''}</dl></div>`):html`<p class="muted">No freeze record for the selected round. Launch stays disabled until the gold is frozen.</p>`}
      ${stale?html`<div class="notice" role="status">The packet, prompt, settings or gold on this page no longer match the freeze of round ${r.id}. Freeze again to create a new round.</div>`:''}
      ${fr&&!afterDraft&&!known?html`<p class="footnote" id="ag-unknown-form">This page did not freeze round ${r.id} (or was reloaded since), so it cannot tell whether the form matches it. The approval dialog shows exactly what the round holds. Freeze again to make a new round from the form.</p>`:''}
      <div class="actions"><button type="button" class="${primaryClass('freeze')}" data-ag="freeze" data-ag-key="freeze" data-ag-lock ${locked()||settled?'disabled':''}>${settled?'Gold is frozen':fr?'Freeze again (new round)':'Freeze gold'}</button>
      ${wasLaunched&&fr?html`<button type="button" data-ag="refreeze" data-ag-key="refreeze" data-ag-lock ${locked()?'disabled':''}>Save a post-hoc freeze version</button>`:''}</div>
      ${wasLaunched&&fr?html`<p class="footnote">A post-hoc version is stored beside the original, labelled post-hoc. It never replaces the original freeze. Fingerprints it adds can be chosen when you classify a run.${fr.shipBar?' It keeps the ship bar frozen before the first run.':''}</p>`:''}`;
  }
  /* A round started from an earlier one: where it came from, both content hashes, and whether the content changed. */
  function carryHtml(r){
    const c=r.carried&&typeof r.carried==='object'?r.carried:{},ch=r.carryChanges&&typeof r.carryChanges==='object'?r.carryChanges:{};
    const own=r.freeze&&r.freeze.contentSha256;
    const content=ch.freezeContent===true?'changed':ch.freezeContent===false?'unchanged':'not frozen yet';
    /* The companion compares a ship bar apart from the gold, and says so only when one of the two rounds has a bar. */
    const bar='shipBar' in ch?(ch.shipBar===true?'changed':ch.shipBar===false?'unchanged':'not frozen yet'):'';
    const other=[['packet','packet files'],['prompt','prompt'],['gafVisible','gaf setting'],['settings','settings']].filter(([k])=>ch[k]===true).map(([,label])=>label);
    return html`<div class="notice neutral" id="ag-carry"><strong>Carried forward from round ${r.carriedFrom}</strong>
      <dl class="history-details"><dt>Its freeze</dt><dd>Version ${c.freezeVersion||'?'}${c.postHoc?', post-hoc':''}: SHA-256 ${c.freezeSha256||'not reported'}</dd>
        <dt>Its content SHA-256</dt><dd>${c.contentSha256||'not reported'}</dd>
        <dt>This round's content SHA-256</dt><dd>${own||(r.freeze?'not reported':'Not frozen yet. Check the gold and fingerprints below, then freeze to confirm them.')}</dd>
        <dt>Gold and fingerprints</dt><dd>${content}</dd>${bar?html`<dt>Ship bar</dt><dd>${bar}</dd>`:''}
        <dt>Also changed</dt><dd>${other.length?other.join(', '):'nothing'}</dd></dl>
      <p class="footnote">Carrying a round forward fills the form. It never freezes, approves or launches anything: this round needs its own freeze and its own approval.</p></div>`;
  }
  /* A figure as the companion reads it: the same steps as parseFigure in backend/agents/classify.cjs (tests/agents-page.test.cjs runs both over a
     list of inputs and compares them). "$12,450", "(1,200)" (negative), "12%" (12, not 0.12) and "3.2x" are figures; "1e3" and "12 EUR" are not.
     Returns null if unusable. The one addition: a typed figure is never Infinity (the input holds 40 characters, so it cannot come up). */
  const FIGURE_RE=/^[-+]?(?:\d+\.?\d*|\.\d+)$/;
  function parseFigure(value){
    if(typeof value==='number')return Number.isFinite(value)?value:null;
    if(typeof value!=='string')return null;
    let text=value.slice(0,4000000).normalize('NFKC').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/[\u2010-\u2015\u2212]/g,'-').trim();
    let negative=false;
    if(/^\(.*\)$/.test(text)){negative=true;text=text.slice(1,-1).trim();}
    text=text.replace(/[$\u20ac\u00a3\u00a5,\s]/g,'').replace(/[%x]$/i,'');
    if(!FIGURE_RE.test(text))return null;
    const parsed=Number(text);
    return negative?-parsed:parsed;
  }
  function cleanFigure(fig,name,errors){
    const label=String(fig.label||'').trim();
    const typed=parseFigure(String(fig.value||'')),toleranceText=String(fig.tolerance||'').trim();
    const value=Number.isFinite(typed)?typed:NaN,tolerance=toleranceText===''?0:parseFigure(toleranceText);
    if(!label)errors.push(name+' needs a label.');
    if(Number.isNaN(value))errors.push(name+' needs a numeric value.');
    if(!Number.isFinite(tolerance)||tolerance<0)errors.push(name+' has a tolerance that is not a number of zero or more.');
    return {label,value,tolerance};
  }
  const blankFig=fig=>!String(fig.label||'').trim()&&!String(fig.value||'').trim()&&!String(fig.tolerance||'').trim();
  const blankFp=fp=>!String(fp.label||'').trim()&&!String(fp.tokens||'').trim()&&fp.figures.every(blankFig)&&/^fp-\d+$/.test(String(fp.id||'').trim());
  /* withBar false: a post-hoc version, which keeps the ship bar of the original freeze, so the bar fields are not read. */
  function buildFreeze(withBar=true){
    const errors=[];
    const gold={decision:S.fz.decision.trim(),figures:[],notes:S.fz.notes.trim()};
    S.fz.figures.forEach((fig,j)=>{if(!blankFig(fig))gold.figures.push(cleanFigure(fig,'Gold figure '+(j+1),errors));});
    if(!gold.decision&&!gold.figures.length)errors.push('Add a gold decision phrase or at least one gold figure.');
    const fingerprints=[],seen=new Set();
    S.fz.fingerprints.forEach((fp,i)=>{
      if(blankFp(fp))return;
      const id=String(fp.id||'').trim(),tokens=lines(fp.tokens).map(t=>t.slice(0,200)).slice(0,30),figures=[];
      fp.figures.forEach((fig,j)=>{if(!blankFig(fig))figures.push(cleanFigure(fig,'Fingerprint '+(i+1)+' figure '+(j+1),errors));});
      if(!FINGERPRINT_ID_RE.test(id))errors.push('Fingerprint '+(i+1)+': the id needs 2 to 40 lower case letters, digits or hyphens.');
      else if(seen.has(id))errors.push('Fingerprint '+(i+1)+': the id '+id+' is used twice.');
      seen.add(id);
      if(!tokens.length&&!figures.length)errors.push('Fingerprint '+(i+1)+' needs at least one token or figure.');
      fingerprints.push({id,label:String(fp.label||'').trim()||id,tokens,figures});
    });
    let shipBar=null;
    if(withBar&&S.fz.bar.on){
      const wrong=wholeOf(S.fz.bar.wrong),of=wholeOf(S.fz.bar.of);
      if(wrong>=1&&of>=wrong&&of<=SHIP_BAR.maxRuns)shipBar={wrong,of};
      else errors.push('The ship bar needs whole numbers: at least 1 wrong, of no fewer runs than that, and at most '+SHIP_BAR.maxRuns+' runs.');
    }
    return {gold,fingerprints,shipBar,errors};
  }
  const wholeOf=value=>/^\s*\d{1,2}\s*$/.test(String(value==null?'':value))?Number(value):NaN;
  /* The bar is in the signature only while it is ticked, so a form without one keeps the signature it had before the bar existed. */
  function freezeContent(){
    const trimmed=fig=>({label:String(fig.label).trim(),value:String(fig.value).trim(),tolerance:String(fig.tolerance).trim()});
    return {decision:S.fz.decision.trim(),notes:S.fz.notes.trim(),figures:S.fz.figures.filter(f=>!blankFig(f)).map(trimmed),
      fingerprints:S.fz.fingerprints.filter(fp=>!blankFp(fp)).map(fp=>({id:fp.id.trim(),label:fp.label.trim(),tokens:lines(fp.tokens),figures:fp.figures.filter(f=>!blankFig(f)).map(trimmed)})),
      ...(S.fz.bar.on?{shipBar:{wrong:String(S.fz.bar.wrong).trim(),of:String(S.fz.bar.of).trim()}}:{})};
  }
  function inputSig(){
    const files=S.packet.files||[];
    return JSON.stringify({dir:S.packet.inspectedDir,include:files.filter(effectiveInclude).map(f=>f.path),prompt:S.prompt.trim(),gaf:S.packet.gafVisible,
      model:S.config.model,effort:S.config.effort,count:S.config.count,atOnce:atOnceOf(S.config),budget:budgetNumber(S.config.budget),freeze:freezeContent()});
  }
  function isStale(round){
    const sig=S.sigs[round.id];
    return !!sig&&sig!==inputSig();
  }
  function formErrors(){
    const errors=[],p=S.packet;
    if(!p.files)errors.push('Inspect a packet folder first.');
    else{
      if(p.dir.trim()!==p.inspectedDir)errors.push('The folder path changed after it was inspected. Inspect it again.');
      if(!p.files.some(effectiveInclude))errors.push('Include at least one file in the packet.');
    }
    if(!S.prompt.trim())errors.push('Write the solver prompt.');
    if(Number.isNaN(budgetNumber(S.config.budget)))errors.push('Set the spending cap per pilot: a number of US dollars from '+BUDGET.minUsd.toFixed(2)+' to '+BUDGET.maxUsd.toFixed(2)+'.');
    return errors;
  }
  function roundBody(){
    const files=(S.packet.files||[]).filter(effectiveInclude);
    /* task is always sent, also when empty: a round carried forward keeps its task only when the request names none, so an empty
       Task field after the writer cleared it must say so. Neither task nor versions is in inputSig: they never make a freeze stale. */
    const body={label:S.label.trim()||'Pilot round',task:taskText(S.task),sourceDir:S.packet.inspectedDir,include:files.map(f=>f.path),overrides:files.filter(f=>!f.defaultInclude).map(f=>f.path),
      promptText:S.prompt,gafVisible:S.packet.gafVisible,
      config:{kind:'pilot',model:S.config.model,effort:S.config.effort,count:S.config.count,maxBudgetUsd:budgetNumber(S.config.budget),concurrency:atOnceOf(S.config)}};
    const versions=projectVersions();
    if(versions)body.versions=versions;
    /* A round frozen from the form after "Start next round" still names the round it came from. */
    if(S.carry&&idOk(S.carry.from))body.carriedFrom=S.carry.from;
    return body;
  }

  /* 5. Round: the settings the selected round was frozen with, the statements, and the approval gate. */
  function roundHtml(){
    const r=S.round;
    return html`<div class="card-title"><div><div class="eyebrow">5 Round</div><h2>Approve and launch</h2></div>${r?pill('Round '+r.id+' · '+(r.status||'draft'),statusKind(r.status)):pill('No round yet')}</div>
      ${r&&r.config?roundFactsHtml(r):html`<p class="muted">Freezing the gold creates a round with the settings above.</p>`}
      <div class="notice"><strong>Read this before you launch</strong><ul class="plain-list"><li>${SHELL_STATEMENT}</li><li>${ISOLATION_STATEMENT}</li><li>${NETWORK_STATEMENT}</li><li>Each pilot works in its own folder holding only the files you ticked, an empty outputs folder and an empty scratch folder.</li></ul></div>
      <div id="ag-gate">${gateHtml()}</div>`;
  }
  /* What the round itself holds (the companion's copy), so the spend shown is what the approval covers. */
  function roundFactsHtml(r){
    const cfg=r.config,budget=Number(cfg.maxBudgetUsd==null?BUDGET.pilotDefault:cfg.maxBudgetUsd),prefix=prefixOf(approvalSummary(r).summary);
    return html`<dl class="history-details" id="ag-round-facts"><dt>Model and effort</dt><dd>${cfg.model||'-'} · ${cfg.effort||'-'}</dd>
      <dt>Pilots</dt><dd>${cfg.count} (${pacingText(cfg)})</dd>
      <dt>Spending cap per pilot</dt><dd>${usd(budget)} (--max-budget-usd ${budget.toFixed(2)})</dd>
      <dt>Round maximum spend</dt><dd>${roundMax(cfg.count,budget)}</dd>
      ${prefix!==null?html`<dt>${PREFIX_HEADING}</dt><dd id="ag-facts-prefix">${prefix}</dd>`:''}
      ${r.carriedFrom?html`<dt>Carried forward from</dt><dd>${r.carriedFrom}</dd>`:''}</dl>`;
  }
  function launchGate(){
    const r=S.round;
    if(!r||!r.freeze)return {ok:false,why:'Freeze the gold first. Launch stays disabled until a freeze record exists.'};
    if(S.status&&S.status.runtime&&!S.status.runtime.found)return {ok:false,why:'Claude Code was not found, so nothing can start. Install it or set CLAUDE_BIN, then use Check again in step 1.'};
    if(r.status==='draft')return {ok:false,why:'The round has no freeze yet. Freeze the gold first.'};
    if(!['frozen','approved'].includes(r.status))return {ok:false,why:'Round '+r.id+' is '+r.status+'. Freeze again to start a new round; a new round needs a new approval.'};
    if(isStale(r))return {ok:false,why:'The packet, prompt, settings or gold changed after the freeze. Freeze again; that creates a new round.'};
    return {ok:true,resume:r.status==='approved'};
  }
  function gateHtml(){
    const gate=launchGate();
    const check=gate.ok&&S.round?S.preflights[S.round.id]:null;
    return html`<p class="${gate.ok?'muted':'ag-why'}">${gate.ok?(gate.resume?'Round '+S.round.id+' is approved but not launched.':'Round '+S.round.id+' is frozen and ready for your approval. Nothing runs until you approve it in the next step.'):gate.why}</p>
      ${check&&!check.ok?html`<div class="notice" role="alert" id="ag-preflight-gate"><strong>Claude Code is not ready for this round.</strong> ${check.message}</div>`:''}
      <div class="actions"><button type="button" class="${primaryClass('open-approve')}" data-ag="open-approve" data-ag-key="open-approve" data-ag-lock ${gate.ok&&!locked()?'':'disabled'}>${gate.resume?'Review and launch':'Review and approve'}</button></div>
      <p class="footnote">Before the approval dialog opens, the companion checks that Claude Code lists every option the Studio passes and that it is signed in (claude --help and claude auth status). No model is started by that check.</p>`;
  }

  /* 6 to 10. Runs, classification, banner, export, simulated grader, author review */
  function runsOf(round){return round&&Array.isArray(round.runs)?round.runs:[];}
  const auditStatus=run=>run.audit&&run.audit.status;
  /* A round view lists runs as rows ({humanVerdict}); a run detail carries the full {human:{verdict,...}} record. Accept both. */
  function humanVerdictOf(run){
    const c=run&&run.classification;
    if(!c||typeof c!=='object')return '';
    if(c.human&&typeof c.human.verdict==='string')return c.human.verdict;
    return typeof c.humanVerdict==='string'?c.humanVerdict:'';
  }
  const isActiveRun=run=>run.state==='queued'||run.state==='running';
  function tally(runs){
    const t={clean:0,discarded:0,failed:0,cancelled:0,active:0,classified:0,verdicts:{}};
    runs.forEach(run=>{
      if(isActiveRun(run)){t.active++;return;}
      if(auditStatus(run)==='DISCARDED'){t.discarded++;return;}
      if(run.state==='failed'){t.failed++;return;}
      if(run.state==='cancelled'){t.cancelled++;return;}
      if(run.state==='completed'&&auditStatus(run)==='CLEAN'){
        t.clean++;
        const verdict=humanVerdictOf(run);
        if(verdict){t.classified++;t.verdicts[verdict]=(t.verdicts[verdict]||0)+1;}
      }
    });
    return t;
  }
  const stateBadge=run=>pill(run.state||'unknown',statusKind(run.state));
  function auditBadge(run){
    const status=auditStatus(run);
    if(status==='CLEAN')return pill('CLEAN','green');
    if(status==='DISCARDED')return pill('DISCARDED','red');
    return endedWithoutAudit(run)?pill('Not audited','amber'):pill('Pending');
  }
  /* A run that is failed or cancelled and has no audit will never get one: it was stopped before it could be audited. */
  const endedWithoutAudit=run=>!auditStatus(run)&&(run.state==='failed'||run.state==='cancelled');
  const verdictLabel=id=>(VERDICTS.find(v=>v.id===id)||{label:id}).label;
  function runsHtml(){
    const r=S.round,runs=runsOf(r),t=tally(runs),n=t.clean;
    const options=S.rounds.length>1||(S.rounds.length===1&&!r);
    const running=anyRunning(),carry=canCarry(r);
    return html`<div class="card-title"><div><div class="eyebrow">6 Runs</div><h2>Pilots and what they did</h2></div>${r?pill((r.status||'draft'),statusKind(r.status)):''}</div>
      ${options?html`<label class="field">Round<select data-ag-in="select-round" data-ag-key="select-round">${r?'':html`<option value="" selected>Choose a round</option>`}${S.rounds.map(x=>html`<option value="${x.id}" ${r&&x.id===r.id?'selected':''}>${(x.label||'Round')+' · '+x.id+' · '+(x.status||'')+' · '+timeText(x.createdAt)}</option>`)}</select></label>`:''}
      ${r&&r.note?html`<div class="notice" role="status" id="ag-round-note"><strong>Note on this round:</strong> ${r.note}${/companion stopped/.test(r.note)?' Pilots that were interrupted show as failed and were not audited. A pilot process may still be running if the companion was killed without a chance to stop it. Start a new round to run them again.':''}</div>`:''}
      <div class="notice neutral" id="ag-banner"><strong>Directional only, n = ${n}.</strong> No rate or difficulty is computed.
        <div class="ag-tiles" aria-hidden="true"><div class="ag-tile good"><strong>${t.clean}</strong><span>Clean</span></div><div class="ag-tile ${t.discarded?'bad':''}"><strong>${t.discarded}</strong><span>Discarded</span></div><div class="ag-tile ${t.failed?'warn':''}"><strong>${t.failed}</strong><span>Failed</span></div><div class="ag-tile"><strong>${t.cancelled}</strong><span>Cancelled</span></div><div class="ag-tile ${t.active?'warn':''}"><strong>${t.active}</strong><span>Running</span></div></div>
        <div class="ag-counts sr-only">Completed and clean: ${t.clean} (directional only, n = ${n}) · Discarded: ${t.discarded} · Failed: ${t.failed} · Cancelled: ${t.cancelled} · Still running: ${t.active}</div>
        ${t.classified?html`<div class="ag-counts">Your verdicts so far (directional only, n = ${n}): ${VERDICTS.map(v=>verdictLabel(v.id)+' '+(t.verdicts[v.id]||0)).join(' · ')}</div>`:''}
        ${t.discarded?html`<div class="ag-counts">Discarded runs are kept and shown, but they are not classified and not counted in the export.</div>`:''}</div>
      ${runs.length?runsTableHtml(runs):html`<div class="empty">${r?'No pilots have started in this round yet.':'No round selected. Freeze the gold to create one.'}</div>`}
      <div class="actions">${r&&['approved','running'].includes(r.status)?html`<button type="button" class="danger" data-ag="cancel-round" data-ag-key="cancel-round" data-ag-lock ${locked()?'disabled':''}>Cancel round</button>`:''}
        ${carry.show?html`<button type="button" data-ag="next-round" data-ag-key="next-round" data-ag-lock ${carry.ok&&!locked()?'':'disabled'}>Start next round from this round</button>`:''}
        <button type="button" data-ag="open-grader" data-ag-key="open-grader" ${running?'disabled':''}>Simulated grader…</button>
        <button type="button" data-ag="open-review" data-ag-key="open-review" ${packageDocuments().length&&!running?'':'disabled'}>Author review…</button></div>
      ${carry.show?html`<p class="footnote" id="ag-next-note">${carry.ok?'Start next round from this round fills the form with its packet selection, prompt, gaf setting, settings, gold and fingerprints, as a new draft round. Nothing is frozen, approved or launched by it: the new round needs its own freeze and approval.':carry.why}</p>`:''}
      ${running?html`<p class="ag-why" id="ag-toolless-why">${RUNNING_TOOL_LESS}</p>`:''}
      <p class="footnote">The simulated grader and the author review each ask for their own approval and use no tools. The grader is a simulation, not Studio grading. It grades a completed pilot with a clean audit, or a reference answer you paste to calibrate the guidance before any pilot runs. The author review needs a task package loaded on the Overview page.</p>
      <div class="ag-export"><h3>Export</h3>
        <p class="muted">Adds one experiment record per clean, completed pilot to the project in the task editor, and downloads the round JSON. Discarded runs are listed separately and are not added.</p>
        <div class="actions"><button type="button" data-ag="export-add" data-ag-key="export-add" data-ag-lock ${r&&!locked()?'':'disabled'}>Add to project experiments…</button><button type="button" data-ag="export-download" data-ag-key="export-download" data-ag-lock ${r&&!locked()?'':'disabled'}>Download round JSON</button></div></div>`;
  }
  function runsTableHtml(runs){
    return html`<div class="table-wrap"><table class="ag-table"><caption class="sr-only">Pilots in the selected round</caption><thead><tr><th scope="col">Pilot</th><th scope="col">State</th><th scope="col">Turns</th><th scope="col">Tool calls</th><th scope="col">Resolved model</th><th scope="col">Audit</th><th scope="col">Elapsed</th><th scope="col">Your verdict</th><th scope="col"><span class="sr-only">Details</span></th></tr></thead><tbody>${runs.map(run=>{
      const calls=run.toolCalls||{},verdict=humanVerdictOf(run);
      return html`<tr class="ag-runrow" data-ag="open-run" data-n="${run.n}"><td data-label="Pilot">${run.n}</td><td data-label="State">${stateBadge(run)}</td>
        <td data-label="Turns">${run.numTurns==null?'-':run.numTurns}</td>
        <td data-label="Tool calls">${calls.total==null?'-':calls.total+' (bash '+(calls.bash||0)+', file '+(calls.file||0)+')'}</td>
        <td data-label="Resolved model">${run.resolvedModel||'-'}</td><td data-label="Audit">${auditBadge(run)}</td><td data-label="Elapsed">${elapsedText(run)}</td>
        <td data-label="Your verdict">${verdict?verdictLabel(verdict):'Not classified'}</td>
        <td data-label=""><button type="button" class="small" data-ag="open-run" data-n="${run.n}" data-ag-key="run-${run.n}" aria-label="Open details for pilot ${run.n}">Details</button></td></tr>`;
    })}</tbody></table></div>`;
  }
  /* "Start next round" is offered for a round that has run (or is running) and has a freeze to carry forward. */
  function canCarry(r){
    const show=!!(r&&r.freeze&&['running','finished','cancelled','failed'].includes(r.status));
    if(!show)return {show:false,ok:false,why:''};
    if(anyRunning())return {show:true,ok:false,why:RUNNING_NEXT};
    if(r.redacted)return {show:true,ok:false,why:'The companion withheld this round\'s data. Wait for the page to read it again.'};
    return {show:true,ok:true,why:''};
  }
  const packageDocuments=()=>S.ctx.package&&Array.isArray(S.ctx.package.documents)?S.ctx.package.documents:[];
  const graderRuns=()=>runsOf(S.round).filter(run=>run.state==='completed'&&auditStatus(run)==='CLEAN');

  /* 7. Pilot gate: the writer's verdicts on every round of one design, set against the platform's gate. Pilot-based and directional. */
  /* Numbers are written as decimals with two places, never as a percentage. */
  const dec=x=>(Math.round(Number(x)*100+1e-6)/100).toFixed(2);
  const lnFact=n=>{let s=0;for(let i=2;i<=n;i++)s+=Math.log(i);return s;};
  const lnBeta=(a,b)=>lnFact(a-1)+lnFact(b-1)-lnFact(a+b-1);      /* B(a,b) = (a-1)!(b-1)!/(a+b-1)! for whole a, b >= 1 */
  /* The chance that a batch of GATE.batch runs averages GATE.mean or lower. With a uniform prior on how often a run is correct, the
     number C of correct runs in the batch is beta-binomial(batch, correct+1, wrong+1). A batch averages the mean or lower when
     C*0.86 + (batch-C)*0.25 <= batch*0.60, which for ten runs is C <= 5. */
  function batchChance(correct,wrong){
    const n=GATE.batch,a=correct+1,b=wrong+1;
    let p=0;
    for(let c=0;c<=n&&c*GATE.correct.point+(n-c)*GATE.wrong.point<=n*GATE.mean+1e-9;c++)p+=Math.exp(lnFact(n)-lnFact(c)-lnFact(n-c)+lnBeta(c+a,n-c+b)-lnBeta(a,b));
    return Math.min(1,Math.max(0,p));
  }
  /* Pure (no DOM, no state), so tests call it as FinanceAgents.pilotGate. runs: run rows or details of the rounds of one design. Only
     a completed run with a CLEAN audit and a verdict of yours counts: wrong is 'fingerprint', correct is 'matches-frozen-gold', and
     unclear is counted on its own and left out of the total. The streak is the correct verdicts in a row at the end, in the order the
     runs ended; an unclear verdict neither breaks nor extends it. The ship bar is met once there are at least `of` runs and the wrong
     ones are at least the same share as `wrong` of `of` (5 of 6 needs 5 of 6, 10 of 12, ...). */
  function pilotGate(runs,shipBar){
    const at=run=>{const t=Date.parse(run.endedAt);return Number.isFinite(t)?t:Infinity;};
    const list=(Array.isArray(runs)?runs:[]).filter(run=>run&&run.state==='completed'&&auditStatus(run)==='CLEAN'&&VERDICTS.some(v=>v.id===humanVerdictOf(run)))
      .map((run,i)=>({verdict:humanVerdictOf(run),t:at(run),i})).sort((x,y)=>(x.t-y.t)||(x.i-y.i));
    let wrong=0,correct=0,unclear=0,streak=0;
    list.forEach(x=>{
      if(x.verdict==='fingerprint'){wrong++;streak=0;}
      else if(x.verdict==='matches-frozen-gold'){correct++;streak++;}
      else unclear++;
    });
    const total=wrong+correct,mean=(c,w)=>total?(correct*c+wrong*w)/total:null;
    const barOk=!!shipBar&&Number.isInteger(shipBar.wrong)&&Number.isInteger(shipBar.of)&&shipBar.wrong>=1&&shipBar.wrong<=shipBar.of;
    return {wrong,correct,unclear,total,streak,stop:streak>=GATE.stop,
      bar:barOk?{wrong:shipBar.wrong,of:shipBar.of,n:total,met:total>=shipBar.of&&wrong*shipBar.of>=shipBar.wrong*total}:null,
      range:total?{low:mean(GATE.correct.low,GATE.wrong.low),high:mean(GATE.correct.high,GATE.wrong.high)}:null,
      point:mean(GATE.correct.point,GATE.wrong.point),chance:total?batchChance(correct,wrong):null};
  }
  /* A design is the packet, the prompt, the frozen gold and how a pilot is run on them: the packet hash, the prompt hash, the content
     hash of the original freeze (which holds the ship bar when one was frozen), whether the solver sees gaf/ (the packet hash does not
     cover it), and the model and effort. A post-hoc version does not move a round to another design; the pilot count, spending cap
     and concurrency do not matter. */
  const designKeyOf=r=>{const p=r&&r.packet,fr=r&&r.freeze,c=r&&r.config;return p&&fr&&c&&p.packetSha256&&p.promptSha256&&fr.contentSha256&&c.model&&c.effort?[p.packetSha256,p.promptSha256,fr.contentSha256,p.gafVisible?'gaf':'no-gaf',c.model,c.effort].join(' '):'';};
  /* The listed rounds that may share the selected round's design and have runs. The list row has no prompt or content hash, so the
     packet hash narrows the reads and the round view decides. Only rounds already listed are read. */
  function designCandidates(){
    const r=S.round;
    if(!designKeyOf(r))return [];
    return S.rounds.filter(x=>x&&x.id!==r.id&&x.packetSha256===r.packet.packetSha256&&x.runCount>0);
  }
  const designStale=x=>{const kept=S.design.views[x.id];return !kept||kept.at!==x.lastActivityAt;};
  function designRounds(){
    const r=S.round,key=designKeyOf(r);
    if(!key)return [];
    return [r,...designCandidates().map(x=>S.design.views[x.id]&&S.design.views[x.id].view).filter(v=>v&&designKeyOf(v)===key)];
  }
  /* Reads the rounds the gate does not have yet, or whose list row says something happened since (a run ended, a verdict was saved).
     Never while a round runs: the companion withholds the gold and the verdicts then. One read at a time; never throws. */
  async function syncDesign(){
    if(S.design.busy||S.phase!=='ready'||anyRunning())return;
    const wanted=designCandidates().filter(designStale);
    if(!wanted.length)return;
    S.design.busy=true;
    let stored=0;
    try{
      for(const row of wanted){
        if(anyRunning())break;
        let view=null;
        try{view=normalizeRound(await api('GET',roundPath(row.id)));}catch{view=null;/* left out of the gate until its row changes */}
        if(view&&view.redacted===true)break;
        S.design.views[row.id]={at:row.lastActivityAt,view};stored++;
      }
    }finally{S.design.busy=false;}
    if(S.mounted&&S.phase==='ready')paintSection('pilot-gate');
    /* A call made during these reads returned at once, so look again: the writer may have selected a round of another design, or a
       row may have changed. Only after a pass that stored a view, so a read the companion withheld (which stores nothing) cannot loop. */
    if(stored&&S.phase==='ready'&&!anyRunning()&&designCandidates().some(designStale))return syncDesign();
  }
  function pilotGateHtml(){
    const head=html`<div class="card-title"><div><div class="eyebrow">7 Pilot gate</div><h2>Pilot gate (pilot-based)</h2></div>${pill('Directional')}</div>`;
    if(anyRunning())return html`${head}<p class="muted" id="ag-pilot-gate-wait">Waiting for the round to end.</p>`;
    const r=S.round;
    if(!designKeyOf(r))return html`${head}<p class="muted" id="ag-pilot-gate-empty">${r?'Freeze this round to see the pilot gate of its design.':'Select a round to see the pilot gate of its design.'}</p>`;
    const rounds=designRounds(),g=pilotGate(rounds.flatMap(runsOf),r.freeze.shipBar),waiting=designCandidates().filter(designStale).length;
    const reading=waiting?html`<p class="footnote">Reading ${waiting} more ${waiting===1?'round':'rounds'} with the same packet.</p>`:'';
    if(!g.total)return html`${head}<p class="muted" id="ag-pilot-gate-empty">No classified runs of this design yet${g.unclear?' ('+g.unclear+' unclear, left out)':''}. Classify clean runs as matching the frozen gold or landing on a fingerprint, and the gate appears here.</p>${reading}`;
    const bar=g.bar?'Ship bar: '+barText(g.bar)+', '+(g.bar.met?'met':'not met yet')+' ('+g.bar.n+(g.bar.n===1?' run':' runs')+' so far)':'No ship bar was frozen with this design';
    return html`${head}
      <p class="muted">Pilot-based and directional. It pools your verdicts on the completed, clean runs of every round of this design: the same packet, the same prompt, the same frozen gold, the same gaf setting, the same model and the same effort. The platform's gate is at least six completed runs averaging 0.60 or lower. This instrument matched a platform batch once and is untested elsewhere.</p>
      <dl class="history-details" id="ag-pilot-gate-facts"><dt>Rounds of this design</dt><dd>${rounds.length}: ${rounds.map(x=>x.id).join(', ')}</dd>
        <dt>Wrong (lands on a frozen fingerprint)</dt><dd>${g.wrong} of ${g.total}</dd>
        <dt>Correct (matches the frozen gold)</dt><dd>${g.correct} of ${g.total}</dd>
        <dt>Unclear</dt><dd>${g.unclear}, left out</dd>
        <dt>Correct in a row, latest runs</dt><dd>${g.streak}<br><small>Stop rule. Three correct in a row: stop testing this design.</small></dd>
        <dt>Projected batch mean</dt><dd>${dec(g.range.low)} to ${dec(g.range.high)}</dd>
        <dt>Chance a ten-run batch averages 0.60 or lower</dt><dd>${dec(g.chance)}</dd></dl>
      <p id="ag-pilot-gate-bar"><strong>${bar}.</strong></p>
      ${g.stop?html`<div class="notice" role="status" id="ag-pilot-gate-stop"><strong>Three correct in a row: stop testing this design.</strong> The latest ${g.streak} classified runs matched the frozen gold, so more pilots of this design are unlikely to change the call.</div>`:''}
      <p class="footnote">Instrument, measured on your own earlier tasks and not a property of this task: a correct run scores ${dec(GATE.correct.low)} to ${dec(GATE.correct.high)} (point ${dec(GATE.correct.point)}), a wrong run ${dec(GATE.wrong.low)} to ${dec(GATE.wrong.high)} (point ${dec(GATE.wrong.point)}). The range weights those by your wrong and correct counts. The chance assumes nothing about the design beyond your verdicts (a uniform prior) and counts a ten-run batch as averaging 0.60 or lower when at most five of its runs are correct.</p>
      ${reading}`;
  }

  /* ---------- Overlays: detail drawer and approval dialogs ---------- */
  function overlayHtml(){
    const o=S.overlay;
    if(!o)return html``;
    if(o.type==='drawer')return drawerHtml(o);
    if(o.type==='approve')return approveHtml(o);
    if(o.type==='grader')return graderHtml(o);
    if(o.type==='review')return reviewHtml(o);
    if(o.type==='export')return exportHtml(o);
    return html``;
  }
  function dialogFrame(title,body,kind){
    return html`<div class="modal-backdrop ${kind==='drawer'?'ag-backdrop':''}" data-ag="backdrop"><section class="${kind==='drawer'?'ag-drawer':'evidence-dialog ag-dialog'}" role="dialog" aria-modal="true" aria-labelledby="ag-dialog-title" tabindex="-1" data-ag-dialog>
      <header class="ag-dialog-head"><h2 id="ag-dialog-title">${title}</h2><button type="button" data-ag="close-overlay" data-ag-key="close-overlay">Close</button></header>${body}</section></div>`;
  }
  function openOverlay(overlay){
    S.returnKey=activeKey();
    S.overlay=overlay;
    paintOverlay();
    const dialog=document.querySelector('#agents-modal [data-ag-dialog]');
    if(dialog)(dialog.querySelector('[data-ag-initial]')||dialog).focus({preventScroll:true});
  }
  function closeOverlay(){
    S.overlay=null;
    paintOverlay();
    const key=S.returnKey;
    S.returnKey=null;
    focusKey(key);
  }
  function focusables(root){
    return [...root.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length>0);
  }
  function trapTab(e){
    const dialog=document.querySelector('#agents-modal [data-ag-dialog]');
    if(!dialog)return;
    const list=focusables(dialog);
    if(!list.length){e.preventDefault();dialog.focus();return;}
    const first=list[0],last=list[list.length-1];
    if(!dialog.contains(document.activeElement)){e.preventDefault();first.focus();}
    else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }

  /* Approve and launch */
  function approvalSummary(round){
    let summary=round.approvalSummary||round.summary||(round.approval&&round.approval.summary)||null;
    let hash=round.summarySha256||round.approvalSummarySha256||(summary&&(summary.summarySha256||summary.sha256))||'';
    /* A read made while another round runs withholds both; the freeze answer of this round kept them. */
    const kept=S.approvals[round.id];
    if(!hash&&kept){summary=summary||kept.summary;hash=kept.hash;}
    return {summary:summary&&typeof summary==='object'?summary:null,hash:typeof hash==='string'?hash:''};
  }
  function documentedCommand(cfg){
    const tools=(cfg.tools&&cfg.tools.length?cfg.tools:['Bash','Read','Write','Edit','Glob','Grep']).join(',');
    const budget=Number(cfg.maxBudgetUsd==null?BUDGET.pilotDefault:cfg.maxBudgetUsd);
    return ['claude','-p','<prompt elided>','--model',cfg.model||'?','--effort',cfg.effort||'?','--output-format','stream-json','--verbose','--tools',tools,'--allowedTools',tools,
      '--permission-mode','acceptEdits','--disable-slash-commands','--strict-mcp-config','--setting-sources','','--no-session-persistence','--max-budget-usd',budget.toFixed(2)].map((x,i,all)=>x==='<prompt elided>'?x:shellQuote(x)).join(' ');
  }
  function commandLineFor(summary,round){
    const given=summary&&(summary.commandLine||summary.command);
    if(typeof given==='string'&&given)return {text:given,source:'companion'};
    const argv=summary&&Array.isArray(summary.argv)?summary.argv:null;
    if(argv&&argv.length)return {text:argv.map(a=>shellQuote(String(a))).join(' '),source:'companion'};
    return {text:documentedCommand(round.config||{}),source:'documented'};
  }
  /* The prompt as stored with the round, cut for display only; the hash shown beside it covers the whole text. */
  function promptShown(packet,redacted){
    const text=typeof packet.promptText==='string'?packet.promptText:'';
    if(!text&&redacted)return '(withheld while a round is running: a running pilot could read it from the companion. The hash below covers the prompt; the text comes back when the round has ended.)';
    if(!text)return '(the companion did not send the prompt text)';
    return text.length>4000?text.slice(0,4000)+'\n... ('+text.length+' characters in all; the hash covers all of them)':text;
  }
  /* The fixed text every pilot sees before the writer's prompt, as the companion sent it with the approval summary (promptPrefix). Never typed in this file. */
  const prefixOf=summary=>summary&&typeof summary.promptPrefix==='string'?summary.promptPrefix:null;
  const prefixShown=summary=>{const text=prefixOf(summary);return text===null?'(the companion did not send the fixed text, so it cannot be shown here. Update the companion)':text;};
  /* Which of the selected files each pilot gets, and which the gaf setting holds back. */
  function fileListsHtml(packet){
    const files=Array.isArray(packet.files)?packet.files.filter(f=>f&&f.include):[];
    if(!files.length)return html`<p class="muted">The companion did not send the file list.</p>`;
    const delivered=files.filter(f=>packet.gafVisible||!isGaf(f.path)),withheld=files.filter(f=>!packet.gafVisible&&isGaf(f.path));
    const show=list=>list.length?html`<ul class="plain-list">${list.slice(0,60).map(f=>html`<li><code class="ag-path">${f.path}</code>${f.overridden?' (override)':''}</li>`)}${list.length>60?html`<li>and ${list.length-60} more</li>`:''}</ul>`:html`<p class="muted">None.</p>`;
    return html`<p><strong>${files.length} selected, ${delivered.length} delivered to each pilot.</strong> Pilots find them under ./filesystem/.</p>${show(delivered)}
      ${withheld.length?html`<p><strong>Withheld because gaf/ is hidden (${withheld.length}):</strong></p>${show(withheld)}`:''}`;
  }
  function approveHtml(o){
    const round=S.round;
    if(!round||round.id!==o.roundId)return dialogFrame('Approve and launch',html`<p>This round is no longer selected.</p>`);
    const s=o.summary||{},cfg=round.config||{},packet=round.packet||{},freeze=round.freeze||{};
    const command=commandLineFor(o.summary,round);
    const localOverrides=(S.packet.files||[]).filter(f=>effectiveInclude(f)&&!f.defaultInclude).map(f=>f.path);
    const overrides=Array.isArray(s.overrides)?s.overrides:Array.isArray(packet.files)?packet.files.filter(f=>f.overridden).map(f=>f.path):localOverrides;
    const allChecked=ACKNOWLEDGEMENTS.every(a=>o.acks[a.id]);
    const model=s.model||cfg.model,effort=s.effort||cfg.effort,count=s.count||cfg.count,tools=s.tools||cfg.tools;
    const budget=Number(cfg.maxBudgetUsd==null?BUDGET.pilotDefault:cfg.maxBudgetUsd);
    const check=o.preflight||{state:'unknown'},ready=check.state==='ok'||check.state==='unavailable';
    return dialogFrame('Approve and launch this round',html`
      <p class="muted">You are approving exactly what is shown here. Nothing has started. The companion checks that this summary still matches before it runs anything.</p>
      ${preflightHtml(check)}
      <dl class="history-details"><dt>Round</dt><dd>${round.id}</dd><dt>Model</dt><dd>${model}</dd><dt>Effort</dt><dd>${effort}</dd><dt>Pilots</dt><dd>${count} (at most ${S.status.max}; ${pacingText({count,concurrency:cfg.concurrency})})</dd>
        <dt>Spending cap per pilot</dt><dd>${usd(budget)} (--max-budget-usd ${budget.toFixed(2)})</dd><dt>Round maximum spend</dt><dd>${roundMax(count,budget)} (${count} × ${usd(budget)}) <span id="ag-approve-cap-note">${CAP_STATEMENT}</span></dd>
        ${round.carriedFrom?html`<dt>Carried forward from</dt><dd>Round ${round.carriedFrom}. Gold and fingerprints ${round.carryChanges&&round.carryChanges.freezeContent===true?'changed':'unchanged'}${round.carryChanges&&typeof round.carryChanges.shipBar==='boolean'?', ship bar '+(round.carryChanges.shipBar?'changed':'unchanged'):''} (content SHA-256 ${round.carried&&round.carried.contentSha256||'?'} then, ${round.freeze&&round.freeze.contentSha256||'see the summary text'} now).</dd>`:''}
        <dt>Tools</dt><dd>${Array.isArray(tools)?tools.join(', '):'Bash, Read, Write, Edit, Glob, Grep'}</dd>
        <dt>Working folder</dt><dd>${s.workingFolder||s.folder||'One new folder per pilot, outside this project, under the system temporary folder'}</dd>
        <dt>Packet SHA-256</dt><dd>${s.packetSha256||packet.packetSha256||'not reported'}</dd><dt>Freeze SHA-256</dt><dd>${s.freezeSha256||freeze.sha256||'not reported'}</dd>
        ${freeze.shipBar?html`<dt>Ship bar</dt><dd>${barText(freeze.shipBar)} runs, frozen with the gold</dd>`:''}
        <dt>gaf/ visible</dt><dd>${(s.gafVisible!==undefined?s.gafVisible:packet.gafVisible)?'Yes':'No'}</dd>
        <dt>Overridden files</dt><dd>${overrides.length?overrides.map(p=>html`<code class="ag-path">${p}</code> `):'None'}</dd>
        <dt>Summary SHA-256</dt><dd>${o.hash||'not provided by the companion'}</dd></dl>
      <h3>${PREFIX_HEADING}</h3>
      <pre class="ag-final" id="ag-prefix" tabindex="0" aria-label="${PREFIX_HEADING}">${prefixShown(s)}</pre>
      <p class="footnote">The companion adds this text in front of your prompt for every pilot. It is not something you wrote, and it is not part of the prompt hash below.</p>
      <h3>Your prompt</h3>
      <pre class="ag-final" tabindex="0" aria-label="Your prompt, which every pilot receives after the fixed text above">${promptShown(packet,round.redacted===true)}</pre>
      <p class="footnote">Prompt SHA-256 <span class="hash">${packet.promptSha256||'not reported'}</span>. The hash covers your prompt only. Every pilot gets the fixed text above, then this prompt.</p>
      <h3>Files</h3>
      ${fileListsHtml(packet)}
      <h3>Command line</h3>
      <pre class="ag-command">${command.text}</pre>
      <p class="footnote">${command.source==='companion'?'As built by the companion, with the prompt elided. The browser cannot change it.':'The companion did not send its own copy, so this is the documented command with the prompt elided.'}</p>
      <div class="notice"><strong>Isolation</strong><br>${ISOLATION_STATEMENT}</div>
      ${s.text?html`<details><summary>The exact text this approval covers</summary><pre class="ag-command" tabindex="0" aria-label="Approval summary text">${s.text}</pre><p class="footnote">The summary hash above is the SHA-256 of this text. The companion refuses to launch if it no longer matches.</p></details>`:''}
      <div class="ag-foot">
        <fieldset class="ag-acks"><legend>Required before launch</legend>${ACKNOWLEDGEMENTS.map((a,i)=>html`<label class="check"><input type="checkbox" data-ag-in="ack" data-id="${a.id}" data-ag-key="ack-${a.id}" ${o.acks[a.id]?'checked':''} ${i===0?'data-ag-initial':''}><span><strong>${a.label}</strong>${a.text}</span></label>`)}</fieldset>
        ${!o.hash?html`<div class="notice" role="alert">The companion did not send an approval hash for this round, so it cannot be approved from here. Update the companion and try again.</div>`:''}
        ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
        <div class="actions"><button type="button" class="primary" data-ag="approve-launch" data-ag-key="approve-launch" ${allChecked&&o.hash&&ready&&!locked()?'':'disabled'}>Approve and launch</button><button type="button" data-ag="close-overlay" data-ag-key="cancel-approve">Cancel</button></div>
      </div>`);
  }
  /* The pre-flight result at the top of the approval dialog. A problem blocks the approval until a check passes. */
  function preflightHtml(check){
    if(check.state==='ok')return html`<div class="notice neutral" role="status" id="ag-preflight"><strong>Claude Code is ready.</strong> It lists every option the Studio passes and it is signed in${check.version?' (version '+check.version+')':''}.${check.signIn?' '+check.signIn:''} Checked with claude --help and claude auth status; no model was started.</div>`;
    if(check.state==='unavailable')return html`<div class="notice neutral" role="status" id="ag-preflight">This companion cannot check Claude Code before approval. The launch still checks it, and refuses with the reason if something is missing.</div>`;
    if(check.state==='failed')return html`<div class="notice" role="alert" id="ag-preflight"><strong>Fix this before you approve.</strong> ${check.message}<div class="actions"><button type="button" class="small" data-ag="recheck-preflight" data-ag-key="recheck-preflight" ${locked()?'disabled':''}>Check again</button></div></div>`;
    return html`<div class="notice neutral" role="status" id="ag-preflight">Checking Claude Code (claude --help and claude auth status; no model is started).</div>`;
  }
  /* Asks the companion for the launch pre-flight of a round. Never throws: the result says what happened. */
  async function checkRound(id){
    try{
      const data=await api('POST',roundPath(id,'/preflight'),{});
      const result={state:'ok',ok:true,version:typeof data.version==='string'?data.version:'',signIn:typeof data.signIn==='string'?data.signIn:'',message:''};
      S.preflights[id]=result;
      return result;
    }catch(error){
      /* An older companion has no such route (405), or a service without the check says so (404). */
      if(error.status===405||(error.status===404&&/not available/i.test(error.message))){delete S.preflights[id];return {state:'unavailable',ok:true,message:''};}
      const result={state:'failed',ok:false,message:error.message};
      S.preflights[id]=result;
      return result;
    }
  }
  async function openApprove(){
    const gate=launchGate();
    if(!gate.ok){say(gate.why,true);return;}
    const id=S.roundId;
    let check=null;
    await work('approve-open',async()=>{await refreshRound(id);check=await checkRound(id);});
    const again=launchGate();
    if(!again.ok){say(again.why,true);return;}
    const {summary,hash}=approvalSummary(S.round);
    if(summary&&typeof summary.commandLine==='string'&&summary.commandLine)S.commands[id]=summary.commandLine;
    openOverlay({type:'approve',roundId:id,acks:{},summary,hash,error:'',preflight:check});
    if(check&&check.state==='failed')say('Claude Code is not ready for round '+id+': '+check.message,true);
  }
  async function recheckPreflight(){
    const o=S.overlay;
    if(!o||o.type!=='approve')return;
    o.preflight={state:'checking'};paintOverlay();
    let check=null;
    await work('preflight',async()=>{check=await checkRound(o.roundId);});
    if(S.overlay!==o)return;
    o.preflight=check;
    paintOverlay();gates();
    if(check.state==='ok')say('Claude Code is ready for round '+o.roundId+'.');
    else if(check.state==='failed')say(check.message,true);
  }
  async function approveAndLaunch(){
    const o=S.overlay;
    if(!o||o.type!=='approve')return;
    if(!ACKNOWLEDGEMENTS.every(a=>o.acks[a.id])||!o.hash)return;
    if(!o.preflight||!['ok','unavailable'].includes(o.preflight.state))return;
    const id=o.roundId;
    try{
      await work('launch',async()=>{
        /* A round the companion already holds as approved (an earlier launch was refused) is launched without approving it again. */
        if(S.round&&S.round.status==='frozen')await api('POST',roundPath(id,'/approve'),{summarySha256:o.hash,acknowledgements:ACKNOWLEDGEMENTS.map(a=>a.id)});
        await api('POST',roundPath(id,'/launch'),{});
        await refreshRound(id);
        await loadRounds();
      });
    }catch(error){
      /* The approval may have gone through before the launch was refused. Read the round again so the page, the gate and this dialog agree with the companion. */
      try{await refreshRound(id);await loadRounds();}catch{/* the original error is the one to show */}
      if(S.overlay===o){
        const approved=!!(S.round&&S.round.id===id&&S.round.status==='approved');
        o.error=error.message+(/PACKET HASH MISMATCH/i.test(error.message)?' A file in the packet folder changed after it was inspected. Inspect the folder again and freeze a new round.':'')
          +(approved?' Round '+id+' is approved and nothing was started. Fix the cause, then press Approve and launch again: this dialog launches the approved round without asking for a new approval.':'');
        paintOverlay();
      }
      paintAll();gates();
      return;
    }
    closeOverlay();
    /* The companion holds the launched round now, so the draft in this browser goes, and nothing is saved while it runs. */
    clearStoredDraft();
    S.carry=null;
    say('Round '+id+' launched: '+pacingText(S.round&&S.round.config||{count:1})+'. Pilots run on this computer. This page refreshes every 1.5 seconds. The draft saved in this browser was removed.');
    paintAll();gates();schedulePoll();
  }

  /* Run drawer and classification */
  function formFor(run){
    const human=run&&run.classification&&run.classification.human;
    return {verdict:human&&human.verdict||'',ids:Array.isArray(human&&human.fingerprintIds)?[...human.fingerprintIds]:[],note:human&&human.note||'',saving:false,error:''};
  }
  async function openRunDrawer(n){
    const base=runsOf(S.round).find(run=>run.n===n);
    if(!base||!S.round)return;
    const roundId=S.round.id;
    openOverlay({type:'drawer',n,roundId,run:base,loading:true,error:'',form:formFor(base)});
    try{
      const data=await api('GET',runPath(roundId,n));
      const o=S.overlay;
      if(o&&o.type==='drawer'&&o.n===n&&o.roundId===roundId){
        o.run={...base,...(data.run&&typeof data.run==='object'?data.run:data)};
        /* The row in the round view only knows the verdict's name. Take the saved verdict, ids and note from the detail unless the writer has already started choosing. */
        if(!o.form.verdict&&!o.form.note&&!o.form.ids.length)o.form=formFor(o.run);
        o.loading=false;
        paintOverlay();
        /* A withheld detail means a round is running, perhaps one this page has not seen: read the list and poll until it ends. */
        if(o.run.redacted===true){await loadRounds();paintAll();gates();schedulePoll();}
      }
    }catch(error){
      const o=S.overlay;
      if(o&&o.type==='drawer'&&o.n===n){o.loading=false;o.error=error.message;paintOverlay();}
    }
  }
  async function refreshDrawer(){
    const o=S.overlay;
    if(!o||o.type!=='drawer'||!S.round||S.round.id!==o.roundId)return;
    const fromRound=runsOf(S.round).find(run=>run.n===o.n);
    if(!fromRound)return;
    const data=await api('GET',runPath(o.roundId,o.n));
    if(S.overlay!==o)return;
    o.run={...fromRound,...(data.run&&typeof data.run==='object'?data.run:data)};
    paintOverlay();
  }
  function canClassify(run){return run.state==='completed'&&auditStatus(run)==='CLEAN'&&run.redacted!==true;}
  /* The companion's suggestion lists every fingerprint it checked as {id,label,hit,...} and every gold figure as {label,value,found,where}. */
  function suggestedFingerprintIds(suggested){
    const list=suggested&&Array.isArray(suggested.fingerprints)?suggested.fingerprints:[];
    return list.map(item=>typeof item==='string'?item:item&&item.hit===true&&typeof item.id==='string'?item.id:'').filter(Boolean);
  }
  function suggestedMatches(suggested){
    const list=suggested&&Array.isArray(suggested.matches)?suggested.matches:[];
    return list.map(m=>{
      if(typeof m==='string')return m;
      if(!m||typeof m!=='object')return '';
      const name=String(m.label||m.value||'figure');
      return name+(m.value!==undefined&&m.label?' '+m.value:'')+': '+(m.found?'found'+(m.where?' in the '+m.where:''):'not found');
    }).filter(Boolean);
  }
  function drawerHtml(o){
    const run=o.run||{},calls=run.toolCalls||{},audit=run.audit||{},violations=Array.isArray(audit.violations)?audit.violations:[];
    const final=run.final&&typeof run.final.text==='string'?run.final.text:null;
    const outputs=Array.isArray(run.outputs)?run.outputs:[];
    const withheld=run.redacted===true&&final===null&&!isActiveRun(run)&&!o.loading;
    return dialogFrame('Pilot '+o.n+' · '+(run.state||''),html`
      <div class="actions">${stateBadge(run)}${auditBadge(run)}${o.loading?pill('Loading details'):''}</div>
      ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
      <dl class="history-details"><dt>Requested</dt><dd>${run.requestedModel||'-'} · effort ${run.requestedEffort||'-'}</dd><dt>Resolved model</dt><dd>${run.resolvedModel||'-'}</dd>
        <dt>Turns</dt><dd>${run.numTurns==null?'-':run.numTurns}</dd><dt>Tool calls</dt><dd>${calls.total==null?'-':calls.total+' (bash '+(calls.bash||0)+', file '+(calls.file||0)+')'}</dd>
        <dt>Exit code</dt><dd>${run.exitCode==null?'-':run.exitCode}</dd><dt>Ended because</dt><dd>${run.terminalReason||'-'}</dd><dt>Reported cost</dt><dd>${run.costUsd==null?'-':'USD '+run.costUsd}</dd>
        <dt>Started</dt><dd>${run.startedAt?timeText(run.startedAt):'-'}</dd><dt>Elapsed</dt><dd>${elapsedText(run)}</dd></dl>
      ${outputLocationHtml(o,run)}
      ${auditSectionHtml(run,audit,violations)}
      ${run.state==='failed'?failureHtml(run):''}
      <h3>${run.state==='failed'?"Runtime message (the run failed)":'Final answer'}</h3>
      ${final!==null?html`<pre class="ag-final" tabindex="0" aria-label="${run.state==='failed'?'Runtime message of':'Final answer of'} pilot ${o.n}">${final||'(empty)'}</pre><p class="footnote">${run.final&&run.final.chars!=null?run.final.chars+' characters. ':''}Shown as plain text.${run.state==='failed'?' This is what the runtime printed as its result. It is not an answer to grade.':''}</p>`:withheld?html`<p class="muted" id="ag-withheld">Hidden while a round is running, because a running pilot could read it from the companion${run.final&&run.final.chars!=null?' ('+run.final.chars+' characters)':''}. The answer, the suggestion and classification come back when the round has ended.</p>`:html`<p class="muted">${isActiveRun(run)?'The pilot has not finished.':o.loading?'Loading.':run.state==='failed'?'The runtime recorded no message.':'No final answer was recorded.'}</p>`}
      <h3>Outputs</h3>
      ${outputs.length?html`<div class="table-wrap"><table class="ag-table"><caption class="sr-only">Files the pilot wrote to its outputs folder</caption><thead><tr><th scope="col">Name</th><th scope="col">Size</th><th scope="col">SHA-256</th></tr></thead><tbody>${outputs.map(f=>html`<tr><td data-label="Name"><code class="ag-path">${f.name}</code></td><td data-label="Size">${bytesText(f.bytes)}</td><td data-label="SHA-256"><span class="hash">${f.sha256}</span></td></tr>`)}</tbody></table></div>`:html`<p class="muted">No files in the outputs folder.</p>`}
      ${classifyHtml(o,run)}`,'drawer');
  }
  /* Where the pilot's files are: the working folder it wrote them in, the evidence folder they are copied to when the run ends,
     and how many there are. Nothing here is served by the companion, so the path is for the writer's own file manager. */
  function outputLocationHtml(o,run){
    const active=isActiveRun(run),folder=typeof run.folder==='string'?run.folder:'';
    /* Until the run ends the companion's count is 0 because nothing is collected yet; the markup says so instead of showing 0. */
    const count=Number.isInteger(run.outputCount)?run.outputCount:Array.isArray(run.outputs)?run.outputs.length:null;
    const noCopy=!active&&(!auditStatus(run)||run.failureReason==='setup-error');
    return html`<h3>Where the output is</h3>
      <dl class="history-details" id="ag-output-location"><dt>Working folder</dt><dd>${folder?html`<code class="ag-path">${folder}</code> <small>in the system temporary folder of this computer; the pilot wrote its files here</small>`:'-'}</dd>
        <dt>Evidence folder</dt><dd><code class="ag-path" id="ag-evidence-path">${evidencePath(o.roundId,o.n)}</code> <button type="button" class="small" data-ag="copy-path" data-ag-key="copy-path" aria-label="Copy the evidence folder path">Copy path</button> <small>relative to the project folder</small></dd>
        <dt>Output files</dt><dd>${active?'Counted when the run ends':count==null?'-':count}</dd></dl>
      ${active?html`<p class="footnote" id="ag-output-note">Copied to the working copy when the run ends</p>`:''}
      ${noCopy?html`<p class="footnote" id="ag-output-missing">${run.failureReason==='setup-error'?'The pilot folder could not be built, so no files were written.':'This pilot ended before the audit ran, so its files may not have been copied: that folder may not exist.'}</p>`:''}
      ${o.copyNote?html`<p class="footnote" id="ag-copy-note" role="status">${o.copyNote}</p>`:''}`;
  }
  /* Copy text with the clipboard API where the page may use it, else with a hidden text area and the older copy command.
     Every piece is checked first, because neither exists in every browser or every test page. Resolves to true only when it copied. */
  async function copyText(text){
    try{
      if(typeof navigator!=='undefined'&&navigator&&navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){await navigator.clipboard.writeText(text);return true;}
    }catch{/* refused or not allowed here: try the older way */}
    try{
      if(typeof document.createElement!=='function'||!document.body||typeof document.execCommand!=='function')return false;
      const area=document.createElement('textarea'),before=document.activeElement;
      area.value=text;area.setAttribute('readonly','');area.setAttribute('aria-hidden','true');area.className='sr-only';
      document.body.appendChild(area);
      let ok=false;
      try{area.focus({preventScroll:true});area.select();ok=document.execCommand('copy')===true;}
      finally{if(area.parentNode)area.parentNode.removeChild(area);}
      if(before&&typeof before.focus==='function'){try{before.focus({preventScroll:true});}catch{/* focus stays where it is */}}
      return ok;
    }catch{return false;}
  }
  async function copyEvidencePath(){
    const o=S.overlay;
    if(!o||o.type!=='drawer')return;
    const path=evidencePath(o.roundId,o.n),ok=await copyText(path);
    if(S.overlay!==o)return;
    o.copyNote=ok?'Copied the evidence folder path to the clipboard.':'The browser did not allow copying. Select the path above and copy it yourself.';
    paintOverlay();
    say(o.copyNote,!ok);
  }
  function auditSectionHtml(run,audit,violations){
    const discarded=audit.status==='DISCARDED';
    const modified=Array.isArray(audit.inputsModified)?audit.inputsModified:[],notes=Array.isArray(audit.notes)?audit.notes:[];
    return html`<h3>Audit</h3>
      ${discarded?html`<div class="notice" role="status"><strong>DISCARDED</strong><br>A tool call of this pilot went outside its own folder, searched the whole computer for files, reached for this computer over the network, or started the agent runtime again (the causes are listed below). The run is kept on disk and shown here, but it cannot be classified and it is left out of the export counts.</div>`:html`<p class="muted">${audit.status==='CLEAN'?'Every recorded tool call stayed inside the pilot folder, as far as the audit can tell. It reads the commands as text and does not run anything, so a path assembled while a command runs (from a variable or command output it cannot see, or from encoded text) is not seen, and neither is a claude process started under a name built at run time. It does not prove nothing else happened.':endedWithoutAudit(run)?'This pilot ended before the audit ran, so it was not audited. It cannot be classified or exported.':'The audit runs when the pilot finishes.'}</p>`}
      ${violations.length?html`<div class="table-wrap"><table class="ag-table"><caption class="sr-only">Violations found by the audit</caption><thead><tr><th scope="col">Tool</th><th scope="col">Kind</th><th scope="col">Path</th><th scope="col">Offending call</th></tr></thead><tbody>${violations.map(v=>html`<tr><td data-label="Tool">${v.tool}</td><td data-label="Kind">${v.kind}</td><td data-label="Path"><code class="ag-path">${v.path}</code></td><td data-label="Offending call"><code class="ag-path">${String(v.call==null?'':v.call).slice(0,600)}</code></td></tr>`)}</tbody></table></div>
        <ul class="plain-list">${[...new Set(violations.map(v=>v.kind))].filter(causeOf).map(k=>html`<li><strong>${k}:</strong> ${causeOf(k)}</li>`)}</ul>`:''}
      ${modified.length?html`<p><strong>Solver files changed during the run:</strong> ${modified.map(m=>html`<code class="ag-path">${m}</code> `)}</p>`:''}
      ${notes.length?html`<ul class="plain-list">${notes.map(note=>html`<li>${note}</li>`)}</ul><p class="footnote">Notes record what the audit noticed but cannot judge from the text of the commands. A note never discards a run. Read them: a note that a directory change or a command could not be resolved means later paths in that run were not fully checked.</p>`:''}`;
  }
  const FAILURE_REASONS=Object.freeze({
    'exit-code':run=>'The program exited with code '+(run.exitCode==null?'(unknown)':run.exitCode)+'.',
    timeout:()=>'The pilot ran out of time (50 minutes) and was stopped.',
    'no-result':()=>'The program ended without sending a final result.',
    'error-result':()=>'The runtime reported an error as its result. Its message is shown below.',
    budget:()=>{const cfg=S.round&&S.round.config||{};const cap=Number(cfg.maxBudgetUsd==null?BUDGET.pilotDefault:cfg.maxBudgetUsd);return 'The pilot reached its spending cap of '+usd(cap)+' (--max-budget-usd '+cap.toFixed(2)+') and the runtime stopped it before it finished. A later round can set a higher cap per pilot in Settings.';},
    'empty-result':()=>'The program finished with an empty result.',
    'spawn-error':()=>'The program could not be started.',
    'setup-error':()=>'The pilot folder could not be built, so nothing was started.',
    signal:run=>'The program was stopped by a signal'+(run.signal?' ('+run.signal+')':'')+'.',
    'no-exit-code':()=>'The program ended without an exit code.',
    interrupted:()=>'The companion stopped while this pilot was running.'
  });
  const failureReasonText=run=>Object.prototype.hasOwnProperty.call(FAILURE_REASONS,run.failureReason)?FAILURE_REASONS[run.failureReason](run):'';
  function failureHtml(run){
    /* The exact command with the prompt elided: the one the companion showed at approval when this page saw it, else the documented one for the round. */
    const remembered=S.round&&S.commands[S.round.id];
    const command=remembered||(S.round?commandLineFor(null,S.round).text:'claude --version');
    const reason=failureReasonText(run);
    return html`<h3>Why it did not finish</h3>
      ${reason?html`<p><strong>${reason}</strong></p>`:''}
      ${run.stderrTail?html`<pre class="ag-stderr" tabindex="0" aria-label="Last lines of the runtime's error output">${run.stderrTail}</pre>`:html`<p class="muted">No error output was captured.</p>`}
      <p>The companion does not work around a refusal. To see the runtime's own message, run this from your own terminal (the prompt is elided; use your own packet folder if you try the full command). It is the command the companion builds for this round${remembered?', as shown when you approved it':''}:</p>
      <pre class="ag-command">${command}</pre>`;
  }
  function classifyHtml(o,run){
    const enabled=canClassify(run),form=o.form,suggested=run.classification&&run.classification.suggested;
    const fingerprints=knownFingerprints(S.round);
    return html`<h3>Classify this answer</h3>
      ${enabled?'':html`<p class="muted">${auditStatus(run)==='DISCARDED'?'Classification is disabled because this run is DISCARDED.':run.redacted===true&&!isActiveRun(run)?'Classification waits until no round is running.':'Classification opens when the pilot has completed with a clean audit.'}</p>`}
      ${suggested?html`<div class="notice neutral"><strong>Suggested verdict, heuristic: ${verdictLabel(suggested.verdict)}</strong><br>This is a keyword and number match against the frozen gold and fingerprints. It is not a judgement and it is never stored as your verdict.
        ${suggestedMatches(suggested).length?html`<br>Gold figures: ${suggestedMatches(suggested).map(m=>html`<code class="ag-path">${m}</code> `)}`:''}
        ${suggestedFingerprintIds(suggested).length?html`<br>Fingerprint candidates: ${suggestedFingerprintIds(suggested).join(', ')}`:''}
        ${typeof suggested.reason==='string'&&suggested.reason?html`<br>Caution: ${suggested.reason}`:''}
        ${enabled?html`<div class="actions"><button type="button" class="small" data-ag="apply-suggestion" data-ag-key="apply-suggestion">Copy suggestion into the controls</button></div>`:''}</div>`:''}
      <fieldset class="ag-classify" ${enabled?'':'disabled'}><legend>Your verdict</legend>
        ${VERDICTS.map(v=>html`<label class="check"><input type="radio" name="ag-verdict" data-ag-in="verdict" data-id="${v.id}" data-ag-key="verdict-${v.id}" ${form.verdict===v.id?'checked':''}>${v.label}</label>`)}
        <div class="ag-chips" role="group" aria-label="Frozen fingerprints">${fingerprints.length?fingerprints.map(fp=>html`<button type="button" class="ag-chip" data-ag="chip" data-id="${fp.id}" data-ag-key="chip-${fp.id}" aria-pressed="${form.ids.includes(fp.id)?'true':'false'}" ${form.verdict==='fingerprint'?'':'disabled'}>${fp.label||fp.id} <small>${fp.id}${fp.postHoc?' · post-hoc':''}</small></button>`):html`<span class="muted">This round has no frozen fingerprints.</span>`}</div>
        <label class="field">Note (optional)<textarea data-ag-in="class-note" data-ag-key="class-note" rows="3" maxlength="2000">
${form.note}</textarea></label>
        ${form.error?html`<div class="notice" role="alert">${form.error}</div>`:''}
        <div class="actions"><button type="button" class="primary" data-ag="save-class" data-ag-key="save-class" ${enabled&&form.verdict&&!form.saving?'':'disabled'}>Save my verdict</button></div></fieldset>
      ${run.classification&&run.classification.human&&run.classification.human.at?html`<p class="footnote">Saved ${timeText(run.classification.human.at)}.</p>`:''}`;
  }
  async function saveClassification(){
    const o=S.overlay;
    if(!o||o.type!=='drawer'||!canClassify(o.run))return;
    const form=o.form;
    if(!form.verdict)return;
    const ids=form.verdict==='fingerprint'?form.ids:[];
    if(form.verdict==='fingerprint'&&!ids.length){form.error='Choose at least one fingerprint chip, or pick another verdict.';paintOverlay();return;}
    form.error='';form.saving=true;paintOverlay();
    try{
      await api('POST',runPath(o.roundId,o.n,'/classify'),{verdict:form.verdict,fingerprintIds:ids,note:form.note.trim()});
      form.saving=false;
      await refreshRound(o.roundId);
      const data=await api('GET',runPath(o.roundId,o.n));
      if(S.overlay===o){o.run={...(runsOf(S.round).find(r=>r.n===o.n)||{}),...(data.run&&typeof data.run==='object'?data.run:data)};}
      paintAll();paintOverlay();
      say('Your verdict for pilot '+o.n+' was saved. The suggested verdict stays labelled heuristic.');
    }catch(error){
      form.saving=false;form.error=error.message;
      if(S.overlay===o)paintOverlay();
      say(error.message,true);
    }
  }

  /* Simulated grader */
  /* What the run button needs: the three approvals, guidance, and an answer (a clean pilot, or a pasted reference answer). */
  const graderReady=o=>!!(o.acks.run&&o.acks.network&&o.acks.notools&&o.guideline.trim()&&(o.source==='ref'?o.reference.trim():graderRuns().length)&&!o.busy);
  function graderHtml(o){
    const runs=graderRuns(),ref=o.source==='ref';
    return dialogFrame('Simulated grader',html`
      <p class="muted">A tool-less agent reads the guideline text and one answer and returns a verdict and a reason, and a score and a list of items when it gives them. It is a <strong>simulated grader, not Studio grading</strong>, and it is one sample.</p>
      <label class="field">Guideline text<textarea data-ag-in="guideline" data-ag-key="guideline" rows="8" maxlength="40000" data-ag-initial>
${o.guideline}</textarea></label>
      <label class="field">Answer to grade<select data-ag-in="answer-run" data-ag-key="answer-run">${runs.map(run=>html`<option value="${run.n}" ${!ref&&String(run.n)===String(o.runN)?'selected':''}>Pilot ${run.n} final answer</option>`)}<option value="ref" ${ref?'selected':''}>Reference answer (paste)</option></select></label>
      ${ref?html`<label class="field">Reference answer (paste)<textarea data-ag-in="reference" data-ag-key="reference" rows="8" maxlength="60000">
${o.reference}</textarea><small>Calibration: your own answer that meets the guidance should score about ${dec(CALIBRATION.expected)}. Below ${dec(CALIBRATION.floor)} the guidance likely needs fixing before any pilot score means anything.</small></label>`:''}
      <label class="field">Model<select data-ag-in="overlay-model" data-ag-key="overlay-model">${S.status.models.map(m=>html`<option value="${m.id}" ${m.id===o.model?'selected':''}>${m.id}</option>`)}</select>${S.status.graderModel?html`<small>${S.status.graderModel} is offered first: it is the grading instrument. Pilots keep the model chosen in Settings.</small>`:''}</label>
      <fieldset class="ag-acks"><legend>Approve this one run</legend>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="run" data-ag-key="g-run" ${o.acks.run?'checked':''}><span><strong>Run one simulated grader</strong>I approve a single run, with the model chosen above.</span></label>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="network" data-ag-key="g-network" ${o.acks.network?'checked':''}><span><strong>Network use by the agent runtime</strong>The guideline text and the answer are sent to Anthropic by the claude program.</span></label>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="notools" data-ag-key="g-notools" ${o.acks.notools?'checked':''}><span><strong>No tools</strong>The grader gets no shell, file or web tools. It cannot read your folders.</span></label></fieldset>
      ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
      ${o.result?graderResultHtml(o.result):''}
      <div class="actions"><button type="button" class="primary" data-ag="run-grader" data-ag-key="run-grader" ${graderReady(o)?'':'disabled'}>${o.busy?'Running…':'Approve and run'}</button><button type="button" data-ag="close-overlay" data-ag-key="cancel-grader">Close</button></div>`);
  }
  function graderResultHtml(r){
    return html`<div class="notice neutral" role="status" id="ag-grader-result"><strong>${r.calibration?'Calibration: the simulated grader on your reference answer':'Simulated grader, not Studio grading'}</strong><br>Verdict: ${r.verdict||'(none returned)'}<br>Reason: ${r.reason||'(none returned)'}${r.score===null?'':html`<br>Score: ${dec(r.score)}`}
      ${r.items.length?html`<ul class="plain-list" id="ag-grader-items">${r.items.map(i=>html`<li><strong>${i.met===true?'Met':i.met===false?'Not met':'Not judged'}:</strong> ${i.item||'(no item named)'}${i.reason?' · '+i.reason:''}</li>`)}</ul>`:''}</div>
      ${r.calibration?calibrationHtml(r.score,r.verdict):''}`;
  }
  /* What a calibration says about the guidance. It grades the writer's own reference answer, so a low score points at the guidance.
     "Meets" needs the verdict as well as the score, and the floor is compared on the rounded score the notice shows. */
  function calibrationHtml(score,verdict){
    if(score===null)return html`<div class="notice" role="status" id="ag-calibration">The grader returned no usable score (none, or a number outside 0 to 1), so this calibration says nothing about the guidance yet. Run it again.</div>`;
    const shown=dec(score);
    if(Number(shown)<Number(dec(CALIBRATION.floor)))return html`<div class="notice" role="alert" id="ag-calibration"><strong>Your reference answer scored ${shown}, below ${dec(CALIBRATION.floor)}.</strong> A reference answer should score about ${dec(CALIBRATION.expected)}, so the guidance likely needs fixing before any pilot score means anything.</div>`;
    if(verdict!=='meets-guidance')return html`<div class="notice" role="alert" id="ag-calibration"><strong>Your reference answer scored ${shown}, but the verdict was ${verdict||'(none returned)'}, not meets-guidance.</strong> The score and the verdict disagree, so this calibration does not show that the guidance reads your reference as meeting it. Read the reason and run it again.</div>`;
    return html`<div class="notice neutral" role="status" id="ag-calibration">Your reference answer scored ${shown}; about ${dec(CALIBRATION.expected)} is expected. The guidance reads your reference as meeting it, in this one sample.</div>`;
  }
  function openGrader(){
    if(anyRunning()){say(RUNNING_TOOL_LESS,true);return;}
    /* Calibration needs no pilot, so it can come first: with no clean run the dialog opens on the reference answer. */
    const runs=graderRuns();
    const project=currentProject();
    openOverlay({type:'grader',guideline:project&&typeof project.guidance==='string'?project.guidance:'',source:runs.length?'run':'ref',runN:runs.length?runs[0].n:null,reference:'',model:graderModel(),acks:{},busy:false,error:'',result:null});
  }
  /* The companion cleans score and items (parseGraderOutput in backend/agents/rounds.cjs); they are read the same way here, so an
     older companion that sends neither shows a verdict and a reason as before. */
  const resultScore=value=>typeof value==='number'&&Number.isFinite(value)&&value>=-1e-9&&value<=1+1e-9?Math.min(1,Math.max(0,value)):null;
  const resultItems=list=>Array.isArray(list)?list.filter(i=>i&&typeof i==='object').slice(0,20).map(i=>({item:typeof i.item==='string'?i.item:'',met:typeof i.met==='boolean'?i.met:null,reason:typeof i.reason==='string'?i.reason:''})):[];
  async function runGrader(){
    const o=S.overlay;
    if(!o||o.type!=='grader'||!graderReady(o))return;
    const calibration=o.source==='ref';
    o.busy=true;o.error='';o.result=null;paintOverlay();
    try{
      let answer=o.reference;
      if(!calibration){
        const detail=await api('GET',runPath(S.round.id,o.runN));
        const run=detail.run&&typeof detail.run==='object'?detail.run:detail;
        answer=run.final&&typeof run.final.text==='string'?run.final.text:'';
      }
      if(!answer.trim())throw new Error(calibration?'Paste a reference answer to calibrate the guidance.':'That pilot has no final answer to grade.');
      const data=await api('POST','/api/agents/grader-sim',{guidelineText:o.guideline,answerText:answer,model:o.model});
      const result=data.result&&typeof data.result==='object'?data.result:data;
      o.result={verdict:result.verdict,reason:result.reason,score:resultScore(result.score),items:resultItems(result.items),calibration};
      say(calibration?'Calibration finished: the simulated grader read your reference answer.':'Simulated grader finished. It is a simulation, not Studio grading.');
    }catch(error){o.error=error.message;say(error.message,true);}
    o.busy=false;
    if(S.overlay===o)paintOverlay();
  }

  /* Author review */
  /* The files "Leave out" holds back: the roles that are not solver material, which package-engine.js lists as WITHHELD_ROLES
     (tests/agents-page.test.cjs compares the two). The author's own private files must not reach the reviewer by default. */
  const REVIEW_LEFT_OUT_ROLES=['evaluator','run-evidence','audit'];
  const reviewLeftOut=doc=>REVIEW_LEFT_OUT_ROLES.includes(doc.role);
  /* How many files the review holds back and sends, for the dialog and the button: left out only while the box is ticked. */
  function reviewCounts(o){
    const docs=packageDocuments(),held=docs.filter(reviewLeftOut),left=o.leaveOut?held:[];
    return {docs,held,left,sent:docs.length-left.length};
  }
  function packageDigest(leaveOut){
    const out=[];let size=0;const cap=PACKAGE_DIGEST_CHARS;
    for(const doc of packageDocuments()){
      if(leaveOut&&reviewLeftOut(doc))continue;
      const head='FILE '+doc.name+' [role '+doc.role+'] sha256 '+shortHash(doc.sha256);
      out.push(head);size+=head.length;
      for(const record of (Array.isArray(doc.records)?doc.records:[]).slice(0,80)){
        const line='  '+record.locator+': '+String(record.text).replace(/\s+/g,' ').slice(0,400);
        if(size+line.length>cap){out.push('  (digest truncated at '+cap+' characters)');return out.join('\n');}
        out.push(line);size+=line.length;
      }
    }
    return out.join('\n');
  }
  function reviewHtml(o){
    const {docs,held,left,sent}=reviewCounts(o),allChecked=o.acks.run&&o.acks.network&&o.acks.notools;
    const n=(count,one,many)=>count+' '+(count===1?one:many);
    return dialogFrame('Author review',html`
      <p class="muted">One tool-less analysis of the task package loaded on the Overview page. It is an author-side read of the sources, not a blind pilot and not a score.</p>
      <p>${docs.length} ${docs.length===1?'file':'files'} loaded: ${docs.slice(0,12).map(d=>html`<code class="ag-path">${d.name}</code> `)}${docs.length>12?'and more.':''}</p>
      ${held.length?html`<label class="check"><input type="checkbox" data-ag-in="review-leave-out" data-ag-key="review-leave-out" ${o.leaveOut?'checked':''} data-ag-initial><span><strong>Leave out the ${n(held.length,'file','files')} marked evaluator-only, run evidence or author review</strong>Otherwise their extracted text is sent too.</span></label>`:''}
      <p id="ag-review-count" class="${sent?'':'ag-why'}" role="status">${left.length} of ${docs.length} ${docs.length===1?'file is':'files are'} left out; ${n(sent,'file is','files are')} sent as extracted text.${left.length?html` Left out: ${left.slice(0,12).map(d=>html`<code class="ag-path">${d.name}</code> `)}${left.length>12?'and more.':''}`:''}${sent?'':' There is nothing to review: untick the box, or load other files.'}</p>
      <label class="field">Model<select data-ag-in="overlay-model" data-ag-key="overlay-model">${S.status.models.map(m=>html`<option value="${m.id}" ${m.id===o.model?'selected':''}>${m.id}</option>`)}</select></label>
      <fieldset class="ag-acks"><legend>Approve this one run</legend>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="run" data-ag-key="r-run" ${o.acks.run?'checked':''}><span><strong>Run one author review</strong>I approve a single run, with the model chosen above.</span></label>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="network" data-ag-key="r-network" ${o.acks.network?'checked':''}><span><strong>Network use by the agent runtime</strong>An extract of the package text and the prompt are sent to Anthropic by the claude program.</span></label>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="notools" data-ag-key="r-notools" ${o.acks.notools?'checked':''}><span><strong>No tools</strong>The reviewer gets no shell, file or web tools. It cannot read your folders.</span></label></fieldset>
      ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
      ${o.result!==null?html`<div class="notice neutral" role="status"><strong>Author review result</strong></div><pre class="ag-final" tabindex="0" aria-label="Author review result">${o.result||'(the companion returned no text)'}</pre>`:''}
      <div class="actions"><button type="button" class="primary" data-ag="run-review" data-ag-key="run-review" ${allChecked&&sent&&!o.busy?'':'disabled'}>${o.busy?'Running…':'Approve and run'}</button><button type="button" data-ag="close-overlay" data-ag-key="cancel-review">Close</button></div>`);
  }
  function openReview(){
    if(anyRunning()){say(RUNNING_TOOL_LESS,true);return;}
    if(!packageDocuments().length){say('Load a task package on the Overview page first.',true);return;}
    /* Files that are not solver material are left out unless the writer unticks the box: the safe choice is the one that needs no action. */
    openOverlay({type:'review',model:S.config.model,leaveOut:packageDocuments().some(reviewLeftOut),acks:{},busy:false,error:'',result:null});
  }
  async function runReview(){
    const o=S.overlay;
    if(!o||o.type!=='review'||o.busy||!(o.acks.run&&o.acks.network&&o.acks.notools)||!reviewCounts(o).sent)return;
    o.busy=true;o.error='';o.result=null;paintOverlay();
    try{
      const data=await api('POST','/api/agents/author-review',{model:o.model,promptText:S.prompt,packageText:packageDigest(o.leaveOut)});
      const result=data.result&&typeof data.result==='object'?data.result:data;
      o.result=String(result.text||(result.final&&result.final.text)||result.reason||'');
      say('Author review finished.');
    }catch(error){o.error=error.message;say(error.message,true);}
    o.busy=false;
    if(S.overlay===o)paintOverlay();
  }

  /* Export */
  async function fetchExport(){
    const data=await api('POST',roundPath(S.round.id,'/export'),{});
    const records=Array.isArray(data)?data:Array.isArray(data.records)?data.records:Array.isArray(data.experiments)?data.experiments:[];
    const discarded=!Array.isArray(data)&&Array.isArray(data.discarded)?data.discarded:[];
    return {records,discarded,raw:data};
  }
  function exportHtml(o){
    return dialogFrame('Add to project experiments',html`
      <p>This adds <strong>${o.records.length}</strong> experiment ${o.records.length===1?'record':'records'} to the project open in the task editor. ${o.discarded.length?o.discarded.length+' discarded '+(o.discarded.length===1?'run is':'runs are')+' left out.':'No discarded runs were found.'}</p>
      <div class="notice neutral">Directional only, n = ${o.records.length}. The records carry your classification and the frozen fingerprint ids, not a rate. Each record is stamped with the project's current design snapshot. Save the project JSON from the task editor to keep them.</div>
      ${o.records.length?html`<ul class="plain-list">${o.records.map(r=>html`<li><code class="ag-path">${r.runId}</code> · ${r.classification} ${Array.isArray(r.rootFailures)&&r.rootFailures.length?'· fingerprints: '+r.rootFailures.join(', '):''}</li>`)}</ul>`:html`<p class="muted">There is nothing to add yet. Classify the clean runs first.</p>`}
      ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
      <div class="actions"><button type="button" class="primary" data-ag="export-confirm" data-ag-key="export-confirm" data-ag-initial ${o.records.length?'':'disabled'}>Add ${o.records.length} to the project</button><button type="button" data-ag="close-overlay" data-ag-key="cancel-export">Cancel</button></div>`);
  }
  function experimentFrom(record,project,snapshot){
    const C=window.FinanceCore,versions=record.versions&&typeof record.versions==='object'?record.versions:{};
    const exp={id:C.uid(),runId:String(record.runId||''),date:String(record.date||'').slice(0,10),model:String(record.model||''),
      score:record.score==null?'':String(record.score),scoreMax:record.scoreMax==null?'':String(record.scoreMax),evidence:String(record.evidence||''),notes:String(record.notes||''),
      snapshot,
      versions:{prompt:String(versions.prompt||project.versions.prompt),workbook:String(versions.workbook||project.versions.workbook),evaluator:String(versions.evaluator||project.versions.evaluator)},
      classification:String(record.classification||'unclassified'),rootFailures:Array.isArray(record.rootFailures)?record.rootFailures.map(String):[]};
    C.validateExperiment(exp);
    return exp;
  }
  function addToProject(records){
    const A=window.FinanceAuthoring,C=window.FinanceCore;
    if(!A||!C)throw new Error('The task editor is not available in this page.');
    /* A project that has not been through parseProject can order its keys differently, which changes its snapshot string.
       Normalize first so the stamped snapshot is the one the editor will report after it takes the project back. */
    const project=C.parseProject(A.getProject()),snapshot=C.snapshot(project);
    const known=new Set(project.experiments.map(x=>x.runId)),added=[],skipped=[];
    records.forEach(record=>{
      if(known.has(String(record.runId))){skipped.push(record.runId+' (already in the project)');return;}
      try{added.push(experimentFrom(record,project,snapshot));known.add(String(record.runId));}
      catch(error){skipped.push(record.runId+' ('+error.message+')');}
    });
    if(added.length)A.loadProject({...project,experiments:[...project.experiments,...added],updatedAt:new Date().toISOString()});
    return {added:added.length,skipped};
  }
  async function exportAdd(){
    let data;
    await work('export',async()=>{data=await fetchExport();});
    openOverlay({type:'export',records:data.records,discarded:data.discarded,error:''});
  }
  function exportConfirm(){
    const o=S.overlay;
    if(!o||o.type!=='export')return;
    try{
      const result=addToProject(o.records);
      closeOverlay();
      say('Added '+result.added+' '+(result.added===1?'record':'records')+' to the project experiments (directional only, n = '+result.added+').'+(result.skipped.length?' Skipped: '+result.skipped.join('; ')+'.':'')+' Note: the task editor was reloaded from its own copy, so save the project JSON there to keep them.');
    }catch(error){o.error=error.message;paintOverlay();say(error.message,true);}
  }
  async function exportDownload(){
    let payload;
    await work('export',async()=>{
      const data=await fetchExport(),round=await refreshRound(S.round.id);
      payload={schema:'finance-agent-round-download',version:1,exportedAt:new Date().toISOString(),note:'Private task material. Directional only; no rate or difficulty is computed.',round,export:data.raw};
    });
    const text=JSON.stringify(payload,null,2),name='Finance_Agent_Round_'+S.round.id+'_PRIVATE.json';
    if(S.ctx.download)S.ctx.download(name,text);
    else{
      const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');
      a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    say('Downloaded '+name+'. It contains the frozen gold and the prompt, so keep it private.');
  }

  /* ---------- Actions ---------- */
  async function inspect(){
    const dir=S.packet.dir.trim();
    if(!dir)throw new Error('Enter the folder path first.');
    S.packet.error='';
    try{
      await work('inspect',async()=>{await listPacket(dir);});
      say('Listed '+S.packet.files.length+' files. Review the include boxes. Files that look like evaluator material are off by default.');
      saveDraftSoon();
    }catch(error){
      S.packet.error=error.message;
      paintSection('packet');
    }
  }
  /* Lists a packet folder. chosen: the paths to tick (a carried round, or a restored draft for the same folder); without
     it the companion's defaults apply. gaf files follow the gaf setting either way. */
  async function listPacket(dir,chosen){
    const data=await api('POST','/api/agents/packet/inspect',{sourceDir:dir});
    const list=Array.isArray(data)?data:Array.isArray(data.files)?data.files:null;
    if(!list)throw new Error('The companion returned no file list.');
    S.packet.files=list.map(normalizeFile).filter(f=>f.path);
    S.packet.inspectedDir=dir;
    const pick=chosen||(S.draftInclude&&S.draftInclude.dir===dir?new Set(S.draftInclude.paths):null);
    S.draftInclude=null;
    S.packet.files.forEach(f=>{
      if(f.excluded)return;
      if(pick)f.include=pick.has(f.path);
      if(isGaf(f.path))f.include=S.packet.gafVisible&&(pick?f.include:true);
    });
  }
  async function freeze(){
    const built=buildFreeze(),errors=[...formErrors(),...built.errors];
    if(errors.length){S.fz.errors=errors;gates();say('Fix '+errors.length+(errors.length===1?' item':' items')+' before freezing.',true);return;}
    S.fz.errors=[];
    await work('freeze',async()=>{
      /* A draft round made by "Start next round" is frozen as it is, unless the Task field names another task than the one the round
         holds: the companion cannot change a round's task afterwards, so a round with the task the writer typed is made instead. */
      let round=S.round&&S.round.status==='draft'&&S.sigs[S.round.id]===inputSig()&&taskText(S.round.task)===taskText(S.task)?S.round:null;
      if(!round){
        round=normalizeRound(await api('POST','/api/agents/rounds',roundBody()));
        S.sigs[round.id]=inputSig();
        S.roundId=round.id;
        S.round=round;
      }
      rememberApproval(await api('POST',roundPath(round.id,'/freeze'),{gold:built.gold,fingerprints:built.fingerprints,...(built.shipBar?{shipBar:built.shipBar}:{})}));
      await refreshRound(round.id);
      await loadRounds();
    });
    const r=S.round,fr=r&&r.freeze,ch=r&&r.carryChanges;
    say('Gold frozen for round '+r.id+(fr&&fr.sha256?'. Freeze hash '+shortHash(fr.sha256)+'.':'.')
      +(r.carriedFrom&&ch&&typeof ch.freezeContent==='boolean'?' Compared with round '+r.carriedFrom+', the gold and fingerprints are '+(ch.freezeContent?'changed':'unchanged')+(typeof ch.shipBar==='boolean'?' and the ship bar is '+(ch.shipBar?'changed':'unchanged'):'')+'.':'')+' Nothing has run.');
    saveDraftSoon();
  }
  async function refreeze(){
    if(!S.round||!S.round.freeze)return;
    const built=buildFreeze(false);
    if(built.errors.length){S.fz.errors=built.errors;gates();say('Fix '+built.errors.length+' items before saving a post-hoc version.',true);return;}
    S.fz.errors=[];
    await work('refreeze',async()=>{
      await api('POST',roundPath(S.round.id,'/refreeze'),{gold:built.gold,fingerprints:built.fingerprints});
      await refreshRound(S.round.id);
    });
    say('Post-hoc freeze version saved beside the original for round '+S.round.id+'.');
  }
  /* "Start next round from this round": the companion makes a new draft from the stored round, and the form is filled
     from it (the folder is listed again, so the file table is current). Nothing is frozen or approved. */
  /* A number as digits, never with an exponent: String(1e-7) is "1e-7" and String(1.5e21) is "1.5e+21", which parseFigure refuses, so a carried
     figure typed that way would block the freeze. The digits are the shortest ones that read back as the same number. Text is left as it is. */
  function typedFigure(v){
    if(typeof v!=='number'||!Number.isFinite(v))return String(v);
    const text=String(v),m=/^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
    if(!m)return text;
    const digits=m[2]+(m[3]||''),point=m[2].length+Number(m[4]);
    return m[1]+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
  }
  function fzFromContent(content){
    const gold=content&&content.gold&&typeof content.gold==='object'?content.gold:{};
    const figure=f=>({label:String(f&&f.label!=null?f.label:''),value:f&&f.value!=null?typedFigure(f.value):'',tolerance:f&&f.tolerance!=null&&f.tolerance!==''?typedFigure(f.tolerance):''});
    const figures=Array.isArray(gold.figures)?gold.figures.slice(0,50).map(figure):[];
    const prints=Array.isArray(content&&content.fingerprints)?content.fingerprints.slice(0,20).map(fp=>({id:String(fp&&fp.id||''),label:String(fp&&fp.label||''),
      tokens:Array.isArray(fp&&fp.tokens)?fp.tokens.map(String).join('\n'):'',figures:Array.isArray(fp&&fp.figures)?fp.figures.slice(0,50).map(figure):[]})):[];
    const bar=content&&content.shipBar;
    return {decision:String(gold.decision||''),notes:String(gold.notes||''),figures:figures.length?figures:[blankFigure()],fingerprints:prints.length?prints:[blankFingerprint(1)],
      bar:bar&&Number.isInteger(bar.wrong)&&Number.isInteger(bar.of)?{on:true,wrong:String(bar.wrong),of:String(bar.of)}:blankBar(),errors:[]};
  }
  async function loadFormFromRound(round){
    const p=round.packet||{},cfg=round.config||{},ids=list=>list.map(c=>c.id);
    S.packet={dir:String(p.sourceDir||''),inspectedDir:'',files:null,gafVisible:p.gafVisible!==false,error:''};
    S.prompt=String(p.promptText||'');
    S.label=String(round.label||'');
    S.task=taskText(round.task);
    const count=Math.min(Math.max(1,Number(cfg.count)||1),S.status.max),atOnce=atOnceOf({count,concurrency:cfg.concurrency});
    S.config={model:ids(S.status.models).includes(cfg.model)?cfg.model:S.status.defaultModel,effort:ids(S.status.efforts).includes(cfg.effort)?cfg.effort:S.status.defaultEffort,
      count,atOnce:atOnce<count?atOnce:0,budget:Number(cfg.maxBudgetUsd==null?BUDGET.pilotDefault:cfg.maxBudgetUsd).toFixed(2)};
    S.fz=fzFromContent(round.carried&&round.carried.content);
    S.draftInclude=null;
    await listPacket(S.packet.dir,new Set((Array.isArray(p.files)?p.files:[]).filter(f=>f&&f.include).map(f=>f.path)));
  }
  async function startNext(){
    const from=S.round,carry=canCarry(from);
    if(!carry.ok){say(carry.why||'This round cannot be carried forward.',true);return;}
    let created=null;
    await work('next',async()=>{
      created=normalizeRound(await api('POST',roundPath(from.id,'/next'),{}));
      S.roundId=created.id;S.round=created;
      await loadRounds();
      if(created.redacted)throw new Error('Round '+created.id+' was made from round '+from.id+', but a round started running meanwhile, so the companion withheld its gold and prompt from this page. Select it again when the running round has ended.');
      S.carry={from:from.id};
      await loadFormFromRound(created);
      S.sigs[created.id]=inputSig();
    });
    saveDraftSoon();
    say('Round '+created.id+' starts from round '+from.id+': the form now holds its packet selection, prompt, settings, gold and fingerprints. Nothing is frozen or approved. Check them, then freeze to confirm; the new round needs its own approval.');
  }
  async function cancelRound(){
    if(!S.round)return;
    await work('cancel',async()=>{
      await api('POST',roundPath(S.round.id,'/cancel'),{});
      await refreshRound(S.round.id);
      await loadRounds();
    });
    say('Cancel requested for round '+S.round.id+'. Running pilots were sent SIGTERM.');
  }
  async function selectRound(id){
    if(!idOk(id))return;
    S.roundId=id;
    S.round=null;
    paintAll();gates();
    await guarded(async()=>{await refreshRound(id);paintAll();gates();schedulePoll();});
  }
  async function checkRuntime(){
    await work('status',async()=>{await loadStatus();});
    say(S.status.runtime.found?'Claude Code found.':'Claude Code was still not found.',!S.status.runtime.found);
  }
  function setCount(value){
    const n=Math.round(Number(value));
    if(!Number.isFinite(n))return;
    S.config.count=Math.min(Math.max(1,n),S.status.max);
    if(S.config.atOnce>=S.config.count)S.config.atOnce=0;
    updateSpend();
    gates();
  }

  /* ---------- The draft kept in this browser ---------- */
  function storage(){try{return window.localStorage||null;}catch{return null;}}
  function draftData(){
    const files=S.packet.files;
    return {v:1,savedAt:new Date().toISOString(),dir:S.packet.dir,
      include:files&&S.packet.inspectedDir?{dir:S.packet.inspectedDir,paths:files.filter(effectiveInclude).map(f=>f.path)}:S.draftInclude,
      prompt:S.prompt,label:S.label,task:S.task,gafVisible:S.packet.gafVisible,
      config:{model:S.config.model,effort:S.config.effort,count:S.config.count,atOnce:S.config.atOnce,budget:S.config.budget},
      fz:{decision:S.fz.decision,notes:S.fz.notes,figures:S.fz.figures,fingerprints:S.fz.fingerprints,bar:S.fz.bar},
      carry:S.carry,sigs:waitingSigs()};
  }
  /* The form signatures of rounds that are not launched yet, so a reload still knows which round the form froze. */
  function waitingSigs(){
    const waiting=new Set(S.rounds.filter(r=>r&&['draft','frozen','approved'].includes(r.status)).map(r=>r.id));
    if(S.round&&['draft','frozen','approved'].includes(S.round.status))waiting.add(S.round.id);
    const out={};
    Object.keys(S.sigs).filter(id=>waiting.has(id)).slice(-10).forEach(id=>{out[id]=S.sigs[id];});
    return out;
  }
  /* Saved a moment after the last change. Never while a round runs: from launch on, the companion holds the round, and
     nothing beyond what it holds is written here. */
  function saveDraftSoon(){
    if(anyRunning())return;
    clearTimeout(S.draftTimer);
    S.draftTimer=setTimeout(saveDraft,DRAFT_SAVE_MS);
  }
  function saveDraft(){
    S.draftTimer=null;
    if(anyRunning())return;
    const st=storage();
    if(!st)return;
    try{const data=draftData();st.setItem(DRAFT_KEY,JSON.stringify(data));S.draftSavedAt=data.savedAt;}
    catch{return;/* full or blocked storage: the form lives in this page only */}
    if(S.phase==='ready')paintSection('draft');
  }
  function clearStoredDraft(){
    clearTimeout(S.draftTimer);S.draftTimer=null;S.draftSavedAt='';
    const st=storage();
    if(st){try{st.removeItem(DRAFT_KEY);}catch{/* blocked storage holds nothing to remove */}}
  }
  function readDraft(){
    const st=storage();
    if(!st)return null;
    try{
      const text=st.getItem(DRAFT_KEY);
      if(!text)return null;
      const data=JSON.parse(text);
      return data&&typeof data==='object'&&data.v===1?data:null;
    }catch{return null;}
  }
  const textOf=(value,max)=>typeof value==='string'?value.slice(0,max):'';
  /* A stored draft is only text the page put there, but it is read like any input: types checked, lengths capped. */
  function applyDraft(d){
    const figure=f=>({label:textOf(f&&f.label,120),value:textOf(f&&f.value,40),tolerance:textOf(f&&f.tolerance,40)});
    const figures=list=>Array.isArray(list)?list.slice(0,50).filter(f=>f&&typeof f==='object').map(figure):[];
    S.packet.dir=textOf(d.dir,1024);
    S.packet.gafVisible=d.gafVisible!==false;
    S.prompt=textOf(d.prompt,20000);
    S.label=textOf(d.label,120);
    S.task=taskText(textOf(d.task,TASK_MAX));
    const inc=d.include;
    S.draftInclude=inc&&typeof inc==='object'&&typeof inc.dir==='string'&&Array.isArray(inc.paths)?{dir:inc.dir.slice(0,1024),paths:inc.paths.filter(x=>typeof x==='string').slice(0,500)}:null;
    const c=d.config&&typeof d.config==='object'?d.config:{};
    if(typeof c.model==='string'&&S.status.models.some(m=>m.id===c.model))S.config.model=c.model;
    if(typeof c.effort==='string'&&S.status.efforts.some(m=>m.id===c.effort))S.config.effort=c.effort;
    if(Number.isInteger(c.count))S.config.count=Math.min(Math.max(1,c.count),S.status.max);
    S.config.atOnce=Number.isInteger(c.atOnce)&&c.atOnce>0&&c.atOnce<S.config.count?c.atOnce:0;
    if(typeof c.budget==='string')S.config.budget=c.budget.slice(0,6);
    const fz=d.fz&&typeof d.fz==='object'?d.fz:{};
    const gold=figures(fz.figures);
    const prints=Array.isArray(fz.fingerprints)?fz.fingerprints.slice(0,20).filter(fp=>fp&&typeof fp==='object').map(fp=>({id:textOf(fp.id,40),label:textOf(fp.label,160),tokens:textOf(fp.tokens,4000),figures:figures(fp.figures)})):[];
    const bar=fz.bar&&typeof fz.bar==='object'?fz.bar:{};
    S.fz={decision:textOf(fz.decision,500),notes:textOf(fz.notes,4000),figures:gold.length?gold:[blankFigure()],fingerprints:prints.length?prints:[blankFingerprint(1)],
      bar:{on:bar.on===true,wrong:textOf(bar.wrong,3)||String(SHIP_BAR.suggestWrong),of:textOf(bar.of,3)||String(SHIP_BAR.suggestOf)},errors:[]};
    S.carry=d.carry&&typeof d.carry==='object'&&idOk(d.carry.from)?{from:d.carry.from}:null;
    if(d.sigs&&typeof d.sigs==='object')Object.keys(d.sigs).slice(0,10).forEach(id=>{if(idOk(id)&&typeof d.sigs[id]==='string'&&d.sigs[id].length<=200000)S.sigs[id]=d.sigs[id];});
    S.draftSavedAt=textOf(d.savedAt,40);
  }
  function clearDraft(){
    clearStoredDraft();
    S.packet={dir:'',inspectedDir:'',files:null,gafVisible:true,error:''};
    S.prompt='';S.label='';S.task='';S.fz=blankFreezeForm();
    S.config=blankConfig(S.status.defaultModel,S.status.defaultEffort);
    S.config.count=Math.min(S.config.count,S.status.max);
    S.carry=null;S.draftInclude=null;
    paintAll();gates();
    say('Draft cleared: the form is empty and nothing is saved in this browser. Rounds the companion holds are not touched.');
  }

  /* ---------- Polling every 1500 ms while a round has work in flight ---------- */
  function shouldPoll(){
    if(!S.mounted||S.phase!=='ready')return false;
    if(S.rounds.some(r=>r&&r.status==='running'))return true;
    if(S.overlay&&S.overlay.type==='drawer'&&S.overlay.run&&S.overlay.run.redacted===true)return true;
    if(!S.round)return false;
    return ['approved','running'].includes(S.round.status)||runsOf(S.round).some(isActiveRun)||S.round.redacted===true;
  }
  function schedulePoll(){
    clearTimeout(S.timer);
    S.timer=null;
    if(shouldPoll())S.timer=setTimeout(pollOnce,POLL_MS);
  }
  async function pollOnce(){
    S.timer=null;
    if(!S.mounted||document.hidden){schedulePoll();return;}
    try{
      if(S.working){return;}
      const wasRunning=anyRunning();
      if(S.roundId)await refreshRound(S.roundId);
      await loadRounds();
      if(wasRunning&&!anyRunning()){paintAll();gates();}
      else{['strip','draft','runs','round','pilot-gate'].forEach(paintSection);gates();}
      const o=S.overlay;
      if(o&&o.type==='drawer'&&(isActiveRun(o.run||{})||(o.run&&o.run.redacted===true&&!anyRunning())))await refreshDrawer();
    }catch(error){say(error.message,true);}
    finally{schedulePoll();}
  }

  /* ---------- Requests from other views: openRun and openRound ---------- */
  /* A view that wants the writer to land on a round or a pilot records the request here and then navigates to Agents; this module
     never navigates. The request waits until this view is mounted and ready, then selects the round and opens the pilot's drawer
     or scrolls to the step. One that is not applied within two minutes is dropped, so a request nobody followed up cannot open a
     drawer much later. A round or pilot the companion does not have is reported in the status line, not thrown. */
  const PENDING_TTL_MS=120000;
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  /* The answer is {recorded, applied}: applied is true only when the view showed what was asked for. A request that is only recorded
     (no view yet) answers at once with applied: false; one made while the view shows answers when it has been applied. */
  function request(roundId,n,step){
    if(!isLocal())return Promise.resolve({recorded:false,applied:false});
    const bad=!idOk(roundId)?'That round id is not valid.':n!==null&&!(Number.isInteger(n)&&n>=1&&n<=99)?'That pilot number is not valid.':'';
    return new Promise(resolve=>{
      const entry={roundId:bad?'':roundId,n:bad?null:n,step:STEPS.some(([id])=>id===step)?step:'',at:Date.now(),bad,settle:applied=>resolve({recorded:true,applied})};
      if(S.pending)S.pending.settle(false);    /* replaced before it was applied */
      S.pending=entry;
      if(S.mounted&&S.phase==='ready')applyPending();
      else entry.settle(false);
    });
  }
  const openRun=(roundId,n)=>request(roundId,Number(n),'');
  const openRound=(roundId,step)=>request(roundId,null,step);
  /* Applies the recorded request when this view can show it. Runs one request at a time; a newer request replaces an older one
     that has not started. Never rejects. */
  async function applyPending(){
    if(S.applying)return;
    S.applying=true;
    try{
      while(S.pending&&S.mounted&&S.phase==='ready'){
        const wanted=S.pending;
        S.pending=null;
        let applied=false;
        try{applied=await applyRequest(wanted);}
        catch(error){if(S.mounted)say(error.message||String(error),true);}
        wanted.settle(applied);
      }
    }finally{
      S.applying=false;
      /* left the view meanwhile: the request stays recorded for the next mount, and its caller is answered now */
      if(S.pending)S.pending.settle(false);
    }
  }
  async function applyRequest(req){
    if(Date.now()-req.at>PENDING_TTL_MS)return false;
    if(req.bad){say(req.bad,true);return false;}
    const id=req.roundId;
    /* An action in progress (a freeze, an approval) owns the selected round until it ends. */
    for(let i=0;S.working&&i<100;i++)await pause(100);
    let round;
    try{round=normalizeRound(await api('GET',roundPath(id)));}
    catch(error){
      if(S.mounted)say(error.status===404?'Round '+id+' was not found on this companion. It may belong to another project folder, or it was removed.':error.message,true);
      return false;
    }
    /* The view may have been left while the round was read: then nothing is painted, and no drawer opens over another view. */
    if(!S.mounted||S.phase!=='ready')return false;
    S.roundId=id;S.round=round;
    if(S.overlay)closeOverlay();
    try{await loadRounds();}catch{/* the next poll reads the list again */}
    if(!S.mounted)return false;
    paintAll();gates();schedulePoll();
    if(req.n!==null){
      const runs=runsOf(S.round);
      goStep('runs');
      if(!runs.some(run=>run.n===req.n)){
        say('Round '+id+(runs.length?' has no pilot '+req.n+'. Its pilots are '+runs.map(run=>run.n).join(', ')+'.':' has not started any pilots, so there is no pilot '+req.n+' to open.'),true);
        return false;
      }
      focusKey('run-'+req.n);
      await openRunDrawer(req.n);
      return true;
    }
    if(req.step)goStep(req.step);
    return true;
  }

  /* ---------- Lifecycle ---------- */
  async function boot(){
    if(!isLocal()){S.phase='offline';paintRoot();return;}
    S.phase='checking';paintRoot();
    try{await loadStatus();S.phase='ready';}
    catch(error){
      S.phase='offline';
      S.offlineNote=error.status===0&&/agent support|model and effort/.test(error.message)?error.message+' Update the companion and run npm start again.':'';
      paintRoot();
      return;
    }
    const draft=readDraft();
    if(draft)applyDraft(draft);
    paintRoot();
    try{
      await loadRounds();
      if(!S.roundId&&S.rounds.length){S.roundId=S.rounds[0].id;await refreshRound(S.roundId);}
      paintAll();gates();
      if(draft)say('Restored the form you were working on from this browser'+(S.draftSavedAt?' (saved '+timeText(S.draftSavedAt)+')':'')+'.'+(S.packet.dir?' Inspect the folder again to see its files.':'')+' Clear draft empties it.');
    }catch(error){say(error.message,true);}
    schedulePoll();
    applyPending();
  }
  function render(ctx){
    S.ctx={...S.ctx,...(ctx||{})};
    if(!isLocal())S.phase='offline';
    return `<div id="ag-root" class="ag-root">${pageInner().text}</div>`;
  }
  /* The dashboard calls this after each of its own renders, with true while the Agents view is showing. */
  function afterRender(active){
    if(!active){
      S.mounted=false;
      clearTimeout(S.timer);S.timer=null;
      if(S.overlay)closeOverlay();
      updateTitle();
      return;
    }
    S.mounted=true;
    if(S.phase==='idle'||(S.phase==='offline'&&isLocal()))boot();
    else if(S.phase==='ready'){
      loadStatus().then(()=>{paintSection('runtime');}).catch(()=>{});
      updateTitle();
      schedulePoll();
      applyPending();
    }
  }

  /* ---------- Events ---------- */
  /* Inputs and clicks that change the form: each one saves the draft a moment later. */
  const DRAFT_INPUTS=new Set(['dir','prompt','include','gaf','decision','notes','fig','fp','bar-on','bar','model','effort','count','label','task','budget','atonce']);
  const DRAFT_CLICKS=new Set(['use-project-prompt','add-gfig','add-pfig','remove-fig','add-fp','remove-fp','count-dec','count-inc']);
  const CLICK={
    'goto-step':t=>goStep(t.dataset.step),
    'check-runtime':()=>checkRuntime(),
    inspect:()=>inspect(),
    'use-project-prompt':()=>{
      const project=currentProject();
      S.prompt=project&&project.business&&typeof project.business.prompt==='string'?project.business.prompt:'';
      if(!S.prompt.trim())say('The project in the task editor has no business prompt yet.',true);
      paintSection('packet');gates();
    },
    'add-gfig':()=>{S.fz.figures.push(blankFigure());paintSection('freeze');},
    'add-pfig':t=>{const fp=S.fz.fingerprints[+t.dataset.i];if(fp){fp.figures.push(blankFigure());paintSection('freeze');}},
    'remove-fig':t=>{
      const list=figList(t.dataset.kind,+t.dataset.i);
      if(list){list.splice(+t.dataset.j,1);if(t.dataset.kind==='gfig'&&!list.length)list.push(blankFigure());paintSection('freeze');gates();}
    },
    'add-fp':()=>{S.fz.fingerprints.push(blankFingerprint(S.fz.fingerprints.length+1));paintSection('freeze');},
    'remove-fp':t=>{S.fz.fingerprints.splice(+t.dataset.i,1);paintSection('freeze');gates();},
    freeze:()=>freeze(),
    refreeze:()=>refreeze(),
    'count-dec':()=>{setCount(S.config.count-1);paintSection('settings');},
    'count-inc':()=>{setCount(S.config.count+1);paintSection('settings');},
    'open-approve':()=>openApprove(),
    'recheck-preflight':()=>recheckPreflight(),
    'approve-launch':()=>approveAndLaunch(),
    'cancel-round':()=>cancelRound(),
    'next-round':()=>startNext(),
    'clear-draft':()=>clearDraft(),
    'open-run':t=>openRunDrawer(Number(t.dataset.n)),
    'copy-path':()=>copyEvidencePath(),
    'close-overlay':()=>closeOverlay(),
    chip:t=>{
      const o=S.overlay;
      if(!o||o.type!=='drawer')return;
      const id=t.dataset.id,ids=o.form.ids;
      if(ids.includes(id))ids.splice(ids.indexOf(id),1);else ids.push(id);
      paintOverlay();
    },
    'apply-suggestion':()=>{
      const o=S.overlay,s=o&&o.run&&o.run.classification&&o.run.classification.suggested;
      if(!s||!VERDICTS.some(v=>v.id===s.verdict))return;
      o.form.verdict=s.verdict;
      const known=new Set(knownFingerprints(S.round).map(fp=>fp.id));
      o.form.ids=s.verdict==='fingerprint'?suggestedFingerprintIds(s).filter(id=>known.has(id)):[];
      paintOverlay();
    },
    'save-class':()=>saveClassification(),
    'open-grader':()=>openGrader(),
    'run-grader':()=>runGrader(),
    'open-review':()=>openReview(),
    'run-review':()=>runReview(),
    'export-add':()=>exportAdd(),
    'export-confirm':()=>exportConfirm(),
    'export-download':()=>exportDownload()
  };
  const INPUT={
    dir:t=>{S.packet.dir=t.value;gates();},
    prompt:t=>{S.prompt=t.value;updateWordCount();gates();},
    include:t=>{const f=S.packet.files&&S.packet.files[+t.dataset.i];if(f){f.include=t.checked;paintSection('packet');gates();}},
    gaf:t=>setGaf(t.checked),
    decision:t=>{S.fz.decision=t.value;gates();},
    notes:t=>{S.fz.notes=t.value;gates();},
    fig:t=>{const list=figList(t.dataset.kind,+t.dataset.i),fig=list&&list[+t.dataset.j];if(fig&&['label','value','tolerance'].includes(t.dataset.f)){fig[t.dataset.f]=t.value;gates();}},
    fp:t=>{const fp=S.fz.fingerprints[+t.dataset.i];if(fp&&['id','label','tokens'].includes(t.dataset.f)){fp[t.dataset.f]=t.value;gates();}},
    'bar-on':t=>{S.fz.bar.on=!!t.checked;paintSection('freeze');gates();},
    bar:t=>{if(['wrong','of'].includes(t.dataset.f)){S.fz.bar[t.dataset.f]=String(t.value==null?'':t.value).trim().slice(0,3);gates();}},
    model:t=>{S.config.model=t.value;gates();},
    effort:t=>{S.config.effort=t.value;gates();},
    count:(t,e)=>{setCount(t.value);if(e.type==='change'){t.value=S.config.count;paintSection('settings');}},
    atonce:t=>{const n=Number(t.value);S.config.atOnce=Number.isInteger(n)&&n>0&&n<S.config.count?n:0;paintSection('settings');gates();},
    budget:t=>{S.config.budget=String(t.value==null?'':t.value).trim().slice(0,6);updateSpend();gates();},
    label:t=>{S.label=t.value;},
    task:t=>{S.task=String(t.value==null?'':t.value).slice(0,TASK_MAX);},
    'select-round':t=>{if(t.value&&(t.value!==S.roundId||!S.round))return selectRound(t.value);},
    ack:t=>{
      const o=S.overlay;
      if(!o||o.type!=='approve'||!ACKNOWLEDGEMENTS.some(a=>a.id===t.dataset.id))return;
      o.acks[t.dataset.id]=t.checked;
      paintOverlay();
    },
    'overlay-ack':t=>{const o=S.overlay;if(o&&o.acks&&['run','network','notools'].includes(t.dataset.id)){o.acks[t.dataset.id]=t.checked;paintOverlay();}},
    'overlay-model':t=>{const o=S.overlay;if(o&&S.status.models.some(m=>m.id===t.value))o.model=t.value;},
    guideline:t=>{
      const o=S.overlay;
      if(!o||o.type!=='grader')return;
      o.guideline=t.value;
      const button=$('#agents-modal [data-ag="run-grader"]');
      if(button)button.disabled=!graderReady(o);
    },
    /* Typing the reference answer only updates the button, so the caret stays where it is. */
    reference:t=>{
      const o=S.overlay;
      if(!o||o.type!=='grader')return;
      o.reference=String(t.value==null?'':t.value);
      const button=$('#agents-modal [data-ag="run-grader"]');
      if(button)button.disabled=!graderReady(o);
    },
    'answer-run':t=>{
      const o=S.overlay;
      if(!o||o.type!=='grader')return;
      if(t.value==='ref')o.source='ref';
      else{o.source='run';o.runN=Number(t.value);}
      paintOverlay();
    },
    'review-leave-out':t=>{const o=S.overlay;if(o&&o.type==='review'){o.leaveOut=t.checked;paintOverlay();}},
    verdict:t=>{const o=S.overlay;if(o&&o.type==='drawer'&&VERDICTS.some(v=>v.id===t.dataset.id)){o.form.verdict=t.dataset.id;if(t.dataset.id!=='fingerprint')o.form.ids=[];paintOverlay();}},
    'class-note':t=>{const o=S.overlay;if(o&&o.type==='drawer')o.form.note=t.value;}
  };
  function handleEvent(e){
    const target=e.target;
    if(!target||!target.closest)return;
    if(e.type==='keydown'){
      if(S.overlay&&e.key==='Escape'){e.preventDefault();closeOverlay();return;}
      if(S.overlay&&e.key==='Tab'&&target.closest('#agents-modal,#ag-root'))trapTab(e);
      if(e.key==='Enter'&&target.id==='ag-dir'){e.preventDefault();guarded(inspect);}
      return;
    }
    if(e.type==='click'){
      const el=target.closest('[data-ag]');
      if(!el||!(el.closest('#ag-root')||el.closest('#agents-modal')))return;
      if(el.dataset.ag==='backdrop'){if(e.target===el)closeOverlay();return;}
      if(el.disabled)return;
      const handler=CLICK[el.dataset.ag];
      if(handler){guarded(()=>handler(el));if(DRAFT_CLICKS.has(el.dataset.ag))saveDraftSoon();}
      return;
    }
    const el=target.closest('[data-ag-in]');
    if(!el||!(el.closest('#ag-root')||el.closest('#agents-modal')))return;
    const handler=INPUT[el.dataset.agIn];
    if(handler){guarded(()=>handler(el,e));if(DRAFT_INPUTS.has(el.dataset.agIn))saveDraftSoon();}
  }
  ['click','input','change','keydown'].forEach(type=>document.addEventListener(type,handleEvent));

  /* pilotGate is the pure computation behind the Pilot gate card, exposed so tests can check it without a page. */
  window.FinanceAgents={render,afterRender,handleEvent,offlineMessage:OFFLINE_MESSAGE,link,get,post,openRun,openRound,pilotGate};
})();
