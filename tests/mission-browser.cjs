/* Optional developer QA for Mission Control (not part of npm test). Uses an isolated headless Chromium profile and never attaches to an
   existing browser. It starts backend/server.cjs as a child process on a free port with CLAUDE_BIN pointing at the test double
   backend/agents/stub-claude.cjs, so no model is ever started. Everything it types is synthetic (tasks Atlas, Meridian, Borealis, Cobalt).

   Flow: the file edition (offline banner, Not available, no request); a companion with three finished rounds and a draft (a DISCARDED
   and a failed pilot among them): the cards, the single yellow button, the stepper, the feed as a listbox driven by real key events (arrow
   keys, Enter selects, Escape closes the inspector and returns focus), Ctrl K, the search, card selection, the import of a synthetic
   evaluation result (and a bad file), Copy path through the real clipboard; then the companion is restarted with slow pilots and a round
   runs: Details withheld while a round runs, one polite live region that announces a finished pilot, focus and scroll unchanged across
   polls, the N new button, reduced motion; then the companion is stopped (alert once, stale marker) and started again (Retry now).
   Every phase checks: no horizontal overflow at 1440x1000, 1280x800 and 390x844, no text under 12px, no percentage or rate wording, a
   visible focus ring on every Tab stop, zero console errors, requests only to 127.0.0.1.
   Retained screenshots: desktop-mission.png (1440x900) and mobile-mission.png (390x844), real viewports, with a round running.

   The companion runs from a private copy of the files it serves, made in the system temporary folder, so round state is written there and
   the project's own private/ folder is never read or written.

   Environment: CHROME_BIN (default /opt/pw-browsers/chromium-1194/chrome-linux/chrome when it exists), QA_OUTPUT (default qa/mission, relative
   to the repository or absolute), APP_ENTRY (the HTML file the file-edition phase opens, default index.html; with STANDALONE=1 it must be the
   built Finance_Task_Studio.html and must load nothing but itself). */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {cleanEnv}=require('./fixtures/clean-env.cjs');
const root=path.resolve(__dirname,'..'),out=path.resolve(root,process.env.QA_OUTPUT||'qa/mission'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'finance-mission-headless-'));
const defaultChrome='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const binary=process.env.CHROME_BIN||(fs.existsSync(defaultChrome)?defaultChrome:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const stub=path.join(root,'backend','agents','stub-claude.cjs');
fs.mkdirSync(out,{recursive:true});
const PROMPT='Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const GOLD={gold:{decision:'hold',figures:[{label:'Usable cash',value:'1,250',tolerance:1}],notes:'Synthetic gold notes'},fingerprints:[{id:'fp-alpha',label:'Counts available credit as cash',tokens:['available facility counted'],figures:[]}]};
const ACK=['shell-access','network','isolation-by-audit'];
const ANSWER_GOLD='Usable cash is 1,250. Hold the borrowing.';
/* The stub plays entry n for pilot n: 1 states the gold, 2 lands on the fingerprint, 3 reads outside its folder (DISCARDED), 4 exits with an error (failed), 5 is unclear. */
const FAST=[
  {resultText:ANSWER_GOLD,numTurns:6,toolUses:[{name:'Read',input:{file_path:'filesystem/Cash_Facts.csv'},result:'synthetic'}],writeFiles:[{path:'outputs/answer.txt',content:'hold 1,250\n'},{path:'outputs/cash_summary.csv',content:'item,value\ncash,1250\n'}]},
  {resultText:'Available facility counted as cash. Proceed.',numTurns:4,writeFiles:[{path:'outputs/answer.txt',content:'proceed\n'}]},
  {toolUses:[{name:'Read',input:{file_path:'/etc/hosts'},result:'synthetic'}],resultText:'Hold. Usable cash is 1,250.'},
  {exitCode:1,resultText:''},
  {resultText:'Unclear. More data is needed.',numTurns:3,writeFiles:[{path:'outputs/notes.md',content:'unclear\n'}]}
];
/* Pilots 1 and 2 end after 4 s; the others keep running until their round is cancelled. */
const SLOW=[0,1,2,3,4].map(i=>({resultText:'Usable cash is 1,250. Hold.',numTurns:5,toolUses:[{name:'Read',input:{file_path:'filesystem/Cash_Facts.csv'},result:'synthetic'}],delayMs:i<2?4000:240000,writeFiles:[{path:'outputs/slow.txt',content:'hold\n'}]}));
const GRADING=JSON.stringify({grading_runs:[{grading_run_id:'run-synthetic-17',final_score:0.62,scoring_method:'rubric',grading_run_status:'completed',judge:{llm_model:{provider:'synthetic',model:'judge-1'}}}],trajectory_output:{attempt_number:2,final_score:0.62,rewards:[{subscores:[{name:'Accuracy',score:0.62,max_score:1,weight:1,reasoning:'**Facts**\n- PASS the cash figure REASONING-MARKER-do-not-store\n- FAIL the facility treatment'}]}]}});
const FORBIDDEN=/%|pass rate|success rate|failure rate|difficulty|caught/i;
let proc,ws,server,nextId=0,pending=new Map(),errors=[],dialogs=[],requests=[],checks=[],companionRoot=null,packetDir=null,allowedPorts=new Set(),port=0,client=null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++nextId;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timeout});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+' '+JSON.stringify(r.exceptionDetails.exception));return r.result.value;}
async function waitFor(expression,label,timeout=45000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await evaluate(expression);if(last)return last;}catch(error){last=String(error);}await delay(120);}throw new Error('Timed out waiting for '+label+' (last: '+JSON.stringify(last)+')');}
async function click(selector){const found=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`);assert.equal(found,true,'missing control '+selector);await delay(80);}
const text=selector=>evaluate(`(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
const inner=selector=>evaluate(`(document.querySelector(${JSON.stringify(selector)})||{}).innerText||''`);
const KEYS={ArrowDown:[40],ArrowUp:[38],Home:[36],End:[35],Enter:[13,'\r'],Escape:[27],Tab:[9]};
/* A real key event through the browser: the page's handlers and the browser's own focus handling both see it. */
async function press(name,modifiers=0){const [vk,textValue]=KEYS[name]||[name.toUpperCase().charCodeAt(0)];const base={key:KEYS[name]?name:name,code:KEYS[name]?name:'Key'+name.toUpperCase(),windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers};await call('Input.dispatchKeyEvent',{type:'keyDown',...base,...(textValue?{text:textValue}:{})});await call('Input.dispatchKeyEvent',{type:'keyUp',...base});await delay(60);}
async function typeText(selector,value){await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.select&&el.select();})()`);await call('Input.insertText',{text:value});await delay(120);}
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
function makeCompanionRoot(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'finance-mission-companion-'));
  const {ASSETS}=require('../backend/server.cjs');
  for(const name of ASSETS)fs.copyFileSync(path.join(root,name),path.join(dir,name));
  fs.cpSync(path.join(root,'backend'),path.join(dir,'backend'),{recursive:true});
  return dir;
}
async function startServer(scenario){
  if(!port)port=await freePort();
  const child=spawn(process.execPath,[path.join(companionRoot,'backend','server.cjs')],{cwd:companionRoot,env:{...cleanEnv(),FINANCE_STUDIO_PORT:String(port),CLAUDE_BIN:stub,FINANCE_STUB_SCENARIO:JSON.stringify(scenario)},stdio:['ignore','pipe','pipe']});
  let log='';
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Companion did not start. Output so far: '+log.slice(-800))),15000);const onData=d=>{log+=d;if(log.includes('http://127.0.0.1:'+port)){clearTimeout(t);resolve();}};child.stdout.on('data',onData);child.stderr.on('data',onData);child.on('exit',code=>{clearTimeout(t);reject(new Error('Companion exited '+code+': '+log.slice(-800)));});});
  allowedPorts.add(String(port));
  server={child,port,url:'http://127.0.0.1:'+port+'/'};
  client=makeClient('http://127.0.0.1:'+port);
}
async function stopServer(){if(server){const child=server.child;server=null;child.removeAllListeners('exit');child.kill();await delay(250);}}
/* Rounds are made over the companion's own HTTP API, as the Agents page does. */
function makeClient(base){
  let nonce='';
  async function api(method,p,body){
    if(!nonce){nonce=(await (await fetch(base+'/api/status')).json()).nonce;}
    const r=await fetch(base+p,{method,headers:{'content-type':'application/json','x-finance-local':nonce,Origin:base,Accept:'application/json'},body:method==='GET'?undefined:JSON.stringify(body||{})});
    const raw=await r.text();let j={};try{j=JSON.parse(raw);}catch{/* not json */}
    if(!r.ok)throw new Error(method+' '+p+' '+r.status+' '+raw.slice(0,200));
    return j.round||j;
  }
  return {
    create:(label,task,count)=>api('POST','/api/agents/rounds',{label,task,sourceDir:packetDir,promptText:PROMPT,gafVisible:true,config:{model:'claude-opus-5-5',effort:'medium',count}}),
    freeze:id=>api('POST','/api/agents/rounds/'+id+'/freeze',GOLD),
    async approve(id){const r=await api('GET','/api/agents/rounds/'+id);return api('POST','/api/agents/rounds/'+id+'/approve',{summarySha256:r.summarySha256,acknowledgements:ACK});},
    launch:id=>api('POST','/api/agents/rounds/'+id+'/launch',{}),
    cancel:id=>api('POST','/api/agents/rounds/'+id+'/cancel',{}),
    get:id=>api('GET','/api/agents/rounds/'+id),
    classify:(id,n,verdict,fingerprintIds)=>api('POST','/api/agents/rounds/'+id+'/runs/'+n+'/classify',{verdict,fingerprintIds:fingerprintIds||[]}),
    async ended(id,t=60000){const end=Date.now()+t;for(;;){const r=await api('GET','/api/agents/rounds/'+id);if(['finished','failed','cancelled'].includes(r.status))return r;if(Date.now()>end)throw new Error('round did not end '+id);await delay(250);}},
    async finished(label,task,count){const r=await this.create(label,task,count);await this.freeze(r.id);await this.approve(r.id);await this.launch(r.id);await this.ended(r.id);return r.id;}
  };
}
function makePacket(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'finance-mission-packet-'));
  fs.mkdirSync(path.join(dir,'filesystem'),{recursive:true});
  fs.writeFileSync(path.join(dir,'filesystem','Facility_Terms.txt'),'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  fs.writeFileSync(path.join(dir,'filesystem','Cash_Facts.csv'),'Label,Value\nOpening usable cash,100\nConfirmed funded draw,500\n');
  return dir;
}
async function metrics(width,height){await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});await delay(250);}
/* Layout checks that hold for every state: nothing scrolls sideways, no text is under 12px, no percentage or rate wording. */
async function layoutChecks(label){
  for(const [w,h] of [[1440,1000],[1280,800],[390,844]]){
    await metrics(w,h);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,label+': horizontal overflow at '+w+'x'+h);
    const small=await evaluate(`(()=>{const out=[];const root=document.querySelector('#mc-root');if(!root)return out;const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);for(let n=walk.nextNode();n;n=walk.nextNode()){if(!n.textContent.trim())continue;const el=n.parentElement;if(!el||el.closest('.sr-only,[hidden]'))continue;const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')continue;const size=parseFloat(cs.fontSize);if(size<12)out.push(el.className+' '+size+' '+n.textContent.trim().slice(0,30));}return out;})()`);
    assert.deepEqual(small,[],label+': text under 12px at '+w);
  }
  await metrics(1440,1000);
  const visible=await inner('#mc-root');
  assert.doesNotMatch(visible,FORBIDDEN,label+': no percentage, rate or difficulty wording');
  assert.doesNotMatch(visible,/\b(?:ready|done|works|fails)\b/i,label+': never says ready, done, works or fails');
  assert.equal(await evaluate('document.title'),'Finance Task Studio',label+': the tab title is not touched');
  assert.deepEqual(await evaluate('(()=>{const seen=new Set(),dup=[];for(const el of document.querySelectorAll("[id]")){if(seen.has(el.id))dup.push(el.id);seen.add(el.id);}return dup;})()'),[],label+': every id is unique');
  assert.equal(await evaluate('[...document.querySelectorAll("#mc-root label[for]")].every(l=>{const t=document.getElementById(l.getAttribute("for"));return !!t&&/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);})'),true,label+': every label points at a form control');
  assert.equal(await evaluate('document.querySelectorAll("#mc-root button.primary").length<=1'),true,label+': at most one yellow button');
  assert.equal(await evaluate('document.querySelectorAll("#mc-root [role=status]").length'),1,label+': one polite live region');
}
async function screenshot(name,width,height){await metrics(width,height);await evaluate('document.activeElement&&document.activeElement.blur();window.scrollTo(0,0)');await delay(150);const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));checks.push(name+' saved (real viewport '+width+'x'+height+')');}
async function openMission(url){
  await call('Page.navigate',{url});
  await waitFor('document.readyState==="complete"&&!!window.FinanceMission&&!!window.FinanceDashboard','page load',15000);
  /* focus emulation does not survive a navigation to another origin: without it the page has no focus and focus events never fire */
  await call('Emulation.setFocusEmulationEnabled',{enabled:true});await call('Page.bringToFront');
  await waitFor('document.hasFocus()','the page to have focus',5000);
  await click('[data-dash-tab="mission"]');
  await waitFor('!!document.querySelector("#mc-root")','the Mission Control view',10000);
}
const rows=()=>evaluate('[...document.querySelectorAll("#mc-feed [role=option]")].map(r=>r.getAttribute("data-key"))');
const active=()=>evaluate(`(()=>{const f=document.querySelector('#mc-feed');const id=f.getAttribute('aria-activedescendant');const opt=id&&document.getElementById(id);return opt?{key:opt.getAttribute('data-key'),dataActive:opt.getAttribute('data-active')}:null;})()`);
const poll=()=>evaluate('document.dispatchEvent(new Event("visibilitychange"))');
(async()=>{try{
  proc=spawn(binary,[...(process.getuid&&process.getuid()===0?['--no-sandbox']:[]),'--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-sync','--metrics-recording-only','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const browserURL=await new Promise((resolve,reject)=>{let t='';const timer=setTimeout(()=>reject(new Error('Headless browser startup timeout')),15000);proc.stderr.on('data',d=>{t+=d;const m=t.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});proc.on('error',reject);proc.on('exit',code=>{if(code)reject(new Error('Headless browser exited '+code+' '+t.slice(-1200)));});});
  const origin=browserURL.replace(/^ws:/,'http:').split('/devtools/')[0];const targets=await(await fetch(origin+'/json/list')).json();const target=targets.find(x=>x.type==='page');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);clearTimeout(p.timeout);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);
    if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push(m.params.entry);
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push({console:m.params.args.map(a=>a.value||a.description).join(' ')});
    if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);
    if(m.method==='Page.javascriptDialogOpening')dialogs.push(m.params.message);});
  const browserVersion=await call('Browser.getVersion');
  await call('Page.enable');await call('Runtime.enable');await call('Log.enable');await call('Network.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await metrics(1440,1000);

  /* 1. The file edition: an offline banner, Not available, no request, Load task package is the one yellow button. */
  await openMission('file://'+(process.env.APP_ENTRY?path.resolve(process.env.APP_ENTRY):path.join(root,'index.html')));
  await waitFor('/Local agents need the companion: run npm start\\./.test(document.querySelector("#mc-root").innerText)','the offline banner');
  assert.match(await inner('#mc-root'),/Active agents: Not available/);
  assert.doesNotMatch(await inner('#mc-root'),/\b0 pilots running/,'never a zero for what is not known');
  assert.equal(await evaluate('[...document.querySelectorAll("#mc-root button.primary")].map(b=>b.getAttribute("data-mc")).join()'),'load');
  assert.equal(await evaluate('document.querySelectorAll("#mc-feed [role=option]").length'),0);
  await delay(500);
  assert.equal(requests.filter(u=>/^https?:/.test(u)).length,0,'the file edition makes no HTTP request');
  if(process.env.STANDALONE==='1')assert.equal(requests.filter(u=>u.startsWith('file:')).length,1,'the standalone edition loads only its HTML file');
  await layoutChecks('file edition');
  checks.push('file edition: offline banner, Not available, Load task package is the only yellow button, no request');

  /* 2. A companion with finished rounds: Atlas (5 pilots, classify two), Meridian (3) and a Borealis draft. */
  packetDir=makePacket();companionRoot=makeCompanionRoot();
  await startServer(FAST);
  const atlas=await client.finished('Atlas round 1','Atlas',5);
  await client.classify(atlas,1,'matches-frozen-gold');await client.classify(atlas,2,'fingerprint',['fp-alpha']);
  const meridian=await client.finished('Meridian round 1','Meridian',3);
  const borealis=(await client.create('Borealis round 1','Borealis',5)).id;
  await call('Browser.grantPermissions',{permissions:['clipboardReadWrite','clipboardSanitizedWrite'],origin:'http://127.0.0.1:'+port});
  await openMission(server.url);
  await waitFor('document.querySelectorAll("#mc-feed [role=option]").length===8','the feed');
  assert.equal(await evaluate('document.querySelectorAll("#mc-cards .mc-card").length'),3,'one card per task');
  assert.equal(await evaluate('[...document.querySelectorAll("[data-mc=card]")].every(b=>b.getAttribute("aria-pressed")==="false")'),true,'cards are toggle buttons');
  assert.equal(await evaluate('[...document.querySelectorAll("#mc-root button.primary")].length'),1,'one yellow button');
  const cards=await inner('#mc-cards');
  for(const phrase of ['Atlas','Meridian','Borealis','No score recorded','0 active','Classify 2 clean pilots','Freeze the round'])assert.ok(cards.includes(phrase),'cards say: '+phrase);
  assert.ok(!cards.includes('Pilots and the simulated grader'),'the cards carry only the short score line; the exact sentence is in the Details');
  assert.match(await text('#mc-stepper'),/QueuedRunningClassifyComplete|Queued[\s\S]*Running[\s\S]*Classify[\s\S]*Complete/);
  assert.equal(await evaluate('document.querySelectorAll("#mc-stepper [aria-current=step]").length'),1,'one current stage');
  assert.equal(await evaluate('document.querySelector("#mc-details details").open'),false,'Details are closed by default');
  assert.equal(await evaluate('document.querySelector("#mc-feed").getAttribute("role")'),'listbox');
  assert.equal(await evaluate('document.querySelectorAll("#mc-feed [role=option]").length'),8);
  assert.deepEqual(await rows(),[1,2,3].map(n=>meridian+':'+n).concat([1,2,3,4,5].map(n=>atlas+':'+n)),'newest round first, pilots in order');
  const feedText=await inner('#mc-feed');
  for(const word of ['COMPLETED','DISCARDED','FAILED'])assert.ok(feedText.includes(word),'the feed names '+word);
  assert.match(feedText,/The program exited with code 1/);
  checks.push('the board: three cards with aria-pressed, one yellow button, the stepper with one current stage, Details closed, the feed in order with COMPLETED, DISCARDED and FAILED rows');

  /* 2b. The first screen: the run feed is the large central panel and its rows are in view without scrolling, the cards line up and do not
     change size when one is selected, the header is one line at 1280px and the search shows its whole placeholder. */
  for(const [w,h,rowsWanted] of [[1440,900,4],[1280,800,2]]){
    await metrics(w,h);await evaluate('window.scrollTo(0,0)');await delay(250);
    const fold=await evaluate(`(()=>{const f=document.querySelector('#mc-feed'),box=f.getBoundingClientRect(),rows=[...f.querySelectorAll('[role=option]')].filter(r=>{const b=r.getBoundingClientRect();return b.top>=box.top-1&&b.bottom<=innerHeight;});const head=document.querySelector('.mc-heading').getBoundingClientRect(),tools=document.querySelector('.mc-tools').getBoundingClientRect();
      const input=document.querySelector('#mc-search'),cs=getComputedStyle(input),ctx=document.createElement('canvas').getContext('2d');ctx.font=cs.fontStyle+' '+cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily;const need=ctx.measureText(input.placeholder).width,room=input.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);
      const tops=[...document.querySelectorAll('.mc-next-btn')].map(b=>Math.round(b.getBoundingClientRect().top));
      return {rows:rows.length,feedWidth:Math.round(box.width),oneLine:tools.top<head.bottom,placeholderFits:need<=room+1,tops,cards:document.querySelectorAll('#mc-cards .mc-card').length};})()`);
    assert.ok(fold.rows>=rowsWanted,`at ${w}x${h} at least ${rowsWanted} feed rows are fully in view without scrolling (saw ${fold.rows})`);
    assert.ok(fold.feedWidth>=540,`at ${w}x${h} the feed is the wide panel (${fold.feedWidth}px)`);
    assert.equal(fold.oneLine,true,`at ${w}x${h} the title and the tools share one line`);
    assert.equal(fold.placeholderFits,true,`at ${w}x${h} the search shows its whole placeholder`);
    assert.equal(new Set(fold.tops).size,1,`at ${w}x${h} the three next-action buttons are on one line: ${fold.tops}`);
  }
  await metrics(1440,900);
  const stable=()=>evaluate('(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return [Math.round(b.top),Math.round(b.height)];};return JSON.stringify([r("#mc-cards"),Math.round(document.querySelector("#mc-stage").getBoundingClientRect().top),[...document.querySelectorAll("#mc-cards .mc-card")].map(c=>Math.round(c.getBoundingClientRect().height))]);})()');
  const beforeSelect=await stable();
  await click('[data-mc=card][data-task="task:atlas"]');await waitFor('document.querySelectorAll("#mc-feed [role=option]").length===5','the card to filter the feed');
  assert.equal(await stable(),beforeSelect,'selecting a card changes the size of no card and moves nothing below them');
  await click('[data-mc=card][data-task="task:atlas"]');await waitFor('document.querySelectorAll("#mc-feed [role=option]").length===8','the filter to clear');
  checks.push('the first screen: at 1440x900 four feed rows and at 1280x800 two are in view without scrolling, the feed is the wide panel, the title and tools share one line with the whole placeholder visible, the next-action buttons line up, and selecting a card changes no size');

  /* 3. The feed is a listbox driven by real keys: arrows move the cursor (focus stays), Enter selects, Escape closes the inspector. */
  await evaluate('document.querySelector("#mc-feed").focus()');
  await delay(100);
  let cur=await active();assert.ok(cur&&cur.dataActive==='true','focusing the feed puts the cursor on a row: '+await evaluate('JSON.stringify({a:document.activeElement.id,ad:document.querySelector("#mc-feed").getAttribute("aria-activedescendant"),n:document.querySelectorAll("#mc-feed [role=option]").length,ids:[...document.querySelectorAll("#mc-feed [role=option]")].map(o=>o.id+"/"+o.getAttribute("data-active"))})'));
  assert.equal(await evaluate('document.activeElement.id'),'mc-feed');
  await press('ArrowDown');await press('ArrowDown');
  const third=await active();assert.equal(third.key,meridian+':3','two arrow-downs reach the third row');
  assert.equal(await evaluate('document.activeElement.id'),'mc-feed','DOM focus never leaves the listbox');
  await press('End');assert.equal((await active()).key,atlas+':5');
  await press('Home');assert.equal((await active()).key,meridian+':1');
  await press('ArrowDown');await press('ArrowDown');
  assert.equal(await evaluate('document.querySelector("#mc-inspector").hidden'),true,'moving the cursor opens nothing');
  await press('Enter');
  await waitFor('!document.querySelector("#mc-inspector").hidden&&/DISCARDED/.test(document.querySelector("#mc-inspector").innerText)','the inspector of the third pilot');
  assert.equal(await evaluate('document.querySelector("#mc-feed [aria-selected=true]").getAttribute("data-key")'),meridian+':3');
  const ins=await inner('#mc-inspector');
  for(const phrase of ['What ran','What happened','Where the output is','Working folder','Evidence path','private/agent-rounds/'+meridian+'/runs/3/outputs/','Output files','Discarded by the audit'])assert.ok(ins.includes(phrase),'the inspector says: '+phrase);
  assert.equal(await evaluate('document.activeElement.id'),'mc-feed','selecting does not steal focus');
  await press('Escape');
  await waitFor('document.querySelector("#mc-inspector").hidden','the inspector to close');
  assert.equal(await evaluate('document.activeElement.id'),'mc-feed','Escape returns focus to the feed');
  assert.equal(await evaluate('document.querySelector("#mc-feed [aria-selected=true]")'),null);
  /* a click selects too, and the inspector shows the answer when no round runs */
  await click('#mc-feed [data-key="'+atlas+':1"]');
  await waitFor('/Final answer/.test(document.querySelector("#mc-inspector").innerText)','the answer of the first Atlas pilot');
  await click('#mc-inspector summary');
  await waitFor('/Usable cash is 1,250\\. Hold the borrowing\\./.test(document.querySelector("#mc-inspector").innerText)','the answer text');
  assert.match(await inner('#mc-inspector'),/answer\.txt/);
  /* Copy path puts the evidence path on the real clipboard */
  await click('#mc-inspector [data-mc=copy]');
  await waitFor('document.querySelector("#mc-inspector [data-mc=copy]").textContent==="Copied"','the copy confirmation');
  assert.equal(await evaluate('navigator.clipboard.readText()'),'private/agent-rounds/'+atlas+'/runs/1/outputs/');
  assert.equal(await evaluate('document.querySelectorAll("#mc-root a[href], #mc-root [download]").length'),0,'nothing is offered as a download');
  assert.match(await text('#mc-status'),/Copied the path to the clipboard\./);
  /* Open in Agents hands the run to the Agents page, which opens that pilot's drawer; coming back finds the inspector as it was */
  await click('#mc-inspector [data-mc=open-agents]');
  await waitFor('FinanceDashboard.getView()==="agents"&&!!document.querySelector("#ag-root")','the Agents page');
  await waitFor('!!document.querySelector("#agents-modal [role=dialog]")','the pilot drawer opened by openRun',20000);
  assert.ok((await inner('#agents-modal')).includes('private/agent-rounds/'+atlas+'/runs/1/outputs/'),'the drawer is the one of the pilot that was inspected');
  await click('#agents-modal [data-ag="close-overlay"]');
  await click('[data-dash-tab="mission"]');
  await waitFor('!!document.querySelector("#mc-root")&&!document.querySelector("#mc-inspector").hidden','the inspector after coming back');
  assert.equal(await evaluate('document.querySelector("#mc-feed [aria-selected=true]").getAttribute("data-key")'),atlas+':1','the same run is still selected');
  await press('Escape');
  checks.push('the feed is a listbox: Arrow, Home, End move the cursor with focus unchanged, Enter selects and opens the inspector (what ran, what happened, where the output is), Escape closes it and returns focus; Copy path reaches the clipboard');

  /* 4. Ctrl K, search, and card selection. */
  await press('k',2);
  assert.equal(await evaluate('document.activeElement.id'),'mc-search','Ctrl K focuses the search field');
  await call('Input.insertText',{text:'meridian'});
  await waitFor('document.querySelectorAll("#mc-cards .mc-card").length===1&&document.querySelectorAll("#mc-feed [role=option]").length===3','the search to filter');
  await waitFor('/1 task, 3 runs/.test(document.querySelector("#mc-status").textContent)','the result count to be announced',5000);
  await evaluate('(()=>{const el=document.querySelector("#mc-search");el.value="";el.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await waitFor('document.querySelectorAll("#mc-cards .mc-card").length===3','the search to clear');
  await click('[data-mc=card][data-task="task:atlas"]');
  await waitFor('document.querySelectorAll("#mc-feed [role=option]").length===5','the card to filter the feed');
  assert.equal(await evaluate('document.querySelector("[data-task=\\"task:atlas\\"]").getAttribute("aria-pressed")'),'true');
  assert.match(await inner('#mc-live'),/Atlas/);
  await click('[data-mc=card][data-task="task:atlas"]');
  await waitFor('document.querySelectorAll("#mc-feed [role=option]").length===8','the second click to clear the filter');
  await evaluate('document.querySelector("#mc-stage-filter").value="failed";document.querySelector("#mc-stage-filter").dispatchEvent(new Event("change",{bubbles:true}))');
  await waitFor('document.querySelectorAll("#mc-feed [role=option]").length===1','the stage filter');
  await evaluate('document.querySelector("#mc-stage-filter").value="all";document.querySelector("#mc-stage-filter").dispatchEvent(new Event("change",{bubbles:true}))');
  await waitFor('document.querySelectorAll("#mc-feed [role=option]").length===8','the stage filter to clear');
  checks.push('Ctrl K focuses the search; the search filters cards, feed and outputs and announces the count; a card filters and a second click clears; the stage filter narrows the feed');

  /* A next-action button hands the round to the Agents page at the right step. */
  await click('[data-mc=next][data-task="task:borealis"]');
  await waitFor('FinanceDashboard.getView()==="agents"','the Agents page from a next action');
  await waitFor('(document.querySelector("#ag-strip")||{}).textContent&&document.querySelector("#ag-strip").textContent.includes('+JSON.stringify(borealis)+')','the Borealis round selected in Agents',20000);
  await click('[data-dash-tab="mission"]');
  await waitFor('document.querySelectorAll("#mc-cards .mc-card").length===3','Mission Control again');
  checks.push('Open in Agents from the inspector opens that pilot drawer; a next-action button selects that round in Agents; coming back finds the inspector and cards as they were');

  /* 5. Importing an evaluation result: a bad file, then a good one. */
  assert.equal(await evaluate('document.querySelector("[data-mc=import]").getAttribute("aria-expanded")'),'false');
  await click('[data-mc=import]');
  await waitFor('!!document.querySelector("[data-mc=import-choose]")','the import panel');
  assert.equal(await evaluate('document.querySelector("[data-mc=import]").getAttribute("aria-expanded")'),'true');
  assert.equal(await evaluate('!!document.getElementById(document.querySelector("[data-mc=import]").getAttribute("aria-controls"))'),true,'aria-controls names an element');
  const feedFile=(name,content)=>evaluate(`(()=>{document.querySelector('[data-mc=import-choose]').click();const input=document.querySelector('#mc-import-file');if(!input)return 'no input';const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:'application/json'}));input.files=dt.files;input.dispatchEvent(new Event('change'));return input.hidden&&input.type;})()`);
  assert.equal(await feedFile('notes.txt','this is not json'),'file','a hidden file input of type file');
  await waitFor('/is not valid JSON/.test(document.querySelector("#mc-import").innerText)','the bad file error');
  assert.match(await inner('#mc-import'),/Could not use notes\.txt\. The evaluation result is not valid JSON\./);
  assert.equal(await evaluate('localStorage.getItem("fts.evals.v1")'),null,'a bad file records nothing');
  await feedFile('grading_run.json',GRADING);
  await waitFor('!!document.querySelector("[data-mc=import-save]")','the parsed file');
  assert.match(await inner('#mc-import'),/0\.62 \/ 1/);
  await click('[data-mc=import-save]');
  assert.match(await inner('#mc-import'),/Type the task name this result belongs to\./);
  await typeText('#mc-imp-task','Atlas');
  await click('[data-mc=import-save]');
  await waitFor('/Imported evaluation result: 0\\.62 \\/ 1, run run-synthetic-17/.test(document.querySelector("#mc-cards").innerText)','the card to show the result');
  assert.match(await inner('#mc-cards'),/Recorded by you from the evaluation; Finance Task Studio did not compute it\./);
  const stored=await evaluate('localStorage.getItem("fts.evals.v1")');
  assert.ok(stored&&!stored.includes('REASONING-MARKER'),'the reasoning text is not stored');
  assert.equal(JSON.parse(stored)[0].task,'Atlas');
  await call('Page.reload');await waitFor('!!window.FinanceMission','reload');await click('[data-dash-tab="mission"]');
  await waitFor('/Imported evaluation result: 0\\.62 \\/ 1/.test(document.querySelector("#mc-cards").innerText)','the stored result after a reload');
  await evaluate('localStorage.removeItem("fts.evals.v1")');
  await call('Page.reload');await waitFor('!!window.FinanceMission','reload');await click('[data-dash-tab="mission"]');
  await waitFor('document.querySelectorAll("#mc-cards .mc-card").length===3','cards after clearing');
  checks.push('importing an evaluation result: a bad file gives a clear error and records nothing; a good file needs a task name, shows on the card verbatim, keeps no reasoning text and survives a reload');
  await layoutChecks('companion, idle');

  /* 6. Keyboard: Tab reaches the controls in order, each with a visible focus ring. */
  await evaluate('document.activeElement&&document.activeElement.blur();window.scrollTo(0,0)');
  const stops=[];
  await evaluate('(()=>{const m=document.querySelector("#mc-root");const first=document.querySelector("#mc-search");first.focus();})()');
  for(let i=0;i<30;i++){
    const stop=await evaluate(`(()=>{const el=document.activeElement;if(!el||el===document.body)return null;const cs=getComputedStyle(el),after=getComputedStyle(el,'::after');const row=el.id==='mc-feed'?el.querySelector('[data-active=true]'):null,rs=row?getComputedStyle(row):null;const ring=(cs.outlineStyle!=='none'&&parseFloat(cs.outlineWidth)>=2)||(after.outlineStyle!=='none'&&parseFloat(after.outlineWidth)>=2)||(!!rs&&rs.outlineStyle!=='none'&&parseFloat(rs.outlineWidth)>=2);return {tag:el.tagName,id:el.id,mc:el.getAttribute('data-mc')||el.getAttribute('data-mc-in')||'',inRoot:!!el.closest('#mc-root'),ring};})()`);
    if(stop&&stop.inRoot)stops.push(stop);
    if(stop&&!stop.inRoot)break;
    await press('Tab');
  }
  assert.ok(stops.length>=14,'Tab visits the page controls: '+stops.length);
  assert.deepEqual(stops.slice(0,3).map(s=>s.id||s.mc),['mc-search','load','import'],'search, Load task package, Import evaluation result come first');
  assert.ok(stops.findIndex(s=>s.id==='mc-feed')>=0&&stops.findIndex(s=>s.id==='mc-feed')<stops.findIndex(s=>s.mc==='view-run'),'the feed is reached before the live run, which sits to its right');assert.ok(stops.some(s=>s.mc==='card'),'cards are reachable');assert.ok(stops.some(s=>s.mc==='next'),'next-action buttons are reachable');assert.ok(stops.some(s=>s.id==='mc-feed'),'the feed is reachable');
  const noRing=stops.filter(s=>!s.ring);assert.deepEqual(noRing,[],'every Tab stop shows a focus ring: '+JSON.stringify(noRing));
  checks.push('Tab order starts search, Load, Import, then cards, next actions, stage filter, feed; every one of '+stops.length+' stops has a 2px focus ring');

  /* 7. A round runs: restart the companion with slow pilots. */
  await call('Page.navigate',{url:'about:blank'});
  await stopServer();await startServer(SLOW);
  await client.freeze(borealis);await client.approve(borealis);await client.launch(borealis);
  await openMission(server.url);
  await waitFor('/Streaming live\\.\\.\\./.test(document.querySelector("#mc-feedbar").innerText)&&document.querySelectorAll("#mc-feed [role=option]").length===13','the running round in the feed',30000);
  assert.equal(await evaluate('document.querySelector("#mc-live-head").innerText.includes("Live run")'),true);
  assert.match(await inner('#mc-cards'),/[1-5] active/,'Borealis shows its running pilots');
  const redacted=await inner('#mc-root');
  assert.ok(redacted.includes('Details withheld while a round runs'),'the page says the details are withheld');
  for(const secret of [ANSWER_GOLD,'Synthetic gold notes','Counts available credit as cash','available facility counted','fp-alpha','Assess the Atlas liquidity','cash_summary.csv',packetDir])assert.ok(!(await evaluate('document.documentElement.outerHTML')).includes(secret),'"'+secret+'" must not be on the page while a round runs');
  assert.equal(await evaluate('[...document.querySelectorAll("#mc-root button.primary")].map(b=>b.getAttribute("data-task")).join()'),'task:borealis','the running round holds the one yellow button');
  assert.equal(await evaluate('[...document.querySelectorAll("[data-mc=next][disabled]")].length'),2,'classification waits for the round');
  /* the inspector of a finished pilot: no answer text, kinds only in the log */
  await click('#mc-feed [data-key="'+atlas+':1"]');
  await waitFor('/Details withheld while a round runs/.test(document.querySelector("#mc-inspector").innerText)','the inspector while a round runs');
  assert.doesNotMatch(await inner('#mc-inspector'),/Usable cash/);
  await click('#mc-inspector [data-mc=close-inspector]');
  checks.push('while a round runs: Streaming live..., running pilots counted, Details withheld while a round runs, no gold, fingerprint, prompt, answer or file name anywhere in the page, the running round holds the single yellow button');
  await screenshot('desktop-mission',1440,900);
  await screenshot('mobile-mission',390,844);
  await layoutChecks('companion, round running');

  /* 8. Polls do not move focus or scroll, and the polite region announces a finished pilot once. A row that changes its own height (a pilot that ends) moves what is below it, as it must, so the polls are watched once the first two pilots have ended. */
  await metrics(1440,1000);
  await waitFor('[...document.querySelectorAll("#mc-feed [role=option]")].slice(0,5).filter(r=>/COMPLETED/.test(r.innerText)).length>=2','two Borealis pilots to end',30000);
  await evaluate('document.querySelector("#mc-feed").focus()');await press('ArrowDown');await press('ArrowDown');await press('ArrowDown');
  await evaluate('document.querySelector("#mc-feed").scrollTop=150');await delay(150);
  await click('#mc-details summary');
  assert.equal(await evaluate('document.querySelector("#mc-details details").open'),true,'Details open on request');
  assert.match(await inner('#mc-details'),/Directional only, n = \d+\./);
  assert.match(await inner('#mc-details'),/Run progress/);
  await evaluate('document.querySelector("#mc-feed").focus()');
  const before={active:await active(),top:await evaluate('document.querySelector("#mc-feed").scrollTop'),focus:await evaluate('document.activeElement.id'),order:await rows()};
  assert.ok(before.top>=100,'the feed is scrolled: '+before.top);
  /* count the feed requests the page makes (the resource timing buffer is small and fills up) */
  await evaluate('(()=>{if(window.__polls===undefined){window.__polls=0;const f=window.fetch;window.fetch=function(...a){if(/\\/api\\/agents\\/runs\\?limit=/.test(String(a[0])))window.__polls++;return f.apply(this,a);};}})()');
  const polls0=await evaluate('window.__polls');
  await poll();await delay(300);await poll();await delay(300);await poll();
  await waitFor(`window.__polls>=${polls0+3}`,'three polls',15000);
  await delay(300);
  const after={active:await active(),top:await evaluate('document.querySelector("#mc-feed").scrollTop'),focus:await evaluate('document.activeElement.id'),order:await rows()};
  assert.deepEqual(after.active,before.active,'the cursor did not move across three polls');
  assert.equal(after.focus,before.focus,'focus did not move');
  assert.ok(Math.abs(after.top-before.top)<=1,'scroll position unchanged: '+before.top+' -> '+after.top);
  assert.deepEqual(after.order,before.order,'row order unchanged');
  assert.equal(await evaluate('document.querySelector("#mc-details details").open'),true,'Details stay open across polls');
  await waitFor('/Borealis: pilot [12] completed\\./.test(document.querySelector("#mc-status").textContent)','a finished pilot to be announced',30000);
  const said=await text('#mc-status');assert.ok(said.length<=160,'at most 160 characters');assert.doesNotMatch(said,/tool call|running|%/,'no progress chatter');
  assert.equal(await evaluate('document.querySelectorAll("#mc-root [aria-live],#mc-root [role=status],#mc-root [role=alert]").length'),2,'the polite region and the alert region, nothing else');
  assert.equal(await text('#mc-alert'),'','no alert while the link is up');
  assert.equal(await evaluate('document.querySelector("#mc-feed").scrollTop>=100'),true,'the announcement did not move the feed');
  checks.push('three polls leave focus, the cursor, the scroll position and the row order unchanged; a finished pilot is announced once in the polite region');

  /* 9. Reduced motion: no animation runs; with motion allowed the live dot pulses. */
  assert.equal(await evaluate('document.getAnimations().filter(a=>a.playState==="running").length>0'),true,'motion allowed: the live dot pulses');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await delay(300);
  assert.equal(await evaluate('document.getAnimations().filter(a=>a.playState==="running").length'),0,'reduced motion: nothing animates');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  checks.push('prefers-reduced-motion: reduce stops every animation; without it the live dot pulses');

  /* 10. A new round arrives while the feed is scrolled: N new, and the view does not jump. */
  await client.cancel(borealis);await client.ended(borealis);
  await waitFor('!/Streaming live/.test(document.querySelector("#mc-feedbar").innerText)','the cancelled round to end',20000);
  await evaluate('document.querySelector("#mc-feed").scrollTop=150');await delay(200);
  const cobalt=(await client.create('Cobalt round 1','Cobalt',3)).id;await client.freeze(cobalt);await client.approve(cobalt);await client.launch(cobalt);
  await waitFor('!!document.querySelector("[data-mc=new]")','the N new button',20000);
  assert.match(await text('[data-mc=new]'),/^\d+ new$/);
  assert.ok(await evaluate('document.querySelector("#mc-feed").scrollTop>=100'),'the feed kept its place when rows arrived above it');
  await click('[data-mc=new]');
  await waitFor('document.querySelector("#mc-feed").scrollTop<=4&&!document.querySelector("[data-mc=new]")','N new to scroll to the top');
  assert.equal(await evaluate('document.querySelector("#mc-feed [role=option]").getAttribute("data-key")'),cobalt+':1','the newest round is first');
  checks.push('a round that arrives while the feed is scrolled shows N new without moving the view, and N new returns to the top');
  await client.cancel(cobalt);await client.ended(cobalt);

  /* 11. The link is lost: an alert once, a stale marker, Retry now; then it comes back. */
  const errorsBefore=errors.length;
  await stopServer();
  await poll();await delay(400);await poll();
  await waitFor('/The link to the local companion was lost/.test(document.querySelector("#mc-alert").textContent)','the link-lost alert',15000);
  const alert=await text('#mc-alert');await poll();await delay(300);await poll();await delay(300);
  assert.equal(await text('#mc-alert'),alert,'announced once');
  assert.match(await inner('#mc-note'),/Showing what was last seen at \d\d:\d\d:\d\d\./);
  assert.match(await inner('#mc-strip'),/Link lost/);assert.match(await inner('#mc-strip'),/Active agents: Not available/);
  assert.equal(await evaluate('!!document.querySelector("[data-mc=retry]")'),true);
  assert.equal(await evaluate('document.querySelectorAll("#mc-root button.primary").length'),0,'no yellow button without the companion');
  assert.ok(await evaluate('document.querySelectorAll("#mc-cards .mc-card").length')>=3,'the last data stays');
  const lostErrors=errors.splice(errorsBefore);
  assert.ok(lostErrors.every(e=>/ERR_CONNECTION_REFUSED|Failed to fetch|net::ERR/.test(JSON.stringify(e))),'only refused connections were logged while the companion was down: '+JSON.stringify(lostErrors.slice(0,3)));
  await startServer(FAST);
  await click('[data-mc=retry]');
  await waitFor('!/Link lost/.test(document.querySelector("#mc-strip").innerText)&&!document.querySelector("[data-mc=retry]")','the link to come back',20000);
  assert.match(await inner('#mc-strip'),/Local companion/);
  checks.push('a stopped companion is announced once as an alert, keeps the last data with a stale marker and no yellow button; Retry now brings it back');
  await layoutChecks('companion, back');

  /* 12. Global assertions. */
  const web=requests.filter(u=>/^https?:/.test(u));
  assert.ok(web.length>0,'the companion was exercised');
  for(const url of web){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1','request left the machine: '+url);assert.ok(allowedPorts.has(u.port),'request to an unknown port: '+url);}
  const api=web.filter(u=>new URL(u).pathname.startsWith('/api/'));assert.ok(api.length>0);
  for(const url of api)assert.match(new URL(url).pathname,/^\/api\/(?:status|agents\/(?:rounds|runs)(?:\/|$))/,'only the documented read routes: '+url);
  assert.deepEqual(dialogs,[],'no alert, confirm or prompt dialog may open');
  assert.equal(errors.length,0,'Browser console/runtime errors: '+JSON.stringify(errors));
  checks.push('every request went to 127.0.0.1 and to a read route; zero console errors apart from the refused connections of the stopped companion; zero dialogs');
  fs.writeFileSync(path.join(out,'browser-report.json'),JSON.stringify({passed:true,checks,requestCount:web.length,apiRequestCount:api.length,hosts:[...new Set(web.map(u=>new URL(u).hostname))],consoleErrors:errors,dialogs,browser:'Isolated headless Chromium',browserVersion,node:process.version,viewports:['1440x1000','1280x800','390x844'],screenshots:['desktop-mission.png','mobile-mission.png']},null,2)+'\n');
  console.log(JSON.stringify({passed:true,checks},null,2));
}catch(error){console.error(error);fs.writeFileSync(path.join(out,'browser-report.json'),JSON.stringify({passed:false,checks,error:String(error),errors,dialogs,requests:requests.filter(u=>/^https?:/.test(u)).slice(-40)},null,2)+'\n');process.exitCode=1;}finally{await stopServer().catch(()=>{});if(ws){try{await call('Browser.close');}catch{/* closing */}try{ws.close();}catch{/* closed */}}if(proc)proc.kill();await delay(300);for(const dir of [profile,companionRoot,packetDir])if(dir){try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{/* the system temporary folder is cleaned up anyway */}}setTimeout(()=>process.exit(process.exitCode||0),300);}})();
