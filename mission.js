/* Mission Control (SPEC 4, 9, 10.2): one card per task, a live panel with a four-stage stepper, a run feed that shows work arriving,
   a docked inspector for the selected run, and the recent outputs. It answers three questions for every run within five seconds:
   what ran, what happened, where the output is.
   Rules this file keeps:
   - Data comes from the companion through FinanceAgents (link, get, openRun, openRound) and its OWN poller: 1.5 s while a round runs,
     8 s idle, only while this view is mounted and the tab is visible, backing off to 15 s after errors, stopped by afterRender(false).
     The file edition makes no request at all.
   - What to show comes from FinanceMissionModel (board, feed, score rows, next action) and FinanceViews (keyed patch, listbox,
     announcer, store). This file only draws it. It computes no rate, percentage, trend or difficulty: counts are counts.
   - While a round runs the companion withholds gold, prompts and answers. The page then shows "Details withheld while a round runs" and
     drops any answer or log text it held. Imported evaluation records keep only the score, run and date (fts.evals.v1); the parsed
     reasoning is never stored.
   - State is module-private (never in the dashboard state, which is exported). The dashboard rebuilds the page on every state change,
     so afterRender(true) repaints from this state. Own listeners are delegated on document and filtered by closest('#mc-root').
   - At most one yellow primary button is on screen: Load task package when nothing is loaded and no round exists, else the next-action
     button of the one task the model marks primaryEligible, else (loaded, no round) Open Agents.
   No inline styles, no inline handlers, no document.title, no request except through FinanceAgents.get. */
(function(){
  'use strict';
  const V=window.FinanceViews,M=window.FinanceMissionModel,W=window.FinanceWorkbenchModel;
  if(!V||!M){
    window.FinanceMission={render:()=>'<div id="mc-root" class="mc-root"><p>Mission Control did not load: its helper scripts are missing.</p></div>',afterRender(){}};
    return;
  }
  const h=V.html,raw=V.raw;
  const POLL_LIVE=1500,POLL_IDLE=8000,POLL_MAX=15000,POLL_FAIL=3000,LOST_AFTER=2,FEED_LIMIT=200,EXTRA_ROUNDS=6;
  const CARD_CAP=6,OUT_SHOW=4,OUT_TRACK=8,OUT_FETCH=4,LOG_KEEP=300,LOG_SHOW=40,LOG_PAGE=100,EVAL_CAP=200,FILE_MAX=30*1024*1024;
  const WITHHELD=M.WITHHELD,OFFLINE_TEXT=M.OFFLINE_MESSAGE;
  /* The stage filter of the feed: the model's state filters plus the page's own "Has outputs". */
  const STAGES=[['all','All stages'],['running','Running'],['needs-verdict','Needs your verdict'],['completed','Completed'],['failed','Failed'],['discarded','Discarded'],['cancelled','Cancelled'],['outputs','Has outputs']];
  const STAGE_IDS=STAGES.map(s=>s[0]);

  /* ---------- state ---------- */
  const S={
    ctx:null,pkg:false,inited:false,mounted:false,gen:0,
    link:'checking',linkText:'',linkError:'',everOk:false,at:0,now:0,
    rounds:[],runs:[],redacted:false,evals:[],
    board:null,all:null,items:[],counts:null,byKey:new Map(),live:null,
    task:null,run:null,query:'',stage:'all',fresh:0,feedTop:0,details:false,more:false,
    detail:new Map(),log:null,copied:'',
    imp:{open:false,busy:false,error:'',parsed:null,name:'',task:''},
    timer:0,busy:false,fails:0,seen:null,seenRounds:null,ann:null,stopVisible:null,searchTimer:0,copyTimer:0
  };

  /* ---------- small helpers ---------- */
  const $=s=>{try{return document.querySelector(s);}catch{return null;}};
  const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const arr=v=>Array.isArray(v)?v:[];
  const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const plural=(n,a,b)=>n+' '+(n===1?a:b||a+'s');
  const clean=(v,max)=>String(v==null?'':v).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max||200);
  const msg=e=>clean(e&&e.message?e.message:e,300)||'Something went wrong.';
  const timeOf=iso=>{const t=Date.parse(iso);return Number.isFinite(t)?t:null;};
  const stamp=iso=>V.formatTime(iso);
  const sizeText=n=>{const b=num(n);if(b===null)return '';if(b<1024)return b+' B';const k=Math.round(b/102.4)/10;if(k<1024)return k+' KB';return (Math.round(b/104857.6)/10)+' MB';};
  const mac=(()=>{try{return /Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent||'');}catch{return false;}})();
  /* An id-safe, collision-resistant word for a task key (the key holds whatever the person typed). */
  const slug=text=>{let x=5381;for(const ch of String(text))x=((x*33)^ch.codePointAt(0))>>>0;return x.toString(36);};
  const KBD=mac?'⌘ K':'Ctrl K';
  const ICON={
    search:'<svg class="mc-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2 17 17"/></svg>',
    task:'<svg class="mc-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 2.5h7l3 3v12H5z"/><path d="M12 2.5v3h3M7.5 10h5M7.5 13h5"/></svg>'
  };

  /* Filters the person chose are kept in the browser (fts.mc.v1); the search text is not. */
  function init(){
    if(S.inited)return;
    S.inited=true;
    const saved=V.store.get(V.STORE_KEYS.mc,{},isObj);
    if(typeof saved.task==='string'&&saved.task.length<=200)S.task=saved.task;
    if(STAGE_IDS.includes(saved.stage))S.stage=saved.stage;
  }
  const saveFilters=()=>{V.store.set(V.STORE_KEYS.mc,{task:S.task,stage:S.stage});};
  const readEvals=()=>arr(V.store.get(V.STORE_KEYS.evals,[],Array.isArray)).filter(isObj);

  /* ---------- the shell, as far as this page needs it ---------- */
  const agents=()=>window.FinanceAgents||null;
  const dash=()=>window.FinanceDashboard||null;
  function go(view){const D=dash();if(D&&typeof D.navigate==='function'){D.navigate(view);return true;}return false;}
  function goAgents(target){
    const A=agents();
    if(A&&target&&target.roundId){
      const n=target.runKey?Number(String(target.runKey).split(':').pop()):NaN;
      if(Number.isInteger(n)&&typeof A.openRun==='function')A.openRun(target.roundId,n);
      else if(typeof A.openRound==='function')A.openRound(target.roundId,target.step);
    }
    return go('agents');
  }
  function goWorkbench(roundId,n){
    const B=window.FinanceWorkbench;
    if(!B||typeof B.open!=='function')return false;
    try{B.open({roundId,n});}catch{return false;}
    return go('workbench');
  }
  const canWorkbench=()=>{const B=window.FinanceWorkbench,D=dash();return !!(B&&typeof B.open==='function'&&D&&typeof D.navigate==='function');};
  function loadPackage(){
    const c=S.ctx,D=dash();
    if(c&&typeof c.loadFiles==='function')c.loadFiles();
    else if(D&&typeof D.loadFiles==='function')D.loadFiles();
  }

  /* ---------- polling ---------- */
  const anyRunning=()=>S.rounds.some(r=>r&&r.status==='running')||S.runs.some(r=>r&&(r.state==='running'||r.state==='queued'));
  function nextDelay(){
    if(S.fails>0)return Math.min(POLL_MAX,POLL_FAIL*Math.pow(2,S.fails-1));
    return anyRunning()?POLL_LIVE:POLL_IDLE;
  }
  function schedule(ms){
    clearTimeout(S.timer);S.timer=0;
    if(!S.mounted||S.link==='offline'||V.isHidden())return;
    const gen=S.gen;
    S.timer=setTimeout(()=>{S.timer=0;if(gen===S.gen&&!V.isHidden())poll();},ms===undefined?nextDelay():ms);
  }
  async function findLink(){
    const A=agents();
    if(!A||typeof A.link!=='function'||typeof A.get!=='function'){S.link='offline';S.linkText=OFFLINE_TEXT;return;}
    const l=await A.link();
    if(!l||!l.local){S.link='offline';S.linkText=(l&&l.offlineMessage)||A.offlineMessage||OFFLINE_TEXT;return;}
    if(!l.ok)throw new Error(l.error||'The companion could not be reached.');
  }
  async function poll(){
    if(S.busy||!S.mounted)return;
    S.busy=true;
    const gen=S.gen,A=agents();
    try{
      if(S.link==='checking'||(S.link==='lost'&&!S.everOk))await findLink();
      if(gen!==S.gen)return;
      if(S.link==='offline'){derive();paint();return;}
      const [r,f]=await Promise.all([A.get('/api/agents/rounds'),A.get('/api/agents/runs?limit='+FEED_LIMIT)]);
      if(gen!==S.gen)return;
      const rounds=arr(r&&r.rounds).filter(x=>isObj(x)&&typeof x.id==='string');
      let runs=arr(f&&f.runs);
      const redacted=!!((r&&r.redacted)||(f&&f.redacted));
      /* A round whose pilots did not all fit in the feed page is asked for on its own, so a card never tallies a partial list. */
      const short=rounds.filter(x=>{const n=num(x.runCount);return n>0&&runs.filter(y=>y&&y.roundId===x.id).length<n;}).slice(0,EXTRA_ROUNDS);
      if(short.length){
        const more=await Promise.all(short.map(x=>A.get('/api/agents/runs?round='+encodeURIComponent(x.id)+'&limit=200').then(v=>arr(v&&v.runs),()=>[])));
        if(gen!==S.gen)return;
        runs=runs.concat(...more);
      }
      const wasLost=S.link==='lost';
      if(redacted&&!S.redacted)scrub();
      S.rounds=rounds;S.runs=runs;S.redacted=redacted;S.link='local';S.linkError='';S.fails=0;S.everOk=true;S.at=Date.now();
      if(wasLost&&S.ann){S.ann.resolve('link');S.ann.say('The link to the local companion is back.',{kind:'link-restored'});}
      derive();announce();paint();
      await pullExtras();
      if(gen===S.gen)paintDetail();
    }catch(e){
      if(gen!==S.gen)return;
      S.fails++;S.linkError=msg(e);
      if(S.link==='local'&&S.fails>=LOST_AFTER){
        S.link='lost';
        if(S.ann)S.ann.alert('The link to the local companion was lost. The page shows what it last saw.',{key:'link'});
      }else if(S.link==='checking'&&S.fails>=LOST_AFTER){
        S.link='lost';
        if(S.ann)S.ann.alert('The local companion could not be reached.',{key:'link'});
      }
      derive();paint();
    }finally{
      /* a poll that outlived its view (left and shown again) must not release the lock of the newer poll */
      if(gen===S.gen){S.busy=false;if(S.mounted)schedule();}
    }
  }
  const pollNow=()=>{clearTimeout(S.timer);S.timer=0;if(S.mounted&&!S.busy)poll();};

  /* ---------- blindness: what is held, and when it must go ---------- */
  function scrub(){
    S.detail.clear();
    S.log=null;
  }
  /* Keep only what the page shows: the output names and sizes, and the first part of the final answer. */
  function slimDetail(res){
    const d=isObj(res)?res:{},f=isObj(d.final)?d.final:null;
    return {
      outputs:arr(d.outputs).filter(o=>isObj(o)&&typeof o.name==='string').slice(0,200).map(o=>({name:clean(o.name,300),bytes:num(o.bytes)})),
      final:f?{chars:num(f.chars),text:typeof f.text==='string'?f.text.slice(0,6000):undefined}:null
    };
  }
  const slimLine=l=>isObj(l)?{seq:num(l.seq),at:typeof l.at==='string'?l.at:null,kind:clean(l.kind,20),tool:l.tool===undefined?undefined:clean(l.tool,30),chars:num(l.chars),text:typeof l.text==='string'?l.text.slice(0,400):undefined}:null;
  async function loadDetail(item){
    const A=agents(),old=S.detail.get(item.key);
    if(S.redacted||!A||(old&&old.final))return;
    const res=await A.get('/api/agents/rounds/'+encodeURIComponent(item.roundId)+'/runs/'+item.n);
    if(S.redacted||(res&&res.redacted))return;
    S.detail.set(item.key,{data:slimDetail(res),final:!!item.ended,at:Date.now()});
    if(S.detail.size>60){const first=S.detail.keys().next().value;S.detail.delete(first);}
  }
  async function loadLog(item){
    const A=agents();
    if(!A)return;
    let lg=S.log;
    if(!lg||lg.key!==item.key)lg=S.log={key:item.key,lines:[],next:0,done:false,withheld:S.redacted,error:''};
    if(lg.withheld!==S.redacted){lg.lines=[];lg.next=0;lg.done=false;lg.withheld=S.redacted;}
    if(lg.done||lg.busy)return;
    lg.busy=true;
    try{
      for(let page=0;page<4;page++){
        const res=await A.get('/api/agents/rounds/'+encodeURIComponent(item.roundId)+'/runs/'+item.n+'/log?after='+lg.next+'&limit='+LOG_PAGE);
        if(S.log!==lg)return;
        const withheld=!!(res&&(res.withheld||res.redacted));
        if(withheld!==lg.withheld){lg.lines=[];lg.next=0;lg.done=false;lg.withheld=withheld;if(page>0)break;continue;}
        const lines=arr(res&&res.lines).map(slimLine).filter(Boolean);
        lg.lines=V.trimRing(lg.lines.concat(lines),LOG_KEEP,50);
        lg.next=num(res&&res.next)!==null?res.next:lg.next;
        lg.done=!!(res&&res.done);
        lg.error='';
        if(lg.done||arr(res&&res.lines).length<LOG_PAGE)break;
      }
    }catch(e){if(S.log===lg)lg.error=msg(e);}
    finally{lg.busy=false;}
  }
  /* The selected run's detail and log, and the names of the newest runs' outputs. Each fetch fails alone. */
  async function pullExtras(){
    const jobs=[];
    const sel=S.run?S.byKey.get(S.run):null;
    if(S.run&&!sel){S.run=null;S.log=null;}
    if(sel){jobs.push(loadDetail(sel),loadLog(sel));}
    if(!S.redacted){
      let fetched=0;
      for(const it of outputRuns().slice(0,OUT_TRACK)){
        const d=S.detail.get(it.key);
        if((!d||!d.final)&&it!==sel&&fetched<OUT_FETCH){fetched++;jobs.push(loadDetail(it));}
      }
    }
    await Promise.all(jobs.map(p=>Promise.resolve(p).catch(()=>{})));
  }

  /* ---------- derived data ---------- */
  function haystack(it){
    const d=S.detail.get(it.key),names=d&&d.data&&Array.isArray(d.data.outputs)?d.data.outputs.map(o=>o&&o.name).join(' '):'';
    return [it.taskName,it.what,it.happened,it.stateWord,it.roundName,it.model,it.output.relPath,it.output.workingFolder,names].join(' ').toLowerCase();
  }
  const matchItem=it=>{const q=S.query.trim().toLowerCase();return !q||haystack(it).includes(q);};
  function taskText(t){
    return [t.name,t.version.label,t.statusLabel,t.nextAction.label,...M.scoreRows(t).map(r=>r.text)].join(' ').toLowerCase();
  }
  /* A search keeps a task when its own text matches or when any of its runs does (a file name, a model). */
  function visibleTasks(){
    const b=S.board;
    if(!b)return [];
    const q=S.query.trim().toLowerCase();
    if(!q)return b.tasks;
    const owners=new Set((S.all?S.all.items:[]).filter(matchItem).map(i=>i.taskKey));
    return b.tasks.filter(t=>owners.has(t.key)||taskText(t).includes(q));
  }
  const taskSelected=()=>S.board&&S.task&&S.board.tasks.some(t=>t.key===S.task)?S.task:null;
  function derive(){
    S.now=Date.now();
    S.evals=readEvals();
    const offline=S.link==='offline'||S.link==='lost';
    S.board=M.buildBoard({rounds:S.rounds,runs:S.runs,evals:S.evals,now:S.now,redacted:S.redacted,offline});
    S.all=M.buildFeed({runs:S.runs,rounds:S.rounds,filter:{},now:S.now,redacted:S.redacted});
    const f=M.buildFeed({runs:S.runs,rounds:S.rounds,filter:{task:taskSelected(),state:S.stage==='outputs'?'all':S.stage},now:S.now,redacted:S.redacted});
    S.counts=f.counts;
    S.items=f.items.filter(it=>(S.stage!=='outputs'||it.output.files>0)&&matchItem(it));
    S.byKey=new Map(S.all.items.map(i=>[i.key,i]));
    S.live=pickLive();
  }
  const launched=r=>!!r.launchedAt||['running','finished','cancelled','failed'].includes(r.status);
  const roundActive=r=>r.status==='running'||(isObj(r.counts)&&(num(r.counts.running)||0)+(num(r.counts.queued)||0)>0);
  function pickLive(){
    const b=S.board;
    if(!b||!S.rounds.length)return null;
    const byId=new Map(S.rounds.map(r=>[r.id,r])),sel=taskSelected();
    const tasks=sel?b.tasks.filter(t=>t.key===sel):visibleTasks();
    let best=null;
    for(const t of tasks)for(const id of t.roundIds){
      const r=byId.get(id);
      if(!r||!launched(r))continue;
      const live=roundActive(r),rank=(live?1e14:0)+(timeOf(r.lastActivityAt||r.createdAt)||0);
      if(!best||rank>best.rank)best={r,t,rank};
    }
    return best?liveFacts(best.r,best.t):null;
  }
  /* The facts of one round for the stepper and the details. From its pilot rows when all of them are present, else from its counts. */
  function liveFacts(r,t){
    const rows=S.runs.filter(x=>x&&x.roundId===r.id);
    const planned=num(r.runCount)||num(r.config&&r.config.count)||rows.length;
    const full=rows.length>=planned&&rows.length>0;
    const c=isObj(r.counts)?r.counts:{};
    const tally=M.tallyRuns(rows);
    const queued=full?tally.queued:num(c.queued)||0,running=full?tally.running:num(c.running)||0;
    const completed=full?rows.filter(x=>x.state==='completed').length:num(c.completed)||0;
    const failed=full?rows.filter(x=>x.state==='failed').length:num(c.failed)||0;
    const cancelled=full?rows.filter(x=>x.state==='cancelled').length:num(c.cancelled)||0;
    const inflight=queued+running,toClassify=full?tally.unclassified:null;
    const startedAt=r.launchedAt||null,start=timeOf(startedAt),end=timeOf(r.endedAt);
    const elapsed=start===null?null:Math.max(0,(inflight>0||end===null?S.now:end)-start);
    const items=S.all?S.all.items.filter(i=>i.roundId===r.id):[];
    const current=items.find(i=>i.state==='running')||null;
    const calls=rows.reduce((n,x)=>n+(x.toolCalls&&num(x.toolCalls.total)||0),0);
    return {round:r,task:t,rows,planned,full,queued,running,completed,failed,cancelled,inflight,toClassify,tally,startedAt,elapsed,current,calls,
      roundName:(items[0]&&items[0].roundName)||r.label||r.id};
  }
  /* A round is complete when nothing is in flight and every clean pilot has your verdict. A pilot list that has not loaded in full
     (toClassify null) cannot say so: the round then waits at Classify instead of claiming it is complete. */
  const roundComplete=L=>L.inflight===0&&L.toClassify===0;
  function stageStates(L){
    const finished=L.completed+L.failed+L.cancelled>0;
    let cur;
    if(L.inflight>0)cur=L.running>0||finished?1:0;
    else cur=roundComplete(L)?3:2;
    return [0,1,2,3].map(i=>i<cur?'done':i===cur?(i===3&&roundComplete(L)?'done':'current'):'todo');
  }

  /* ---------- what is yellow ---------- */
  /* 'load' | 'task:<key>' | 'start' | '' : the one primary on screen. */
  function primaryOf(){
    const b=S.board;
    if(S.link==='checking'&&!S.everOk)return '';
    if(!S.pkg&&!S.rounds.length)return 'load';
    if(b&&b.primaryTaskKey)return 'task:'+b.primaryTaskKey;
    if(S.pkg&&!S.rounds.length&&S.link==='local'&&S.everOk)return 'start';
    return '';
  }

  /* ---------- region markup ---------- */
  const offlineNow=()=>S.link==='offline'||S.link==='lost';
  function loadHtml(){
    return h`<button type="button" class="${primaryOf()==='load'?'primary':''}" data-mc="load" data-key="mc-load">Load task package</button>`;
  }
  function stripHtml(){
    const b=S.board,off=offlineNow();
    if(S.link==='checking'&&!S.everOk)return h`<p class="mc-strip-text"><span>Checking for the local companion...</span></p>`;
    const running=b&&b.counts.running!==null?b.counts.running:0,needs=b?b.counts.needsVerdict:0,tasks=b?b.counts.tasks:0;
    const linkLabel=S.link==='local'?'Local companion':S.link==='lost'?'Link lost':S.link==='checking'?'Checking...':'Offline';
    return h`<p class="mc-strip-text">
      ${tasks?h`<span><strong>${tasks}</strong> ${tasks===1?'task':'tasks'}</span>`:''}
      ${off?h`<span>Active agents: Not available</span>`:tasks?h`<span><strong>${running}</strong> ${running===1?'pilot':'pilots'} running</span>`:''}
      ${off||!tasks?'':h`<span><strong>${needs}</strong> ${needs===1?'pilot needs':'pilots need'} your verdict</span>`}
      <span class="mc-link-state" data-link="${S.link}"><span class="mc-link-dot" aria-hidden="true"></span>${linkLabel}</span>
      ${S.at?h`<span>Updated <time>${stamp(S.at)}</time></span>`:''}
    </p>
    <button type="button" class="mc-link" data-mc="import" data-key="mc-import-open" aria-expanded="${S.imp.open?'true':'false'}" aria-controls="mc-import">Import evaluation result</button>`;
  }
  function noteHtml(){
    if(S.link==='offline')return h`<p class="mc-note">${S.linkText||OFFLINE_TEXT}</p>`;
    if(S.link==='lost'){
      const when=S.at?'Showing what was last seen at '+stamp(S.at)+'.':'Nothing has loaded yet.';
      return h`<div class="mc-note is-stale"><p>The link to the local companion was lost. ${when} ${S.linkError}</p><button type="button" data-mc="retry" data-key="mc-retry">Retry now</button></div>`;
    }
    return '';
  }
  function knownTasks(){return S.board?S.board.tasks.filter(t=>!t.unassigned).map(t=>t.name):[];}
  function importHtml(){
    const i=S.imp;
    if(!i.open)return '';
    const p=i.parsed;
    const score=p?(p.finalScore+(p.scoreMax!==null?' / '+p.scoreMax:'')):'';
    return h`<section class="mc-import mc-panel" aria-labelledby="mc-imp-title">
      <h2 class="mc-h2" id="mc-imp-title">Import evaluation result</h2>
      <p class="mc-hint">Choose the grading result file from the evaluation. It is read in this browser. Only the score, run and date are kept; the reasoning text is not saved.</p>
      ${i.error?h`<p class="mc-error" id="mc-imp-error">${i.error}</p>`:''}
      ${p?h`<dl class="mc-facts">
          <dt>File</dt><dd>${i.name}</dd>
          <dt>Score</dt><dd><strong>${score}</strong></dd>
          <dt>Run</dt><dd>${p.runId||'not recorded'}</dd>
          ${p.judge?h`<dt>Judge</dt><dd>${[p.judge.provider,p.judge.model].filter(Boolean).join(' ')}</dd>`:''}
        </dl>
        <label class="mc-field" for="mc-imp-task"><span>Task this result belongs to</span>
          <input id="mc-imp-task" type="text" list="mc-task-list" maxlength="120" value="${i.task}" data-mc-in="imp-task" data-key="mc-imp-task" autocomplete="off" ${i.error?'aria-describedby="mc-imp-error"':''} placeholder="Task name, for example Atlas">
        </label>
        <datalist id="mc-task-list">${knownTasks().map(n=>h`<option value="${n}"></option>`)}</datalist>
        <div class="mc-actions"><button type="button" data-mc="import-save" data-key="mc-imp-save" ${i.busy?'disabled':''}>Record result</button><button type="button" class="mc-quiet" data-mc="import-cancel" data-key="mc-imp-cancel">Cancel</button></div>`
      :h`<div class="mc-actions"><button type="button" data-mc="import-choose" data-key="mc-imp-choose" ${i.busy?'disabled':''}>${i.busy?'Reading...':'Choose file'}</button><button type="button" class="mc-quiet" data-mc="import-cancel" data-key="mc-imp-cancel">Cancel</button></div>`}
    </section>`;
  }
  function scoreParts(row){
    const m=/^(Imported evaluation result: )(.+?)(, run [\s\S]*)$/.exec(row.text);
    return m?h`${m[1]}<strong>${m[2]}</strong>${m[3]}`:h`${row.text}`;
  }
  /* "N active" with a dot for each running pilot; never a zero for what is not known (offline). It sits inside the card's button, so the
     button's name carries it. */
  function activeHtml(t){
    const a=t.active;
    if(!a||a.available===false||a.total===null)return h`<span class="mc-active is-na">Active agents: Not available</span>`;
    if(a.total<1)return h`<span class="mc-active">0 active<span class="sr-only"> agents</span></span>`;
    const dots=Math.min(a.running,3);
    return h`<span class="mc-active is-on"><span class="mc-dots" aria-hidden="true">${Array.from({length:dots},()=>h`<span class="mc-dot is-live"></span>`)}</span>${a.total} active<span class="sr-only"> agents</span></span>`;
  }
  /* A card shows its name, version, active agents, score line and next action, and it never changes height when it is selected:
     a selection filters the feed and the outputs and puts the task's scores and counts in the live run's Details. With no recorded
     score the card says only "No score recorded"; the exact sentence (SPEC 3.2) is in the Details. */
  function cardHtml(t,primary){
    const sel=S.task===t.key,rows=M.scoreRows(t),ev=rows.find(r=>r.kind==='evaluation');
    const next=t.nextAction;
    const pr=primary==='task:'+t.key;
    return h`<li class="mc-card${sel?' is-selected':''}">
      <button type="button" class="mc-card-main" data-mc="card" data-task="${t.key}" data-key="card:${t.key}" aria-pressed="${sel?'true':'false'}">
        <span class="mc-tile" aria-hidden="true">${raw(ICON.task)}</span>
        <span class="mc-card-id"><span class="mc-card-name">${t.name}</span>${t.version.label?h`<span class="mc-version" title="${t.version.label}">${t.version.label}</span>`:''}</span>
        ${activeHtml(t)}
      </button>
      <p class="mc-score">${ev?scoreParts(ev):'No score recorded'}${ev&&ev.note?h` <span class="mc-badge">${ev.note}</span>`:''}</p>
      <div class="mc-next">
        <p class="mc-next-text"><span class="mc-caption">Next action</span><span class="mc-next-label">${next.label}</span></p>
        <button type="button" class="mc-next-btn${pr?' primary':''}" data-mc="next" data-task="${t.key}" data-key="next:${t.key}" ${next.blocked?h`disabled aria-describedby="mc-why-${slug(t.key)}"`:''}>${next.cta||'Open in Agents'}</button>
        ${next.blocked&&next.blockedReason?h`<p class="mc-why" id="mc-why-${slug(t.key)}">${next.blockedReason}</p>`:''}
      </div>
    </li>`;
  }
  function cardsHtml(){
    const b=S.board,all=visibleTasks();
    if(!b)return '';
    if(!all.length)return S.query&&b.tasks.length?h`<li class="mc-none"><p>No task matches "${S.query}".</p></li>`:'';
    const shown=S.more||S.query||all.length<=CARD_CAP?all:all.slice(0,CARD_CAP);
    const primary=primaryOf();
    const rest=all.length-shown.length;
    return h`${shown.map(t=>cardHtml(t,primary))}${rest>0?h`<li class="mc-more"><button type="button" class="mc-quiet" data-mc="more" data-key="mc-more">Show ${plural(rest,'more task')}</button></li>`:''}${S.more&&!S.query&&all.length>CARD_CAP?h`<li class="mc-more"><button type="button" class="mc-quiet" data-mc="more" data-key="mc-more">Show fewer tasks</button></li>`:''}`;
  }
  function emptyHtml(){
    const b=S.board;
    if(S.link==='checking'&&!S.everOk)return '';
    if(S.link==='lost'&&!S.everOk)return '';
    if(S.link!=='local'||!b||b.tasks.length)return '';
    const p=primaryOf()==='start';
    return h`<section class="mc-quiet-panel mc-panel"><p>${b.message}</p>${p?h`<div class="mc-actions"><button type="button" class="primary" data-mc="start" data-key="mc-start">Open Agents</button></div>`:''}</section>`;
  }
  /* ---- the live panel ---- */
  function liveHeadHtml(){
    const L=S.live;
    if(!L)return '';
    const run=L.inflight>0,taskName=L.task.name;
    return h`<div class="mc-live-top">
        <h2 class="mc-h2" id="mc-live-title"><span class="mc-dot${run?' is-live':''}" aria-hidden="true"></span>${run?'Live run':'Latest run'}</h2>
        <button type="button" class="mc-link" data-mc="view-run" data-key="mc-view-run">View run details</button>
      </div>
      <p class="mc-live-sub"><strong>${taskName}</strong> <span aria-hidden="true">·</span> ${L.roundName}</p>
      <p class="mc-live-meta">${L.startedAt?'Started '+stamp(L.startedAt):'Not started'} <span aria-hidden="true">·</span> ${plural(L.planned,'pilot')}</p>`;
  }
  const STEP_NAMES=['Queued','Running','Classify','Complete'];
  function stepsHtml(){
    const L=S.live;
    if(!L)return '';
    const st=stageStates(L);
    const lines=[
      L.queued>0?L.queued+' waiting':'None waiting',
      L.planned?L.completed+' of '+plural(L.planned,'pilot')+' finished':L.completed+' finished',
      L.toClassify===null?'Pilot list not loaded':L.toClassify>0?L.toClassify+' to classify':'Nothing to classify',
      roundComplete(L)?'Ended, all classified':'Not yet'
    ];
    return h`${STEP_NAMES.map((n,i)=>h`<li class="mc-step is-${st[i]}"${st[i]==='current'?raw(' aria-current="step"'):''}>
        <span class="mc-mark" aria-hidden="true">${st[i]==='done'?'✓':''}</span>
        <span class="mc-step-name">${n}<span class="sr-only">${st[i]==='done'?' (finished)':st[i]==='current'?' (current)':' (not started)'}</span></span>
        <span class="mc-step-count">${lines[i]}</span>
      </li>`)}`;
  }
  const VERDICT_TILES=[['matchedGold','Matches the frozen gold'],['fingerprint','Lands on a frozen fingerprint'],['unclear','Unclear, or neither'],['unclassified','Not classified']];
  function detailsHtml(){
    const L=S.live;
    if(!L)return '';
    const r=L.round,version=M.shortHash(r.packetSha256),model=clean(r.config&&r.config.model,80);
    const done=L.completed,planned=L.planned;
    const cur=L.current,t=L.task;
    const rows=M.scoreRows(t),pil=rows.find(x=>x.kind==='pilots'&&x.roundId===r.id),score=rows.find(x=>x.kind==='evaluation'||x.kind==='empty');
    const tiles=L.full?VERDICT_TILES.map(([k,label])=>h`<div class="mc-tile-count"><dt>${label}</dt><dd>${L.tally[k]}</dd></div>`):null;
    const about=[plural(t.roundIds.length,'round'),t.version.freezeLabel,t.statusLabel].filter(Boolean).join(' · ');
    return h`<details class="mc-details" data-key="mc-details"${S.details?raw(' open'):''}>
      <summary>Details</summary>
      <div class="mc-details-body">
        <p class="mc-chips">${version?h`<span class="mc-chip">Package sha256:${version}</span>`:''}${model?h`<span class="mc-chip">${model}</span>`:''}</p>
        <div class="mc-prog">
          <p class="mc-prog-line"><strong>Run progress</strong> <span>${done} of ${plural(planned,'pilot')} finished${L.failed?' · '+L.failed+' failed':''}</span></p>
          <progress max="${Math.max(1,planned)}" value="${Math.min(done,Math.max(1,planned))}" aria-label="Pilots finished"></progress>
        </div>
        <dl class="mc-facts">
          <dt>Task</dt><dd>${about}</dd>
          <dt>Current pilot</dt><dd>${cur?'Pilot '+cur.n+': '+(cur.turns!==null?plural(cur.turns,'turn')+', ':'')+plural(cur.toolCalls||0,'tool call'):'No pilot is running'}</dd>
          <dt>Time elapsed</dt><dd>${L.elapsed===null?'Not started':M.formatDuration(L.elapsed)}</dd>
          <dt>Tool calls</dt><dd>${L.calls}</dd>
        </dl>
        ${tiles?h`<dl class="mc-counts">${tiles}</dl>`:''}
        <p class="mc-hint">${pil?pil.text:tiles?'Directional only, n = '+L.tally.clean+'.':'The pilot list has not loaded in full, so no verdict count is shown.'}</p>
        ${score?h`<p class="mc-hint">${score.text}${score.note?' '+score.note+'.':''}</p>`:''}
      </div>
    </details>`;
  }
  function feedbarHtml(){
    const L=S.live,live=!!(L&&L.inflight>0)&&S.link==='local';
    const state=S.link==='lost'?'Stale: link lost':live?'Streaming live...':S.link==='offline'?'Paused: offline':'Waiting for new runs';
    return h`<h2 class="mc-h2" id="mc-feed-title">Run feed</h2>
      <span class="mc-stream${live?' is-live':''}">${state}</span>
      <label class="sr-only" for="mc-stage-filter">Filter by stage</label>
      <select id="mc-stage-filter" data-mc-in="stage" data-key="mc-stage-filter">${STAGES.map(([id,label])=>h`<option value="${id}"${id===S.stage?raw(' selected'):''}>${label}</option>`)}</select>`;
  }
  function feedEmptyHtml(){
    if(S.items.length)return '';
    if(!S.all||!S.all.items.length)return h`<p class="mc-feed-empty">No pilot has run yet. Launch an approved round in Agents and its pilots appear here.</p>`;
    return h`<p class="mc-feed-empty">No run matches the search or the stage filter. <button type="button" class="mc-quiet" data-mc="clear-filters" data-key="mc-clear">Clear them</button></p>`;
  }
  function newHtml(){
    return S.fresh>0?h`<button type="button" class="mc-new" data-mc="new" data-key="mc-new">${S.fresh} new</button>`:'';
  }
  /* ---- one feed row ---- */
  function outputCell(it){
    if(it.output.ready){const n=it.output.files;return n===null?'':n===0?'No files':plural(n,'file');}
    return it.state==='running'||it.state==='queued'?'Not copied yet':'No output';
  }
  /* state | what ran and what happened | time and output. The output is the third thing a row answers, so it has its own cell. */
  const rowInner=it=>h`<span class="mc-row-state"><span class="mc-glyph" aria-hidden="true">${it.glyph}</span>${it.stateWord}</span>
    <span class="mc-row-main"><span class="mc-row-what">${it.what}</span><span class="mc-row-happened">${it.happened}</span></span>
    <span class="mc-row-side"><time class="mc-row-time"${it.arrivedAt?raw(' datetime="'+V.esc(it.arrivedAt)+'"'):''}>${stamp(it.arrivedAt)}</time><span class="mc-row-out"><span class="sr-only">Output: </span>${outputCell(it)}</span></span>`;
  const rowClass=it=>'mc-row st-'+it.stateKey+(it.key===S.run?' is-selected':'');
  const rowAttrs=it=>({role:'option','aria-selected':it.key===S.run?'true':'false',class:rowClass(it)});
  const rowOuter=it=>h`<div data-key="${it.key}" role="option" aria-selected="${it.key===S.run?'true':'false'}" class="${rowClass(it)}">${rowInner(it)}</div>`;
  /* ---- the inspector ---- */
  /* A path breaks after each slash, never in the middle of a name; the text copied is the path itself. */
  const pathHtml=p=>raw(V.esc(p).replace(/\//g,'/<wbr>'));
  function failureOf(it){return it.stateKey==='failed'||it.stateKey==='discarded'||it.stateKey==='cancelled';}
  function logLine(l){
    const parts=[l.kind,l.tool,l.chars!==undefined&&l.chars!==null?plural(l.chars,'character'):''].filter(Boolean).join(' · ');
    const text=typeof l.text==='string'&&l.text?clean(l.text,200)+(l.text.length>200?'...':''):'';
    return h`<li><span class="mc-log-seq">${l.seq}</span><span class="mc-log-kind">${parts}</span>${text?h`<span class="mc-log-text">${text}</span>`:''}</li>`;
  }
  function inspectorHtml(){
    const it=S.run?S.byKey.get(S.run):null;
    if(!it)return '';
    const d=S.detail.get(it.key),data=d&&d.data?d.data:null,red=it.redacted||S.redacted;
    const round=S.rounds.find(r=>r.id===it.roundId),ver=round?M.shortHash(round.packetSha256):'';
    /* The evidence path is the one the companion gave once the output was copied; while the run is active it is the path the copy will
       have; a run that ended without a copy has none. */
    const active=it.state==='running'||it.state==='queued',ready=it.output.ready,folder=it.output.workingFolder;
    const evid=ready?it.output.relPath:active?M.evidencePath(it.roundId,it.n):null;
    const files=!red&&data&&Array.isArray(data.outputs)?data.outputs.filter(o=>isObj(o)&&typeof o.name==='string'):null;
    const answer=!red&&data&&isObj(data.final)&&typeof data.final.text==='string'?data.final.text:'';
    const lg=S.log&&S.log.key===it.key?S.log:null;
    const shown=lg?lg.lines.slice(-LOG_SHOW):[];
    const audit=it.audit?(it.audit.status||'Pending')+(it.audit.violationCount?' ('+plural(it.audit.violationCount,'violation')+')':''):it.auditLabel||'Not audited';
    const A=agents(),canAgents=!!(A&&dash());
    return h`<div class="mc-ins-top">
        <div class="mc-ins-id">
          <h2 class="mc-h2" id="mc-ins-title" tabindex="-1">Pilot ${it.n} <span aria-hidden="true">·</span> ${it.roundName}</h2>
          <p class="mc-state st-${it.stateKey}"><span class="mc-glyph" aria-hidden="true">${it.glyph}</span>${it.stateWord}</p>
        </div>
        <button type="button" class="mc-quiet" data-mc="close-inspector" data-key="mc-ins-close" aria-label="Close the run inspector">Close</button>
      </div>
      <section class="mc-ins-sec" aria-labelledby="mc-ins-ran"><h3 class="mc-h3" id="mc-ins-ran">What ran</h3>
        <dl class="mc-facts">
          <dt>Task</dt><dd>${it.taskName}</dd>
          <dt>Model</dt><dd>${it.model||'Not reported'}</dd>
          <dt>Started</dt><dd>${it.startedAt?stamp(it.startedAt):'Not started'}</dd>
          ${ver?h`<dt>Package</dt><dd class="mc-mono">sha256:${ver}</dd>`:''}
        </dl></section>
      <section class="mc-ins-sec" aria-labelledby="mc-ins-did"><h3 class="mc-h3" id="mc-ins-did">What happened</h3>
        <p class="${failureOf(it)?'mc-happened is-bad':'mc-happened'}">${it.happened}</p>
        <dl class="mc-facts">
          <dt>Tool calls</dt><dd>${it.toolCalls===null?'Not reported':it.toolCalls}</dd>
          <dt>Turns</dt><dd>${it.turns===null?'Not reported':it.turns}</dd>
          <dt>Audit</dt><dd>${audit}</dd>
          <dt>Your verdict</dt><dd>${it.verdict?it.verdict.label:it.needsVerdict?'Not classified yet':'Not needed'}</dd>
        </dl>
        ${red?h`<p class="mc-hint">Final answer: ${WITHHELD}${it.output.chars!==null&&it.output.chars!==undefined?' ('+plural(it.output.chars,'character')+')':''}.</p>`
          :answer?h`<details class="mc-more-details" data-key="mc-answer"><summary>Final answer (${plural(answer.length,'character')})</summary><pre class="mc-answer">${answer.slice(0,6000)}</pre></details>`:''}
      </section>
      <section class="mc-ins-sec" aria-labelledby="mc-ins-where"><h3 class="mc-h3" id="mc-ins-where">Where the output is</h3>
        <dl class="mc-facts">
          <dt>Working folder</dt><dd class="mc-mono mc-path">${folder?pathHtml(folder):'Not reported'}</dd>
          <dt>Evidence path</dt><dd><span class="mc-mono mc-path">${evid?pathHtml(evid):'Not available'}</span>${evid?h`<span class="mc-copy"><button type="button" class="mc-quiet" data-mc="copy" data-path="${evid}" data-key="copy:${it.key}">${S.copied===it.key?'Copied':'Copy path'}</button></span>`:''}</dd>
          <dt>Output files</dt><dd>${active?'Counted when the run ends':!ready?'None':it.output.files===null?'Not counted yet':it.output.files===0?'None':it.output.files}</dd>
        </dl>
        ${ready?'':active?h`<p class="mc-hint">Copied to the evidence folder when the run ends.</p>`:h`<p class="mc-hint">No output was copied for this run.</p>`}
        ${red&&ready&&it.output.files?h`<p class="mc-hint">File names: ${WITHHELD}.</p>`:files&&files.length?h`<ul class="mc-names">${files.slice(0,12).map(o=>h`<li><span class="mc-mono">${o.name}</span>${num(o.bytes)!==null?h` <span class="mc-muted">${sizeText(o.bytes)}</span>`:''}</li>`)}${files.length>12?h`<li class="mc-muted">and ${files.length-12} more</li>`:''}</ul>`:''}
      </section>
      <details class="mc-more-details" data-key="mc-activity"><summary>Activity (${lg?plural(lg.lines.length,'line'):'not loaded'})</summary>
        ${red||(lg&&lg.withheld)?h`<p class="mc-hint">${WITHHELD}: only the kind of each step is listed.</p>`:''}
        ${lg&&lg.error?h`<p class="mc-hint">The activity could not be read: ${lg.error}</p>`:''}
        ${shown.length?h`<ol class="mc-log">${shown.map(logLine)}</ol>`:h`<p class="mc-hint">${lg&&lg.done?'This run wrote no lines.':'No lines yet.'}</p>`}
      </details>
      <div class="mc-actions">
        ${canAgents?h`<button type="button" data-mc="open-agents" data-key="mc-open-agents">Open in Agents</button>`:''}
        ${canWorkbench()?h`<button type="button" data-mc="open-workbench" data-key="mc-open-wb">Open in Workbench</button>`:''}
      </div>`;
  }
  /* ---- recent outputs ---- */
  function outputRuns(){
    if(!S.all)return [];
    const sel=taskSelected();
    return S.all.items.filter(it=>it.ended&&it.output.ready&&it.output.files>0&&(!sel||it.taskKey===sel)&&matchItem(it))
      .sort((a,b)=>(timeOf(b.endedAt||b.arrivedAt)||0)-(timeOf(a.endedAt||a.arrivedAt)||0));
  }
  function outputsHtml(){
    if(!S.all||!S.all.items.length)return '';
    const runs=outputRuns();
    const head=h`<div class="mc-sec-head"><h2 class="mc-h2" id="mc-out-title">Recent outputs</h2>${runs.length?h`<button type="button" class="mc-link" data-mc="view-all" data-key="mc-view-all">View all</button>`:''}</div>`;
    if(S.redacted){
      const files=runs.reduce((n,it)=>n+(it.output.files||0),0);
      return h`${head}<p class="mc-hint">${runs.length?plural(files,'file')+' from '+plural(runs.length,'pilot')+'. ':''}${WITHHELD}.</p>`;
    }
    const entries=[];
    for(const it of runs.slice(0,OUT_TRACK)){
      const d=S.detail.get(it.key),list=d&&d.data&&Array.isArray(d.data.outputs)?d.data.outputs.filter(o=>isObj(o)&&typeof o.name==='string'&&!/^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(o.name)):null;
      const who=it.taskName+' · pilot '+it.n;
      if(list&&list.length)for(const o of list)entries.push({key:it.key+'/'+o.name,name:o.name,meta:[sizeText(o.bytes),V.ago(it.endedAt||it.arrivedAt,S.now),who].filter(Boolean).join(' · '),path:it.output.relPath+o.name});
      else entries.push({key:it.key,name:plural(it.output.files,'file')+' from pilot '+it.n,meta:[V.ago(it.endedAt||it.arrivedAt,S.now),it.taskName].filter(Boolean).join(' · '),path:it.output.relPath});
    }
    const shown=entries.slice(0,OUT_SHOW);
    if(!shown.length)return h`${head}<p class="mc-hint">${S.query||S.task?'No output matches.':'No outputs yet. A pilot’s files appear here after its run ends.'}</p>`;
    return h`${head}<ul class="mc-out-list">${shown.map(e=>h`<li class="mc-out"><div class="mc-out-main"><span class="mc-out-name">${e.name}</span><span class="mc-out-meta">${e.meta}</span></div><button type="button" class="mc-quiet" data-mc="copy" data-path="${e.path}" data-key="copy:${e.key}">${S.copied===e.key?'Copied':'Copy path'}</button></li>`)}</ul>`;
  }

  /* ---------- the page ---------- */
  const stageHidden=()=>!(S.live||(S.all&&S.all.items.length)||S.run);
  const insHidden=()=>!(S.run&&S.byKey.get(S.run));
  function rootAttrs(){return 'data-link="'+V.esc(S.link)+'" data-state="'+(S.link==='checking'&&!S.everOk?'checking':S.board&&S.board.tasks.length?'live':'empty')+'"';}
  function render(ctx){
    init();
    S.ctx=ctx||S.ctx;
    S.pkg=!!(S.ctx&&S.ctx.package&&Array.isArray(S.ctx.package.documents)&&S.ctx.package.documents.length>0);
    try{derive();}catch(e){S.board=null;}
    const showLive=!!S.live;
    return h`<div id="mc-root" class="mc-root" ${raw(rootAttrs())}>
      <div class="mc-top">
      <header class="mc-head">
        <div class="mc-heading">
          <p class="mc-index" aria-hidden="true">01 /</p>
          <h1 class="mc-title">Mission Control</h1>
          <p class="mc-tagline">See what ran, what happened and where the output is.</p>
        </div>
        <div class="mc-tools">
          <div class="mc-search">${raw(ICON.search)}<label class="sr-only" for="mc-search">Search tasks, runs, or outputs</label><input id="mc-search" type="search" data-mc-in="search" placeholder="Search tasks, runs, or outputs..." autocomplete="off" spellcheck="false" value="${S.query}" aria-keyshortcuts="Control+K Meta+K"><kbd class="mc-kbd" aria-hidden="true">${KBD}</kbd></div>
          <div id="mc-load" class="mc-slot">${loadHtml()}</div>
        </div>
      </header>
      <div class="mc-strip" id="mc-strip">${stripHtml()}</div>
      </div>
      <div id="mc-note">${noteHtml()}</div>
      <div id="mc-import">${importHtml()}</div>
      <ul id="mc-cards" class="mc-cards" aria-label="Tasks"${S.board&&visibleTasks().length||S.query?'':raw(' hidden')}>${cardsHtml()}</ul>
      <div id="mc-empty">${emptyHtml()}</div>
      <div id="mc-stage" class="mc-stage" data-live="${showLive?'true':'false'}" data-inspector="${insHidden()?'false':'true'}"${stageHidden()?raw(' hidden'):''}>
        <section id="mc-feedpanel" class="mc-feedpanel mc-panel" aria-labelledby="mc-feed-title">
          <div id="mc-feedbar" class="mc-feedbar">${feedbarHtml()}</div>
          <div class="mc-feedwrap"><div id="mc-newslot">${newHtml()}</div><div id="mc-feed" class="mc-feed" tabindex="0" role="listbox" aria-label="Run feed"${S.items.length?'':raw(' hidden')}>${S.items.map(rowOuter)}</div><div id="mc-feed-empty">${feedEmptyHtml()}</div></div>
        </section>
        <section id="mc-live" class="mc-live mc-panel" aria-labelledby="mc-live-title"${showLive?'':raw(' hidden')}>
          <div id="mc-live-head">${liveHeadHtml()}</div>
          <ol id="mc-stepper" class="mc-steps" aria-label="Round stages">${stepsHtml()}</ol>
          <div id="mc-details">${detailsHtml()}</div>
        </section>
        <aside id="mc-inspector" class="mc-inspector mc-panel" aria-label="Run inspector"${insHidden()?raw(' hidden'):''}>${inspectorHtml()}</aside>
        <section id="mc-outputs" class="mc-outputs mc-panel" aria-labelledby="mc-out-title"${S.all&&S.all.items.length?'':raw(' hidden')}>${outputsHtml()}</section>
      </div>
      <div id="mc-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-views-live="polite"></div>
      <div id="mc-alert" class="sr-only" role="alert" aria-atomic="true" data-views-live="assertive"></div>
    </div>`.toString();
  }

  /* ---------- painting ---------- */
  const REGIONS=[['mc-load',loadHtml],['mc-strip',stripHtml],['mc-note',noteHtml],['mc-import',importHtml],['mc-cards',cardsHtml],['mc-empty',emptyHtml],
    ['mc-live-head',liveHeadHtml],['mc-stepper',stepsHtml],['mc-details',detailsHtml],['mc-feedbar',feedbarHtml],['mc-newslot',newHtml],['mc-feed-empty',feedEmptyHtml],
    ['mc-inspector',inspectorHtml],['mc-outputs',outputsHtml]];
  function setHidden(id,hide){const el=$('#'+id);if(!el)return;if(hide)el.setAttribute('hidden','');else el.removeAttribute('hidden');}
  function paintFeed(){
    const el=$('#mc-feed');
    if(!el)return;
    let patch=null;
    try{patch=V.keyedPatch(el,S.items,{key:i=>i.key,render:rowInner,attrs:rowAttrs,tag:'div'});}catch{patch=null;}
    if(!patch)V.setHtml(el,S.items.map(rowOuter).join(''));
    setHidden('mc-feed',!S.items.length);
    if(patch&&patch.scrolledAway&&patch.inserted.length)S.fresh+=patch.inserted.length;
    if(!el.scrollTop&&S.fresh)S.fresh=0;
  }
  function paint(){
    if(!S.mounted)return;
    const root=$('#mc-root');
    if(!root)return;
    for(const [id,fn] of REGIONS){
      const el=$('#'+id);
      if(!el)continue;
      let markup='';
      try{markup=fn();}catch(e){markup='';}
      V.setHtml(el,markup);
    }
    paintFeed();
    const nl=$('#mc-newslot');
    if(nl)V.setHtml(nl,newHtml());
    setHidden('mc-cards',!(S.board&&visibleTasks().length)&&!S.query);
    setHidden('mc-stage',stageHidden());
    setHidden('mc-live',!S.live);
    setHidden('mc-inspector',insHidden());
    setHidden('mc-outputs',!(S.all&&S.all.items.length));
    const stage=$('#mc-stage');
    if(stage){stage.setAttribute('data-inspector',insHidden()?'false':'true');stage.setAttribute('data-live',S.live?'true':'false');}
    root.setAttribute('data-link',S.link);
    root.setAttribute('data-state',S.link==='checking'&&!S.everOk?'checking':S.board&&S.board.tasks.length?'live':'empty');
  }
  /* The detail and log arrive after a poll's first paint; only the inspector and the outputs need to change. */
  function paintDetail(){
    if(!S.mounted)return;
    for(const id of ['mc-inspector','mc-outputs']){
      const fn=id==='mc-inspector'?inspectorHtml:outputsHtml,el=$('#'+id);
      if(el){let markup='';try{markup=fn();}catch{markup='';}V.setHtml(el,markup);}
    }
    paintFeed();
  }
  /* A search or a filter changes what the cards, the feed and the outputs show, not what has been fetched. */
  function refilter(){derive();paint();}

  /* ---------- announcements: terminal transitions only ---------- */
  const VERB={completed:'completed',failed:'failed',cancelled:'was cancelled',discarded:'was discarded by the audit'};
  function announce(){
    const ann=S.ann,items=S.all?S.all.items:[],prev=S.seen;
    const now=new Map(),rounds=new Set();
    for(const it of items){now.set(it.key,{active:it.state==='running'||it.state==='queued'});rounds.add(it.roundId);}
    if(prev&&ann){
      for(const it of items){
        const was=prev.get(it.key),active=it.state==='running'||it.state==='queued',knownRound=!!(S.seenRounds&&S.seenRounds.has(it.roundId));
        /* A pilot is announced when it ends after being seen active, or when it arrives already ended in a round not seen before.
           A row of a known round that only now appears (the feed window moved, a per-round fetch changed) is not news. */
        if(!active&&VERB[it.stateKey]&&(was?was.active:!knownRound))ann.say(it.taskName+': pilot '+it.n+' '+VERB[it.stateKey]+'.',{kind:it.stateKey});
        if(!was&&!knownRound&&S.seenRounds&&active)ann.say(it.taskName+': round '+it.roundName+' started.',{kind:'new-round'});
      }
    }
    S.seen=now;
    S.seenRounds=rounds;
  }
  /* A message that answers something the person just did (a search, a copy, an import). It goes to the same polite region. */
  function tell(text){
    const el=$('#mc-status');
    if(!el)return;
    const line=clean(text,160);
    if(el.textContent===line){el.textContent='';setTimeout(()=>{el.textContent=line;},60);}
    else el.textContent=line;
  }

  /* ---------- actions ---------- */
  function selectTask(key){
    S.task=S.task===key?null:key;
    saveFilters();
    refilter();
    const sel=S.task?S.board.tasks.find(t=>t.key===S.task):null;
    tell(sel?'Showing '+sel.name+'.':'Showing every task.');
  }
  function currentRun(){
    const L=S.live;
    if(!L)return null;
    const items=S.all.items.filter(i=>i.roundId===L.round.id);
    return items.find(i=>i.state==='running')||items.find(i=>i.needsVerdict)||items.find(i=>i.stateKey==='failed'||i.stateKey==='discarded')||items[0]||null;
  }
  function selectRun(key,opts){
    const o=opts||{};
    if(!S.byKey.has(key))return false;
    const opening=!S.run;
    if(S.run!==key)S.log=null;
    S.run=key;
    paintFeed();paintDetail();
    setHidden('mc-inspector',false);
    const stage=$('#mc-stage');
    if(stage)stage.setAttribute('data-inspector','true');
    const A=agents(),it=S.byKey.get(key);
    if(A&&!S.redacted)loadDetail(it).catch(()=>{}).then(()=>paintDetail());
    if(A)loadLog(it).catch(()=>{}).then(()=>paintDetail());
    if(o.focus){const t=$('#mc-ins-title');if(t&&t.focus)t.focus({preventScroll:true});}
    if(opening||o.focus)reveal($('#mc-inspector'));
    return true;
  }
  /* When the inspector opens, bring it up to where it sticks (24px under the top of the window), so that what ran, what happened and
     where the output is are all in view together. Smooth only when the reader allows motion. */
  function reveal(el){
    try{
      if(!el||typeof el.getBoundingClientRect!=='function'||typeof window.scrollBy!=='function')return;
      const r=el.getBoundingClientRect(),vh=window.innerHeight||0,gap=24;
      if(r.top<0||r.top>gap+4||r.bottom>vh)window.scrollBy({top:r.top-gap,behavior:V.reducedMotion()?'auto':'smooth'});
    }catch{/* the page keeps its place */}
  }
  function closeInspector(){
    if(!S.run)return;
    S.run=null;S.log=null;
    paintFeed();paintDetail();
    setHidden('mc-inspector',true);
    const stage=$('#mc-stage');
    if(stage)stage.setAttribute('data-inspector','false');
    const feed=$('#mc-feed');
    if(feed&&typeof feed.focus==='function'&&!feed.hidden)feed.focus({preventScroll:true});
  }
  async function copyPath(path,key){
    const ok=await V.copyText(path);
    S.copied=ok?key:'';
    clearTimeout(S.copyTimer);
    paintDetail();
    tell(ok?'Copied the path to the clipboard.':'The browser did not allow copying. Select the path and copy it yourself.');
    if(ok)S.copyTimer=setTimeout(()=>{S.copied='';paintDetail();},2000);
  }
  function openPicker(){
    if(typeof document.createElement!=='function'||!document.body){S.imp.error='This browser cannot open a file here.';paintImport();return;}
    const old=$('#mc-import-file');
    if(old&&old.remove)old.remove();
    const input=document.createElement('input');
    input.type='file';input.accept='.json,application/json';input.id='mc-import-file';input.hidden=true;
    input.setAttribute('tabindex','-1');input.setAttribute('aria-hidden','true');
    document.body.appendChild(input);
    input.addEventListener('change',()=>{const f=input.files&&input.files[0];if(input.remove)input.remove();if(f)readEval(f);});
    input.click();
  }
  const paintImport=()=>{const el=$('#mc-import');if(el)V.setHtml(el,importHtml());const b=$('#mc-strip');if(b)V.setHtml(b,stripHtml());};
  async function readEval(file){
    const i=S.imp;
    i.busy=true;i.error='';i.parsed=null;
    paintImport();
    try{
      if(!W||typeof W.parseStudioGrading!=='function'||typeof W.normalizeEval!=='function')throw new Error('The evaluation reader did not load. Reload the page and try again.');
      if(num(file.size)!==null&&file.size>FILE_MAX)throw new Error('The file is larger than 30 MB, so it was not read.');
      const text=await file.text();
      const parsed=W.parseStudioGrading(text);
      if(parsed.finalScore===null)throw new Error('The file has no final score, so there is nothing to record.');
      i.parsed=parsed;i.name=clean(file.name,120)||'evaluation.json';
      if(!i.task)i.task=defaultTask();
    }catch(e){
      i.error='Could not use '+(clean(file&&file.name,80)||'that file')+'. '+msg(e);
      tell(i.error);
    }
    i.busy=false;
    paintImport();
    focusKey(i.parsed?'mc-imp-task':'mc-imp-choose');
  }
  function defaultTask(){
    const b=S.board;
    if(!b)return '';
    const sel=taskSelected();
    if(sel){const t=b.tasks.find(x=>x.key===sel);if(t&&!t.unassigned)return t.name;}
    const named=b.tasks.filter(t=>!t.unassigned);
    return named.length===1?named[0].name:'';
  }
  function focusKey(key){
    try{
      const el=document.querySelector('[data-key="'+key+'"]');
      if(el&&typeof el.focus==='function')el.focus({preventScroll:true});
    }catch{/* focus is a convenience */}
  }
  function recordEval(){
    const i=S.imp,p=i.parsed;
    if(!p)return;
    const task=clean(i.task,120);
    if(!task){i.error='Type the task name this result belongs to.';paintImport();focusKey('mc-imp-task');tell(i.error);return;}
    let rec;
    try{rec=W.normalizeEval(p,{task,sourceName:i.name,importedAt:new Date().toISOString()});}
    catch(e){i.error=msg(e);paintImport();return;}
    const key=M.taskKey({task}),t=S.board?S.board.tasks.find(x=>x.key===key):null,round=t?S.rounds.find(r=>r.id===t.latestRoundId):null;
    if(round){rec.roundId=round.id;rec.packetSha256=round.packetSha256||'';}
    const list=readEvals().filter(r=>r.id!==rec.id);
    list.push(rec);
    const stored=V.store.set(V.STORE_KEYS.evals,list.slice(-EVAL_CAP));
    S.imp={open:false,busy:false,error:'',parsed:null,name:'',task:''};
    derive();paint();
    focusKey('mc-import-open');
    tell('Recorded the evaluation result for '+task+'.'+(stored?'':' The browser did not save it, so it is kept for this page only.'));
  }

  function act(name,el){
    const attr=n=>{try{return el.getAttribute(n)||'';}catch{return '';}};
    switch(name){
      case 'load':loadPackage();break;
      case 'start':go('agents');break;
      case 'import':
        if(S.imp.open)S.imp={open:false,busy:false,error:'',parsed:null,name:'',task:S.imp.task};
        else S.imp.open=true;
        paintImport();
        if(S.imp.open)focusKey(S.imp.parsed?'mc-imp-task':'mc-imp-choose');
        break;
      case 'import-choose':openPicker();break;
      case 'import-save':recordEval();break;
      case 'import-cancel':S.imp={open:false,busy:false,error:'',parsed:null,name:'',task:S.imp.task};paintImport();focusKey('mc-import-open');break;
      case 'card':selectTask(attr('data-task'));break;
      case 'next':{
        const t=S.board&&S.board.tasks.find(x=>x.key===attr('data-task'));
        if(t&&!t.nextAction.blocked)goAgents(t.nextAction.target);
        break;
      }
      case 'more':S.more=!S.more;paint();break;
      case 'view-run':{const it=currentRun();if(it)selectRun(it.key,{focus:true});break;}
      case 'close-inspector':closeInspector();break;
      case 'copy':copyPath(attr('data-path'),attr('data-key').replace(/^copy:/,''));break;
      case 'open-agents':{const it=S.run?S.byKey.get(S.run):null;if(it)goAgents({roundId:it.roundId,runKey:it.key});break;}
      case 'open-workbench':{const it=S.run?S.byKey.get(S.run):null;if(it)goWorkbench(it.roundId,it.n);break;}
      case 'new':{const f=$('#mc-feed');S.fresh=0;if(f){f.scrollTop=0;if(f.focus)f.focus({preventScroll:true});}paint();break;}
      case 'retry':S.fails=0;pollNow();break;
      case 'view-all':S.stage='outputs';saveFilters();refilter();{const f=$('#mc-feed');if(f&&f.focus&&!f.hidden)f.focus({preventScroll:true});}tell(plural(S.items.length,'run')+' with outputs.');break;
      case 'clear-filters':S.query='';S.stage='all';{const s=$('#mc-search');if(s)s.value='';}saveFilters();refilter();break;
      default:break;
    }
  }
  const inRoot=el=>{try{return !!(el&&typeof el.closest==='function'&&el.closest('#mc-root'));}catch{return false;}};
  function onClick(e){
    if(!S.mounted||!e||!e.target||typeof e.target.closest!=='function')return;
    const hit=e.target.closest('[data-mc]');
    if(hit&&inRoot(hit))act(hit.getAttribute('data-mc'),hit);
  }
  function onInput(e){
    if(!S.mounted||!e||!e.target)return;
    const t=e.target,kind=typeof t.getAttribute==='function'?t.getAttribute('data-mc-in'):null;
    if(!kind||!inRoot(t))return;
    if(kind==='search'){
      S.query=String(t.value||'');
      refilter();
      clearTimeout(S.searchTimer);
      S.searchTimer=setTimeout(()=>{
        if(!S.mounted)return;
        const q=S.query.trim();
        tell(q?plural(visibleTasks().length,'task')+', '+plural(S.items.length,'run')+' and '+plural(outputRuns().length,'run')+' with outputs match.':'Search cleared.');
      },500);
    }else if(kind==='imp-task')S.imp.task=String(t.value||'');
    else if(kind==='stage'&&e.type==='change'){
      const v=String(t.value||'');
      S.stage=STAGE_IDS.includes(v)?v:'all';
      saveFilters();refilter();
    }
  }
  function onKey(e){
    if(!S.mounted||!e)return;
    const k=String(e.key||'');
    if((e.ctrlKey||e.metaKey)&&!e.altKey&&k.toLowerCase()==='k'){
      const s=$('#mc-search');
      if(s&&typeof s.focus==='function'){if(e.preventDefault)e.preventDefault();s.focus();if(s.select)s.select();}
      return;
    }
    if(k!=='Escape')return;
    const tag=String(e.target&&e.target.tagName||'').toUpperCase();
    if(tag==='SELECT')return;
    if(S.imp.open&&e.target&&typeof e.target.closest==='function'&&e.target.closest('#mc-import')){act('import-cancel',e.target);return;}
    if(tag==='INPUT'||tag==='TEXTAREA')return;
    if(S.run&&(inRoot(e.target)||!e.target||e.target===document.body||tag==='BODY')){if(e.preventDefault)e.preventDefault();closeInspector();}
  }
  function onToggle(e){
    const t=e&&e.target;
    if(!S.mounted||!t||typeof t.getAttribute!=='function'||!inRoot(t))return;
    if(t.getAttribute('data-key')==='mc-details')S.details=!!t.open;
  }
  function onScroll(){
    const f=$('#mc-feed');
    if(!f)return;
    S.feedTop=f.scrollTop||0;
    if(S.feedTop<=4&&S.fresh){S.fresh=0;const nl=$('#mc-newslot');if(nl)V.setHtml(nl,newHtml());}
  }
  ['click','input','change','keydown'].forEach(type=>{
    const fn=type==='click'?onClick:type==='keydown'?onKey:onInput;
    try{document.addEventListener(type,fn);}catch{/* no document */}
  });
  try{document.addEventListener('toggle',onToggle,true);}catch{/* no document */}

  /* ---------- lifecycle ---------- */
  function bind(){
    const root=$('#mc-root');
    if(!root)return;
    if(S.ann)S.ann.attach(root);else S.ann=V.announcer(root);
    const feed=$('#mc-feed');
    if(feed){
      V.bindListbox(feed,{label:'Run feed',onActivate:key=>{selectRun(key);}});
      if(typeof feed.addEventListener==='function')feed.addEventListener('scroll',onScroll,{passive:true});
      if(S.feedTop)feed.scrollTop=S.feedTop;
    }
  }
  function mount(){
    const first=!S.mounted;
    S.mounted=true;
    if(first){S.gen++;S.fails=0;S.stopVisible=V.onVisible(()=>{if(S.mounted)pollNow();});}
    bind();
    if(!S.board)derive();
    paint();
    if(first)schedule(0);
  }
  function unmount(){
    if(!S.mounted)return;
    S.mounted=false;S.gen++;S.busy=false;
    clearTimeout(S.timer);clearTimeout(S.searchTimer);clearTimeout(S.copyTimer);S.timer=0;
    if(S.stopVisible){S.stopVisible();S.stopVisible=null;}
    if(S.ann){S.ann.destroy();S.ann=null;}
    const old=$('#mc-import-file');
    if(old&&old.remove)old.remove();
    S.seen=null;S.seenRounds=null;S.copied='';
    if(S.link==='lost'||S.link==='checking')S.link='checking';
  }
  function afterRender(active){if(active)mount();else unmount();}
  /* Cross-view: select a task card by key (or by name). Returns whether a card was selected. */
  function focusTask(key){
    if(!S.board)return false;
    const k=String(key||''),t=S.board.tasks.find(x=>x.key===k)||S.board.tasks.find(x=>x.key===M.taskKey({task:k}));
    if(!t)return false;
    S.task=t.key;saveFilters();
    if(S.mounted)refilter();
    return true;
  }
  window.FinanceMission={render,afterRender,focusTask};
})();
