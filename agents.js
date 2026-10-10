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
  const DEFAULT_PROMPT_WORDS=60;      /* the shipped-format limit in core.js; used only when the project is not available */
  const PACKAGE_DIGEST_CHARS=90000;   /* the companion refuses a review prompt over 120 KiB */
  const ID_RE=/^[a-z0-9-]{4,64}$/;
  const FINGERPRINT_ID_RE=/^[a-z0-9-]{2,40}$/;
  const ACKNOWLEDGEMENTS=[
    {id:'shell-access',label:'Shell access as me',text:'Each pilot is a Claude Code agent that can run shell commands as my user account on this computer.'},
    {id:'network',label:'Network use by the agent runtime',text:'The agent runtime (the claude program) sends the packet files and the prompt to Anthropic over the network. This page itself only talks to the companion on this computer.'},
    {id:'isolation-by-audit',label:'Isolation by audit only',text:'There is no operating system sandbox. Pilots are told to stay inside their own folder and every tool call is checked afterwards. A call outside the folder discards that run. It is detected, not blocked.'}
  ];
  const ISOLATION_STATEMENT='Isolation is by instruction and audit, not by an operating system sandbox. A pilot is a Claude Code agent with shell access, running as you. Any read or write outside its own folder is detected after the fact and the run is marked DISCARDED. It is not blocked.';
  const SHELL_STATEMENT='Each pilot can run shell commands as your user account on this computer.';
  const NETWORK_STATEMENT='The agent runtime (the claude program) contacts Anthropic over the network. This page only talks to the companion on this computer.';
  const GAF_SENTENCE='Matches production only if the production solver sees this file.';
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
    'bare-cd':'cd with no argument moves to the home directory.'
  });
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
    config:{model:'',effort:'',count:1},
    fz:{decision:'',notes:'',figures:[blankFigure()],fingerprints:[blankFingerprint(1)],errors:[]},
    rounds:[],
    roundId:null,
    round:null,
    sigs:{},                 // round id -> input signature at creation, to flag a freeze that no longer matches the form
    commands:{},             // round id -> the command line (prompt elided) the companion showed at approval
    working:'',
    overlay:null,
    returnKey:null,
    msg:{text:'',error:false},
    timer:null,
    mounted:false
  };
  function blankFigure(){return {label:'',value:'',tolerance:''};}
  function blankFingerprint(n){return {id:'fp-'+n,label:'',tokens:'',figures:[]};}

  /* ---------- Small helpers ---------- */
  const isLocal=()=>location.protocol==='http:'&&location.hostname==='127.0.0.1';
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
  function elapsedText(run){
    const start=Date.parse(run.startedAt);
    if(!Number.isFinite(start))return '-';
    const end=run.endedAt?Date.parse(run.endedAt):Date.now();
    const seconds=Math.max(0,Math.round(((Number.isFinite(end)?end:Date.now())-start)/1000));
    return Math.floor(seconds/60)+'m '+String(seconds%60).padStart(2,'0')+'s';
  }
  const shortHash=h=>String(h||'').slice(0,12);
  /* The same pattern the companion uses to decide which files belong to the gaf folder (GAF_RE in backend/agents/pilot-folder.cjs;
     tests/agents-page.test.cjs checks that the two stay identical). A name such as gaf-hedge.csv counts, not only a gaf/ folder. */
  const isGaf=path=>/(?:^|[/_ -])gaf(?:[/_. -]|$)/i.test(String(path));
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
      defaultModel:pickDefault(models,'claude-opus-5-5'),defaultEffort:pickDefault(efforts,'medium')};
  }
  async function loadStatus(){
    const data=await api('GET','/api/status');
    S.nonce=typeof data.nonce==='string'?data.nonce:'';
    S.status=normalizeStatus(data);
    const ids=list=>list.map(c=>c.id);
    if(!ids(S.status.models).includes(S.config.model))S.config.model=S.status.defaultModel;
    if(!ids(S.status.efforts).includes(S.config.effort))S.config.effort=S.status.defaultEffort;
    S.config.count=Math.min(Math.max(1,S.config.count),S.status.max);
  }
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
  const SECTIONS={runtime:runtimeHtml,packet:packetHtml,freeze:freezeHtml,round:roundHtml,runs:runsHtml};
  function paintSection(name){setHtml($('#ag-'+name),SECTIONS[name]());}
  function paintAll(){if(S.phase==='ready')Object.keys(SECTIONS).forEach(paintSection);}
  function paintRoot(){setHtml($('#ag-root'),pageInner(),true);}
  function paintOverlay(){setHtml($('#agents-modal'),overlayHtml());}
  /* The gate and the freeze state live inside the round and freeze cards. Repainting them leaves the parent's cached markup out of date, so clear it. */
  function gates(){
    if(S.phase!=='ready')return;
    const gate=$('#ag-gate'),state=$('#ag-freeze-state');
    if(gate){setHtml(gate,gateHtml());const card=$('#ag-round');if(card)card.agHtml=null;}
    if(state){setHtml(state,freezeStateHtml());const card=$('#ag-freeze');if(card)card.agHtml=null;}
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
    return html`
      <div class="dash-heading"><div><div class="eyebrow">Local agents</div><h1>Run blind pilots on your packet.</h1><p>Start Claude Code agents on this computer, one folder per pilot, then read what they did and classify the answers against a gold written before any output. Nothing starts until you approve a round. Results are directional. No rate or difficulty is computed.</p></div></div>
      <div id="ag-status" class="ag-status ${S.msg.error?'error':''}" role="status" aria-live="polite" aria-atomic="true">${S.msg.text}</div>
      <section class="card" id="ag-runtime" aria-label="Runtime">${runtimeHtml()}</section>
      <section class="card" id="ag-packet" aria-label="Packet">${packetHtml()}</section>
      <section class="card" id="ag-freeze" aria-label="Freeze">${freezeHtml()}</section>
      <section class="card" id="ag-round" aria-label="Round">${roundHtml()}</section>
      <section class="card" id="ag-runs" aria-label="Runs">${runsHtml()}</section>`;
  }

  /* 1. Runtime */
  function runtimeHtml(){
    const rt=S.status.runtime;
    if(rt.found){
      return html`<div class="card-title"><div><div class="eyebrow">1 Runtime</div><h2>Claude Code was found</h2></div>${pill('Found','green')}</div>
        <dl class="history-details"><dt>Version</dt><dd>${rt.version||'unknown'}</dd><dt>Path</dt><dd>${rt.path||'unknown'}</dd><dt>Found by</dt><dd>${rt.source||'unknown'}</dd><dt>Pilot limit</dt><dd>At most ${S.status.max} per round</dd></dl>
        <p class="footnote">Detection only runs claude --version. It never starts a model.</p>
        <div class="actions"><button type="button" class="small" data-ag="check-runtime" data-ag-key="check-runtime">Check again</button></div>`;
    }
    return html`<div class="card-title"><div><div class="eyebrow">1 Runtime</div><h2>Claude Code was not found</h2></div>${pill('Not found','amber')}</div>
      <div class="notice">Pilots need the claude command. Install Claude Code and sign in from your own terminal, or set CLAUDE_BIN to its path before running npm start, then check again. Nothing here will install or sign in for you.</div>
      <div class="actions"><button type="button" class="small" data-ag="check-runtime" data-ag-key="check-runtime">Check again</button></div>`;
  }

  /* 2. Packet */
  function packetHtml(){
    const p=S.packet,files=p.files,included=files?files.filter(effectiveInclude).length:0,gafCount=files?files.filter(f=>isGaf(f.path)).length:0;
    const words=wordsOf(S.prompt),limit=promptLimit();
    return html`<div class="card-title"><div><div class="eyebrow">2 Packet</div><h2>Choose the solver files and prompt</h2></div>${files?pill(included+' of '+files.length+' files included','green'):pill('Not inspected')}</div>
      <p class="muted">Enter a folder on this computer. The companion lists its regular files (no symlinks). Nothing is copied anywhere until you launch a round, and each pilot gets only the files ticked below. Inside its own folder a pilot finds them under <code>./filesystem/</code>, with the folder structure kept, so choose the folder that is the production <code>filesystem</code> folder itself.</p>
      <div class="ag-row"><label class="field ag-grow">Folder path<input type="text" id="ag-dir" data-ag-in="dir" data-ag-key="dir" value="${p.dir}" maxlength="1024" autocomplete="off" spellcheck="false" placeholder="/path/to/solver-packet"></label><button type="button" class="primary" data-ag="inspect" data-ag-key="inspect" data-ag-lock ${locked()?'disabled':''}>Inspect</button></div>
      ${p.error?html`<div class="notice" role="alert">${p.error}</div>`:''}
      ${files&&files.some(f=>/^filesystem\//.test(f.path))?html`<div class="notice" role="status"><strong>This folder already holds a filesystem/ folder.</strong> Pilots would see ./filesystem/filesystem/..., which is not the production layout. Choose the filesystem folder itself, or go on if this nesting is what you want.</div>`:''}
      ${files?filesTableHtml(files):html`<div class="empty">No folder inspected yet.</div>`}
      <label class="field">Solver prompt<textarea id="ag-prompt" data-ag-in="prompt" data-ag-key="prompt" rows="6" maxlength="20000" spellcheck="true">
${S.prompt}</textarea></label>
      <div class="ag-row"><p id="ag-wordcount" class="ag-count ${words>limit?'over':''}">${wordsText(words,limit)}</p><button type="button" class="small" data-ag="use-project-prompt" data-ag-key="use-project-prompt">Use the project prompt</button></div>
      <label class="check"><input type="checkbox" data-ag-in="gaf" data-ag-key="gaf" ${p.gafVisible?'checked':''}><span><strong>The solver can see the gaf/ folder${files?' ('+gafCount+(gafCount===1?' file':' files')+' in this packet)':''}</strong>${GAF_SENTENCE}</span></label>`;
  }
  const wordsText=(words,limit)=>words+' words. Project limit '+limit+(words>limit?'. Over the limit.':'.');
  function effectiveInclude(f){return f.include&&!f.excluded&&(S.packet.gafVisible||!isGaf(f.path));}
  function filesTableHtml(files){
    if(!files.length)return html`<div class="empty">The folder has no regular files.</div>`;
    return html`<div class="table-wrap"><table class="ag-table"><caption class="sr-only">Files in the packet folder</caption><thead><tr><th scope="col">Include</th><th scope="col">File</th><th scope="col">Role</th><th scope="col">Size</th><th scope="col">Note</th></tr></thead><tbody>${files.map((f,i)=>{
      const hidden=isGaf(f.path)&&!S.packet.gafVisible,unusable=!!f.excluded,override=f.include&&!hidden&&!unusable&&!f.defaultInclude;
      return html`<tr><td data-label="Include"><label class="check ag-include"><input type="checkbox" data-ag-in="include" data-i="${i}" data-ag-key="inc-${i}" ${f.include&&!hidden&&!unusable?'checked':''} ${hidden||unusable?'disabled':''} aria-label="${(f.defaultInclude?'Include ':'Include anyway, override: ')+f.path}">${f.defaultInclude?'':html`<small>override</small>`}</label></td>
        <td data-label="File"><code class="ag-path">${f.path}</code>${override?pill('Override','amber'):''}${hidden?pill('Hidden: gaf/ is off'):''}${unusable?pill('Cannot be used','amber'):''}</td>
        <td data-label="Role">${f.role}</td><td data-label="Size">${bytesText(f.bytes)}</td><td data-label="Note">${f.reason||(f.defaultInclude?'':'Excluded by default')}</td></tr>`;
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

  /* 3. Freeze */
  function freezeHtml(){
    const f=S.fz;
    return html`<div class="card-title"><div><div class="eyebrow">3 Freeze</div><h2>Freeze the gold before any run</h2></div></div>
      <p class="muted">Write down what a correct answer says and which wrong answers you expect, before you see any output. Freezing stores a hash and a time stamp. It also fixes the packet, prompt and settings for this round: change any of them afterwards and you must freeze again, which creates a new round.</p>
      <label class="field">Gold decision keywords or phrase<input type="text" data-ag-in="decision" data-ag-key="decision" value="${f.decision}" maxlength="500" autocomplete="off" placeholder="What a correct answer must say, as typed"><small>Separate alternatives with a semicolon; any one of them counts. Used only for the heuristic suggestion. You make the final call on every run.</small></label>
      <h3>Gold figures</h3>
      <div class="ag-figlist">${f.figures.map((fig,j)=>figureRowHtml('gfig',0,j,fig,'gold figure'))}</div>
      <div class="actions"><button type="button" class="small" data-ag="add-gfig" data-ag-key="add-gfig">Add a gold figure</button></div>
      <label class="field">Gold notes (optional)<textarea data-ag-in="notes" data-ag-key="notes" rows="3" maxlength="4000">
${f.notes}</textarea></label>
      <h3>Fingerprints of expected wrong answers</h3>
      <div class="ag-fplist">${f.fingerprints.map((fp,i)=>fingerprintHtml(fp,i))}</div>
      <div class="actions"><button type="button" class="small" data-ag="add-fp" data-ag-key="add-fp">Add a fingerprint</button></div>
      <div id="ag-freeze-state">${freezeStateHtml()}</div>`;
  }
  function figureRowHtml(kind,i,j,fig,word){
    const base=`${kind}-${i}-${j}`;
    return html`<div class="ag-figrow">
      <label class="field">Label<input type="text" data-ag-in="fig" data-kind="${kind}" data-i="${i}" data-j="${j}" data-f="label" data-ag-key="${base}-label" value="${fig.label}" maxlength="120" autocomplete="off"></label>
      <label class="field">Value<input type="text" inputmode="decimal" data-ag-in="fig" data-kind="${kind}" data-i="${i}" data-j="${j}" data-f="value" data-ag-key="${base}-value" value="${fig.value}" maxlength="40" autocomplete="off"></label>
      <label class="field">Tolerance<input type="text" inputmode="decimal" data-ag-in="fig" data-kind="${kind}" data-i="${i}" data-j="${j}" data-f="tolerance" data-ag-key="${base}-tolerance" value="${fig.tolerance}" maxlength="40" autocomplete="off" placeholder="0"></label>
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
    return html`${S.fz.errors.length?html`<div class="notice" role="alert"><strong>Fix before freezing</strong><ul class="plain-list">${S.fz.errors.map(e=>html`<li>${e}</li>`)}</ul></div>`:''}
      ${fr?versions.map(v=>html`<div class="notice neutral"><strong>${v.postHoc?'Post-hoc freeze version ':'Frozen '}${v.version?'(version '+v.version+')':''}</strong>
        <dl class="history-details"><dt>Round</dt><dd>${r.id}</dd><dt>${v.postHoc?'Saved at':'Frozen at'}</dt><dd>${timeText(v.frozenAt)}</dd><dt>Freeze SHA-256</dt><dd>${v.sha256}</dd>${v.postHoc?html`<dt>Label</dt><dd>Post-hoc: written after launch, stored beside the original freeze</dd>`:''}</dl></div>`):html`<p class="muted">No freeze record for the selected round. Launch stays disabled until the gold is frozen.</p>`}
      ${stale?html`<div class="notice" role="status">The packet, prompt, settings or gold on this page no longer match the freeze of round ${r.id}. Freeze again to create a new round.</div>`:''}
      <div class="actions"><button type="button" class="primary" data-ag="freeze" data-ag-key="freeze" data-ag-lock ${locked()||(fr&&!afterDraft&&!stale)?'disabled':''}>${fr&&!afterDraft&&!stale?'Gold is frozen':fr?'Freeze again (new round)':'Freeze gold'}</button>
      ${wasLaunched&&fr?html`<button type="button" data-ag="refreeze" data-ag-key="refreeze" data-ag-lock ${locked()?'disabled':''}>Save a post-hoc freeze version</button>`:''}</div>
      ${wasLaunched&&fr?html`<p class="footnote">A post-hoc version is stored beside the original, labelled post-hoc. It never replaces the original freeze. Fingerprints it adds can be chosen when you classify a run.</p>`:''}`;
  }
  function cleanFigure(fig,name,errors){
    const label=String(fig.label||'').trim();
    const value=Number(String(fig.value||'').replace(/[,\s]/g,''));
    const toleranceText=String(fig.tolerance||'').replace(/[,\s]/g,'');
    const tolerance=toleranceText===''?0:Number(toleranceText);
    if(!label)errors.push(name+' needs a label.');
    if(String(fig.value||'').trim()===''||!Number.isFinite(value))errors.push(name+' needs a numeric value.');
    if(!Number.isFinite(tolerance)||tolerance<0)errors.push(name+' has a tolerance that is not a number of zero or more.');
    return {label,value,tolerance};
  }
  const blankFig=fig=>!String(fig.label||'').trim()&&!String(fig.value||'').trim()&&!String(fig.tolerance||'').trim();
  const blankFp=fp=>!String(fp.label||'').trim()&&!String(fp.tokens||'').trim()&&fp.figures.every(blankFig)&&/^fp-\d+$/.test(String(fp.id||'').trim());
  function buildFreeze(){
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
    return {gold,fingerprints,errors};
  }
  function freezeContent(){
    const trimmed=fig=>({label:String(fig.label).trim(),value:String(fig.value).trim(),tolerance:String(fig.tolerance).trim()});
    return {decision:S.fz.decision.trim(),notes:S.fz.notes.trim(),figures:S.fz.figures.filter(f=>!blankFig(f)).map(trimmed),
      fingerprints:S.fz.fingerprints.filter(fp=>!blankFp(fp)).map(fp=>({id:fp.id.trim(),label:fp.label.trim(),tokens:lines(fp.tokens),figures:fp.figures.filter(f=>!blankFig(f)).map(trimmed)}))};
  }
  function inputSig(){
    const files=S.packet.files||[];
    return JSON.stringify({dir:S.packet.inspectedDir,include:files.filter(effectiveInclude).map(f=>f.path),prompt:S.prompt.trim(),gaf:S.packet.gafVisible,
      model:S.config.model,effort:S.config.effort,count:S.config.count,freeze:freezeContent()});
  }
  function isStale(round){
    const sig=S.sigs[round.id];
    return !!sig&&sig!==inputSig();
  }
  function preflight(){
    const errors=[],p=S.packet;
    if(!p.files)errors.push('Inspect a packet folder first.');
    else{
      if(p.dir.trim()!==p.inspectedDir)errors.push('The folder path changed after it was inspected. Inspect it again.');
      if(!p.files.some(effectiveInclude))errors.push('Include at least one file in the packet.');
    }
    if(!S.prompt.trim())errors.push('Write the solver prompt.');
    return errors;
  }
  function roundBody(){
    const files=(S.packet.files||[]).filter(effectiveInclude);
    return {label:S.label.trim()||'Pilot round',sourceDir:S.packet.inspectedDir,include:files.map(f=>f.path),overrides:files.filter(f=>!f.defaultInclude).map(f=>f.path),
      promptText:S.prompt,gafVisible:S.packet.gafVisible,config:{kind:'pilot',model:S.config.model,effort:S.config.effort,count:S.config.count}};
  }

  /* 4. Round */
  function roundHtml(){
    const st=S.status,cfg=S.config;
    return html`<div class="card-title"><div><div class="eyebrow">4 Round</div><h2>Model, effort and pilots</h2></div>${S.round?pill('Round '+S.round.id+' · '+(S.round.status||'draft'),S.round.status==='frozen'?'green':''):pill('No round yet')}</div>
      <div class="field-row three">
        <label class="field">Model<select data-ag-in="model" data-ag-key="model">${st.models.map(m=>html`<option value="${m.id}" ${m.id===cfg.model?'selected':''}>${m.id}</option>`)}</select></label>
        <label class="field">Effort<select data-ag-in="effort" data-ag-key="effort">${st.efforts.map(m=>html`<option value="${m.id}" ${m.id===cfg.effort?'selected':''}>${m.id}</option>`)}</select></label>
        <div class="field"><span id="ag-count-label">Pilots (1 to ${st.max})</span><div class="ag-stepper" role="group" aria-labelledby="ag-count-label">
          <button type="button" class="small" data-ag="count-dec" data-ag-key="count-dec" aria-label="Fewer pilots" ${cfg.count<=1?'disabled':''}>-</button>
          <input type="number" id="ag-count" data-ag-in="count" data-ag-key="count" min="1" max="${st.max}" step="1" value="${cfg.count}" aria-labelledby="ag-count-label">
          <button type="button" class="small" data-ag="count-inc" data-ag-key="count-inc" aria-label="More pilots" ${cfg.count>=st.max?'disabled':''}>+</button></div></div>
      </div>
      <label class="field">Round label (optional)<input type="text" data-ag-in="label" data-ag-key="label" value="${S.label}" maxlength="120" autocomplete="off" placeholder="Pilot round"></label>
      <div class="notice"><strong>Read this before you launch</strong><ul class="plain-list"><li>${SHELL_STATEMENT}</li><li>${ISOLATION_STATEMENT}</li><li>${NETWORK_STATEMENT}</li><li>Each pilot works in its own folder holding only the files you ticked, an empty outputs folder and an empty scratch folder.</li></ul></div>
      <div id="ag-gate">${gateHtml()}</div>`;
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
    return html`<p class="${gate.ok?'muted':'ag-why'}">${gate.ok?(gate.resume?'Round '+S.round.id+' is approved but not launched.':'Round '+S.round.id+' is frozen and ready for your approval. Nothing runs until you approve it in the next step.'):gate.why}</p>
      <div class="actions"><button type="button" class="primary" data-ag="open-approve" data-ag-key="open-approve" data-ag-lock ${gate.ok&&!locked()?'':'disabled'}>${gate.resume?'Review and launch':'Review and approve'}</button></div>`;
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
  function stateBadge(run){
    const kind=run.state==='completed'?'green':run.state==='failed'||run.state==='cancelled'?'amber':'';
    return pill(run.state||'unknown',kind);
  }
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
    return html`<div class="card-title"><div><div class="eyebrow">5 Runs</div><h2>Pilots and what they did</h2></div>${r?pill((r.status||'draft'),r.status==='finished'?'green':''):''}</div>
      ${options?html`<label class="field">Round<select data-ag-in="select-round" data-ag-key="select-round">${r?'':html`<option value="" selected>Choose a round</option>`}${S.rounds.map(x=>html`<option value="${x.id}" ${r&&x.id===r.id?'selected':''}>${(x.label||'Round')+' · '+x.id+' · '+(x.status||'')+' · '+timeText(x.createdAt)}</option>`)}</select></label>`:''}
      ${r&&r.note?html`<div class="notice" role="status" id="ag-round-note"><strong>Note on this round:</strong> ${r.note}${/companion stopped/.test(r.note)?' Pilots that were interrupted show as failed and were not audited. A pilot process may still be running if the companion was killed without a chance to stop it. Start a new round to run them again.':''}</div>`:''}
      <div class="notice neutral" id="ag-banner"><strong>Directional only, n = ${n}.</strong> No rate or difficulty is computed.
        <div class="ag-counts">Completed and clean: ${t.clean} (directional only, n = ${n}) · Discarded: ${t.discarded} · Failed: ${t.failed} · Cancelled: ${t.cancelled} · Still running: ${t.active}</div>
        ${t.classified?html`<div class="ag-counts">Your verdicts so far (directional only, n = ${n}): ${VERDICTS.map(v=>verdictLabel(v.id)+' '+(t.verdicts[v.id]||0)).join(' · ')}</div>`:''}
        ${t.discarded?html`<div class="ag-counts">Discarded runs are kept and shown, but they are not classified and not counted in the export.</div>`:''}</div>
      ${runs.length?runsTableHtml(runs):html`<div class="empty">${r?'No pilots have started in this round yet.':'No round selected. Freeze the gold to create one.'}</div>`}
      <div class="actions">${r&&['approved','running'].includes(r.status)?html`<button type="button" class="danger" data-ag="cancel-round" data-ag-key="cancel-round" data-ag-lock ${locked()?'disabled':''}>Cancel round</button>`:''}
        <button type="button" data-ag="open-grader" data-ag-key="open-grader" ${graderRuns().length?'':'disabled'}>Simulated grader…</button>
        <button type="button" data-ag="open-review" data-ag-key="open-review" ${packageDocuments().length?'':'disabled'}>Author review…</button></div>
      <p class="footnote">The simulated grader and the author review each ask for their own approval and use no tools. The grader is a simulation, not Studio grading, and it needs a completed pilot with a clean audit. The author review needs a task package loaded on the Overview page.</p>
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
  const packageDocuments=()=>S.ctx.package&&Array.isArray(S.ctx.package.documents)?S.ctx.package.documents:[];
  const graderRuns=()=>runsOf(S.round).filter(run=>run.state==='completed'&&auditStatus(run)==='CLEAN');

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
    const summary=round.approvalSummary||round.summary||(round.approval&&round.approval.summary)||null;
    const hash=round.summarySha256||round.approvalSummarySha256||(summary&&(summary.summarySha256||summary.sha256))||'';
    return {summary:summary&&typeof summary==='object'?summary:null,hash:typeof hash==='string'?hash:''};
  }
  function documentedCommand(cfg){
    const tools=(cfg.tools&&cfg.tools.length?cfg.tools:['Bash','Read','Write','Edit','Glob','Grep']).join(',');
    return ['claude','-p','<prompt elided>','--model',cfg.model||'?','--effort',cfg.effort||'?','--output-format','stream-json','--verbose','--tools',tools,'--allowedTools',tools,
      '--permission-mode','acceptEdits','--disable-slash-commands','--strict-mcp-config','--setting-sources','','--no-session-persistence'].map((x,i,all)=>x==='<prompt elided>'?x:shellQuote(x)).join(' ');
  }
  function commandLineFor(summary,round){
    const given=summary&&(summary.commandLine||summary.command);
    if(typeof given==='string'&&given)return {text:given,source:'companion'};
    const argv=summary&&Array.isArray(summary.argv)?summary.argv:null;
    if(argv&&argv.length)return {text:argv.map(a=>shellQuote(String(a))).join(' '),source:'companion'};
    return {text:documentedCommand(round.config||{}),source:'documented'};
  }
  /* The prompt as stored with the round, cut for display only; the hash shown beside it covers the whole text. */
  function promptShown(packet){
    const text=typeof packet.promptText==='string'?packet.promptText:'';
    if(!text)return '(the companion did not send the prompt text)';
    return text.length>4000?text.slice(0,4000)+'\n... ('+text.length+' characters in all; the hash covers all of them)':text;
  }
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
    return dialogFrame('Approve and launch this round',html`
      <p class="muted">You are approving exactly what is shown here. Nothing has started. The companion checks that this summary still matches before it runs anything.</p>
      <dl class="history-details"><dt>Round</dt><dd>${round.id}</dd><dt>Model</dt><dd>${model}</dd><dt>Effort</dt><dd>${effort}</dd><dt>Pilots</dt><dd>${count} (at most ${S.status.max})</dd>
        <dt>Tools</dt><dd>${Array.isArray(tools)?tools.join(', '):'Bash, Read, Write, Edit, Glob, Grep'}</dd>
        <dt>Working folder</dt><dd>${s.workingFolder||s.folder||'One new folder per pilot, outside this project, under the system temporary folder'}</dd>
        <dt>Packet SHA-256</dt><dd>${s.packetSha256||packet.packetSha256||'not reported'}</dd><dt>Freeze SHA-256</dt><dd>${s.freezeSha256||freeze.sha256||'not reported'}</dd>
        <dt>gaf/ visible</dt><dd>${(s.gafVisible!==undefined?s.gafVisible:packet.gafVisible)?'Yes':'No'}</dd>
        <dt>Overridden files</dt><dd>${overrides.length?overrides.map(p=>html`<code class="ag-path">${p}</code> `):'None'}</dd>
        <dt>Summary SHA-256</dt><dd>${o.hash||'not provided by the companion'}</dd></dl>
      <h3>Prompt</h3>
      <pre class="ag-final" tabindex="0" aria-label="The prompt every pilot receives">${promptShown(packet)}</pre>
      <p class="footnote">Prompt SHA-256 <span class="hash">${packet.promptSha256||'not reported'}</span>. Every pilot gets this text after a short fixed lead-in that points to ./filesystem and ./outputs.</p>
      <h3>Files</h3>
      ${fileListsHtml(packet)}
      <h3>Command line</h3>
      <pre class="ag-command">${command.text}</pre>
      <p class="footnote">${command.source==='companion'?'As built by the companion, with the prompt elided. The browser cannot change it.':'The companion did not send its own copy, so this is the documented command with the prompt elided.'}</p>
      <div class="notice"><strong>Isolation</strong><br>${ISOLATION_STATEMENT}</div>
      ${s.text?html`<details><summary>The exact text this approval covers</summary><pre class="ag-command" tabindex="0" aria-label="Approval summary text">${s.text}</pre><p class="footnote">The summary hash above is the SHA-256 of this text. The companion refuses to launch if it no longer matches.</p></details>`:''}
      <fieldset class="ag-acks"><legend>Required before launch</legend>${ACKNOWLEDGEMENTS.map((a,i)=>html`<label class="check"><input type="checkbox" data-ag-in="ack" data-id="${a.id}" data-ag-key="ack-${a.id}" ${o.acks[a.id]?'checked':''} ${i===0?'data-ag-initial':''}><span><strong>${a.label}</strong>${a.text}</span></label>`)}</fieldset>
      ${!o.hash?html`<div class="notice" role="alert">The companion did not send an approval hash for this round, so it cannot be approved from here. Update the companion and try again.</div>`:''}
      ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
      <div class="actions"><button type="button" class="primary" data-ag="approve-launch" data-ag-key="approve-launch" ${allChecked&&o.hash&&!locked()?'':'disabled'}>Approve and launch</button><button type="button" data-ag="close-overlay" data-ag-key="cancel-approve">Cancel</button></div>`);
  }
  async function openApprove(){
    const gate=launchGate();
    if(!gate.ok){say(gate.why,true);return;}
    const id=S.roundId;
    await work('approve-open',async()=>{await refreshRound(id);});
    const again=launchGate();
    if(!again.ok){say(again.why,true);return;}
    const {summary,hash}=approvalSummary(S.round);
    if(summary&&typeof summary.commandLine==='string'&&summary.commandLine)S.commands[id]=summary.commandLine;
    openOverlay({type:'approve',roundId:id,acks:{},summary,hash,error:''});
  }
  async function approveAndLaunch(){
    const o=S.overlay;
    if(!o||o.type!=='approve')return;
    if(!ACKNOWLEDGEMENTS.every(a=>o.acks[a.id])||!o.hash)return;
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
    say('Round '+id+' launched. Pilots run on this computer. This page refreshes every 1.5 seconds.');
    paintAll();gates();schedulePoll();
  }

  /* Run drawer and classification */
  function formFor(run){
    const human=run&&run.classification&&run.classification.human;
    return {verdict:human&&human.verdict||'',ids:Array.isArray(human&&human.fingerprintIds)?[...human.fingerprintIds]:[],note:human&&human.note||'',saving:false,error:''};
  }
  async function openRun(n){
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
  function canClassify(run){return run.state==='completed'&&auditStatus(run)==='CLEAN';}
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
    return dialogFrame('Pilot '+o.n+' · '+(run.state||''),html`
      <div class="actions">${stateBadge(run)}${auditBadge(run)}${o.loading?pill('Loading details'):''}</div>
      ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
      <dl class="history-details"><dt>Requested</dt><dd>${run.requestedModel||'-'} · effort ${run.requestedEffort||'-'}</dd><dt>Resolved model</dt><dd>${run.resolvedModel||'-'}</dd>
        <dt>Turns</dt><dd>${run.numTurns==null?'-':run.numTurns}</dd><dt>Tool calls</dt><dd>${calls.total==null?'-':calls.total+' (bash '+(calls.bash||0)+', file '+(calls.file||0)+')'}</dd>
        <dt>Exit code</dt><dd>${run.exitCode==null?'-':run.exitCode}</dd><dt>Ended because</dt><dd>${run.terminalReason||'-'}</dd><dt>Reported cost</dt><dd>${run.costUsd==null?'-':'USD '+run.costUsd}</dd>
        <dt>Started</dt><dd>${run.startedAt?timeText(run.startedAt):'-'}</dd><dt>Elapsed</dt><dd>${elapsedText(run)}</dd></dl>
      ${auditSectionHtml(run,audit,violations)}
      ${run.state==='failed'?failureHtml(run):''}
      <h3>${run.state==='failed'?"Runtime message (the run failed)":'Final answer'}</h3>
      ${final!==null?html`<pre class="ag-final" tabindex="0" aria-label="${run.state==='failed'?'Runtime message of':'Final answer of'} pilot ${o.n}">${final||'(empty)'}</pre><p class="footnote">${run.final&&run.final.chars!=null?run.final.chars+' characters. ':''}Shown as plain text.${run.state==='failed'?' This is what the runtime printed as its result. It is not an answer to grade.':''}</p>`:html`<p class="muted">${isActiveRun(run)?'The pilot has not finished.':o.loading?'Loading.':run.state==='failed'?'The runtime recorded no message.':'No final answer was recorded.'}</p>`}
      <h3>Outputs</h3>
      ${outputs.length?html`<div class="table-wrap"><table class="ag-table"><caption class="sr-only">Files the pilot wrote to its outputs folder</caption><thead><tr><th scope="col">Name</th><th scope="col">Size</th><th scope="col">SHA-256</th></tr></thead><tbody>${outputs.map(f=>html`<tr><td data-label="Name"><code class="ag-path">${f.name}</code></td><td data-label="Size">${bytesText(f.bytes)}</td><td data-label="SHA-256"><span class="hash">${f.sha256}</span></td></tr>`)}</tbody></table></div>`:html`<p class="muted">No files in the outputs folder.</p>`}
      ${classifyHtml(o,run)}`,'drawer');
  }
  function auditSectionHtml(run,audit,violations){
    const discarded=audit.status==='DISCARDED';
    const modified=Array.isArray(audit.inputsModified)?audit.inputsModified:[],notes=Array.isArray(audit.notes)?audit.notes:[];
    return html`<h3>Audit</h3>
      ${discarded?html`<div class="notice" role="status"><strong>DISCARDED</strong><br>This pilot read or wrote outside its own folder. The run is kept on disk and shown here, but it cannot be classified and it is left out of the export counts.</div>`:html`<p class="muted">${audit.status==='CLEAN'?'Every recorded tool call stayed inside the pilot folder, as far as the audit can tell. It reads the commands as text and does not run anything, so a path assembled while a command runs (from a variable or command output it cannot see, or from encoded text) is not seen. It does not prove nothing else happened.':endedWithoutAudit(run)?'This pilot ended before the audit ran, so it was not audited. It cannot be classified or exported.':'The audit runs when the pilot finishes.'}</p>`}
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
      ${enabled?'':html`<p class="muted">${auditStatus(run)==='DISCARDED'?'Classification is disabled because this run is DISCARDED.':'Classification opens when the pilot has completed with a clean audit.'}</p>`}
      ${suggested?html`<div class="notice neutral"><strong>Suggested verdict, heuristic: ${verdictLabel(suggested.verdict)}</strong><br>This is a keyword and number match against the frozen gold and fingerprints. It is not a judgement and it is never stored as your verdict.
        ${suggestedMatches(suggested).length?html`<br>Gold figures: ${suggestedMatches(suggested).map(m=>html`<code class="ag-path">${m}</code> `)}`:''}
        ${suggestedFingerprintIds(suggested).length?html`<br>Fingerprint candidates: ${suggestedFingerprintIds(suggested).join(', ')}`:''}
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
  function graderHtml(o){
    const runs=graderRuns(),allChecked=o.acks.run&&o.acks.network&&o.acks.notools;
    return dialogFrame('Simulated grader',html`
      <p class="muted">A tool-less agent reads the guideline text and one answer and returns a verdict and a reason. It is a <strong>simulated grader, not Studio grading</strong>, and it is one sample.</p>
      <label class="field">Guideline text<textarea data-ag-in="guideline" data-ag-key="guideline" rows="8" maxlength="40000" data-ag-initial>
${o.guideline}</textarea></label>
      <label class="field">Answer to grade<select data-ag-in="answer-run" data-ag-key="answer-run">${runs.map(run=>html`<option value="${run.n}" ${String(run.n)===String(o.runN)?'selected':''}>Pilot ${run.n} final answer</option>`)}</select></label>
      <label class="field">Model<select data-ag-in="overlay-model" data-ag-key="overlay-model">${S.status.models.map(m=>html`<option value="${m.id}" ${m.id===o.model?'selected':''}>${m.id}</option>`)}</select></label>
      <fieldset class="ag-acks"><legend>Approve this one run</legend>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="run" data-ag-key="g-run" ${o.acks.run?'checked':''}><span><strong>Run one simulated grader</strong>I approve a single run, with the model chosen above.</span></label>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="network" data-ag-key="g-network" ${o.acks.network?'checked':''}><span><strong>Network use by the agent runtime</strong>The guideline text and the answer are sent to Anthropic by the claude program.</span></label>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="notools" data-ag-key="g-notools" ${o.acks.notools?'checked':''}><span><strong>No tools</strong>The grader gets no shell, file or web tools. It cannot read your folders.</span></label></fieldset>
      ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
      ${o.result?html`<div class="notice neutral" role="status"><strong>Simulated grader, not Studio grading</strong><br>Verdict: ${o.result.verdict||'(none returned)'}<br>Reason: ${o.result.reason||'(none returned)'}</div>`:''}
      <div class="actions"><button type="button" class="primary" data-ag="run-grader" data-ag-key="run-grader" ${allChecked&&o.guideline.trim()&&runs.length&&!o.busy?'':'disabled'}>${o.busy?'Running…':'Approve and run'}</button><button type="button" data-ag="close-overlay" data-ag-key="cancel-grader">Close</button></div>`);
  }
  function openGrader(){
    const runs=graderRuns();
    if(!runs.length){say('A simulated grader needs a completed run with a clean audit.',true);return;}
    const project=currentProject();
    openOverlay({type:'grader',guideline:project&&typeof project.guidance==='string'?project.guidance:'',runN:runs[0].n,model:S.config.model,acks:{},busy:false,error:'',result:null});
  }
  async function runGrader(){
    const o=S.overlay;
    if(!o||o.type!=='grader'||o.busy||!(o.acks.run&&o.acks.network&&o.acks.notools))return;
    o.busy=true;o.error='';o.result=null;paintOverlay();
    try{
      const detail=await api('GET',runPath(S.round.id,o.runN));
      const run=detail.run&&typeof detail.run==='object'?detail.run:detail;
      const answer=run.final&&typeof run.final.text==='string'?run.final.text:'';
      if(!answer.trim())throw new Error('That pilot has no final answer to grade.');
      const data=await api('POST','/api/agents/grader-sim',{guidelineText:o.guideline,answerText:answer,model:o.model});
      const result=data.result&&typeof data.result==='object'?data.result:data;
      o.result={verdict:result.verdict,reason:result.reason};
      say('Simulated grader finished. It is a simulation, not Studio grading.');
    }catch(error){o.error=error.message;say(error.message,true);}
    o.busy=false;
    if(S.overlay===o)paintOverlay();
  }

  /* Author review */
  function packageDigest(leaveOutEvaluator){
    const out=[];let size=0;const cap=PACKAGE_DIGEST_CHARS;
    for(const doc of packageDocuments()){
      if(leaveOutEvaluator&&doc.role==='evaluator')continue;
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
    const docs=packageDocuments(),evaluatorCount=docs.filter(d=>d.role==='evaluator').length,allChecked=o.acks.run&&o.acks.network&&o.acks.notools;
    return dialogFrame('Author review',html`
      <p class="muted">One tool-less analysis of the task package loaded on the Overview page. It is an author-side read of the sources, not a blind pilot and not a score.</p>
      <p>${docs.length} ${docs.length===1?'file':'files'} loaded: ${docs.slice(0,12).map(d=>html`<code class="ag-path">${d.name}</code> `)}${docs.length>12?'and more.':''}</p>
      ${evaluatorCount?html`<label class="check"><input type="checkbox" data-ag-in="review-leave-out" data-ag-key="review-leave-out" ${o.leaveOut?'checked':''} data-ag-initial><span><strong>Leave out the ${evaluatorCount} file${evaluatorCount===1?'':'s'} marked evaluator-only</strong>Otherwise their extracted text is sent too.</span></label>`:''}
      <label class="field">Model<select data-ag-in="overlay-model" data-ag-key="overlay-model">${S.status.models.map(m=>html`<option value="${m.id}" ${m.id===o.model?'selected':''}>${m.id}</option>`)}</select></label>
      <fieldset class="ag-acks"><legend>Approve this one run</legend>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="run" data-ag-key="r-run" ${o.acks.run?'checked':''}><span><strong>Run one author review</strong>I approve a single run, with the model chosen above.</span></label>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="network" data-ag-key="r-network" ${o.acks.network?'checked':''}><span><strong>Network use by the agent runtime</strong>An extract of the package text and the prompt are sent to Anthropic by the claude program.</span></label>
        <label class="check"><input type="checkbox" data-ag-in="overlay-ack" data-id="notools" data-ag-key="r-notools" ${o.acks.notools?'checked':''}><span><strong>No tools</strong>The reviewer gets no shell, file or web tools. It cannot read your folders.</span></label></fieldset>
      ${o.error?html`<div class="notice" role="alert">${o.error}</div>`:''}
      ${o.result!==null?html`<div class="notice neutral" role="status"><strong>Author review result</strong></div><pre class="ag-final" tabindex="0" aria-label="Author review result">${o.result||'(the companion returned no text)'}</pre>`:''}
      <div class="actions"><button type="button" class="primary" data-ag="run-review" data-ag-key="run-review" ${allChecked&&docs.length&&!o.busy?'':'disabled'}>${o.busy?'Running…':'Approve and run'}</button><button type="button" data-ag="close-overlay" data-ag-key="cancel-review">Close</button></div>`);
  }
  function openReview(){
    if(!packageDocuments().length){say('Load a task package on the Overview page first.',true);return;}
    openOverlay({type:'review',model:S.config.model,leaveOut:false,acks:{},busy:false,error:'',result:null});
  }
  async function runReview(){
    const o=S.overlay;
    if(!o||o.type!=='review'||o.busy||!(o.acks.run&&o.acks.network&&o.acks.notools))return;
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
      await work('inspect',async()=>{
        const data=await api('POST','/api/agents/packet/inspect',{sourceDir:dir});
        const list=Array.isArray(data)?data:Array.isArray(data.files)?data.files:null;
        if(!list)throw new Error('The companion returned no file list.');
        S.packet.files=list.map(normalizeFile).filter(f=>f.path);
        S.packet.inspectedDir=dir;
        (S.packet.files||[]).forEach(f=>{if(isGaf(f.path)&&!f.excluded)f.include=S.packet.gafVisible;});
      });
      say('Listed '+S.packet.files.length+' files. Review the include boxes. Files that look like evaluator material are off by default.');
    }catch(error){
      S.packet.error=error.message;
      paintSection('packet');
    }
  }
  async function freeze(){
    const built=buildFreeze(),errors=[...preflight(),...built.errors];
    if(errors.length){S.fz.errors=errors;gates();say('Fix '+errors.length+(errors.length===1?' item':' items')+' before freezing.',true);return;}
    S.fz.errors=[];
    await work('freeze',async()=>{
      let round=S.round&&S.round.status==='draft'&&S.sigs[S.round.id]===inputSig()?S.round:null;
      if(!round){
        round=normalizeRound(await api('POST','/api/agents/rounds',roundBody()));
        S.sigs[round.id]=inputSig();
        S.roundId=round.id;
        S.round=round;
      }
      await api('POST',roundPath(round.id,'/freeze'),{gold:built.gold,fingerprints:built.fingerprints});
      await refreshRound(round.id);
      await loadRounds();
    });
    const fr=S.round&&S.round.freeze;
    say('Gold frozen for round '+S.round.id+(fr&&fr.sha256?'. Freeze hash '+shortHash(fr.sha256)+'.':'.')+' Nothing has run.');
  }
  async function refreeze(){
    if(!S.round||!S.round.freeze)return;
    const built=buildFreeze();
    if(built.errors.length){S.fz.errors=built.errors;gates();say('Fix '+built.errors.length+' items before saving a post-hoc version.',true);return;}
    S.fz.errors=[];
    await work('refreeze',async()=>{
      await api('POST',roundPath(S.round.id,'/refreeze'),{gold:built.gold,fingerprints:built.fingerprints});
      await refreshRound(S.round.id);
    });
    say('Post-hoc freeze version saved beside the original for round '+S.round.id+'.');
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
    gates();
  }

  /* ---------- Polling every 1500 ms while a round has work in flight ---------- */
  function shouldPoll(){
    if(!S.mounted||S.phase!=='ready'||!S.round)return false;
    return ['approved','running'].includes(S.round.status)||runsOf(S.round).some(isActiveRun);
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
      const before=S.round&&S.round.status;
      await refreshRound(S.roundId);
      if(S.round&&S.round.status!==before)await loadRounds();
      paintSection('runs');paintSection('round');gates();
      if(S.overlay&&S.overlay.type==='drawer'&&isActiveRun(S.overlay.run||{}))await refreshDrawer();
    }catch(error){say(error.message,true);}
    finally{schedulePoll();}
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
    paintRoot();
    try{
      await loadRounds();
      if(!S.roundId&&S.rounds.length){S.roundId=S.rounds[0].id;await refreshRound(S.roundId);}
      paintAll();gates();
    }catch(error){say(error.message,true);}
    schedulePoll();
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
      return;
    }
    S.mounted=true;
    if(S.phase==='idle'||(S.phase==='offline'&&isLocal()))boot();
    else if(S.phase==='ready'){
      loadStatus().then(()=>{paintSection('runtime');}).catch(()=>{});
      schedulePoll();
    }
  }

  /* ---------- Events ---------- */
  const CLICK={
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
    'count-dec':()=>{setCount(S.config.count-1);paintSection('round');},
    'count-inc':()=>{setCount(S.config.count+1);paintSection('round');},
    'open-approve':()=>openApprove(),
    'approve-launch':()=>approveAndLaunch(),
    'cancel-round':()=>cancelRound(),
    'open-run':t=>openRun(Number(t.dataset.n)),
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
    model:t=>{S.config.model=t.value;gates();},
    effort:t=>{S.config.effort=t.value;gates();},
    count:(t,e)=>{setCount(t.value);if(e.type==='change'){t.value=S.config.count;paintSection('round');}},
    label:t=>{S.label=t.value;},
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
      if(button)button.disabled=!(o.acks.run&&o.acks.network&&o.acks.notools&&o.guideline.trim()&&graderRuns().length&&!o.busy);
    },
    'answer-run':t=>{const o=S.overlay;if(o&&o.type==='grader')o.runN=Number(t.value);},
    'review-leave-out':t=>{const o=S.overlay;if(o&&o.type==='review')o.leaveOut=t.checked;},
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
      if(handler)guarded(()=>handler(el));
      return;
    }
    const el=target.closest('[data-ag-in]');
    if(!el||!(el.closest('#ag-root')||el.closest('#agents-modal')))return;
    const handler=INPUT[el.dataset.agIn];
    if(handler)guarded(()=>handler(el,e));
  }
  ['click','input','change','keydown'].forEach(type=>document.addEventListener(type,handleEvent));

  window.FinanceAgents={render,afterRender,handleEvent,offlineMessage:OFFLINE_MESSAGE};
})();
