/* Evidence Workbench (SPEC 4, 9.3, 10): files | source or diff | evidence, with a log drawer underneath.
   All state is module-private. The dashboard rebuilds #dashboard-app on every change, so every region repaints from S in afterRender(true).
   Pure work lives in FinanceWorkbenchModel (cases, diff rows, parsers), FinancePackageEngine (diffPackages, resolveClause) and FinanceViews (kit). */
(function(){
  'use strict';
  const V=window.FinanceViews,W=window.FinanceWorkbenchModel,E=window.FinancePackageEngine;
  if(!V||!W||!E){window.FinanceWorkbench={render:()=>'<div id="wb-root" class="wb-root"><section class="card"><h2>Evidence Workbench</h2><p>The Evidence Workbench did not load. The other views still work.</p></section></div>',afterRender(){},open(){return false;}};return;}
  const H=V.html,R=V.raw,esc=V.esc;
  const PAGE=200,RING=2000,TRIM=250,DOM_LINES=500,LOG_LIMIT=200,TICK_MS=1000,RUNS_BUSY_MS=4000,RUNS_IDLE_MS=20000,LOG_MS=2000,PENDING_TTL=120000,STEP_MAX=5,EVAL_CAP=200,LINK_CAP=500;
  const KEY_RUN=/^([a-z0-9-]{4,64}):([1-9][0-9]?)$/;
  const STATE_WORD={queued:'Queued',running:'Running',completed:'Completed',failed:'Failed',cancelled:'Cancelled'};
  const VERDICT_WORD={'matches-frozen-gold':'Matches the frozen gold',fingerprint:'Landed on a frozen fingerprint',unclear:'Unclear'};
  const ST={met:{word:'Met',glyph:'&#10003;'},'not-met':{word:'Not met',glyph:'&#10005;'},unknown:{word:'Unknown',glyph:'?'}};
  const CHANGE_WORD={added:'Added',removed:'Removed',value:'Value changed',formula:'Formula changed',type:'Type changed','cache-lost':'No saved value in the changed file (unknown, not zero)'};
  const ROLE_WORD={evaluator:'Evaluator-only','run-evidence':'Run evidence',audit:'Audit',template:'Template',proposal:'Proposal',prompt:'Prompt',source:'Source'};
  const WITHHELD='Details withheld while a round runs';
  const PANES=['files','diff','evidence'];
  const PANE_WORD={files:'Files',diff:'Diff',evidence:'Evidence'};
  const stepWord=n=>n===0?'Collapsed':'Height '+n+' of '+STEP_MAX;

  /* ---------- state ---------- */
  const S={
    ctx:null,active:false,listening:false,live:null,
    link:null,linkBusy:false,linkAt:0,
    runs:[],runsRedacted:false,runsStatus:'idle',runsError:'',runsBusy:false,runsAt:0,prevState:{},
    runKey:'',picked:false,round:null,run:null,detail:'idle',detailError:'',detailAt:0,loadSeq:0,wantCrit:'',autoCrit:false,pending:null,
    cmp:{pkg:null,name:'',busy:false,error:'',progress:''},diff:null,diffKey:'',diffError:'',diffCache:new Map(),
    evalParsed:null,evalFile:'',evalMsgs:null,msgFile:'',importOpen:false,importTask:'',importError:'',evalRec:null,
    cs:null,csKey:'',csFresh:false,decision:new Set(),cur:{total:0,locs:[]},scrollChange:false,notice:'',evalPending:null,msgPending:null,
    fileId:'',mode:'',page:0,rec:null,goto:'',gotoMsg:'',gotoHits:[],changeIdx:-1,expanded:{},dirs:{},changedOnly:false,scrollTo:'',
    critId:'',critOpen:false,onlyNotMet:false,solverTab:'answer',q:'',
    pane:'diff',filesOpen:false,lb:null,recLb:null,
    log:{key:'',lines:[],seq:0,more:false,done:false,withheld:false,busy:false,error:'',follow:true,step:0,restore:2,trimmed:false,epoch:0,at:0,drag:false},
    timer:null,stopVisible:null,rendered:{},status:'',inputs:{grading:null,messages:null,compare:null}
  };

  /* ---------- small helpers ---------- */
  const $=sel=>{try{return document.querySelector(sel);}catch{return null;}};
  const $$=(root,sel)=>{try{return root&&root.querySelectorAll?Array.from(root.querySelectorAll(sel)):[];}catch{return [];}};
  const getA=(el,n)=>{try{return el&&el.getAttribute?el.getAttribute(n):null;}catch{return null;}};
  const setA=(el,n,v)=>{try{if(el&&el.setAttribute)el.setAttribute(n,v);}catch{/* not an element */}};
  const delA=(el,n)=>{try{if(el&&el.removeAttribute)el.removeAttribute(n);}catch{/* not an element */}};
  const hasCls=(el,c)=>(getA(el,'class')||'').split(/\s+/).includes(c);
  const setCls=(el,c,on)=>{if(!el)return;const list=(getA(el,'class')||'').split(/\s+/).filter(Boolean),has=list.includes(c);if(on&&!has)list.push(c);else if(!on&&has)list.splice(list.indexOf(c),1);else return;setA(el,'class',list.join(' '));};
  const num=n=>Number(n).toLocaleString('en-US');
  const plural=(n,one,many)=>num(n)+' '+(n===1?one:many||one+'s');
  const msgOf=e=>String(e&&e.message||e||'Something went wrong.').slice(0,300);
  const trunc=(s,n)=>{s=String(s==null?'':s);return s.length>n?s.slice(0,n-1)+'…':s;};
  const fnv=s=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16);};
  const jsonSig=v=>{try{return fnv(JSON.stringify(v==null?null:v));}catch{return 'x';}};
  const taskKeyOf=t=>String(t||'').normalize('NFC').replace(/\s+/g,' ').trim().toLowerCase();
  const fmtNum=n=>{if(typeof n!=='number'||!Number.isFinite(n))return String(n==null?'':n);return (+n.toPrecision(12)).toLocaleString('en-US',{maximumFractionDigits:6});};
  const narrow=()=>{try{return !!(window.matchMedia&&window.matchMedia('(max-width: 1023px)').matches);}catch{return false;}};
  const hidden=()=>{try{return !!document.hidden;}catch{return false;}};
  const dash=()=>window.FinanceDashboard||null;
  const agents=()=>window.FinanceAgents||null;
  const api=path=>{const a=agents();return a&&typeof a.get==='function'?a.get(path):Promise.reject(Object.assign(new Error('The companion client did not load.'),{status:0}));};
  const enc=encodeURIComponent;
  const dataKey=el=>getA(el,'data-key');
  const keyEl=key=>$$($('#wb-root'),'[data-key]').find(e=>dataKey(e)===key)||null;
  const focusKey=key=>{const el=keyEl(key);try{if(el&&typeof el.focus==='function')el.focus();}catch{/* no focus here */}};
  /* True when focus sits on the control `key`, or was lost to the page (its control was just replaced). */
  const focusWasOn=key=>{let a=null;try{a=document.activeElement;}catch{/* no document focus */}return !a||a===document.body||dataKey(a)===key;};

  /* ---------- stores: layout, author links, evaluation records ---------- */
  const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  function loadLayout(){const v=V.store.get(V.STORE_KEYS.wb,{},isObj);S.log.restore=Number.isInteger(v.restore)&&v.restore>=1&&v.restore<=STEP_MAX?v.restore:2;S.log.follow=v.follow!==false;S.onlyNotMet=v.notMet===true;}
  function saveLayout(){V.store.set(V.STORE_KEYS.wb,{restore:S.log.restore,follow:S.log.follow,notMet:S.onlyNotMet});}
  const readLinks=()=>V.store.get(V.STORE_KEYS.links,[],Array.isArray).filter(l=>isObj(l)&&typeof l.criterionId==='string'&&typeof l.documentName==='string'&&typeof l.locator==='string');
  const readEvals=()=>V.store.get(V.STORE_KEYS.evals,[],Array.isArray).filter(isObj);
  function saveEval(rec){let list=readEvals().filter(x=>x.id!==rec.id);list.push(rec);if(list.length>EVAL_CAP)list=list.slice(-EVAL_CAP);return V.store.set(V.STORE_KEYS.evals,list);}

  /* ---------- the package, the comparison, the diff ---------- */
  function livePackage(){
    let p=null;
    try{const D=dash();p=D&&typeof D.getPackage==='function'?D.getPackage():null;}catch{p=null;}
    if(!p&&S.ctx&&S.ctx.package&&Array.isArray(S.ctx.package.documents)&&S.ctx.package.documents.length)p=S.ctx.package;
    return p&&Array.isArray(p.documents)&&p.documents.length?p:null;
  }
  function evidencePair(){try{const D=dash(),p=D&&typeof D.getEvidencePair==='function'?D.getEvidencePair():null;return p&&p.baseline&&p.candidate&&Array.isArray(p.baseline.documents)&&Array.isArray(p.candidate.documents)?p:null;}catch{return null;}}
  /* Which two packages are compared, and which one the panes read. null when there is nothing to compare. The loaded package is the base
     of a package loaded here; an evidence pair counts only when the loaded package is one of its two sides. */
  function setup(){
    const live=livePackage();
    if(live&&S.cmp.pkg)return {kind:'loaded',main:live,other:S.cmp.pkg,base:live,cand:S.cmp.pkg,label:S.cmp.name};
    const pr=evidencePair();
    if(live&&pr&&live.fingerprint){
      if(live.fingerprint===pr.baseline.fingerprint)return {kind:'pair',main:live,other:pr.candidate,base:pr.baseline,cand:pr.candidate,label:'the proposed revision'};
      if(live.fingerprint===pr.candidate.fingerprint)return {kind:'pair',main:live,other:pr.baseline,base:pr.baseline,cand:pr.candidate,label:'the baseline'};
    }
    return null;
  }
  const mainPackage=()=>{const c=setup();return c?c.main:livePackage();};
  function ensureDiff(){
    const c=setup();
    if(!c||!c.base.fingerprint||!c.cand.fingerprint){S.diff=null;S.diffKey='';S.diffError='';return c;}
    const key=c.base.fingerprint+'|'+c.cand.fingerprint;
    if(S.diffKey===key&&(S.diff||S.diffError))return c;
    S.diffKey=key;S.diffError='';
    if(S.diffCache.has(key)){S.diff=S.diffCache.get(key);return c;}
    try{S.diff=E.diffPackages(c.base,c.cand);S.diffCache.set(key,S.diff);if(S.diffCache.size>4)S.diffCache.delete(S.diffCache.keys().next().value);}
    catch(e){S.diff=null;S.diffError=msgOf(e);}
    return c;
  }
  const projectForCase=()=>{try{const A=window.FinanceAuthoring,p=A&&typeof A.getProject==='function'?A.getProject():null;return isObj(p)&&Array.isArray(p.roots)&&p.roots.some(r=>r&&Array.isArray(r.outputs)&&r.outputs.length)?p:null;}catch{return null;}};
  const taskKey=()=>taskKeyOf(S.round&&S.round.task);
  const runSig=(r,u)=>[r&&r.id,r&&r.status,r&&r.redacted,r&&r.freeze&&r.freeze.sha256,r&&Array.isArray(r.postHocFreezes)?r.postHocFreezes.length:0,u&&u.id,u&&u.state,u&&u.endedAt,u&&u.redacted,u&&u.final&&u.final.chars,jsonSig(u&&u.classification),u&&u.audit&&u.audit.status].join('~');
  /* The case, rebuilt only when an input changed. */
  function getCase(){
    if(S.csFresh&&S.cs)return S.cs;
    const c=ensureDiff(),main=c?c.main:livePackage(),project=projectForCase(),links=readLinks();
    const key=[main&&main.fingerprint,c&&c.other.fingerprint,S.diffKey,S.diffError,runSig(S.round,S.run),jsonSig(project),jsonSig(links),S.evalParsed?jsonSig(S.evalParsed):'',taskKey()].join('|');
    if(S.cs&&S.csKey===key){S.csFresh=true;return S.cs;}
    let cs;
    try{cs=W.buildCase({package:main,comparePackage:c?c.other:null,diff:S.diff,round:S.round,runDetail:S.run,project,links,evalParsed:S.evalParsed,taskKey:taskKey()});}
    catch(e){cs={files:[],criteria:[],solver:{conclusion:null,finalText:null,withheld:false},limits:[],notes:['The case could not be built: '+msgOf(e)]};}
    S.cs=cs;S.csKey=key;S.csFresh=true;S.decision=new Set();
    for(const cr of cs.criteria)for(const x of cr.cells)if(x.decisionChanges===true)S.decision.add(x.documentName+'\t'+x.locator);
    if(S.fileId&&!cs.files.some(f=>f.id===S.fileId)){S.fileId='';S.rec=null;S.page=0;}
    if(!S.fileId&&cs.files.length){const pick=cs.files.find(f=>f.change==='changed'&&f.inPackage)||cs.files.find(f=>f.inPackage&&docOf(f)&&docOf(f).records.length)||cs.files.find(f=>f.inPackage)||cs.files[0];S.fileId=pick.id;S.page=0;S.rec=null;}
    if(S.critId&&!cs.criteria.some(x=>x.id===S.critId)){S.critId='';S.critOpen=false;}
    return cs;
  }
  const crit=()=>{const cs=S.cs||getCase();return cs.criteria.find(x=>x.id===S.critId)||null;};
  const fileOf=()=>{const cs=S.cs||getCase();return cs.files.find(f=>f.id===S.fileId)||null;};
  /* The extracted document behind a file entry: the loaded package first, then the other package (a file that only exists there). */
  function docOf(f){
    if(!f)return null;
    const c=setup(),main=mainPackage();
    let d=main&&main.documents.find(x=>x.id===f.id);
    if(!d&&main&&f.inPackage){const same=main.documents.filter(x=>x.name===f.name);if(same.length===1)d=same[0];}
    if(d)return d;
    const other=c&&c.other;
    return other?other.documents.find(x=>x.id===f.id)||other.documents.find(x=>x.name===f.name)||null:null;
  }
  const docFrom=f=>{const d=docOf(f),main=mainPackage();return d?(main&&main.documents.includes(d)?'main':'other'):'none';};
  function diffDocOf(f){
    if(!S.diff||!f)return null;
    const docs=S.diff.documents||[];
    return docs.find(d=>d.candId===f.id||d.baseId===f.id)||(docs.filter(d=>d.name===f.name).length===1?docs.find(d=>d.name===f.name):null);
  }
  const effectiveMode=f=>{if(S.mode==='diff'&&S.diff)return 'diff';if(S.mode==='source')return 'source';return S.diff&&f&&f.change&&f.change!=='unchanged'?'diff':'source';};
  const counts=cs=>{const n={met:0,'not-met':0,unknown:0};for(const c of cs.criteria)n[c.status]=(n[c.status]||0)+1;return n;};

  /* ---------- the link to the companion, the run list, one run ---------- */
  const linkOk=()=>!!(S.link&&S.link.ok);
  async function checkLink(){
    const a=agents();if(S.linkBusy||!a||typeof a.link!=='function')return;
    S.linkBusy=true;
    try{S.link=await a.link();}catch(e){S.link={local:false,ok:false,offlineMessage:'',error:msgOf(e)};}
    S.linkBusy=false;S.linkAt=Date.now();
    if(!S.active)return;
    paint('runBlock');paint('notes');paintDrawer();
    if(linkOk())loadRuns();
  }
  const validRow=r=>isObj(r)&&typeof r.key==='string'&&KEY_RUN.test(r.key)&&typeof r.roundId==='string'&&Number.isInteger(r.n);
  const stateWord=r=>r&&r.audit&&r.audit.status==='DISCARDED'?'Discarded':STATE_WORD[r&&r.state]||'Unknown';
  const runRow=key=>S.runs.find(r=>r.key===key)||null;
  const withTask=r=>r.task&&!String(r.roundLabel||'').toLowerCase().includes(String(r.task).toLowerCase());
  const roundName=r=>(withTask(r)?r.task+' · ':'')+(r.roundLabel||r.roundId);
  const runLabel=r=>r?roundName(r)+' · Pilot '+r.n:'';
  async function loadRuns(){
    if(S.runsBusy||!linkOk())return;
    S.runsBusy=true;
    try{
      const d=await api('/api/agents/runs?limit=200');
      S.runs=(d&&Array.isArray(d.runs)?d.runs:[]).filter(validRow);S.runsRedacted=!!(d&&d.redacted);S.runsStatus='ready';S.runsError='';
    }catch(e){S.runsStatus='error';S.runsError=msgOf(e);}
    S.runsBusy=false;S.runsAt=Date.now();
    if(S.active)afterRuns();
  }
  /* What a fresh run list changes: a pending selection, the default run, a terminal change of the selected run (announced, and its details come back). */
  function afterRuns(){
    const prev=S.prevState,next={};
    for(const r of S.runs)next[r.key]=r.state+'/'+(r.audit?r.audit.status:'');
    const row=runRow(S.runKey),was=prev[S.runKey];
    S.prevState=next;
    paint('runBlock');paint('notes');
    if(S.pending)applyPending();
    else if(!S.runKey&&!S.picked&&S.runs.length&&S.detail==='idle'){const best=S.runs.find(r=>r.state==='completed'&&!(r.audit&&r.audit.status==='DISCARDED'))||S.runs[0];selectRun(best.key,{auto:true});}
    if(row&&was&&next[row.key]&&was!==next[row.key]){
      const word=stateWord(row),kind=word==='Discarded'?'discarded':row.state==='completed'?'completed':row.state==='failed'?'failed':row.state==='cancelled'?'cancelled':'';
      if(kind&&S.live)S.live.say(runLabel(row)+' '+word.toLowerCase()+'.',{kind});
      loadDetail(false);
    }else if(row&&S.run&&(S.run.redacted||S.round&&S.round.redacted)&&!S.runsRedacted)loadDetail(false);
    else if(row&&S.run&&S.runsRedacted&&!S.run.redacted)loadDetail(false);
    /* The log follows the same rule: once any round runs, text already read is dropped and only kinds stay; when it ends the text is read again. */
    const L=S.log;
    if(S.runsRedacted&&!L.withheld&&L.lines.length){L.lines=L.lines.map(stripLine);L.withheld=true;paintDrawer();}
    else if(!S.runsRedacted&&L.withheld&&L.key&&linkOk()){resetLog(L.key);paintDrawer();logFetch(true);}
  }
  function resetLog(key){const L=S.log;L.key=key||'';L.lines=[];L.seq=0;L.more=false;L.done=false;L.withheld=false;L.busy=false;L.error='';L.trimmed=false;L.epoch++;L.at=0;}
  async function selectRun(key,opts){
    const o=opts||{},m=KEY_RUN.exec(key||'');
    S.runKey=m?key:'';if(!o.auto)S.picked=true;
    S.notice='';S.round=null;S.run=null;S.detailError='';S.critId='';S.critOpen=false;S.autoCrit=!o.criterionId;S.wantCrit=o.criterionId||'';
    resetLog(S.runKey);
    S.detail=m?'loading':'idle';
    invalidateCase();
    if(S.active){paint('notes');paintCases();paintDrawer();}
    if(m)await loadDetail(true);
  }
  async function loadDetail(first){
    const m=KEY_RUN.exec(S.runKey||'');if(!m)return;
    const seq=++S.loadSeq,key=S.runKey;
    try{
      const [r,d]=await Promise.all([api('/api/agents/rounds/'+enc(m[1])),api('/api/agents/rounds/'+enc(m[1])+'/runs/'+m[2])]);
      if(seq!==S.loadSeq||key!==S.runKey)return;
      S.round=r&&isObj(r.round)?r.round:r;S.run=d&&isObj(d.run)?d.run:d;S.detail='ready';S.detailError='';
    }catch(e){
      if(seq!==S.loadSeq||key!==S.runKey)return;
      if(!first&&S.detail==='ready')return;
      S.detail='error';S.detailError=msgOf(e);
    }
    S.detailAt=Date.now();
    invalidateCase();
    const cs=getCase();
    if(S.wantCrit){if(cs.criteria.some(c=>c.id===S.wantCrit)){S.critId=S.wantCrit;S.critOpen=true;}S.wantCrit='';}
    else if(first&&S.autoCrit&&!S.critId&&cs.criteria.length)S.critId=(cs.criteria.find(c=>c.status==='not-met')||cs.criteria[0]).id;
    S.autoCrit=false;
    const c=crit(),cl=c&&firstClause(c);
    if(cl)revealClause(cl,{quiet:true,keepRec:true});
    if(S.active){paintAll();if(first)logFetch(true);}
  }
  const invalidateCase=()=>{S.csKey='';S.csFresh=false;};
  const touch=()=>{S.csFresh=false;};
  const firstClause=c=>c.clauses.find(x=>x.resolved&&(x.basis==='source-anchor'||x.basis==='author-link'))||null;
  function applyPending(){
    const p=S.pending;
    if(!p)return;
    if(Date.now()-p.at>PENDING_TTL||!linkOk()){S.pending=null;return;}
    if(S.runsStatus!=='ready'||S.runsBusy)return;
    const row=S.runs.find(r=>r.roundId===p.roundId&&r.n===p.n);
    if(!row&&!p.retried){p.retried=true;loadRuns();return;}
    S.pending=null;
    if(!row){S.notice='That run is not in the run list of this companion.';paint('notes');return;}
    selectRun(row.key,{criterionId:p.criterionId});
  }

  /* ---------- the log of the selected run ---------- */
  const stripLine=l=>({seq:l.seq,at:l.at||null,kind:l.kind,tool:l.tool,chars:l.chars});
  async function logFetch(first){
    const L=S.log,m=KEY_RUN.exec(L.key||'');
    if(!m||L.busy||!linkOk())return;
    const epoch=L.epoch;
    L.busy=true;
    try{
      const d=await api('/api/agents/rounds/'+enc(m[1])+'/runs/'+m[2]+'/log?after='+L.seq+'&limit='+LOG_LIMIT);
      if(epoch!==L.epoch)return;
      const withheld=!!(d&&d.withheld);
      if(L.withheld&&!withheld){L.lines=[];L.seq=0;L.withheld=false;L.busy=false;L.trimmed=false;return logFetch(first);}
      if(withheld&&!L.withheld)L.lines=L.lines.map(stripLine);
      L.withheld=withheld;
      const got=(d&&Array.isArray(d.lines)?d.lines:[]).filter(l=>isObj(l)&&Number.isInteger(l.seq)&&l.seq>L.seq);
      for(const l of got)L.lines.push(withheld?stripLine(l):l);
      if(got.length)L.seq=got[got.length-1].seq;
      else if(d&&Number.isInteger(d.next)&&d.next<L.seq)L.seq=d.next;
      const kept=V.trimRing(L.lines,RING,TRIM);
      if(kept!==L.lines){L.lines=kept;L.trimmed=true;}
      L.more=got.length>=LOG_LIMIT;L.done=!!(d&&d.done)&&!L.more;L.error='';L.at=Date.now();
    }catch(e){if(epoch!==L.epoch)return;L.error=msgOf(e);L.at=Date.now();}
    L.busy=false;
    if(!S.active)return;
    paintDrawer();
    if(L.more&&L.step>0)logFetch(false);
  }
  function setStep(n,opts){
    const L=S.log,step=V.clamp(Math.round(Number(n)),0,STEP_MAX);
    L.step=step;if(step>0){L.restore=step;saveLayout();}
    const d=$('#wb-drawer'),root=$('#wb-root');
    if(root)setA(root,'data-wb-step',String(step));
    if(d){setA(d,'class',(getA(d,'class')||'').replace(/\bstep-\d\b/g,'').replace(/\s+/g,' ').trim()+' '+V.stepClass(step,STEP_MAX+1));}
    const sp=$('#wb-splitter');if(sp){setA(sp,'aria-valuenow',String(step));setA(sp,'aria-valuetext',stepWord(step));}
    paint('drawerBar');
    if(step>0){paintLog();if(L.key&&(L.more||!L.done))logFetch(false);scrollLog();}
  }
  const logCount=()=>{const L=S.log,n=L.trimmed?L.seq:L.lines.length;return L.more&&!L.trimmed?num(n)+'+ lines':plural(n,'line');};
  function logText(){return S.log.lines.slice(-DOM_LINES).map(l=>(l.at?V.formatTime(l.at)+' ':'')+kindWord(l)+(l.tool?' '+l.tool:'')+(typeof l.text==='string'&&l.text?' '+l.text:l.chars!=null?' '+plural(l.chars,'character'):'')).join('\n');}
  function logTick(){
    const L=S.log;
    if(!L.key||L.step===0||L.done||L.busy||!linkOk()||hidden()||Date.now()-L.at<LOG_MS)return;
    logFetch(false);
  }
  function scrollLog(){const el=$('#wb-log');if(el&&S.log.follow)el.scrollTop=el.scrollHeight;}

  /* ---------- the other package, and an evaluation result ---------- */
  function fileInput(kind,accept,multiple,onFiles){
    let input=S.inputs[kind];
    if(!input){
      try{input=document.createElement('input');input.type='file';setA(input,'hidden','');setA(input,'tabindex','-1');setA(input,'aria-hidden','true');if(document.body)document.body.appendChild(input);}catch{return;}
      input.addEventListener('change',()=>{const files=Array.from(input.files||[]);try{input.value='';}catch{/* a fake input */}if(files.length)S.inputs[kind+'Fn'](files);});
      S.inputs[kind]=input;
    }
    input.accept=accept;input.multiple=!!multiple;S.inputs[kind+'Fn']=onFiles;
    try{input.click();}catch{/* no picker in this environment */}
  }
  async function loadCompare(files){
    if(S.cmp.busy)return;
    S.cmp.busy=true;S.cmp.error='';S.cmp.progress='Reading '+plural(files.length,'file')+'...';paint('midHead');paint('notes');
    try{
      const pkg=await E.ingestFiles(files,{onProgress:x=>{S.cmp.progress=(x.phase==='extracted'?'Extracted ':'Reading ')+trunc(x.name,60);const el=$('#wb-cmp-progress');if(el)el.textContent=S.cmp.progress;}});
      S.cmp.pkg=pkg;S.cmp.name=files.length===1?trunc(files[0].name,48):plural(files.length,'file');
      S.mode='';S.changeIdx=-1;S.expanded={};
      say('Comparing with '+S.cmp.name+'.');
    }catch(e){S.cmp.error='The changed package could not be read: '+msgOf(e);}
    S.cmp.busy=false;S.cmp.progress='';
    invalidateCase();
    const refocus=focusWasOn('compare-load');
    if(S.active){paintAll();if(refocus)focusKey(S.cmp.pkg?'compare-clear':'compare-load');}
  }
  function clearCompare(){S.cmp.pkg=null;S.cmp.name='';S.cmp.error='';S.mode='';S.changeIdx=-1;invalidateCase();paintAll();focusKey('compare-load');say('Comparison removed.');}
  async function readJson(file){
    if(!file||typeof file.text!=='function')throw new Error('That file could not be read.');
    if(file.size>64*1024*1024)throw new Error('That file is larger than 64 MB.');
    const text=await file.text();
    try{return JSON.parse(text);}catch{throw new Error('That file is not valid JSON.');}
  }
  async function pickGrading(files){
    S.importError='';
    try{S.evalPending=W.parseStudioGrading(await readJson(files[0]));S.evalFile=files[0].name;}
    catch(e){S.evalPending=null;S.evalFile='';S.importError=msgOf(e);}
    paint('import');
  }
  async function pickMessages(files){
    S.importError='';
    try{S.msgPending=W.parseStudioMessages(await readJson(files[0]));S.msgFile=files[0].name;}
    catch(e){S.msgPending=null;S.msgFile='';S.importError=msgOf(e);}
    paint('import');
  }
  function importEval(){
    const p=S.evalPending;
    if(!p){S.importError='Choose the grading file first.';paint('import');return;}
    const task=S.importTask.trim().slice(0,120);
    if(!task){S.importError='Type the task name this result belongs to.';paint('import');focusKey('import-task');return;}
    let rec;
    try{rec=W.normalizeEval(p,{task,sourceName:S.evalFile,importedAt:new Date().toISOString()});}catch(e){S.importError=msgOf(e);paint('import');return;}
    const saved=saveEval(rec);
    S.evalParsed=p;S.evalRec=rec;if(S.msgPending)S.evalMsgs=S.msgPending;
    S.evalPending=null;S.msgPending=null;S.evalFile='';S.msgFile='';S.importOpen=false;S.importError='';
    invalidateCase();paintAll();focusKey('import-open');
    say(saved?'Evaluation result imported. The score record is saved in this browser.':'Evaluation result imported for this session only: this browser did not allow saving it.');
  }
  function removeEval(){S.evalParsed=null;S.evalMsgs=null;S.evalRec=null;invalidateCase();paintAll();say('Imported evaluation removed from this view. The saved score record is kept.');}
  /* ---------- wording ---------- */
  const baseName=n=>{const i=String(n).lastIndexOf('/');return i<0?String(n):String(n).slice(i+1).trim()||String(n);};
  function roleWord(f){
    if(!f.inPackage&&f.change==='removed')return 'Removed file';
    if(!f.inPackage&&f.change==='added')return 'Added file';
    if(f.role==='evaluator')return 'Evaluator-only';
    if(f.role==='source'&&f.solverFacing===true)return 'Solver';
    return ROLE_WORD[f.role]||'File';
  }
  function changeLine(f){
    if(f.change==='changed'){
      const parts=[];
      if(f.changedCells)parts.push(plural(f.changedCells,'cell'));
      if(f.changedLines)parts.push(plural(f.changedLines,'line'));
      if(f.metaChanges)parts.push(plural(f.metaChanges,'workbook change'));
      return 'Changed · '+(parts.length?parts.join(', '):'file bytes differ');
    }
    return f.change==='unchanged'?'Unchanged':f.change==='added'?'Added in the changed package':f.change==='removed'?'Removed in the changed package':'';
  }
  function basisText(c){
    const cs=S.cs;
    if(cs&&cs.solver.withheld)return WITHHELD;
    switch(c.statusBasis){
      case 'heuristic-figure-search':return c.status==='met'?'Found in the '+(c.conclusion&&c.conclusion.where==='outputs'?'saved outputs':'final answer')+' (text search)':'Not found in the answer or outputs (text search)';
      case 'human-verdict':return 'Your recorded verdict';
      case 'explicit-token':return 'Marked in the evaluation text';
      default:return 'No basis to decide yet';
    }
  }
  const originWord=c=>c.origin==='freeze-figure'?'Frozen figure':c.origin==='project-output'?'Task output':'Imported evaluation item';
  const clauseBasis=cl=>cl.basis==='author-link'?'Linked by you':cl.basis==='text-match-unconfirmed'?'Suggested by a text match, not confirmed':'From the task source list';
  function verifyText(cl){
    if(!cl.resolved)return '';
    if(cl.basis==='text-match-unconfirmed')return 'Unconfirmed: this never changes the status.';
    return cl.excerptVerified===true?'The quote matches the source text.':cl.excerptVerified===false?'The quote does not match the source text.':cl.basis==='author-link'?'':'No quote to check.';
  }
  const formulaText=sn=>!sn?'none':sn.hasFormula?(sn.formula?'='+sn.formula:'a shared formula'):'a typed value';
  /* Facts about a changed cell that the before and after values do not show: the formulas, a missing saved value, a hidden cell. */
  function cellNotes(x,withKind){
    const out=[];
    if(x.change==='formula')out.push('Formula: '+formulaText(x.before)+' → '+formulaText(x.after));
    else if(withKind&&(x.change==='type'||x.change==='cache-lost'))out.push(CHANGE_WORD[x.change]);
    if(x.hidden)out.push('In a hidden row, column or sheet');
    return out;
  }
  const valueOf=snap=>{if(!snap)return '';if(snap.cachePresent===false&&snap.hasFormula)return 'no saved value';const v=String(snap.value==null?'':snap.value);return v===''?'(empty)':v;};
  function decisionNum(text,on){return on?H`<span class="sr-only">Decision-changing: </span><mark class="wb-decision"><b>${text}</b></mark>`:H`<b>${text}</b>`;}
  function say(text){S.status=String(text||'');const el=$('#wb-status');if(!el)return;el.textContent='';el.textContent=S.status;}

  /* ---------- markup of each region (all escape their data through the kit's html``) ---------- */
  const headMarkup=()=>H`<header class="wb-head"><div class="wb-title"><p class="wb-idx" aria-hidden="true">02 /</p><h1 class="wb-h1">Evidence Workbench</h1><p class="wb-tag">Clause, changed cell and solver conclusion, side by side.</p></div><div class="wb-top"><label class="wb-search"><span class="sr-only">Search files and criteria</span><svg class="wb-ic" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="wb-search" type="search" data-wb-in="search" placeholder="Search files and criteria..." autocomplete="off" spellcheck="false" aria-keyshortcuts="Control+K Meta+K"><kbd id="wb-kbd" class="wb-kbd" aria-hidden="true">Ctrl K</kbd></label><button type="button" id="wb-load" class="primary" data-wb-act="load">Load task package</button></div></header>`;

  /* The run picker lives in the evidence pane (the run decides what the criteria say). */
  function runSelect(){
    const online=linkOk(),groups=[];
    for(const r of S.runs){let g=groups.find(x=>x.id===r.roundId);if(!g){g={id:r.roundId,label:roundName(r),rows:[]};groups.push(g);}g.rows.push(r);}
    for(const g of groups)g.rows.sort((a,b)=>a.n-b.n);
    const known=S.runs.some(r=>r.key===S.runKey),loading=online&&(S.runsStatus==='idle'||S.runsStatus==='loading');
    const placeholder=!S.link?'Checking the companion...':!online?(S.link.local?'Companion not reachable':'Not available offline'):loading?'Loading runs...':S.runs.length?'No run selected':'No runs yet';
    return H`<select id="wb-run" class="wb-select" data-key="run" data-wb-act="run"${online&&S.runs.length?'':R(' disabled')}><option value="">${placeholder}</option>${S.runKey&&!known?H`<option value="${S.runKey}" selected>${S.runKey}</option>`:''}${groups.map(g=>g.rows.map(r=>H`<option value="${r.key}"${r.key===S.runKey?R(' selected'):''}>${g.label} · Pilot ${r.n} · ${stateWord(r)}</option>`))}</select>`;
  }
  /* The comparison lives in the middle pane, next to the Diff tab it switches on. */
  function compareLine(){
    const c=setup();
    if(S.cmp.busy)return H`<span id="wb-cmp-progress" role="status">${S.cmp.progress}</span>`;
    if(c&&c.kind==='loaded')return H`Comparing with <strong>${S.cmp.name}</strong>. <button type="button" class="wb-ghost" data-key="compare-clear" data-wb-act="compare-clear">Remove comparison</button>`;
    if(c&&c.kind==='pair')return H`Comparing the baseline with the proposed revision.`;
    if(!livePackage())return H`Diff needs a loaded task package and a changed one to compare it with.`;
    return H`${S.diffError?'The comparison could not be made.':'Diff needs a changed package.'} <button type="button" class="wb-ghost" data-key="compare-load" data-wb-act="compare-load">Compare with a changed package</button>`;
  }

  function notesMarkup(){
    const out=[],cs=S.cs||getCase();
    if(S.link&&!S.link.ok)out.push(S.link.local?H`<p class="wb-note" role="alert">The companion could not be reached. ${S.link.error} <button type="button" class="wb-ghost" data-key="relink" data-wb-act="relink">Try again</button></p>`:H`<p class="wb-note">${S.link.offlineMessage||'Local agents need the companion: run npm start.'} Runs and live logs are not available here. Package files, comparisons and imported evaluation results still work.</p>`);
    if(S.runsStatus==='error')out.push(H`<p class="wb-note" role="alert">The run list could not be read: ${S.runsError} <button type="button" class="wb-ghost" data-key="retry-runs" data-wb-act="retry-runs">Retry</button></p>`);
    if(cs.solver.withheld)out.push(H`<p class="wb-note"><strong>${WITHHELD}.</strong> The frozen figures, answers and log text come back when the round ends.</p>`);
    if(S.cmp.error)out.push(H`<p class="wb-note" role="alert">${S.cmp.error}</p>`);
    if(S.diffError)out.push(H`<p class="wb-note" role="alert">The two packages could not be compared: ${S.diffError}</p>`);
    if(S.notice)out.push(H`<p class="wb-note">${S.notice}</p>`);
    return H`${out}`;
  }

  function importMarkup(){
    if(!S.importOpen||opened())return '';
    const tasks=[...new Set(S.runs.map(r=>r.task).filter(Boolean))].slice(0,100),p=S.evalPending,ready=!!p;
    const facts=p?H`<p class="wb-sub wb-facts" id="wb-import-facts">Read: score <strong>${p.finalScore===null?'not stated':p.finalScore+(p.scoreMax!==null?' / '+p.scoreMax:'')}</strong>, run ${p.runId||'not recorded'}, ${plural(p.items.length,'item')} listed.</p>`:'';
    return H`<section class="wb-import" aria-label="Import an evaluation result"><p class="wb-sub">Read an evaluation result on this computer. Nothing is uploaded. Only the score record is kept in this browser.</p><div class="wb-import-row"><div class="wb-import-file"><button type="button" data-key="import-grading" data-wb-act="import-grading">Choose grading file</button><span class="wb-sub">${S.evalFile||'No file chosen'}</span>${facts}</div><div class="wb-import-file"><button type="button" data-key="import-messages" data-wb-act="import-messages">Choose solver messages file (optional)</button><span class="wb-sub">${S.msgFile||'No file chosen'}</span></div><label class="wb-fld">Task this result belongs to<input id="wb-import-task" type="text" data-key="import-task" data-wb-in="import-task" list="wb-tasks" maxlength="120" autocomplete="off" placeholder="Task name, for example Atlas" aria-required="true"${S.importError?R(' aria-describedby="wb-import-err"'):''} value="${S.importTask}"></label><datalist id="wb-tasks">${tasks.map(t=>H`<option value="${t}"></option>`)}</datalist><div class="wb-import-go"><button type="button" data-key="import-go" data-wb-act="import-go"${ready?'':R(' aria-disabled="true"')}>Import</button><button type="button" class="wb-ghost" data-key="import-cancel" data-wb-act="import-cancel">Cancel</button></div></div>${S.importError?H`<p class="wb-err" id="wb-import-err" role="alert">${S.importError}</p>`:''}</section>`;
  }

  const paneId=p=>p==='files'?'wb-files':p==='diff'?'wb-mid':'wb-evid';
  function tabsMarkup(){
    const cs=S.cs||getCase(),idx=PANES.indexOf(S.pane),label=p=>p==='files'?'Files ('+cs.files.length+')':PANE_WORD[p];
    return H`<div class="wb-tablist" role="tablist" aria-label="Panes">${PANES.map(p=>H`<button type="button" role="tab" id="wb-pt-${p}" class="wb-pt" data-key="pt-${p}" data-wb-act="pane" data-pane="${p}" aria-selected="${p===S.pane?'true':'false'}" aria-controls="${paneId(p)}" tabindex="${p===S.pane?'0':'-1'}">${label(p)}</button>`)}</div><nav class="wb-stepper" aria-label="Steps"><button type="button" class="wb-sb" data-key="step-back" data-wb-act="step-back"${idx<=0?R(' disabled'):''}>Back</button><ol class="wb-steps">${PANES.map((p,i)=>H`<li><button type="button" class="wb-sn" data-key="sn-${p}" data-wb-act="pane" data-pane="${p}"${p===S.pane?R(' aria-current="step"'):''}><span class="wb-num" aria-hidden="true">${i+1}</span>${PANE_WORD[p]}</button></li>`)}</ol><button type="button" class="wb-sb" data-key="step-next" data-wb-act="step-next"${idx>=PANES.length-1?R(' disabled'):''}>Next</button></nav>`;
  }

  /* files: a tree, one level of folders at most (a name's path before its last slash) */
  const fileVisible=f=>(!S.q||f.name.toLowerCase().includes(S.q))&&(!S.changedOnly||(f.change&&f.change!=='unchanged'));
  function filesMarkup(){
    const cs=S.cs||getCase(),files=cs.files.filter(fileVisible),items=[],dirs=new Map();
    for(const f of files){
      const i=f.name.lastIndexOf('/');
      if(i<0){items.push({file:f,base:f.name});continue;}
      const dir=f.name.slice(0,i).trim()||'/';let g=dirs.get(dir);
      if(!g){g={dir,files:[]};dirs.set(dir,g);items.push(g);}
      g.files.push({file:f,base:f.name.slice(i+1).trim()||f.name});
    }
    const visibleIds=[];
    for(const it of items){if(it.file)visibleIds.push(it.file.id);else if(S.dirs[it.dir]!==false)for(const x of it.files)visibleIds.push(x.file.id);}
    const tabId=visibleIds.includes(S.fileId)?S.fileId:visibleIds[0];
    const total=items.length;
    const leaf=(x,level,pos,size)=>{
      const f=x.file,sel=f.id===S.fileId;
      return H`<div role="treeitem" class="wb-file${sel?' is-selected':''}" data-key="f:${f.id}" data-wb-act="file" data-id="${f.id}" aria-level="${level}" aria-posinset="${pos}" aria-setsize="${size}" aria-selected="${sel?'true':'false'}" tabindex="${f.id===tabId?'0':'-1'}" title="${f.name}"><span class="wb-fn">${x.base}</span><span class="wb-role">${roleWord(f)}</span>${sel&&changeLine(f)?H`<span class="wb-fchg"><span aria-hidden="true">&#9679;</span> ${changeLine(f)}</span>`:''}</div>`;
    };
    const rows=items.map((it,i)=>{
      if(it.file)return leaf(it,1,i+1,total);
      const open=S.dirs[it.dir]!==false;
      return H`<div role="treeitem" class="wb-dir" data-key="d:${it.dir}" data-wb-act="dir" data-dir="${it.dir}" aria-level="1" aria-posinset="${i+1}" aria-setsize="${total}" aria-expanded="${open?'true':'false'}" tabindex="-1" title="${it.dir}"><span class="wb-caret" aria-hidden="true">${open?'▾':'▸'}</span><span class="wb-fn">${it.dir}</span></div>${open?it.files.map((x,j)=>leaf(x,2,j+1,it.files.length)):''}`;
    });
    const empty=!cs.files.length?(livePackage()?'This package has no files.':'No files yet.'):!files.length?'No file matches.':'';
    return H`<div class="wb-pane-head"><h2 class="wb-h">Files <span class="wb-count">(${cs.files.length})</span></h2>${S.diff&&(cs.files.length>=12||S.changedOnly)?H`<button type="button" class="wb-toggle" data-key="changed-only" data-wb-act="changed-only" aria-pressed="${S.changedOnly?'true':'false'}">Changed only</button>`:''}</div>${empty?H`<p class="wb-hint">${empty}</p>`:''}<div id="wb-tree" class="wb-tree" role="tree" aria-label="Files" data-key="tree">${rows}</div>`;
  }

  /* the middle pane: head (name, mode), body (source records or the diff) */
  function midHeadMarkup(){
    const f=fileOf(),mode=f?effectiveMode(f):'source',cs=S.cs||getCase();
    const d=f?docOf(f):null,sub=f?[f.kind||'file',d?plural(d.records.length,'record'):f.change==='removed'?'removed':'not in the loaded package'].join(' · '):'';
    const tab=(id,word)=>H`<button type="button" role="tab" id="wb-mt-${id}" class="wb-mt" data-key="mt-${id}" data-wb-act="mode" data-mode="${id}" aria-selected="${mode===id?'true':'false'}" aria-controls="wb-mid-body" tabindex="${mode===id?'0':'-1'}"${id==='diff'&&!S.diff?R(' aria-disabled="true" aria-describedby="wb-diff-why"'):''}>${word}</button>`;
    return H`<div class="wb-mid-bar"><button type="button" class="wb-ghost wb-files-btn" data-key="files-btn" data-wb-act="files-toggle" aria-expanded="${S.filesOpen?'true':'false'}" aria-controls="wb-files">Files (${cs.files.length})</button><div class="wb-mid-title"><h2 class="wb-h wb-fname" title="${f?f.name:''}">${f?baseName(f.name):cs.files.length?'Select a file':'Source and diff'}</h2>${sub?H`<p class="wb-sub">${sub}</p>`:''}</div><div class="wb-seg" role="tablist" aria-label="View mode">${tab('source','Source')}${tab('diff','Diff')}</div></div><p id="wb-diff-why" class="wb-why">${compareLine()}</p>`;
  }
  const emptyBox=(...parts)=>H`<div class="wb-empty">${parts.filter(Boolean).map(p=>H`<p>${p}</p>`)}</div>`;
  function linkedSet(f){
    const s=new Set(),c=crit();
    if(c&&f)for(const cl of c.clauses)if(cl.resolved&&(cl.basis==='source-anchor'||cl.basis==='author-link')&&cl.documentName===f.name&&(!cl.sha256||!f.sha256||cl.sha256===f.sha256))s.add(cl.locator);
    return s;
  }
  const selLoc=f=>S.rec&&f&&S.rec.fileId===f.id?S.rec.locator:null;
  function midBodyMarkup(){
    const cs=S.cs||getCase(),f=fileOf();
    if(!cs.files.length)return livePackage()?emptyBox('This package has no files to read.'):H`${emptyBox('No task package is loaded.','Load a task package to read its files, clauses and changes here.')}<p><button type="button" data-key="load-empty" data-wb-act="load">Load task package</button></p>`;
    if(!f)return emptyBox('Select a file to read it.');
    return effectiveMode(f)==='diff'?diffBody(f):sourceBody(f);
  }
  function sourceBody(f){
    const d=docOf(f),from=docFrom(f);
    if(!d)return emptyBox(f.change==='removed'?'This file is only in the base package, which is not the one loaded.':'This file is not in the loaded package.');
    const recs=d.records||[],total=recs.length;
    if(!total)return emptyBox(d.status==='unsupported'?'This file is kept in the inventory but not read. A PDF needs a text export.':d.status==='error'?'This file could not be read: '+((d.warnings||[]).join(' ')||'unknown error')+'.':'No text or cells were extracted from this file.');
    const pages=Math.max(1,Math.ceil(total/PAGE)),page=V.clamp(S.page,0,pages-1),a=page*PAGE,b=Math.min(total,a+PAGE),linked=linkedSet(f),sel=selLoc(f);
    return H`<div class="wb-toolbar"><div class="wb-goto"><label class="sr-only" for="wb-goto-in">Go to locator</label><input id="wb-goto-in" type="text" data-key="goto" data-wb-in="goto" placeholder="Go to a locator, for example Row 12 or B7" autocomplete="off" spellcheck="false" value="${S.goto}"><button type="button" data-key="goto-go" data-wb-act="goto">Go</button></div>${pages>1?H`<div class="wb-pager"><button type="button" data-key="page-prev" data-wb-act="page-prev"${page<=0?R(' disabled'):''}>Previous ${PAGE}</button><span class="wb-sub">Records ${num(a+1)} to ${num(b)} of ${num(total)}</span><button type="button" data-key="page-next" data-wb-act="page-next"${page>=pages-1?R(' disabled'):''}>Next ${PAGE}</button></div>`:''}</div><p id="wb-goto-msg" class="wb-sub wb-gmsg" role="status">${S.gotoMsg}</p>${S.gotoHits.length?H`<ul class="wb-hits" aria-label="Records that hold ${S.goto.trim()}">${S.gotoHits.map(h=>H`<li><button type="button" class="wb-where" data-wb-act="open-loc" data-doc="${h.documentName}" data-sha="${h.sha256||''}" data-loc="${h.locator}">${h.documentName} · ${h.locator}</button></li>`)}</ul>`:''}${from==='other'?H`<p class="wb-sub">Shown from the changed package. Links can only point at records of the loaded package.</p>`:''}<div id="wb-recs" class="wb-recs" data-key="recs">${recs.slice(a,b).map((r,i)=>{const on=r.locator===sel,lk=linked.has(r.locator);return H`<div role="option" class="wb-rec${on?' is-selected':''}${lk?' is-linked':''}" data-key="rec:${a+i}" data-wb-loc="${r.locator}" aria-selected="${on?'true':'false'}"><span class="wb-loc">${r.locator}</span><span class="wb-rt">${r.text}</span>${r.hidden?H`<span class="wb-hid">hidden</span>`:''}</div>`;})}</div>`;
  }
  function diffToolbar(total,noun,all){
    const cur=S.changeIdx;
    const count=total>1&&cur>=0&&cur<total?'Change '+num(cur+1)+' of '+num(total):plural(all!=null?all:total,noun);
    if(total<2)return H`<div class="wb-toolbar"><span class="wb-sub" id="wb-chg-count">${count}</span></div>`;
    return H`<div class="wb-toolbar"><div class="wb-pager"><button type="button" data-key="chg-prev" data-wb-act="prev-change"${cur<=0?R(' disabled'):''}>Previous change</button><span class="wb-sub" id="wb-chg-count">${count}</span><button type="button" data-key="chg-next" data-wb-act="next-change"${cur>=total-1?R(' disabled'):''}>Next change</button></div></div>`;
  }
  function diffBody(f){
    const dd=diffDocOf(f),c=setup();
    S.cur={total:0,locs:[]};
    if(!dd||!c)return emptyBox('This file is not part of the comparison.');
    const note=(dd.limits||[]).filter(t=>!/recalculat/i.test(t)).slice(0,3);
    if(dd.status==='unchanged')return emptyBox('This file is the same in both packages (same content hash).');
    if(dd.status==='added')return emptyBox('This file exists only in the changed package. The whole file is the change.','Switch to Source to read it.');
    if(dd.status==='removed')return emptyBox('This file exists only in the base package. The whole file is the change.');
    const meta=metaLines(dd),metaBlock=meta.length?H`<section class="wb-metachg" aria-label="Workbook changes"><h3 class="wb-sheet-name">Workbook changes</h3><ul class="wb-notes-list">${meta.map(t=>H`<li>${t}</li>`)}</ul></section>`:'';
    const tail=H`${metaBlock}${note.length?H`<ul class="wb-notes-list">${note.map(t=>H`<li>${t}</li>`)}</ul>`:''}`;
    if(dd.cells.length)return cellDiff(f,dd,c,tail);
    if(dd.lines.some(l=>l.op!=='equal'))return lineDiff(f,dd,c,tail);
    return H`${meta.length?'':emptyBox('The file bytes differ, but no extracted cell or line differs.')}${tail}`;
  }
  /* Sheets and defined names that were added, removed or changed: part of a workbook's mutation even when no cell differs. */
  function metaLines(dd){
    const m=dd&&dd.metaChanges&&typeof dd.metaChanges==='object'?dd.metaChanges:{},out=[];
    for(const x of Array.isArray(m.sheets)?m.sheets:[]){
      const was=x.before&&x.before.state||'visible',now=x.after&&x.after.state||'visible';
      out.push(x.change==='added'?'Sheet '+x.name+' was added.':x.change==='removed'?'Sheet '+x.name+' was removed.':'Sheet '+x.name+' changed from '+was+' to '+now+'.');
    }
    for(const x of Array.isArray(m.definedNames)?m.definedNames:[]){
      out.push(x.change==='added'?'Name '+x.name+' was added'+(x.after?', pointing at '+x.after:'')+'.':x.change==='removed'?'Name '+x.name+' was removed.':'Name '+x.name+' now points at '+x.after+' (it pointed at '+x.before+').');
    }
    return out.slice(0,20);
  }
  function cellDiff(f,dd,c,tail){
    const candDoc=c.cand.documents.find(d=>d.id===dd.candId)||null,baseDoc=c.base.documents.find(d=>d.id===dd.baseId)||null;
    const view=W.diffViewRows(dd,{context:2,candDoc,baseDoc}),total=view.changes.length,linked=linkedSet(f),sel=selLoc(f);
    S.cur={total,locs:view.changes.map(x=>x.locator)};
    const cellTd=cell=>{
      if(cell.role!=='changed')return H`<td class="wb-c" data-wb-loc="${cell.locator}">${cell.known?cell.value:'unknown'}</td>`;
      const i=cell.changeIndex,cur=i===S.changeIdx,dec=S.decision.has(f.name+'\t'+cell.locator),ch=cell.change,tab=cur||(S.changeIdx<0&&i===0)?'0':'-1';
      const body=ch==='added'?H`<span class="sr-only">Added: </span>${decisionNum(valueOf(cell.after),dec)}`:ch==='removed'?H`<span class="sr-only">Removed: </span><span class="wb-was">${valueOf(cell.before)}</span>`:H`<span class="sr-only">${cell.locator}, ${CHANGE_WORD[ch]||'changed'}. Before: </span><span class="wb-was">${valueOf(cell.before)}</span><span class="wb-arrow" aria-hidden="true">&rarr;</span><span class="sr-only"> Now: </span>${decisionNum(valueOf(cell.after),dec)}`;
      return H`<td class="wb-c wb-changed${cur?' is-current':''}${linked.has(cell.locator)?' is-linked':''}${sel===cell.locator?' is-selected':''}" data-wb-loc="${cell.locator}"><button type="button" class="wb-chg" data-key="chg:${i}" data-wb-act="pick-cell" data-change="${i}" data-wb-loc="${cell.locator}" tabindex="${tab}">${body}${cellNotes(cell,true).map(n=>H`<span class="wb-kind">${n}</span>`)}</button></td>`;
    };
    const sections=view.sections.map(sec=>{const used=new Set(sec.rows.flatMap(r=>r.cells.filter(x=>x.role==='changed'||(x.known&&String(x.value)!=='')).map(x=>x.col))),cols=sec.columns.filter(x=>used.has(x)),shown=cols.length?cols:sec.columns.slice(0,1);sec={...sec,columns:shown,rows:sec.rows.map(r=>({...r,cells:r.cells.filter(x=>shown.includes(x.col))}))};return H`<section class="wb-sheet">${sec.sheet?H`<h3 class="wb-sheet-name">${sec.sheet}</h3>`:''}<div class="wb-tablewrap"><table class="wb-dt"><caption class="sr-only">Changed cells with two rows and two columns of context</caption><thead><tr><th scope="col" class="wb-rn"><span class="sr-only">Row</span></th>${sec.columns.map(col=>H`<th scope="col">${col}</th>`)}</tr></thead><tbody>${sec.rows.map(row=>H`${row.gapBefore>0?H`<tr class="wb-gap"><td colspan="${sec.columns.length+1}">${plural(row.gapBefore,'row')} not shown</td></tr>`:''}<tr><th scope="row" class="wb-rn">${row.row}</th>${row.cells.map(cellTd)}</tr>`)}</tbody></table></div>${sec.truncated?H`<p class="wb-sub">Only the first rows and columns are drawn.</p>`:''}</section>`;});
    const beyond=view.changes.filter(x=>!x.shown).length,loose=Array.isArray(view.unplaced)?view.unplaced:[];
    const extra=H`${beyond?H`<p class="wb-sub">${plural(beyond,'change')} lie beyond the first 400 rows and 30 columns drawn here.</p>`:''}${loose.length?H`<section class="wb-loosechg" aria-label="Changes without a row and column"><h3 class="wb-sheet-name">Changes that have no row and column</h3><ul class="wb-notes-list">${loose.slice(0,20).map(x=>H`<li>${x.locator} · ${CHANGE_WORD[x.change]||'Changed'} · ${valueOf(x.before)} → ${valueOf(x.after)}</li>`)}</ul>${loose.length>20?H`<p class="wb-sub">${plural(loose.length-20,'more change')}.</p>`:''}</section>`:''}`;
    return H`${diffToolbar(total,'changed cell',Math.max(total,Number(view.total)||0))}<div class="wb-diff" data-key="diff">${sections}</div>${extra}${tail}`;
  }
  function lineDiff(f,dd,c,tail){
    const view=W.lineDiffRows(dd,{collapseAfter:6}),total=view.changes.length,mainIsBase=c.main===c.base,sel=selLoc(f),linked=linkedSet(f);
    S.cur={total,locs:view.changes.map(ch=>{const r=view.rows[ch.firstRow];const loc=r&&(mainIsBase?r.baseLocator:r.candLocator);return loc||'';})};
    const first=new Set();
    const line=(r,key)=>{
      const op=r.op,loc=(mainIsBase?r.baseLocator:r.candLocator)||'',label=op==='add'?'Added':op==='del'?'Removed':'Unchanged',shown=op==='del'?r.baseLocator:r.candLocator;
      const marks=r.changeIndex!=null&&!first.has(r.changeIndex)?(first.add(r.changeIndex),true):false;
      const cur=r.changeIndex!=null&&r.changeIndex===S.changeIdx;
      return H`<div role="option" class="wb-ln is-${op}${cur?' is-current':''}${loc&&linked.has(loc)?' is-linked':''}${loc&&loc===sel?' is-selected':''}" data-key="${key}" data-wb-loc="${loc}" data-change="${r.changeIndex==null?'':r.changeIndex}"${marks?R(' data-first="1"'):''} aria-selected="${loc&&loc===sel?'true':'false'}"><span class="wb-lno">${shown||''}</span><span class="wb-lsign" aria-hidden="true">${op==='add'?'+':op==='del'?'−':''}</span><span class="sr-only">${label}: </span><span class="wb-lt">${r.text}</span></div>`;
    };
    const rows=[];
    for(const r of view.rows){
      if(r.type!=='collapsed'){rows.push(line(r,'ln:'+r.index));continue;}
      if(S.expanded[f.id+':'+r.fromIndex]){for(let i=r.fromIndex;i<r.toIndex;i++){const op=dd.lines[i];rows.push(line({op:'equal',baseLocator:op.baseLocator,candLocator:op.candLocator,text:op.after!=null?op.after:op.before,changeIndex:null},'ln:'+i));}continue;}
      rows.push(H`<div role="option" class="wb-ln wb-collapsed" data-key="gap:${r.fromIndex}" data-wb-expand="${r.fromIndex}" aria-selected="false"><span class="wb-lt">${plural(r.count,'unchanged line')} hidden. Press Enter to show them.</span></div>`);
    }
    return H`${diffToolbar(total,'change')}<div id="wb-recs" class="wb-recs wb-lines" data-key="recs">${rows}</div>${tail}`;
  }

  /* the right pane */
  /* The evidence pane has two states. The list (run picker, counts, criteria) is the default. Choosing a criterion opens its evidence card in the whole pane,
     with a way back and a step to the neighbouring criteria, so the clause, the changed cell and the conclusion are read together without scrolling past a list. */
  const opened=()=>S.critOpen&&!!crit();
  function runBlockMarkup(){
    if(opened())return '';
    return H`<div class="wb-runbar"><label class="wb-lbl" for="wb-run">Run</label><button type="button" class="wb-ghost" data-key="import-open" data-wb-act="import-open" aria-expanded="${S.importOpen?'true':'false'}" aria-controls="wb-import">Import evaluation result</button></div>${runSelect()}`;
  }
  function evidHeadMarkup(){
    const cs=S.cs||getCase();
    if(opened()){
      const rows=critRows(cs),i=rows.findIndex(x=>x.id===S.critId),first=i<=0,last=i<0||i>=rows.length-1;
      return H`<div class="wb-detailbar"><button type="button" class="wb-ghost wb-back" data-key="crit-back" data-wb-act="crit-back"><span aria-hidden="true">&larr;</span> All criteria</button>${i>=0?H`<span class="wb-sub wb-pos">${i+1} of ${rows.length}</span>`:''}<span class="wb-stepbtns"><button type="button" class="wb-pn" data-key="crit-prev" data-wb-act="crit-prev" aria-label="Previous criterion"${first?R(' aria-disabled="true"'):''}><span aria-hidden="true">&lsaquo;</span></button><button type="button" class="wb-pn" data-key="crit-next" data-wb-act="crit-next" aria-label="Next criterion"${last?R(' aria-disabled="true"'):''}><span aria-hidden="true">&rsaquo;</span></button></span></div>`;
    }
    const n=counts(cs),rec=S.evalRec||(taskKey()?readEvals().filter(x=>taskKeyOf(x.task)===taskKey()).pop():null);
    const evalLine=rec&&rec.score!=null?H`<p class="wb-sub wb-evalline">Imported evaluation result: ${rec.score}${rec.scoreMax!=null?' / '+rec.scoreMax:''}, run ${rec.runId||'unknown'}, ${String(rec.importedAt||'').slice(0,10)||'unknown date'}. Recorded by you from the evaluation; Finance Task Studio did not compute it.</p>`:'';
    return H`<div class="wb-pane-head"><h2 class="wb-h">Criteria</h2><button type="button" class="wb-toggle" data-key="only-not-met" data-wb-act="only-not-met" aria-pressed="${S.onlyNotMet?'true':'false'}">Not met only</button></div><p class="wb-counts"><span class="st-not-met"><span aria-hidden="true">&#10005;</span> ${num(n['not-met'])} Not met</span><span class="st-met"><span aria-hidden="true">&#10003;</span> ${num(n.met)} Met</span><span class="st-unknown">${num(n.unknown)} Unknown</span></p>${evalLine}${S.evalParsed?H`<p class="wb-sub"><button type="button" class="wb-linkbtn" data-key="eval-remove" data-wb-act="eval-remove">Remove the imported evaluation from this view</button></p>`:''}`;
  }
  const critRows=cs=>cs.criteria.filter(c=>(!S.onlyNotMet||c.status==='not-met')&&(!S.q||(c.text+' '+c.group).toLowerCase().includes(S.q)));
  function critNoteMarkup(){
    const cs=S.cs||getCase(),rows=critRows(cs);
    if(opened())return '';
    if(S.detail==='loading')return H`<p class="wb-hint" role="status">Loading the run...</p>`;
    if(S.detail==='error')return H`<div class="wb-fail" role="alert"><p><strong>The run could not be read.</strong> ${S.detailError}</p><button type="button" data-key="retry-detail" data-wb-act="retry-detail">Retry</button></div>`;
    if(!cs.criteria.length)return H`<p class="wb-hint">${S.runKey?'This run has no criteria to list.':'No criteria yet.'} Choose a run, load the task project with its outputs, or import an evaluation result.</p>`;
    if(!rows.length)return H`<p class="wb-hint">${S.onlyNotMet?'No criterion is Not met.':'No criterion matches the search.'}</p>`;
    return '';
  }
  function critInner(c){const st=ST[c.status]||ST.unknown;return H`<span class="wb-cs st-${c.status}"><span class="wb-glyph" aria-hidden="true">${R(st.glyph)}</span><span class="wb-cw">${st.word}</span></span><span class="wb-cb"><span class="wb-ct">${c.text}</span><span class="wb-cbasis">${basisText(c)}</span></span>`;}
  /* A long record is shown as an excerpt around the value being looked for (the model's excerptAround), or its first characters, with the whole quote behind a disclosure. */
  const QUOTE_MAX=260;
  function needlesFor(cl,c){
    const out=[];
    if(cl.match)out.push(cl.match);
    const fig=c.conclusion&&c.conclusion.figure&&c.conclusion.figure.expected;
    if(fig!==undefined&&fig!==null&&String(fig).trim()!=='')out.push(String(fig).trim());
    const cell=c.cells.find(x=>x.documentName===cl.documentName&&x.locator===cl.locator);
    if(cell&&cell.after&&cell.after.value!=null&&String(cell.after.value)!=='')out.push(String(cell.after.value));
    const n=c.numbers[0];
    if(n&&typeof n.correct==='number'&&Number.isFinite(n.correct)){out.push(String(n.correct));out.push(n.correct.toLocaleString('en-US',{maximumFractionDigits:6}));}
    return out;
  }
  function quoteView(text,needles,key){
    const t=String(text||'');
    if(!t.trim())return H`<blockquote class="wb-quote">(empty record)</blockquote>`;
    if(t.length<=QUOTE_MAX)return H`<blockquote class="wb-quote">${t}</blockquote>`;
    let ex=null;
    for(const nd of needles||[]){ex=W.excerptAround(t,nd,110);if(ex)break;}
    /* the cut ends are moved to the nearest space so no word is split */
    const before=ex?(ex.ellipsisBefore?ex.before.replace(/^\S*\s+/,''):ex.before):'',after=ex?(ex.ellipsisAfter?ex.after.replace(/\s+\S*$/,''):ex.after):'';
    const body=ex?H`${ex.ellipsisBefore?'…':''}${before}<b>${ex.match}</b>${after}${ex.ellipsisAfter?'…':''}`:H`${t.slice(0,QUOTE_MAX).replace(/\s+\S*$/,'')}…`;
    return H`<blockquote class="wb-quote">${body}</blockquote><details class="wb-fullquote" data-key="full:${key}"><summary>Show the full quote (${num(t.length)} characters)</summary><blockquote class="wb-quote wb-full">${t}</blockquote></details>`;
  }
  function clauseItem(cl,c){
    const here=cl.resolved?H`<button type="button" class="wb-where" data-wb-act="open-loc" data-doc="${cl.documentName}" data-sha="${cl.sha256||''}" data-loc="${cl.locator}">${cl.documentName} · ${cl.locator}</button>`:H`<span class="wb-where">${cl.documentName} · ${cl.locator}</span>`;
    return H`<div class="wb-clause">${cl.resolved?quoteView(cl.quote,needlesFor(cl,c),cl.documentName+'|'+cl.locator):H`<p class="wb-unres"><strong>Not resolved.</strong> ${cl.reason||'This clause was not found in the package.'}</p>`}<p class="wb-meta">${here} <span>${clauseBasis(cl)}${cl.resolved&&verifyText(cl)?'. '+verifyText(cl):''}</span>${cl.basis==='author-link'?H` <button type="button" class="wb-linkbtn" data-wb-act="unlink" data-doc="${cl.documentName}" data-loc="${cl.locator}">Remove link</button>`:''}</p></div>`;
  }
  function clausePart(c){
    const conf=c.clauses.filter(x=>x.basis!=='text-match-unconfirmed'),sug=c.clauses.filter(x=>x.basis==='text-match-unconfirmed'),r=S.rec,main=mainPackage();
    const reason=!r?'Select a record in the middle pane first.':!main?'Load a task package first.':docFrom(fileOf())==='other'?'That record is only in the changed package.':'';
    return H`<section class="wb-part" aria-labelledby="wb-h-clause"><h4 id="wb-h-clause" class="wb-ph">Source clause</h4>${conf.length?clauseItem(conf[0],c):H`<p class="wb-none">No source clause is linked to this criterion.</p>`}${conf.length>1?H`<details class="wb-more" data-key="more-clauses"><summary>${plural(conf.length-1,'more clause')}</summary>${conf.slice(1).map(x=>clauseItem(x,c))}</details>`:''}${sug.length?H`<div class="wb-sugg"><p class="wb-sub">Suggested by a text match, not confirmed. A suggestion never changes the status.</p>${sug.slice(0,3).map(x=>clauseItem(x,c))}</div>`:''}<div class="wb-linkrow"><button type="button" data-key="link-clause" data-wb-act="link-clause" aria-describedby="wb-link-why"${reason?R(' aria-disabled="true"'):''}>Link clause</button><span id="wb-link-why" class="${reason?'wb-sub':'sr-only'}">${reason||'Links the selected record to this criterion.'}</span></div></section>`;
  }
  function cellPart(c){
    const items=[];
    for(const x of c.cells){
      const dec=x.decisionChanges===true;
      items.push(H`<div class="wb-cellchg"><p class="wb-meta"><button type="button" class="wb-where" data-wb-act="open-loc" data-doc="${x.documentName}" data-loc="${x.locator}">${x.documentName} · ${x.locator}</button> <span>${CHANGE_WORD[x.change]||'Changed'}</span></p><p class="wb-vals"><span class="wb-was">${valueOf(x.before)}</span><span class="wb-arrow" aria-hidden="true">&rarr;</span><span class="sr-only"> now </span>${decisionNum(valueOf(x.after),dec)}</p>${cellNotes(x,false).map(n=>H`<p class="wb-sub">${n}</p>`)}</div>`);
    }
    for(const x of c.lines)items.push(H`<div class="wb-cellchg"><p class="wb-meta"><button type="button" class="wb-where" data-wb-act="open-loc" data-doc="${x.documentName}" data-loc="${x.candLocator||x.baseLocator}">${x.documentName} · ${x.candLocator||x.baseLocator}</button> <span>${x.op==='add'?'Line added':'Line removed'}</span></p><p class="wb-vals">${x.op==='add'?x.after:x.before}</p></div>`);
    const nums=c.numbers.map(n=>H`<p class="wb-nums">${n.label}${n.decisionChanges?H` <span class="sr-only">Decision-changing: </span>`:''}: correct reading ${n.decisionChanges?H`<mark class="wb-decision"><b>${fmtNum(n.correct)}</b></mark>`:H`<b>${fmtNum(n.correct)}</b>`}, wrong reading ${n.decisionChanges?H`<mark class="wb-decision"><b>${fmtNum(n.wrong)}</b></mark>`:H`<b>${fmtNum(n.wrong)}</b>`}${n.unit?' '+n.unit:''}</p>`);
    const empty=!S.diff?H`<p class="wb-none">${S.diffError?'The comparison could not be made.':'Load a changed package to see which cells changed.'}</p>`:H`<p class="wb-none">No changed cell matches this criterion's source clause.</p>`;
    return H`<section class="wb-part" aria-labelledby="wb-h-cell"><h4 id="wb-h-cell" class="wb-ph">Changed cell</h4>${items.length?items.slice(0,3):empty}${items.length>3?H`<p class="wb-sub">${plural(items.length-3,'more change')} in the middle pane.</p>`:''}${nums}</section>`;
  }
  function conclusionPart(c){
    const cs=S.cs,cn=c.conclusion||{},row=runRow(S.runKey),parts=[],head=H`<h4 id="wb-h-conc" class="wb-ph">Solver conclusion</h4>`;
    if(cs.solver.withheld)return H`<section class="wb-part" aria-labelledby="wb-h-conc">${head}<p class="wb-none">${WITHHELD}.</p></section>`;
    if(c.origin==='studio-item')parts.push(H`<p>${c.status==='unknown'?'The evaluation text carries no explicit pass or fail mark for this item.':'The evaluation text marks this item '+ST[c.status].word+'.'}</p>`);
    else if(!cn.runRef)parts.push(H`<p class="wb-none">No run is selected, so there is no solver conclusion.</p>`);
    else{
      if(cn.figure)parts.push(H`<p>Expected <b>${cn.figure.expected}</b>. ${cn.figure.found===true?'Found in the '+(cn.where==='outputs'?'saved outputs':'final answer')+'.':cn.figure.found===false?'Not found in the answer or the saved outputs.':'Not checked.'}</p>`);
      if(cn.quote)parts.push(H`<blockquote class="wb-quote">${cn.quote}</blockquote>`);
      if(cn.humanVerdict)parts.push(H`<p>Your verdict: ${VERDICT_WORD[cn.humanVerdict.verdict]||cn.humanVerdict.verdict}${cn.humanVerdict.note?'. '+cn.humanVerdict.note:''}</p>`);
      if(!parts.length)parts.push(H`<p class="wb-none">The solver's answer says nothing that this criterion checks.</p>`);
      if(row)parts.push(H`<p class="wb-sub">${runLabel(row)}</p>`);
    }
    /* A criterion with no figure of its own: the run's overall result, so the card still says what the solver concluded. */
    const sc=cs.solver.conclusion;
    if(c.origin==='project-output'&&sc&&!cn.figure){
      parts.length=0;
      parts.push(H`<p>No frozen figure is paired with this output. ${row?runLabel(row)+': ':'The run: '}${STATE_WORD[sc.state]||sc.state||'unknown state'}, audit ${sc.audit||'not run'}. Suggested verdict: ${VERDICT_WORD[sc.suggestedVerdict]||'none yet'} <span class="wb-sub">(a text search, not grading)</span>.</p>`);
    }
    return H`<section class="wb-part" aria-labelledby="wb-h-conc">${head}${parts}</section>`;
  }
  function cardMarkup(){
    const cs=S.cs||getCase(),c=crit();
    if(!opened())return cs.criteria.length?H`<p class="wb-hint">Choose a criterion to see its source clause, the changed cell and the solver's conclusion together.</p>`:'';
    const st=ST[c.status]||ST.unknown;
    return H`<article class="wb-card" aria-labelledby="wb-card-title"><header class="wb-card-head"><h3 id="wb-card-title" class="wb-card-title" tabindex="-1">${c.text}</h3><p class="wb-card-kind">${originWord(c)} · <span class="wb-card-status st-${c.status}"><span aria-hidden="true">${R(st.glyph)}</span> ${st.word}</span></p></header>${clausePart(c)}${cellPart(c)}${conclusionPart(c)}</article>`;
  }
  function solverMarkup(){
    const cs=S.cs||getCase(),sv=cs.solver,tab=S.solverTab==='conclusion'?'conclusion':'answer',row=runRow(S.runKey);
    const t=(id,word)=>H`<button type="button" role="tab" id="wb-sv-${id}" class="wb-mt" data-key="sv-${id}" data-wb-act="solver-tab" data-tab="${id}" aria-selected="${tab===id?'true':'false'}" aria-controls="wb-solver-panel" tabindex="${tab===id?'0':'-1'}">${word}</button>`;
    let body;
    if(tab==='answer'){
      const ans=sv.finalText,msgs=S.evalMsgs&&S.evalMsgs.finalAnswer;
      body=sv.withheld?H`<p class="wb-none">${WITHHELD}.</p>`:ans?H`<pre class="wb-answer" tabindex="0" aria-label="Final answer of ${row?runLabel(row):'the run'}">${ans}</pre>`:msgs?H`<p class="wb-sub">Final answer from the imported solver messages (read in this browser only).</p><pre class="wb-answer" tabindex="0" aria-label="Final answer from the imported solver messages">${msgs}</pre>`:H`<p class="wb-none">No answer to show. Choose a finished run, or import solver messages.</p>`;
    }else{
      const cn=sv.conclusion;
      body=sv.withheld?H`<p class="wb-none">${WITHHELD}.</p>${cn?H`<dl class="wb-dl"><dt>State</dt><dd>${STATE_WORD[cn.state]||cn.state}</dd><dt>Audit</dt><dd>${cn.audit||'Not audited'}</dd></dl>`:''}`:cn?H`<dl class="wb-dl"><dt>State</dt><dd>${STATE_WORD[cn.state]||cn.state||'Unknown'}</dd><dt>Audit</dt><dd>${cn.audit||'Not audited'}</dd><dt>Suggested verdict</dt><dd>${VERDICT_WORD[cn.suggestedVerdict]||'None yet'} <span class="wb-sub">(a text search, not grading)</span></dd><dt>Your verdict</dt><dd>${cn.humanVerdict?VERDICT_WORD[cn.humanVerdict.verdict]||cn.humanVerdict.verdict:'Not recorded'}</dd>${cn.fingerprintsHit&&cn.fingerprintsHit.length?H`<dt>Fingerprints found</dt><dd>${cn.fingerprintsHit.map(x=>x.label||x.id).join(', ')}</dd>`:''}${cn.decision&&cn.decision.keywords&&cn.decision.keywords.length?H`<dt>Decision words</dt><dd>${cn.decision.found&&cn.decision.found.length?'Found: '+cn.decision.found.join(', '):'None of '+cn.decision.keywords.join(', ')+' found'}</dd>`:''}</dl>`:H`<p class="wb-none">No run is selected.</p>`;
    }
    return H`<div class="wb-seg" role="tablist" aria-label="Solver output">${t('answer','Answer')}${t('conclusion','Conclusion')}</div><div id="wb-solver-panel" class="wb-sp" role="tabpanel" aria-labelledby="wb-sv-${tab}">${body}</div>`;
  }
  function limitsMarkup(){
    const cs=S.cs||getCase(),items=[...cs.limits,...cs.notes.filter(n=>n!==WITHHELD)];
    if(S.evalParsed){for(const l of S.evalParsed.limits||[])items.push(l);}
    if(!items.length)return '';
    return H`<details class="wb-limits-d" data-key="limits"><summary>Limits and notes (${items.length})</summary><ul>${items.map(t=>H`<li>${t}</li>`)}</ul></details>`;
  }

  /* the log drawer bar (the body is kept by keyedPatch) */
  function drawerBarMarkup(){
    const L=S.log,open=L.step>0;
    const sum=S.link&&!S.link.ok?(S.link.local?'companion not reachable':'not available offline'):!S.runKey?'no run selected':L.withheld?logCount()+' · kinds only while a round runs':logCount()+' · Follow tail '+(L.follow?'on':'off');
    return H`<button type="button" class="wb-dtoggle" data-key="drawer-toggle" data-wb-act="drawer-toggle" aria-expanded="${open?'true':'false'}" aria-controls="wb-log"><span class="wb-caret" aria-hidden="true">${open?'▾':'▴'}</span><strong>Live logs</strong><span class="wb-dsum"> · ${sum}</span></button>${open?H`<span class="wb-dactions"><button type="button" class="wb-toggle" data-key="follow" data-wb-act="follow" aria-pressed="${L.follow?'true':'false'}">Follow tail</button><button type="button" data-key="log-clear" data-wb-act="log-clear">Clear</button><button type="button" data-key="log-copy" data-wb-act="log-copy">Copy</button></span>`:''}`;
  }
  /* ---------- painting: every region in its own try/catch, a Retry card when one fails ---------- */
  const REG={
    runBlock:{id:'wb-runblock',fn:runBlockMarkup},notes:{id:'wb-notes',fn:notesMarkup},import:{id:'wb-import',fn:importMarkup},tabs:{id:'wb-tabs',fn:tabsMarkup},
    files:{id:'wb-files',fn:filesMarkup},midHead:{id:'wb-mid-head',fn:midHeadMarkup,after:afterMidHead},midBody:{id:'wb-mid-body',fn:midBodyMarkup,after:afterMid},
    evidHead:{id:'wb-evid-head',fn:evidHeadMarkup},critNote:{id:'wb-crit-note',fn:critNoteMarkup},card:{id:'wb-card',fn:cardMarkup},solver:{id:'wb-solver',fn:solverMarkup},limits:{id:'wb-limits',fn:limitsMarkup},
    drawerBar:{id:'wb-drawer-bar',fn:drawerBarMarkup},logNote:{id:'wb-log-note',fn:logNoteMarkup}
  };
  const failCard=(name,e)=>H`<div class="wb-fail" role="alert"><p><strong>This part could not be drawn.</strong> ${msgOf(e)}</p><button type="button" data-key="retry-${name}" data-wb-act="retry" data-region="${name}">Retry</button></div>`;
  function paint(name){
    const r=REG[name],el=r&&$('#'+r.id);
    if(!el)return;
    let m;
    try{getCase();m=r.fn();}catch(e){m=failCard(name,e);}
    try{V.setHtml(el,m);if(r.after)r.after(el);}catch(e){try{el.innerHTML=String(failCard(name,e));}catch{/* nothing more to do */}}
  }
  function logNoteMarkup(){
    const L=S.log;
    if(!S.runKey)return H`<p class="wb-hint">Choose a run to read its log.</p>`;
    if(!linkOk())return H`<p class="wb-hint">The log needs the companion.</p>`;
    if(L.error)return H`<p class="wb-hint" role="alert">The log could not be read: ${L.error}</p>`;
    if(L.withheld)return H`<p class="wb-hint">${WITHHELD}: only the kind and tool name of each line are shown.</p>`;
    if(!L.lines.length)return H`<p class="wb-hint">${L.busy?'Reading the log...':L.done?'This run wrote no log lines.':'No log lines yet.'}</p>`;
    return '';
  }
  const kindWord=l=>l.kind==='tool'&&!l.tool?'tool result':l.kind;
  function logRow(l){return H`${l.at?H`<span class="wb-ll-at">${V.formatTime(l.at)}</span>`:''}<span class="wb-ll-n">${l.seq}</span><span class="wb-ll-k">${kindWord(l)}</span>${l.tool?H`<span class="wb-ll-t">${l.tool}</span>`:''}<span class="wb-ll-x">${typeof l.text==='string'&&l.text?l.text:l.chars!=null?plural(l.chars,'character'):''}</span>`;}
  function paintLog(){
    const el=$('#wb-log');
    if(!el)return;
    const lines=S.log.lines.slice(-DOM_LINES);
    try{
      const res=V.keyedPatch(el,lines,{key:l=>String(l.seq),render:logRow,attrs:()=>({class:'wb-ll'})});
      if(res===null)V.setHtml(el,H`${lines.map(l=>H`<div class="wb-ll" data-key="${l.seq}">${logRow(l)}</div>`)}`);
    }catch{/* the rows keep their last state */}
    paint('logNote');
    if(S.log.follow)scrollLog();
  }
  function paintDrawer(){paint('drawerBar');paintLog();}
  function paintCrit(){
    const el=$('#wb-crit');
    if(!el)return;
    const cs=S.cs||getCase(),rows=critRows(cs);
    try{
      const res=V.keyedPatch(el,rows,{key:c=>'c:'+c.id,render:critInner,attrs:(c,i)=>({role:'option','aria-selected':c.id===S.critId?'true':'false','aria-posinset':String(i+1),'aria-setsize':String(rows.length),class:'wb-crit-row st-'+c.status+(c.id===S.critId?' is-selected':'')})});
      if(res===null)V.setHtml(el,H`${rows.map(c=>H`<div role="option" class="wb-crit-row st-${c.status}${c.id===S.critId?' is-selected':''}" data-key="c:${c.id}" aria-selected="${c.id===S.critId?'true':'false'}">${critInner(c)}</div>`)}`);
    }catch{/* the rows keep their last state */}
    if(rows.length&&!opened())delA(el,'hidden');else setA(el,'hidden','');
    if(S.lb&&S.lb.el===el){S.lb.refresh();if(S.critId&&rows.some(c=>c.id===S.critId))S.lb.setActive('c:'+S.critId,{scroll:false});}
  }
  function syncRoot(){const r=$('#wb-root');if(!r)return;setA(r,'data-wb-pane',S.pane);setA(r,'data-wb-files',S.filesOpen?'open':'closed');setA(r,'data-wb-step',String(S.log.step));}
  function paintCases(){for(const n of ['files','midHead','midBody','runBlock','import','evidHead','critNote','card','solver','limits','tabs'])paint(n);paintCrit();paintChip();}
  function paintAll(){paint('notes');paintCases();paintDrawer();syncRoot();}

  /* ---------- marks that move without repainting a pane ---------- */
  const tagOf=el=>String(el&&el.tagName||'').toUpperCase();
  const locEls=body=>$$(body,'[data-wb-loc]').filter(el=>tagOf(el)!=='BUTTON');
  function applyLinked(){
    const set=linkedSet(fileOf());
    for(const el of locEls($('#wb-mid-body'))){const loc=getA(el,'data-wb-loc');setCls(el,'is-linked',!!loc&&set.has(loc));}
    paintChip();
  }
  function applyRec(){
    const f=fileOf(),loc=selLoc(f);
    for(const el of locEls($('#wb-mid-body'))){const on=!!loc&&getA(el,'data-wb-loc')===loc;setCls(el,'is-selected',on);if(getA(el,'role')==='option')setA(el,'aria-selected',on?'true':'false');}
  }
  function paintChip(){
    const chip=$('#wb-chip');
    if(!chip)return;
    const c=crit(),cl=c&&firstClause(c);
    if(!c||!cl){setA(chip,'hidden','');return;}
    const here=linkedSet(fileOf()).size>0;
    chip.textContent='Linked: '+trunc(c.text,44)+(here?'':' · '+baseName(cl.documentName));
    setA(chip,'title','Linked: '+c.text+' · '+cl.documentName+' · '+cl.locator);delA(chip,'hidden');
  }
  function scrollToLoc(loc){
    const el=locEls($('#wb-mid-body')).find(e=>getA(e,'data-wb-loc')===loc);
    try{if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest'});}catch{/* no scrolling here */}
  }
  function scrollToChange(i){
    const els=$$($('#wb-mid-body'),'[data-change]').filter(e=>getA(e,'data-change')===String(i));
    const el=els.find(e=>getA(e,'data-first')==='1')||els[0];
    try{if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest'});}catch{/* no scrolling here */}
  }
  /* the body is the panel of whichever of Source and Diff is showing */
  function afterMidHead(){
    const body=$('#wb-mid-body'),f=fileOf();
    if(body)setA(body,'aria-labelledby','wb-mt-'+(f?effectiveMode(f):'source'));
  }
  function afterMid(){
    const recs=$('#wb-recs');
    S.recLb=recs?V.bindListbox(recs,{label:'Records',onActivate:activateRec}):null;
    applyLinked();
    if(S.scrollChange){scrollToChange(S.changeIdx);S.scrollChange=false;}
    if(S.scrollTo){scrollToLoc(S.scrollTo);S.scrollTo='';}
  }

  /* ---------- choosing things ---------- */
  const fileByName=(name,sha)=>{const cs=S.cs||getCase();return cs.files.find(f=>f.name===name&&f.inPackage&&(!sha||f.sha256===sha))||cs.files.find(f=>f.name===name&&(!sha||f.sha256===sha))||cs.files.find(f=>f.name===name)||null;};
  const recIndex=(d,loc)=>{const recs=d&&d.records||[];for(let i=0;i<recs.length;i++)if(recs[i].locator===loc)return i;return -1;};
  const recOf=(f,loc)=>{const d=docOf(f);return {fileId:f.id,docId:d?d.id:'',name:f.name,sha256:d?d.sha256:f.sha256,locator:loc};};
  /* Bring a clause's file and record into view. Only a different file or page repaints the middle pane; the same page just moves marks. */
  function revealClause(cl,opts){
    const o=opts||{},f=fileByName(cl.documentName,cl.sha256);
    if(!f)return false;
    const d=docOf(f),i=d?recIndex(d,cl.locator):-1,page=i>=0?Math.floor(i/PAGE):0,moved=S.fileId!==f.id||S.page!==page;
    if(S.fileId!==f.id){S.changeIdx=-1;S.gotoMsg='';S.gotoHits=[];if(!o.select)S.rec=null;}
    S.fileId=f.id;S.page=page;S.scrollTo=cl.locator;
    if(o.select&&i>=0)S.rec=recOf(f,cl.locator);
    if(o.quiet)return true;
    if(moved){paint('files');paint('midHead');paint('midBody');}
    else{applyLinked();if(o.select)applyRec();scrollToLoc(cl.locator);S.scrollTo='';}
    return true;
  }
  /* Choosing a criterion (user: it opens its card and takes focus) marks its clause in the middle pane. */
  function pickCriterion(id,user){
    S.critId=id;
    if(user)S.critOpen=true;
    const c=crit(),cl=c&&firstClause(c);
    if(cl)revealClause(cl,{});
    paint('runBlock');paint('import');paint('evidHead');paint('critNote');paintCrit();paint('card');applyLinked();
    if(user){
      focusCard();
      if(c&&c.status==='not-met'&&S.log.lines.length&&S.log.step===0)setStep(1);
    }
  }
  function focusCard(){
    const pane=$('#wb-evid'),h=$('#wb-card-title');
    if(pane)pane.scrollTop=0;
    try{if(h&&typeof h.focus==='function')h.focus({preventScroll:true});}catch{/* no focus here */}
  }
  /* Back to the list: the criterion stays selected and takes the cursor. */
  function closeCard(){
    const id=S.critId;
    if(!S.critOpen)return;
    S.critOpen=false;
    paint('runBlock');paint('import');paint('evidHead');paint('critNote');paintCrit();paint('card');
    const list=$('#wb-crit'),pane=$('#wb-evid');
    if(pane)pane.scrollTop=0;
    try{if(list&&typeof list.focus==='function')list.focus({preventScroll:true});}catch{/* no focus here */}
    if(S.lb&&id)S.lb.setActive('c:'+id,{scroll:false});
    const row=$$(list,'[role="option"]').find(o=>getA(o,'data-key')==='c:'+id);
    try{if(row&&typeof row.scrollIntoView==='function')row.scrollIntoView({block:'nearest'});}catch{/* no scrolling here */}
  }
  /* Previous and next criterion, in the order of the list. */
  function stepCrit(delta){
    const cs=S.cs||getCase(),rows=critRows(cs),i=rows.findIndex(x=>x.id===S.critId),j=i+delta;
    if(i<0||j<0||j>=rows.length)return;
    S.critId=rows[j].id;
    const c=crit(),cl=c&&firstClause(c);
    if(cl)revealClause(cl,{});
    paint('evidHead');paintCrit();paint('card');applyLinked();
    const pane=$('#wb-evid');if(pane)pane.scrollTop=0;
    const st=ST[c.status]||ST.unknown;
    say('Criterion '+(j+1)+' of '+rows.length+': '+c.text+', '+st.word+'.');
  }
  function selectFile(id){
    if(!id)return;
    S.filesOpen=false;
    if(narrow())S.pane='diff';
    if(id!==S.fileId){S.fileId=id;S.page=0;S.rec=null;S.changeIdx=-1;S.gotoMsg='';S.gotoHits=[];S.scrollTo='';}
    syncRoot();paint('tabs');paint('files');paint('midHead');paint('midBody');paint('card');
  }
  function activateRec(key,opt){
    const f=fileOf();
    if(!f||!opt)return;
    if(getA(opt,'data-wb-expand')!==null){S.expanded[f.id+':'+getA(opt,'data-wb-expand')]=true;paint('midBody');return;}
    const loc=getA(opt,'data-wb-loc');
    if(!loc)return;
    S.rec=recOf(f,loc);applyRec();paint('card');
  }
  function gotoChange(delta){
    const cur=S.cur||{total:0,locs:[]},f=fileOf();
    if(!cur.total||!f)return;
    S.changeIdx=S.changeIdx<0?(delta>0?0:cur.total-1):V.clamp(S.changeIdx+delta,0,cur.total-1);
    const loc=cur.locs[S.changeIdx];
    if(loc)S.rec=recOf(f,loc);
    S.scrollChange=true;paint('midBody');paint('card');say('Change '+num(S.changeIdx+1)+' of '+num(cur.total)+(loc?': '+loc+'.':'.'));
  }
  function pickCell(a){
    const f=fileOf(),i=Number(getA(a,'data-change')),loc=getA(a,'data-wb-loc');
    if(!f||!loc)return;
    S.changeIdx=Number.isInteger(i)?i:-1;S.rec=recOf(f,loc);paint('midBody');paint('card');
  }
  function gotoLocator(){
    const f=fileOf(),d=f&&docOf(f),q=S.goto.trim();
    if(!d)return;
    S.gotoHits=[];
    if(!q){S.gotoMsg='Type a locator first.';paint('midBody');return;}
    const c=setup(),owner=docFrom(f)==='main'?mainPackage():c&&c.other;
    let idx=-1,msg='';
    if(owner&&E.resolveClause(owner,{documentId:d.id,locator:q}))idx=recIndex(d,q);
    if(idx<0){
      const low=q.toLowerCase(),exact=d.records.findIndex(r=>String(r.locator).toLowerCase()===low);
      if(exact>=0)idx=exact;
      else if(!q.includes('!')){
        const found=[];
        d.records.forEach((r,i)=>{if(String(r.locator).toLowerCase().endsWith('!'+low))found.push(i);});
        if(found.length===1)idx=found[0];
        else if(found.length>1)msg=q+' exists on '+plural(found.length,'sheet')+'. Type the sheet too, for example '+d.records[found[0]].locator+'.';
      }
    }
    if(idx<0){
      if(!msg&&q.length>=3&&owner){try{S.gotoHits=W.suggestClauses(owner,q,{limit:5});}catch{S.gotoHits=[];}}
      S.gotoMsg=msg||'No record in this file has the locator '+q+'.'+(S.gotoHits.length?' These records hold it as text:':'');
      paint('midBody');return;
    }
    const loc=d.records[idx].locator;
    S.page=Math.floor(idx/PAGE);S.rec=recOf(f,loc);S.scrollTo=loc;S.gotoMsg='Showing '+loc+'.';paint('midBody');paint('card');
  }
  function linkClause(){
    const c=crit(),r=S.rec,main=mainPackage();
    if(!c)return say('Select a criterion first.');
    if(!r||!main)return say('Select a record in the middle pane first.');
    const d=main.documents.find(x=>x.id===r.docId);
    if(!d)return say('That record is only in the changed package, so it was not linked.');
    if(!E.resolveClause(main,{documentId:d.id,sha256:d.sha256,locator:r.locator}))return say('That record cannot be resolved to exactly one record, so it was not linked.');
    const key=taskKey(),rec={taskKey:key,criterionId:c.id,documentName:d.name,sha256:d.sha256,locator:r.locator,linkedAt:new Date().toISOString()};
    let list=readLinks().filter(l=>!(l.criterionId===rec.criterionId&&l.documentName===rec.documentName&&l.locator===rec.locator&&taskKeyOf(l.taskKey)===key));
    list.push(rec);if(list.length>LINK_CAP)list=list.slice(-LINK_CAP);
    const ok=V.store.set(V.STORE_KEYS.links,list);
    invalidateCase();getCase();paint('card');applyLinked();
    say('Linked '+d.name+', '+r.locator+' to this criterion.'+(ok?'':' This browser did not allow saving it, so it lasts for this session only.'));
  }
  function unlinkClause(a){
    const c=crit(),doc=getA(a,'data-doc'),loc=getA(a,'data-loc'),key=taskKey();
    if(!c)return;
    V.store.set(V.STORE_KEYS.links,readLinks().filter(l=>!(l.criterionId===c.id&&l.documentName===doc&&l.locator===loc&&taskKeyOf(l.taskKey)===key)));
    invalidateCase();getCase();paint('card');applyLinked();say('Link removed.');
  }

  /* ---------- actions ---------- */
  function narrowTab(root,list,dir,key){
    const tabs=$$(root,'[role="tab"]');
    const i=tabs.findIndex(t=>t===list),n=tabs.length;
    if(i<0||!n)return false;
    const to=key==='Home'?0:key==='End'?n-1:V.clamp(i+dir,0,n-1),target=tabs[to];
    if(!target||target===list)return true;
    try{target.focus();}catch{/* no focus here */}
    if(getA(target,'aria-disabled')!=='true')try{target.click();}catch{/* synthetic */}
    return true;
  }
  const ACT={
    load(){const D=dash(),f=(S.ctx&&typeof S.ctx.loadFiles==='function'&&S.ctx.loadFiles)||(D&&typeof D.loadFiles==='function'&&D.loadFiles);if(f)f();else say('The file picker is not available here.');},
    retry(a){const r=getA(a,'data-region');if(REG[r])paint(r);},
    'retry-detail'(){S.detail='loading';paint('critNote');loadDetail(true);},
    'retry-runs'(){S.runsStatus='loading';paint('notes');loadRuns();},
    relink(){S.link=null;paint('notes');checkLink();},
    file(a){selectFile(getA(a,'data-id'));},
    dir(a){const d=getA(a,'data-dir');S.dirs[d]=S.dirs[d]===false;paint('files');},
    'changed-only'(){S.changedOnly=!S.changedOnly;paint('files');},
    mode(a){
      const m=getA(a,'data-mode');
      if(m==='diff'&&!S.diff)return say(S.diffError?'The comparison could not be made.':'Diff needs a changed package. Use Compare with a changed package.');
      S.mode=m==='diff'?'diff':'source';S.changeIdx=-1;paint('midHead');paint('midBody');
    },
    'solver-tab'(a){S.solverTab=getA(a,'data-tab')==='conclusion'?'conclusion':'answer';paint('solver');},
    'only-not-met'(){S.onlyNotMet=!S.onlyNotMet;saveLayout();paint('evidHead');paint('critNote');paintCrit();},
    'link-clause'(a){if(getA(a,'aria-disabled')==='true')return say(S.rec?'Load a task package first.':'Select a record in the middle pane first.');linkClause();},
    unlink(a){unlinkClause(a);},
    'open-loc'(a){revealClause({documentName:getA(a,'data-doc'),sha256:getA(a,'data-sha')||'',locator:getA(a,'data-loc')},{select:true});paint('card');},
    chip(){const c=crit(),cl=c&&firstClause(c);if(cl)revealClause(cl,{});},
    'crit-back'(){closeCard();},
    'crit-prev'(a){if(getA(a,'aria-disabled')!=='true')stepCrit(-1);},
    'crit-next'(a){if(getA(a,'aria-disabled')!=='true')stepCrit(1);},
    'prev-change'(){gotoChange(-1);},
    'next-change'(){gotoChange(1);},
    'pick-cell'(a){pickCell(a);},
    'page-prev'(){S.page=Math.max(0,S.page-1);S.rec=null;paint('midBody');paint('card');},
    'page-next'(){S.page+=1;S.rec=null;paint('midBody');paint('card');},
    goto(){gotoLocator();},
    pane(a){const p=getA(a,'data-pane');if(PANES.includes(p)){S.pane=p;syncRoot();paint('tabs');}},
    'step-back'(){const i=PANES.indexOf(S.pane);if(i>0){S.pane=PANES[i-1];syncRoot();paint('tabs');}},
    'step-next'(){const i=PANES.indexOf(S.pane);if(i<PANES.length-1){S.pane=PANES[i+1];syncRoot();paint('tabs');}},
    'files-toggle'(){
      S.filesOpen=!S.filesOpen;syncRoot();paint('midHead');
      if(S.filesOpen){const t=$('#wb-tree [tabindex="0"]');try{if(t)t.focus();}catch{/* no focus here */}}
    },
    'compare-load'(a){if(getA(a,'aria-disabled')==='true')return say('Load a task package first, then compare it with a changed one.');fileInput('compare','.zip,.xlsx,.xlsm,.docx,.txt,.md,.csv,.json,.html,.log',true,loadCompare);},
    'compare-clear'(){clearCompare();},
    'import-open'(){S.importOpen=!S.importOpen;S.importError='';paint('import');paint('runBlock');},
    'import-cancel'(){S.importOpen=false;S.importError='';S.evalPending=null;S.msgPending=null;S.evalFile='';S.msgFile='';paint('import');paint('runBlock');const b=$('[data-wb-act="import-open"]');try{if(b)b.focus();}catch{/* no focus here */}},
    'import-grading'(){fileInput('grading','.json,application/json',false,pickGrading);},
    'import-messages'(){fileInput('messages','.json,application/json',false,pickMessages);},
    'import-go'(a){if(getA(a,'aria-disabled')==='true'){S.importError='Choose the grading file first.';paint('import');return;}importEval();},
    'eval-remove'(){removeEval();},
    'drawer-toggle'(){setStep(S.log.step>0?0:S.log.restore);},
    follow(){S.log.follow=!S.log.follow;saveLayout();paint('drawerBar');if(S.log.follow)scrollLog();},
    'log-clear'(){S.log.lines=[];S.log.trimmed=false;paintDrawer();say('Log cleared.');},
    'log-copy'(){V.copyText(logText()).then(ok=>say(ok?'Copied the log lines.':'The browser did not allow copying.'));}
  };
  function onClick(e){
    if(!S.active)return;
    touch();
    const t=e&&e.target;
    if(!t||typeof t.closest!=='function')return;
    if(S.filesOpen&&!t.closest('#wb-files')&&!t.closest('.wb-files-btn')){S.filesOpen=false;syncRoot();paint('midHead');}
    if(!t.closest('#wb-root'))return;
    const a=t.closest('[data-wb-act]');
    if(!a||(getA(a,'disabled')!==null&&tagOf(a)==='BUTTON'))return;
    const fn=ACT[getA(a,'data-wb-act')];
    if(fn)try{fn(a,e);}catch(err){console.error('Evidence Workbench: '+msgOf(err));}
  }
  function onInput(e){
    if(!S.active)return;
    touch();
    const t=e&&e.target;
    if(!t||typeof t.closest!=='function'||!t.closest('#wb-root'))return;
    const kind=getA(t,'data-wb-in'),v=String(t.value==null?'':t.value);
    if(kind==='search'){
      S.q=v.trim().toLowerCase();paint('files');paint('critNote');paintCrit();
      const cs=S.cs||getCase();say(S.q?plural(cs.files.filter(fileVisible).length,'file')+' and '+plural(critRows(cs).length,'criterion','criteria')+' match.':'Search cleared.');
    }else if(kind==='goto')S.goto=v;
    else if(kind==='import-task')S.importTask=v;
  }
  function onChange(e){
    if(!S.active)return;
    touch();
    const t=e&&e.target;
    if(!t||typeof t.closest!=='function'||!t.closest('#wb-root'))return;
    if(getA(t,'data-wb-act')==='run')selectRun(String(t.value||''),{});
  }
  function onKeydown(e){
    if(!S.active||!e)return;
    touch();
    const t=e.target,key=e.key,inRoot=!!(t&&typeof t.closest==='function'&&t.closest('#wb-root'));
    if((e.ctrlKey||e.metaKey)&&!e.altKey&&String(key).toLowerCase()==='k'){
      const s=$('#wb-search');
      if(s){if(e.preventDefault)e.preventDefault();try{s.focus();if(s.select)s.select();}catch{/* no focus here */}}
      return;
    }
    if(!inRoot)return;
    if(key==='Escape'){
      if(S.filesOpen){S.filesOpen=false;syncRoot();paint('midHead');const b=$('.wb-files-btn');try{if(b)b.focus();}catch{/* no focus here */}}
      else if(S.importOpen&&t.closest('#wb-import')){ACT['import-cancel']();}
      else if(S.critOpen&&t.closest('#wb-evid')){if(e.preventDefault)e.preventDefault();closeCard();}
      else if(S.importOpen){ACT['import-cancel']();}
      else if(getA(t,'id')==='wb-search'&&S.q){t.value='';S.q='';paint('files');paint('critNote');paintCrit();}
      return;
    }
    if(getA(t,'data-wb-in')==='goto'&&key==='Enter'){if(e.preventDefault)e.preventDefault();gotoLocator();return;}
    if(getA(t,'id')==='wb-splitter'){
      const to=V.nextSplitterStep(S.log.step,key,{restore:S.log.restore});
      if(to!==null){if(e.preventDefault)e.preventDefault();setStep(to);}
      return;
    }
    const item=t.closest('[role="treeitem"]');
    if(item&&t.closest('[role="tree"]'))return treeKey(e,item);
    const tab=tagOf(t)==='BUTTON'&&getA(t,'role')==='tab'?t:null;
    if(tab){
      const dir=key==='ArrowRight'?1:key==='ArrowLeft'?-1:0;
      if(dir||key==='Home'||key==='End'){if(e.preventDefault)e.preventDefault();narrowTab(t.closest('[role="tablist"]'),tab,dir,key);}
    }
  }
  function treeKey(e,item){
    const items=$$(item.closest('[role="tree"]'),'[role="treeitem"]'),cur=items.indexOf(item),key=e.key;
    if(key==='Enter'||key===' '||key==='Spacebar'){if(e.preventDefault)e.preventDefault();const fn=ACT[getA(item,'data-wb-act')];if(fn)fn(item,e);return;}
    const model=items.map(el=>({level:Number(getA(el,'aria-level'))||1,expanded:getA(el,'aria-expanded')==='true'?true:getA(el,'aria-expanded')==='false'?false:undefined}));
    const r=V.nextTreeIndex(model,cur,key);
    if(!r)return;
    if(e.preventDefault)e.preventDefault();
    if(r.action==='move'){items.forEach((el,i)=>setA(el,'tabindex',i===r.index?'0':'-1'));try{items[r.index].focus();}catch{/* no focus here */}}
    else if(r.action==='expand'||r.action==='collapse'){const d=getA(items[r.index],'data-dir');if(d!==null){S.dirs[d]=r.action==='expand';paint('files');}}
  }
  function onPointerDown(e){
    if(!S.active||!e||(e.button!=null&&e.button!==0))return;
    const t=e.target;
    if(!t||getA(t,'id')!=='wb-splitter')return;
    const d=$('#wb-drawer');
    if(!d)return;
    if(e.preventDefault)e.preventDefault();
    S.log.drag=true;
    const move=ev=>{
      const h=d.getBoundingClientRect().bottom-ev.clientY,step=h<84?0:V.clamp(Math.round((h-120)/80)+1,1,STEP_MAX);
      if(step!==S.log.step)setStep(step);
    };
    const up=()=>{S.log.drag=false;document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',up);};
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',up);
  }
  function onScroll(e){
    const t=e&&e.target;
    if(!S.active||!t||getA(t,'id')!=='wb-log'||!S.log.follow)return;
    if(Number(t.scrollHeight)-Number(t.scrollTop)-Number(t.clientHeight)>24){S.log.follow=false;saveLayout();paint('drawerBar');}
  }

  /* ---------- timers ---------- */
  function tick(){
    if(!S.active||hidden())return;
    touch();
    const now=Date.now();
    if(!S.link){checkLink();return;}
    if(!linkOk()){if(S.link.local&&now-S.linkAt>10000)checkLink();return;}
    const busy=S.runsRedacted||S.runs.some(r=>r.state==='running'||r.state==='queued');
    if(now-S.runsAt>=(busy?RUNS_BUSY_MS:RUNS_IDLE_MS))loadRuns();
    const row=runRow(S.runKey);
    if(S.run&&(S.run.redacted||(S.round&&S.round.redacted)||(row&&(row.state==='running'||row.state==='queued')))&&now-S.detailAt>=RUNS_BUSY_MS)loadDetail(false);
    logTick();
  }
  function startTimer(){
    if(!S.timer)S.timer=setInterval(tick,TICK_MS);
    if(!S.stopVisible)S.stopVisible=V.onVisible(()=>{S.runsAt=0;S.log.at=0;tick();});
  }
  function stopTimer(){
    if(S.timer){clearInterval(S.timer);S.timer=null;}
    if(S.stopVisible){try{S.stopVisible();}catch{/* already stopped */}S.stopVisible=null;}
  }

  /* ---------- the page ---------- */
  function skeleton(){
    const r=name=>{let m;try{getCase();m=REG[name].fn();}catch(e){m=failCard(name,e);}const s=String(m);S.rendered[name]=s;return s;};
    const L=S.log;
    return `<div id="wb-root" class="wb-root" data-wb-pane="${esc(S.pane)}" data-wb-files="${S.filesOpen?'open':'closed'}" data-wb-step="${L.step}">${headMarkup()}<div id="wb-notes" class="wb-notes">${r('notes')}</div><div id="wb-tabs" class="wb-tabs">${r('tabs')}</div><div class="wb-body"><section id="wb-files" class="wb-pane wb-files" aria-label="Files" data-keep-scroll="files">${r('files')}</section><section id="wb-mid" class="wb-pane wb-mid" aria-label="Source and diff"><div class="wb-mid-top"><div id="wb-mid-head" class="wb-mid-head">${r('midHead')}</div><button type="button" id="wb-chip" class="wb-chip" data-wb-act="chip" hidden></button></div><div id="wb-mid-body" class="wb-mid-body" role="tabpanel" aria-labelledby="wb-mt-source" data-keep-scroll="mid">${r('midBody')}</div></section><section id="wb-evid" class="wb-pane wb-evid" aria-label="Evidence" data-keep-scroll="evid"><div id="wb-runblock" class="wb-runblock">${r('runBlock')}</div><div id="wb-import" class="wb-importhost">${r('import')}</div><div id="wb-evid-head">${r('evidHead')}</div><div id="wb-crit" class="wb-crit" hidden></div><div id="wb-crit-note">${r('critNote')}</div><div id="wb-card">${r('card')}</div><div id="wb-solver" class="wb-solverbox">${r('solver')}</div><div id="wb-limits">${r('limits')}</div></section></div><section id="wb-drawer" class="wb-drawer ${V.stepClass(L.step,STEP_MAX+1)}" role="region" aria-label="Live logs"><div id="wb-splitter" class="wb-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize live logs" aria-controls="wb-log" aria-valuemin="0" aria-valuemax="${STEP_MAX}" aria-valuenow="${L.step}" aria-valuetext="${stepWord(L.step)}" tabindex="0"></div><div id="wb-drawer-bar" class="wb-drawer-bar">${r('drawerBar')}</div><div id="wb-log-note" class="wb-log-note">${r('logNote')}</div><div id="wb-log" class="wb-log" role="log" aria-live="off" aria-label="Log lines" tabindex="0" data-keep-scroll="log"></div></section><div id="wb-live" class="wb-live"></div><p id="wb-status" class="sr-only" role="status" aria-live="polite"></p></div>`;
  }
  let layoutLoaded=false;
  function render(ctx){
    touch();
    if(ctx)S.ctx=ctx;
    if(!layoutLoaded){layoutLoaded=true;loadLayout();}
    S.rendered={};
    return skeleton();
  }
  function install(){
    if(S.listening)return;
    S.listening=true;
    document.addEventListener('click',onClick);document.addEventListener('input',onInput);document.addEventListener('change',onChange);
    document.addEventListener('keydown',onKeydown);document.addEventListener('pointerdown',onPointerDown);document.addEventListener('scroll',onScroll,true);
  }
  function afterRender(active){
    if(!active){S.active=false;stopTimer();if(S.live){try{S.live.destroy();}catch{/* gone */}S.live=null;}return;}
    S.active=true;install();touch();
    if(!$('#wb-root'))return;
    for(const name of Object.keys(S.rendered)){const el=$('#'+REG[name].id);if(el&&el.vkHtml==null)el.vkHtml=S.rendered[name];}
    S.rendered={};
    if(S.live){try{S.live.destroy();}catch{/* gone */}}
    S.live=V.announcer($('#wb-live'));
    S.lb=V.bindListbox($('#wb-crit'),{label:'Criteria',onActivate:key=>pickCriterion(String(key).slice(2),true)});
    paintAll();
    if(!S.link)checkLink();
    else if(linkOk()){if(S.pending||S.runsStatus!=='ready'||Date.now()-S.runsAt>RUNS_IDLE_MS)loadRuns();if(S.log.key&&!S.log.lines.length&&!S.log.done&&!S.log.busy)logFetch(true);}
    startTimer();
  }
  /* Mission Control calls this before it navigates here; the selection is applied once the run list is fresh. */
  function open(sel){
    const s=isObj(sel)?sel:{};
    if(typeof s.roundId!=='string'||!/^[a-z0-9-]{4,64}$/.test(s.roundId)||!Number.isInteger(s.n)||s.n<1||s.n>99)return false;
    S.pending={roundId:s.roundId,n:s.n,criterionId:typeof s.criterionId==='string'?s.criterionId.slice(0,300):'',at:Date.now(),retried:false};
    if(S.active&&linkOk())loadRuns();
    return true;
  }
  window.FinanceWorkbench={render,afterRender,open};
})();
