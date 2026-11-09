/* Humanize page: one field of text in, one final text field out, through the companion's /api/humanize routes (src/humanize,
   docs/humanize.md). window.FinanceHumanize = {render, afterRender, handleEvent}. Rules this file keeps, like pipeline.js:
   - It makes no request of its own. Every call goes through window.FinanceAgents.link / get / post (agents.js), which loads the session
     code, sends it on every POST and only accepts relative paths under /api/. Opened from disk the page makes no request at all.
   - It never supplies a command, a binary or an argument: it sends the text, two provider names from the lists the companion reports,
     three small numbers, the Verva page address and optional CSS selectors, and the one acknowledgement.
   - Every dynamic string is escaped by the html tag below. No inline style attributes, no form submission, no browser storage: the text
     stays in this page's memory and in the companion.
   - The form and the run are painted into separate boxes, so a poll that repaints the run never resets what is being typed. */
(function(){
  'use strict';
  const W=window;
  const OFFLINE_MESSAGE='Humanize needs the companion: run npm start. On its own, without the Studio: npm run humanize -- run --in draft.txt';
  const POLL_MS=1500;
  /* Display copies of src/humanize/constants.cjs (tests/humanize.test.cjs checks that the two agree). The companion enforces its own. */
  const BARS=Object.freeze({prose:0.90,other:0.70,aggregate:0.80});
  const ENDED=['passed','below-bar','stalled','budget','cancelled','failed','needs-sign-in'];
  const STATUS_TEXT={running:'Running',passed:'Signed off','below-bar':'Below the bar',stalled:'Stalled',budget:'Call cap reached',cancelled:'Stopped',failed:'Failed','needs-sign-in':'Verva asks for a sign-in'};
  const STAGE_TEXT={secretary:'Secretary: brief and masks',rewrite:'Rewriters (Verva)',repair:'Repair: facts and meaning',signoff:'Sign-off (GPTZero)',done:'Done'};

  const ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'};
  const esc=x=>String(x==null?'':x).replace(/[&<>"'`]/g,c=>ESC[c]);
  class Raw{constructor(t){this.text=t;}}
  function part(value){
    if(value instanceof Raw)return value.text;
    if(Array.isArray(value))return value.map(part).join('');
    if(value===false||value===true||value==null)return '';
    return esc(value);
  }
  function html(strings,...values){let out=strings[0];values.forEach((value,i)=>{out+=part(value)+strings[i+1];});return new Raw(out);}
  const pct=x=>Number.isFinite(x)?`${Math.round(x*1000)/10}%`:'–';

  const S={
    phase:'idle',offlineNote:'',status:null,list:[],run:null,runId:null,timer:null,mounted:false,ctx:{},msg:'',msgError:false,
    form:{text:'',rewriter:'verva',detector:'gptzero',passes:3,rounds:3,workers:1,ack:false},
    verva:{url:'',input:'',button:'',output:''},
  };
  const agents=()=>W.FinanceAgents;
  const isLocal=()=>location.protocol==='http:'&&location.hostname==='127.0.0.1';
  const get=path=>agents().get(path);
  const post=(path,body)=>agents().post(path,body||{});
  const messageOf=error=>String(error&&error.message||error);
  const $=id=>document.getElementById(id);
  function say(text,error){S.msg=text||'';S.msgError=!!error;const el=$('hz-msg');if(el){el.textContent=S.msg;el.className='hz-msg'+(S.msgError?' error':'');}}

  /* ---------- What the companion sends, read in one place ---------- */
  function adaptStatus(data){
    const c=data&&typeof data==='object'?data:{};
    const list=(v,fallback)=>Array.isArray(v)&&v.length?v.filter(x=>x&&typeof x.id==='string'):fallback;
    return {
      bars:{prose:Number(c.bars&&c.bars.prose)||BARS.prose,other:Number(c.bars&&c.bars.other)||BARS.other,aggregate:Number(c.bars&&c.bars.aggregate)||BARS.aggregate},
      limits:{maxPassesCap:Number(c.limits&&c.limits.maxPassesCap)||5,maxRoundsCap:Number(c.limits&&c.limits.maxRoundsCap)||6,maxWorkers:Number(c.limits&&c.limits.maxWorkers)||4,maxTextChars:Number(c.limits&&c.limits.maxTextChars)||60000},
      rewriters:list(c.rewriters,[{id:'verva',label:'Verva (in Chrome)',external:true},{id:'stub',label:'Offline rewriter (stub)',external:false}]),
      detectors:list(c.detectors,[{id:'gptzero',label:'GPTZero',external:true},{id:'stub',label:'Offline estimate (stub)',external:false}]),
      ack:c.acknowledgement&&typeof c.acknowledgement.id==='string'?c.acknowledgement:{id:'third-party-text',text:'Text leaves this computer.'},
      gptzero:c.gptzero&&typeof c.gptzero==='object'?{found:!!c.gptzero.found,source:c.gptzero.source||null,error:c.gptzero.error||''}:{found:false,source:null,error:''},
      verva:c.verva&&typeof c.verva==='object'?{configured:!!c.verva.configured,url:c.verva.url||'',chrome:!!c.verva.chrome,browser:c.verva.browser||'closed',signIn:c.verva.signIn||'closed'}:{configured:false,url:'',chrome:false,browser:'closed',signIn:'closed'},
    };
  }
  const withheld=v=>!!(v&&typeof v==='object'&&v.withheld);
  function adaptRun(data){
    const v=data&&typeof data==='object'?data:{};
    const agg=v.aggregate&&typeof v.aggregate==='object'?v.aggregate:{};
    return {
      id:typeof v.id==='string'?v.id:S.runId,status:typeof v.status==='string'?v.status:'running',stage:v.stage||'',round:v.round|0,pass:v.pass|0,
      error:withheld(v.error)?'(withheld while a round of pilots runs)':v.error||'',redacted:!!v.redacted,
      aggregate:{human:Number.isFinite(agg.human)?agg.human:null,bar:Number.isFinite(agg.bar)?agg.bar:BARS.aggregate,met:!!agg.met,history:Array.isArray(agg.history)?agg.history:[]},
      calls:v.calls&&typeof v.calls==='object'?{rewrite:v.calls.rewrite|0,scan:v.calls.scan|0}:{rewrite:0,scan:0},
      signedOff:!!v.signedOff,
      estimate:!!(v.providers&&v.providers.detector&&v.providers.detector.estimate),
      rewriter:v.providers&&v.providers.rewriter?v.providers.rewriter.label:'',detector:v.providers&&v.providers.detector?v.providers.detector.label:'',
      final:typeof v.final==='string'?v.final:withheld(v.final)?null:'',
      chunks:Array.isArray(v.chunks)?v.chunks:[],
      brief:v.brief&&!withheld(v.brief)?v.brief:null,
      log:Array.isArray(v.log)?v.log:[],
    };
  }
  const ended=run=>!!run&&ENDED.includes(run.status);

  /* ---------- Markup ---------- */
  function setupBox(){
    const st=S.status;
    if(!st)return html``;
    const g=st.gptzero,v=st.verva;
    const sourceText=g.source==='keychain'?'the Keychain item finance-studio-gptzero-key':g.source==='env'?'GPTZERO_API_KEY':'';
    return html`<section class="card hz-setup"><h2>Workers</h2>
      <ul class="hz-checks">
        <li>${g.found?html`<span class="pill green">ready</span> GPTZero key found in ${sourceText}.`:html`<span class="pill amber">missing</span> No GPTZero key${g.error?html` (${g.error})`:''}. Set GPTZERO_API_KEY before npm start, or store it in the macOS Keychain item finance-studio-gptzero-key. The companion keeps it away from pilots.`}</li>
        <li>${v.configured?html`<span class="pill green">set</span> Verva page: ${v.url}`:html`<span class="pill amber">not set</span> Give the address of Verva's humanizer page below.`}</li>
        <li>${v.chrome?html`<span class="pill green">found</span> Chrome or Chromium for the Verva worker.`:html`<span class="pill red">missing</span> No Chrome found. Install Google Chrome, or set FINANCE_STUDIO_CHROME.`}</li>
        <li>${v.signIn==='open'?html`<span class="pill amber">open</span> The Verva sign-in window is open. Sign in there, then press Done.`:html`<span class="pill">sign-in</span> Sign in once; the sign-in stays in the worker's own Chrome profile (private/humanize/verva-profile). The Studio cannot see the sign-in window.`}</li>
      </ul>
      <div class="field-row"><label class="field">Verva page address<input type="url" data-hz-in="verva-url" value="${S.verva.url}" placeholder="the address of the humanizer page, starting with https" autocomplete="off" spellcheck="false"></label>
      <div class="hz-inline-actions"><button type="button" data-hz="verva-save">Save address</button>${v.signIn==='open'?html`<button type="button" data-hz="verva-done">Done signing in</button>`:html`<button type="button" data-hz="verva-sign-in"${v.configured&&v.chrome?'':' disabled'}>Sign in to Verva</button>`}</div></div>
      <details class="hz-details"><summary>Pin the page's elements (only if the worker cannot find them)</summary>
        <div class="field-row"><label class="field">Text box (CSS selector)<input type="text" data-hz-in="verva-input" value="${S.verva.input}" spellcheck="false"></label><label class="field">Humanize button<input type="text" data-hz-in="verva-button" value="${S.verva.button}" spellcheck="false"></label></div>
        <label class="field">Result<input type="text" data-hz-in="verva-output" value="${S.verva.output}" spellcheck="false"></label>
      </details></section>`;
  }

  function formBox(){
    const st=S.status;
    if(!st)return html``;
    const f=S.form;
    const external=[...st.rewriters,...st.detectors].some(p=>(p.id===f.rewriter||p.id===f.detector)&&p.external);
    const running=S.run&&!ended(S.run);
    const option=(list,value)=>list.map(p=>html`<option value="${p.id}"${p.id===value?' selected':''}>${p.label}</option>`);
    const num=(name,value,max)=>html`<input type="number" min="1" max="${max}" step="1" data-hz-in="${name}" value="${value}">`;
    return html`<section class="card hz-form"><h2>Text</h2>
      <p class="muted hz-lede">The secretary locks the terms, maps each figure to the subject and verb it belongs to, and records every figure's basis. Verva rewrites masked chunks (figures and locked terms become placeholders), the repair workers put back anything that slipped, and GPTZero signs off each chunk at ${pct(st.bars.prose)} human for prose and ${pct(st.bars.other)} for other text. A chunk that has not passed after its passes is respliced and goes round again until the whole text reads ${pct(st.bars.aggregate)} human.</p>
      <label class="field">Text to humanize<textarea rows="12" data-hz-in="text" spellcheck="true" placeholder="Paste the draft here">${f.text}</textarea><small>${f.text.length.toLocaleString()} of ${st.limits.maxTextChars.toLocaleString()} characters. Headings, tables and code are shipped as written.</small></label>
      <div class="hz-grid">
        <label class="field">Rewriter<select data-hz-in="rewriter">${option(st.rewriters,f.rewriter)}</select></label>
        <label class="field">Detector<select data-hz-in="detector">${option(st.detectors,f.detector)}</select></label>
        <label class="field">Passes per chunk${num('passes',f.passes,st.limits.maxPassesCap)}</label>
        <label class="field">Rounds${num('rounds',f.rounds,st.limits.maxRoundsCap)}</label>
        <label class="field">Workers per field${num('workers',f.workers,st.limits.maxWorkers)}</label>
      </div>
      ${external?html`<label class="check"><input type="checkbox" data-hz-in="ack"${f.ack?' checked':''}><span><strong>Text leaves this computer</strong>${st.ack.text}</span></label>`:html`<p class="muted">Offline dry run: nothing leaves this computer. The stub detector's numbers are an estimate and never sign a run off.</p>`}
      <div class="hz-start-row"><button type="button" class="primary" data-hz="start"${running||!f.text.trim()||(external&&!f.ack)?' disabled':''}>Start</button><span class="muted">${running?'A run is in progress.':''}</span></div>
    </section>`;
  }

  function statusPill(run){
    const tone=run.status==='passed'?(run.estimate?'amber':'green'):run.status==='running'?'':['failed','needs-sign-in'].includes(run.status)?'red':'amber';
    /* the shared sheet draws the glyph of a coloured pill (✓ ! ✕); only the neutral running pill gets one here */
    const glyph=tone?'':'… ';
    return html`<span class="pill ${tone}">${glyph}${run.status==='passed'&&run.estimate?'Reached the bar (offline estimate)':STATUS_TEXT[run.status]||run.status}</span>`;
  }

  function runBox(){
    const run=S.run;
    if(!run)return html``;
    const running=!ended(run);
    const chunkRows=run.chunks.map(c=>html`<tr><td>${c.id}</td><td>${c.kind}</td><td>${pct(c.bar)}</td><td>${(c.passes||[]).map(p=>html`<span class="hz-pass${p.gate==='rejected'?' rejected':''}" title="${(p.reasons||[]).join('; ')}">${p.kind==='baseline'?'base':`r${p.round}.${p.pass}`} ${p.gate==='rejected'?'rejected':pct(p.human)}${p.splices?html` <em>+${p.splices} splice</em>`:''}</span>`)}</td><td>${pct(c.best&&c.best.human)}</td><td>${c.status}${(c.notes||[]).length?html`<br><span class="hz-note">read: ${c.notes.join(', ')}</span>`:''}</td></tr>`);
    return html`<section class="card hz-run"><div class="hz-run-head"><h2>Run</h2>${statusPill(run)}${running?html`<button type="button" data-hz="stop">Stop</button>`:''}</div>
      ${run.redacted?html`<p class="hz-msg">A round of pilots is running, so the text, the brief and the log are withheld from this page until it ends.</p>`:''}
      <dl class="hz-facts">
        <div><dt>Stage</dt><dd>${STAGE_TEXT[run.stage]||run.stage||'–'}${running?html` · round ${run.round}, pass ${run.pass}`:''}</dd></div>
        <div><dt>Aggregate</dt><dd>${pct(run.aggregate.human)} human <span class="muted">(bar ${pct(run.aggregate.bar)})</span></dd></div>
        <div><dt>Calls</dt><dd>${run.calls.rewrite} rewrite · ${run.calls.scan} scan</dd></div>
        <div><dt>Workers</dt><dd>${run.rewriter} → repair → ${run.detector}</dd></div>
      </dl>
      ${run.estimate?html`<p class="hz-warn">Scored by the offline estimate, not GPTZero: nothing here is signed off.</p>`:''}
      ${run.error?html`<p class="hz-error">${run.error}</p>`:''}
      ${run.aggregate.history.length?html`<p class="muted">By round: ${run.aggregate.history.map(h=>`${h.round}: ${pct(h.human)}`).join(' · ')}</p>`:''}
      <h3>Final text</h3>
      ${run.final===null?html`<p class="muted">Withheld while a round of pilots runs.</p>`:html`<textarea class="hz-final" rows="12" readonly aria-label="Final text">${run.final}</textarea>
      <div class="hz-inline-actions"><button type="button" data-hz="copy"${run.final?'':' disabled'}>Copy</button><button type="button" data-hz="download"${run.final?'':' disabled'}>Download .txt</button>${running?html`<span class="muted">The best version so far; it changes until the run ends.</span>`:''}</div>`}
      <h3>Chunks</h3>
      <div class="hz-table-wrap"><table class="hz-table"><thead><tr><th>Chunk</th><th>Kind</th><th>Bar</th><th>Passes</th><th>Best</th><th>State</th></tr></thead><tbody>${chunkRows}</tbody></table></div>
      ${run.brief?briefBox(run.brief):''}
      ${run.log.length?html`<details class="hz-details"><summary>Log (${run.log.length})</summary><ol class="hz-log">${run.log.slice(-200).map(l=>html`<li><span class="muted">r${l.round}.${l.pass} ${l.stage}</span> ${withheld(l.text)?'(withheld)':l.text}</li>`)}</ol></details>`:''}
    </section>`;
  }

  function briefBox(b){
    const facts=Array.isArray(b.facts)?b.facts:[],terms=Array.isArray(b.terms)?b.terms:[],bindings=Array.isArray(b.bindings)?b.bindings:[];
    return html`<details class="hz-details"><summary>Secretary's brief: ${facts.length} figure(s), ${terms.length} term(s), ${bindings.length} binding(s)</summary>
      <h4>Figures and their basis</h4><ul class="hz-tags">${facts.map(f=>html`<li>${f.text} <span class="muted">${f.basis}${f.count>1?` ×${f.count}`:''}</span></li>`)}</ul>
      <h4>Terminology lock</h4><ul class="hz-tags">${terms.map(t=>html`<li>${t.text} <span class="muted">${t.kind==='watch'?'watched':t.kind}</span></li>`)}</ul>
      <h4>Noun-verb map</h4><ul class="hz-bindings">${bindings.slice(0,60).map(x=>html`<li><strong>${x.subject||'(no subject)'}</strong> ${x.negated?'not ':''}${x.verb||'–'}${x.direction?` (${x.direction})`:''} → ${(x.facts||[]).join(', ')}</li>`)}</ul>
    </details>`;
  }

  function listBox(){
    const rows=S.list.filter(r=>r.id!==(S.run&&S.run.id));
    if(!rows.length)return html``;
    return html`<section class="card"><h2>Earlier runs</h2><ul class="hz-runs">${rows.map(r=>html`<li><button type="button" data-hz="open" data-id="${r.id}">${r.startedAt?new Date(r.startedAt).toLocaleString():r.id}</button> <span class="muted">${STATUS_TEXT[r.status]||r.status} · ${pct(r.aggregate)} · ${r.rewriter||''} / ${r.detector||''}</span></li>`)}</ul></section>`;
  }

  function pageInner(){
    if(S.phase==='offline')return html`<section class="card"><h1>Humanize</h1><p>${OFFLINE_MESSAGE}</p>${S.offlineNote?html`<p class="muted">${S.offlineNote}</p>`:''}</section>`;
    if(S.phase!=='ready')return html`<section class="card"><h1>Humanize</h1><p class="muted">Connecting to the companion…</p></section>`;
    return html`<header class="hz-head"><h1>Humanize</h1><p class="muted">Secretary → Verva rewriters → repair → GPTZero sign-off, in lock step. Nothing starts until you press Start.</p></header>
      <p id="hz-msg" class="hz-msg${S.msgError?' error':''}">${S.msg}</p>
      <div id="hz-setup">${setupBox()}</div><div id="hz-form">${formBox()}</div><div id="hz-run">${runBox()}</div><div id="hz-list">${listBox()}</div>`;
  }
  function paint(id,markup){const el=$(id);if(el)el.innerHTML=markup.text;}
  function paintRoot(){const root=$('hz-root');if(root)root.innerHTML=pageInner().text;}
  const paintRun=()=>{paint('hz-run',runBox());paint('hz-list',listBox());};

  /* ---------- Talking to the companion ---------- */
  async function refreshStatus(){S.status=adaptStatus((await get('/api/humanize')).config);}
  async function loadList(){const data=await get('/api/humanize');S.list=Array.isArray(data.runs)?data.runs:[];if(data.config)S.status=adaptStatus(data.config);return data;}
  async function refreshRun(){if(!S.runId)return;S.run=adaptRun(await get('/api/humanize/'+encodeURIComponent(S.runId)));}
  function schedulePoll(){
    clearTimeout(S.timer);S.timer=null;
    if(!S.mounted||!S.run||ended(S.run))return;
    S.timer=setTimeout(async()=>{
      try{await refreshRun();if(ended(S.run)){await loadList();paint('hz-form',formBox());}paintRun();}
      catch(error){say(messageOf(error),true);}
      schedulePoll();
    },POLL_MS);
  }

  const CLICK={
    async start(){
      const f=S.form;
      say('');
      const body={text:f.text,rewriter:f.rewriter,detector:f.detector,maxPasses:f.passes,maxRounds:f.rounds,workers:f.workers,acknowledgements:f.ack?[S.status.ack.id]:[]};
      const {id}=await post('/api/humanize/start',body);
      S.runId=id;S.run=adaptRun({id,status:'running',stage:'secretary'});
      paint('hz-form',formBox());paintRun();schedulePoll();
    },
    async stop(){if(!S.runId)return;S.run=adaptRun(await post('/api/humanize/'+encodeURIComponent(S.runId)+'/stop'));await loadList();paintRun();paint('hz-form',formBox());},
    async open(el){S.runId=el.dataset.id;await refreshRun();paintRun();schedulePoll();},
    async copy(){if(!S.run||!S.run.final)return;try{await navigator.clipboard.writeText(S.run.final);say('The final text is on the clipboard.');}catch(error){say('The browser did not allow the copy; select the text and copy it by hand.',true);}},
    download(){if(!S.run||!S.run.final)return;const name=`humanized-${(S.run.id||'text').replace(/[^a-z0-9-]/gi,'')}.txt`;if(typeof S.ctx.download==='function')S.ctx.download(name,S.run.final,'text/plain');},
    async 'verva-save'(){const v=S.verva;const body={url:v.url.trim()};for(const k of ['input','button','output'])body[k]=v[k].trim();await post('/api/humanize/verva/config',body);await refreshStatus();paint('hz-setup',setupBox());paint('hz-form',formBox());say('Saved the Verva settings.');},
    async 'verva-sign-in'(){await post('/api/humanize/verva/sign-in');await refreshStatus();paint('hz-setup',setupBox());say('A Chrome window is open on Verva. Sign in there, then press Done signing in.');},
    async 'verva-done'(){await post('/api/humanize/verva/sign-in/done');await refreshStatus();paint('hz-setup',setupBox());say('The Verva sign-in is kept for the next run.');},
  };
  const INPUT={
    text:el=>{S.form.text=el.value;const small=el.parentElement&&el.parentElement.querySelector('small');if(small&&S.status)small.textContent=`${el.value.length.toLocaleString()} of ${S.status.limits.maxTextChars.toLocaleString()} characters. Headings, tables and code are shipped as written.`;const btn=document.querySelector('[data-hz="start"]');if(btn)btn.disabled=!startable();},
    rewriter:el=>{S.form.rewriter=el.value;S.form.ack=false;paint('hz-form',formBox());},
    detector:el=>{S.form.detector=el.value;S.form.ack=false;paint('hz-form',formBox());},
    passes:el=>{S.form.passes=clampNum(el.value,1,S.status.limits.maxPassesCap,3);},
    rounds:el=>{S.form.rounds=clampNum(el.value,1,S.status.limits.maxRoundsCap,3);},
    workers:el=>{S.form.workers=clampNum(el.value,1,S.status.limits.maxWorkers,1);},
    ack:el=>{S.form.ack=el.checked;const btn=document.querySelector('[data-hz="start"]');if(btn)btn.disabled=!startable();},
    'verva-url':el=>{S.verva.url=el.value;},
    'verva-input':el=>{S.verva.input=el.value;},
    'verva-button':el=>{S.verva.button=el.value;},
    'verva-output':el=>{S.verva.output=el.value;},
  };
  const FIELD_EVENT={text:'input',rewriter:'change',detector:'change',passes:'change',rounds:'change',workers:'change',ack:'change','verva-url':'input','verva-input':'input','verva-button':'input','verva-output':'input'};
  const clampNum=(value,min,max,fallback)=>{const n=Math.round(Number(value));return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;};
  function startable(){
    const st=S.status,f=S.form;
    if(!st||!f.text.trim()||(S.run&&!ended(S.run)))return false;
    const external=[...st.rewriters,...st.detectors].some(p=>(p.id===f.rewriter||p.id===f.detector)&&p.external);
    return !external||f.ack;
  }

  function handleEvent(e){
    const target=e.target;
    if(!target||typeof target.closest!=='function')return;
    const mine=el=>!!el&&!!el.closest('#hz-root');
    if(e.type==='click'){
      const el=target.closest('[data-hz]');
      if(!el||!mine(el)||el.disabled)return;
      const handler=CLICK[el.dataset.hz];
      if(handler){el.disabled=true;Promise.resolve().then(()=>handler(el)).catch(error=>say(messageOf(error),true)).finally(()=>{if(el.isConnected)el.disabled=false;const btn=document.querySelector('[data-hz="start"]');if(btn)btn.disabled=!startable();});}
      return;
    }
    if(e.type!=='input'&&e.type!=='change')return;
    const el=target.closest('[data-hz-in]');
    if(!el||!mine(el)||FIELD_EVENT[el.dataset.hzIn]!==e.type)return;
    const handler=INPUT[el.dataset.hzIn];
    if(handler){try{handler(el);}catch(error){say(messageOf(error),true);}}
  }
  ['click','input','change'].forEach(type=>document.addEventListener(type,handleEvent));

  /* ---------- Lifecycle ---------- */
  async function boot(){
    const A=agents();
    if(!isLocal()){S.phase='offline';paintRoot();return;}
    if(!A||typeof A.link!=='function'){S.phase='offline';S.offlineNote='The Humanize page needs agents.js, which did not load. The other views still work.';paintRoot();return;}
    S.phase='checking';paintRoot();
    try{
      const link=await A.link();
      if(!link.local||!link.ok){S.phase='offline';S.offlineNote=link.error||'';paintRoot();return;}
      const data=await loadList();
      const pick=(data.running&&S.list.find(r=>r.id===data.running))||S.list[0]||null;
      if(pick){S.runId=pick.id;await refreshRun().catch(error=>say(messageOf(error),true));}
      S.phase='ready';
    }catch(error){
      S.phase='offline';
      S.offlineNote=error&&error.status===404?'This companion has no humanize support. Update it and run npm start again.':messageOf(error);
      paintRoot();return;
    }
    paintRoot();schedulePoll();
  }
  function render(ctx){
    S.ctx={...S.ctx,download:ctx&&typeof ctx.download==='function'?ctx.download:S.ctx.download};
    if(!isLocal())S.phase='offline';
    return `<div id="hz-root" class="hz-root">${pageInner().text}</div>`;
  }
  /* The dashboard calls this after each of its own renders, with true while the Humanize view is showing. */
  function afterRender(active){
    if(!active){S.mounted=false;clearTimeout(S.timer);S.timer=null;return;}
    S.mounted=true;
    if(S.phase==='idle'||S.phase==='offline')boot();
    else if(S.phase==='ready'){paintRoot();schedulePoll();}
  }

  W.FinanceHumanize={render,afterRender,handleEvent,adaptRun,adaptStatus,BARS,offlineMessage:OFFLINE_MESSAGE};
})();
