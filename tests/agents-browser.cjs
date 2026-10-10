/* Optional developer QA for the Agents page (not part of npm test). Uses an isolated headless Chromium profile and never attaches
   to an existing browser. It starts backend/server.cjs as a child process on a free port with CLAUDE_BIN pointing at the test double
   backend/agents/stub-claude.cjs, so no model is ever started. Everything it types is synthetic.

   Flow: offline edition message, inspect a synthetic packet folder (with a hostile file name), freeze, stepper cap, stale freeze,
   approve and launch 2 pilots, classify both, export. Then the server is restarted with the stub's violation scenario and a second
   round produces a DISCARDED run, which must not be classifiable or exported.

   The companion runs from a private copy of the files it serves, made in the system temporary folder, so round state is written
   there and the project's own private/ folder is never read or written.

   Environment: CHROME_BIN (default /opt/pw-browsers/chromium-1194/chrome-linux/chrome when it exists), QA_OUTPUT (default qa/agents),
   AGENTS_TEST_SERVER (debugging only: run another server entry point instead of the copy of backend/server.cjs). */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,process.env.QA_OUTPUT||'qa/agents'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'finance-studio-headless-'));
const defaultChrome='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const binary=process.env.CHROME_BIN||(fs.existsSync(defaultChrome)?defaultChrome:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const stub=path.join(root,'backend','agents','stub-claude.cjs');
/* The stub's scenario switch (header of backend/agents/stub-claude.cjs): JSON text; an array is indexed by the trailing -n of the
   pilot's folder name. Pilot 1 states the gold, pilot 2 lands on the first fingerprint. Neither makes tool calls, because the
   simulated grader and the author review run in folders that pick scenario 1. The second server run makes a call outside the folder. */
const SCENARIO_ENV='FINANCE_STUB_SCENARIO';
const SCENARIO_CLEAN=JSON.stringify([
  {resultText:'Decision: approve. Units owed: 2,480. {"verdict":"meets-guidance","reason":"The answer states the guided figure."}',writeFiles:[{path:'outputs/answer.txt',content:'approve 2,480\n'}]},
  {resultText:'Hold the transfer. Units owed: 2,915. {"verdict":"does-not-meet-guidance","reason":"The figure differs."}',writeFiles:[{path:'outputs/answer.txt',content:'hold 2,915\n'}]}
]);
const SCENARIO_DISCARD=JSON.stringify({toolUses:[{name:'Read',input:{file_path:'/etc/hosts'},result:'synthetic'}],resultText:'Decision: approve. Units owed: 2,480.'});
const HOSTILE_NAME='<img src=x onerror=alert(1)>.txt';
const OFFLINE_TEXT='Local agents need the companion: run npm start.';
const downloads=path.join(out,'downloads');
let companionRoot=null;
fs.mkdirSync(out,{recursive:true});fs.rmSync(downloads,{recursive:true,force:true});fs.mkdirSync(downloads,{recursive:true});
let proc,ws,server,nextId=0,pending=new Map(),errors=[],dialogs=[],requests=[],checks=[],packetDir=null,allowedPorts=new Set();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++nextId;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timeout});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+' '+JSON.stringify(r.exceptionDetails.exception));return r.result.value;}
async function click(selector){const found=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`);assert.equal(found,true,'missing control '+selector);await delay(60);}
async function waitFor(expression,label,timeout=45000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await evaluate(expression);if(last)return last;}catch(error){last=String(error);}await delay(120);}throw new Error('Timed out waiting for '+label+' (last: '+JSON.stringify(last)+')');}
async function focusClick(selector){const found=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();el.click();return true;})()`);assert.equal(found,true,'missing control '+selector);await delay(60);}
async function setValue(selector,value){const done=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);assert.equal(done,true,'missing field '+selector);await delay(40);}
const text=selector=>evaluate(`(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
async function screenshot(name,width,height){await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});await delay(150);const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));const overflow=await evaluate('document.documentElement.scrollWidth>window.innerWidth');assert.equal(overflow,false,name+' horizontal overflow');checks.push(name+' fits viewport');}
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
/* The files the companion serves plus backend/, copied to a temporary folder. It has no private/ folder, so the companion runs viewer only and writes its rounds there. */
function makeCompanionRoot(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'finance-agents-companion-'));
  const {ASSETS}=require('../backend/server.cjs');
  for(const name of ASSETS)fs.copyFileSync(path.join(root,name),path.join(dir,name));
  fs.cpSync(path.join(root,'backend'),path.join(dir,'backend'),{recursive:true});
  return dir;
}
async function startServer(extraEnv){
  const port=await freePort();
  const serverEntry=process.env.AGENTS_TEST_SERVER||path.join(companionRoot,'backend','server.cjs');
  const child=spawn(process.execPath,[serverEntry],{cwd:companionRoot,env:{...process.env,FINANCE_STUDIO_PORT:String(port),CLAUDE_BIN:stub,...extraEnv},stdio:['ignore','pipe','pipe']});
  let log='';
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Companion did not start. Output so far: '+log.slice(-800))),15000);const onData=d=>{log+=d;if(log.includes('http://127.0.0.1:'+port)){clearTimeout(t);resolve();}};child.stdout.on('data',onData);child.stderr.on('data',onData);child.on('exit',code=>{clearTimeout(t);reject(new Error('Companion exited '+code+': '+log.slice(-800)));});});
  allowedPorts.add(String(port));
  return {child,port,url:'http://127.0.0.1:'+port+'/'};
}
async function stopServer(){if(server){const child=server.child;server=null;child.removeAllListeners('exit');child.kill();await delay(200);}}
function makePacket(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'finance-agents-packet-'));
  fs.mkdirSync(path.join(dir,'filesystem','gaf'),{recursive:true});
  fs.writeFileSync(path.join(dir,'filesystem','brief.txt'),'Atlas Holdings owes Meridian Partners 2,480 units under the synthetic side letter.\n');
  fs.writeFileSync(path.join(dir,'filesystem','schedule.csv'),'party,units\nAtlas,2480\nMeridian,0\n');
  fs.writeFileSync(path.join(dir,'filesystem','gaf','hedge-note.txt'),'Synthetic note placed in the gaf folder.\n');
  fs.writeFileSync(path.join(dir,'evaluator-notes.txt'),'Synthetic evaluator material used to test the override path.\n');
  fs.writeFileSync(path.join(dir,HOSTILE_NAME),'A file whose name looks like markup.\n');
  return dir;
}
const PROMPT='Review the Atlas and Meridian schedule in the folder and state your decision with the units owed.';
async function openAgents(url){
  await call('Page.navigate',{url});await waitFor('document.readyState==="complete"&&!!window.FinanceDashboard','page load',15000);
  await click('[data-dash-tab="agents"]');
}
async function fillPacketAndFreeze(options){
  await setValue('#ag-dir',packetDir);await click('[data-ag="inspect"]');
  await waitFor('document.querySelectorAll("#ag-packet tbody tr").length>=5','file table');
  await setValue('#ag-prompt',PROMPT);
  await setValue('[data-ag-in="decision"]','approve');
  await setValue('[data-ag-key="gfig-0-0-label"]','Units owed');await setValue('[data-ag-key="gfig-0-0-value"]','2,480');await setValue('[data-ag-key="gfig-0-0-tolerance"]','0');
  await setValue('[data-ag-key="fp-0-id"]','fp-alpha');await setValue('[data-ag-key="fp-0-label"]','Alpha reading');await setValue('[data-ag-key="fp-0-tokens"]','2,915\nhold');
  await click('[data-ag="add-fp"]');
  await setValue('[data-ag-key="fp-1-id"]','fp-beta');await setValue('[data-ag-key="fp-1-label"]','Beta reading');await setValue('[data-ag-key="fp-1-tokens"]','1,100');
  await setValue('[data-ag-in="model"]','claude-sonnet-5-5');await setValue('[data-ag-in="effort"]','low');
  await setValue('#ag-count',String(options.pilots));
}
(async()=>{try{
  proc=spawn(binary,[...(process.getuid&&process.getuid()===0?['--no-sandbox']:[]),'--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-sync','--metrics-recording-only','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const browserURL=await new Promise((resolve,reject)=>{let t='';const timer=setTimeout(()=>reject(new Error('Headless browser startup timeout')),15000);proc.stderr.on('data',d=>{t+=d;const m=t.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});proc.on('error',reject);proc.on('exit',code=>{if(code)reject(new Error('Headless browser exited '+code+' '+t.slice(-1200)));});});
  const origin=browserURL.replace(/^ws:/,'http:').split('/devtools/')[0];const targets=await(await fetch(origin+'/json/list')).json();const target=targets.find(x=>x.type==='page');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);clearTimeout(p.timeout);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push(m.params.entry);if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push({console:m.params.args.map(a=>a.value||a.description)});if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);if(m.method==='Page.javascriptDialogOpening'){dialogs.push(m.params.message);call('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});}});
  const browserVersion=await call('Browser.getVersion');await call('Page.enable');await call('Runtime.enable');await call('Log.enable');await call('Network.enable');await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});

  /* 1. The offline edition opened from disk shows only the offline message and makes no request. */
  await call('Page.navigate',{url:'file://'+path.join(root,'index.html')});await waitFor('document.readyState==="complete"&&!!window.FinanceAgents','offline page load',15000);
  await click('[data-dash-tab="agents"]');
  assert.equal((await text('#ag-root')).trim(),OFFLINE_TEXT);
  assert.equal(await evaluate('document.querySelectorAll("#ag-root button, #ag-root input, #ag-root textarea").length'),0,'offline edition must offer no controls');
  assert.equal(requests.filter(u=>/^https?:/.test(u)).length,0,'offline edition must make no HTTP request');
  checks.push('file edition shows only the offline message, with no controls and no HTTP request');

  /* 2. Start the companion with the clean stub scenario and open the page. */
  packetDir=makePacket();companionRoot=makeCompanionRoot();
  server=await startServer({[SCENARIO_ENV]:SCENARIO_CLEAN});
  await openAgents(server.url);
  await waitFor('!!document.querySelector("#ag-runtime")','runtime panel');
  const runtimeText=await text('#ag-runtime');assert.match(runtimeText,/Claude Code was found/);assert.match(runtimeText,/Version/);assert.match(runtimeText,/Path/);
  checks.push('runtime panel reports the stub as found, with version and path');
  const pageText=await evaluate('document.body.innerText');
  for(const phrase of ['No account or model needed','Sources stay in this browser'])assert.ok(!pageText.includes(phrase),'the companion-served page must not say "'+phrase+'"');
  assert.match(pageText,/No model runs until you approve a round or a review/);assert.match(pageText,/Sources stay on this computer/);
  checks.push('the companion-served page says models run only after approval, not that none run');

  /* 3. Packet: inspect, hostile name renders as text, defaults, overrides and the gaf toggle. */
  await fillPacketAndFreeze({pilots:2});
  const names=await evaluate('[...document.querySelectorAll("#ag-packet .ag-path")].map(el=>el.textContent)');
  assert.ok(names.includes(HOSTILE_NAME),'hostile file name must render as literal text');
  assert.equal(await evaluate('document.querySelectorAll("#ag-root img").length'),0,'hostile name must not create an element');
  assert.equal(await evaluate(`document.querySelector('#ag-packet tbody').innerHTML.includes('<img')`),false,'hostile name must be escaped in markup');
  checks.push('hostile file name renders as text, no element created, no dialog');
  const row=name=>`[...document.querySelectorAll('#ag-packet tbody tr')].find(tr=>tr.querySelector('.ag-path').textContent===${JSON.stringify(name)})`;
  assert.equal(await evaluate(`${row('evaluator-notes.txt')}.querySelector('input').checked`),false,'evaluator-looking file is off by default');
  assert.equal(await evaluate(`${row('filesystem/gaf/hedge-note.txt')}.querySelector('input').checked`),true,'gaf files are included by default (visible to the solver)');
  assert.match(await text('#ag-packet'),/Matches production only if the production solver sees this file\./);
  await click('[data-ag-in="gaf"]');
  assert.equal(await evaluate(`${row('filesystem/gaf/hedge-note.txt')}.querySelector('input').disabled`),true,'gaf files are locked while the toggle is off');
  await click('[data-ag-in="gaf"]');
  assert.equal(await evaluate(`${row('filesystem/gaf/hedge-note.txt')}.querySelector('input').checked`),true,'gaf toggle includes the gaf files again');
  await click(`[data-ag-key="inc-${await evaluate(`[...document.querySelectorAll('#ag-packet tbody tr')].findIndex(tr=>tr.querySelector('.ag-path').textContent==='evaluator-notes.txt')`)}"]`);
  assert.match(await evaluate(`${row('evaluator-notes.txt')}.textContent`),/Override/,'ticking an excluded file is shown as an override');
  assert.match(await text('#ag-wordcount'),/\d+ words\. Project limit \d+/);
  checks.push('packet panel: defaults exclude evaluator-looking files, gaf toggle with the production sentence, override is labelled, word count against the project limit');

  /* 4. Launch is disabled before the freeze. Pilots are capped by the status allowlist. */
  assert.equal(await evaluate('document.querySelector("[data-ag=open-approve]").disabled'),true,'launch must be disabled before freezing');
  for(let i=0;i<8;i++)await click('[data-ag="count-inc"]:not([disabled])').catch(()=>{});
  assert.equal(await evaluate('document.querySelector("#ag-count").value'),String(await evaluate('Number(document.querySelector("#ag-count").max)')),'stepper stops at the cap');
  assert.equal(await evaluate('document.querySelector("[data-ag=count-inc]").disabled'),true);
  await setValue('#ag-count','99');assert.equal(await evaluate('Number(document.querySelector("#ag-count").value)'),await evaluate('Number(document.querySelector("#ag-count").max)'),'typed values are clamped to the cap');
  await setValue('#ag-count','2');
  assert.match(await text("#ag-round"),/not by an operating system sandbox/);assert.match(await text('#ag-round'),/shell commands as your user account/);
  checks.push('launch disabled until frozen; pilots stepper capped at the status maximum; isolation and shell statements printed in the round card');

  /* 5. Freeze, stale detection, and the live region. */
  await click('[data-ag="freeze"]');
  await waitFor('/Frozen/.test(document.querySelector("#ag-freeze-state").textContent)&&/[0-9a-f]{64}/.test(document.querySelector("#ag-freeze-state").textContent)','frozen record with hash');
  const frozenText=await text('#ag-freeze-state');assert.match(frozenText,/Frozen at/);assert.match(frozenText,/rnd-[a-z0-9-]+/);
  assert.equal(await evaluate('document.querySelector("#ag-status").getAttribute("aria-live")'),'polite');await waitFor('/Gold frozen/.test(document.querySelector("#ag-status").textContent)','frozen status message');
  await waitFor('document.querySelector("[data-ag=open-approve]").disabled===false','launch enabled after freeze');
  await setValue('#ag-prompt',PROMPT+' Extra words.');
  assert.equal(await evaluate('document.querySelector("[data-ag=open-approve]").disabled'),true,'changing the prompt after the freeze disables launch');
  assert.match(await text('#ag-gate'),/changed after the freeze/);
  await setValue('#ag-prompt',PROMPT);
  assert.equal(await evaluate('document.querySelector("[data-ag=open-approve]").disabled'),false,'restoring the prompt restores the freeze match');
  checks.push('freeze shows hash and time; a changed prompt marks the freeze stale and disables launch; restoring it re-enables');

  /* 6. Approve and launch: three acknowledgements, command line with the prompt elided. */
  await click('[data-ag="open-approve"]');
  await waitFor('!!document.querySelector("#agents-modal [role=dialog]")','approval dialog');
  const dialog=await text('#agents-modal');assert.match(dialog,/Approve and launch this round/);assert.match(dialog,/claude-sonnet-5-5/);assert.match(dialog,/Overridden files/);assert.match(dialog,/evaluator-notes\.txt/);
  const command=await text('#agents-modal .ag-command');assert.match(command,/claude/i);assert.match(command,/--model/);assert.ok(!command.includes('Atlas'),'the command summary elides the prompt');
  assert.equal(await evaluate('document.querySelectorAll("#agents-modal input[type=checkbox]").length'),3);
  assert.equal(await evaluate('document.querySelector("#agents-modal [data-ag=approve-launch]").disabled'),true);
  for(const id of ['shell-access','network','isolation-by-audit']){assert.equal(await evaluate('document.querySelector("#agents-modal [data-ag=approve-launch]").disabled'),true);await click(`#agents-modal [data-id="${id}"]`);}
  assert.equal(await evaluate('document.querySelector("#agents-modal [data-ag=approve-launch]").disabled'),false);
  await screenshot('desktop-approval',1440,1000);
  await click('#agents-modal [data-ag="approve-launch"]');
  await waitFor('!document.querySelector("#agents-modal [role=dialog]")','dialog closed after launch');
  await waitFor('document.querySelectorAll("#ag-runs tbody tr").length===2','two pilot rows');
  checks.push('approval dialog needs three checkboxes, shows the command line with the prompt elided and the override list, then launches 2 pilots');

  /* 7. Runs table, banner, drawer, classification. */
  await waitFor('[...document.querySelectorAll("#ag-runs tbody tr")].every(tr=>/completed|failed|cancelled/.test(tr.children[1].textContent))','pilots to finish',120000);
  const runsText=await text('#ag-runs');assert.match(runsText,/Directional only, n = 2\. No rate or difficulty is computed\./);assert.ok(!runsText.includes('%'),'no percentage anywhere in the runs card');assert.ok(!/pass rate|success rate|failure rate/i.test(runsText),'no rate wording');
  assert.equal(await evaluate('[...document.querySelectorAll("#ag-runs tbody tr")].every(tr=>tr.children[1].textContent.trim()==="completed")'),true,'both pilots completed');
  assert.equal(await evaluate('[...document.querySelectorAll("#ag-runs tbody tr")].every(tr=>tr.children[5].textContent.trim()==="CLEAN")'),true,'both pilots audited CLEAN');
  checks.push('both pilots finish; the banner reads directional only, n = 2; no percentage or pass rate is shown');
  await focusClick('#ag-runs [data-ag-key="run-1"]');
  await waitFor('!!document.querySelector("#agents-modal .ag-drawer")&&!!document.querySelector("#agents-modal .ag-final")','drawer with final answer');
  assert.ok((await text('#agents-modal .ag-final')).trim().length>0,'final answer is shown');
  const drawer=await text('#agents-modal');assert.match(drawer,/Audit/);assert.match(drawer,/Outputs/);
  assert.match(drawer,/Suggested verdict, heuristic: Matches the frozen gold/);assert.match(drawer,/Units owed 2480: found in the final/);
  await screenshot('desktop-drawer',1440,1000);
  await click('#agents-modal [data-ag="apply-suggestion"]');
  assert.equal(await evaluate('document.querySelector("#agents-modal [data-id=matches-frozen-gold]").checked'),true,'the suggestion is copied into the controls');
  await setValue('[data-ag-in="class-note"]','Checked by hand against the frozen gold.');
  await click('#agents-modal [data-ag="save-class"]');await waitFor('/was saved/.test(document.querySelector("#ag-status").textContent)','classification saved');
  await evaluate('(document.activeElement||document.body).dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await waitFor('!document.querySelector("#agents-modal [role=dialog]")','drawer closed by Escape');
  assert.equal(await evaluate('document.activeElement&&document.activeElement.getAttribute("data-ag-key")'),'run-1','focus returns to the control that opened the drawer');
  await click('#ag-runs [data-ag-key="run-2"]');await waitFor('/Suggested verdict, heuristic/.test(document.querySelector("#agents-modal").textContent)','second drawer with its suggestion');
  assert.match(await text('#agents-modal'),/Suggested verdict, heuristic: Lands on a frozen fingerprint/);assert.match(await text('#agents-modal'),/Fingerprint candidates: fp-alpha/);
  assert.equal(await evaluate('[...document.querySelectorAll("#agents-modal .ag-chip")].every(b=>b.disabled)'),true,'fingerprint chips wait for the fingerprint verdict');
  await click('#agents-modal [data-ag="apply-suggestion"]');
  assert.equal(await evaluate('document.querySelector("#agents-modal .ag-chip[data-id=fp-alpha]").getAttribute("aria-pressed")'),'true','the suggested fingerprint is pressed');
  assert.equal(await evaluate('document.querySelector("#agents-modal .ag-chip[data-id=fp-beta]").getAttribute("aria-pressed")'),'false');
  await click('#agents-modal [data-ag="save-class"]');await waitFor('/Lands on a frozen fingerprint/.test(document.querySelector("#ag-runs").textContent)','verdicts in table');
  await click('#agents-modal [data-ag="close-overlay"]');
  assert.match(await text('#ag-runs'),/Your verdicts so far \(directional only, n = 2\)/);assert.match(await text('#ag-runs'),/Matches the frozen gold 1/);
  assert.equal(await evaluate('[...document.querySelectorAll("#ag-runs tbody tr")].map(tr=>tr.children[7].textContent.trim()).join("|")'),'Matches the frozen gold|Lands on a frozen fingerprint','the table lists each saved verdict');
  checks.push('detail drawer shows final answer, outputs and audit; the heuristic suggestion (gold figures, fingerprint ids) copies into the controls; verdict and fingerprint chips save and the table lists them; Escape closes and returns focus');

  /* 8. Simulated grader and author review are separate approvals. */
  await click('[data-ag="open-grader"]');await waitFor('!!document.querySelector("#agents-modal [data-ag=run-grader]")','grader dialog');
  assert.equal(await evaluate('document.querySelector("#agents-modal [data-ag=run-grader]").disabled'),true,'grader needs its own approval');
  assert.match(await text('#agents-modal'),/simulated grader, not Studio grading/i);
  await setValue('[data-ag-in="guideline"]','You are grading a liquidity answer. The correct figure is 2,480 units.');
  for(const id of ['run','network','notools'])await click(`#agents-modal [data-id="${id}"]`);
  assert.equal(await evaluate('document.querySelector("#agents-modal [data-ag=run-grader]").disabled'),false);
  await click('#agents-modal [data-ag="run-grader"]');await waitFor('/Verdict: (meets-guidance|does-not-meet-guidance|unclear)/.test(document.querySelector("#agents-modal").textContent)','simulated grader result');
  assert.match(await text('#agents-modal'),/Simulated grader, not Studio grading/);
  await click('#agents-modal [data-ag="close-overlay"]');
  assert.equal(await evaluate('document.querySelector("[data-ag=open-review]").disabled'),true,'author review needs a loaded package');
  await evaluate(`(async()=>{await FinanceDashboard.ingest([new File(['Atlas owes Meridian 2,480 units.\\n'],'brief.txt',{type:'text/plain'})]);})()`);
  await click('[data-dash-tab="agents"]');await waitFor('document.querySelector("[data-ag=open-review]")&&document.querySelector("[data-ag=open-review]").disabled===false','author review enabled once a package is loaded');
  await click('[data-ag="open-review"]');await waitFor('!!document.querySelector("#agents-modal [data-ag=run-review]")','review dialog');
  assert.equal(await evaluate('document.querySelector("#agents-modal [data-ag=run-review]").disabled'),true,'author review needs its own approval');
  for(const id of ['run','network','notools'])await click(`#agents-modal [data-id="${id}"]`);
  await click('#agents-modal [data-ag="run-review"]');await waitFor('/Author review result/.test(document.querySelector("#agents-modal").textContent)&&/Units owed/.test(document.querySelector("#agents-modal .ag-final").textContent)','author review result');
  await click('#agents-modal [data-ag="close-overlay"]');
  checks.push('simulated grader and author review each run behind their own approval, end to end through the stub, and the grader is labelled as a simulation');

  /* 9. Export: add to project experiments, then download the round JSON. */
  await click('[data-ag="export-add"]');await waitFor('!!document.querySelector("#agents-modal [data-ag=export-confirm]")','export confirmation');
  assert.match(await text('#agents-modal'),/adds 2 experiment records/);
  await click('#agents-modal [data-ag="export-confirm"]');await waitFor('/Added 2 records/.test(document.querySelector("#ag-status").textContent)','export added');
  const experiments=await evaluate('FinanceAuthoring.getProject().experiments');assert.equal(experiments.length,2);
  assert.deepEqual(experiments.map(x=>x.classification).sort(),['model-error','no-root-failure']);assert.deepEqual(experiments.find(x=>x.classification==='model-error').rootFailures,['fp-alpha']);
  assert.equal(await evaluate('(()=>{const p=FinanceAuthoring.getProject(),s=FinanceCore.snapshot(p);return p.experiments.every(x=>x.snapshot===s);})()'),true,'experiments carry the current project snapshot');
  checks.push('export adds two experiment records to the project after confirmation');
  await click('[data-ag="export-download"]');
  let saved;for(let i=0;i<50&&!saved;i++){await delay(120);saved=fs.readdirSync(downloads).find(f=>/^Finance_Agent_Round_.*_PRIVATE\.json$/.test(f));}
  assert.ok(saved,'round JSON downloaded');await delay(300);
  const roundJson=JSON.parse(fs.readFileSync(path.join(downloads,saved),'utf8'));assert.ok(roundJson.round&&roundJson.export);
  checks.push('round JSON downloads');
  await screenshot('desktop-agents',1440,1000);await screenshot('mobile-agents',390,844);
  await click('#ag-runs [data-ag-key="run-1"]');await waitFor('!!document.querySelector("#agents-modal .ag-drawer")','mobile drawer');await screenshot('mobile-drawer',390,844);await click('#agents-modal [data-ag="close-overlay"]');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});

  /* 10. Second server run with the violation scenario: a DISCARDED pilot is kept, shown, and not classifiable or exportable. */
  await stopServer();
  server=await startServer({[SCENARIO_ENV]:SCENARIO_DISCARD});
  await openAgents(server.url);await waitFor('!!document.querySelector("#ag-runtime")','runtime panel after restart');
  await fillPacketAndFreeze({pilots:1});
  await click('[data-ag="freeze"]');await waitFor('document.querySelector("[data-ag=open-approve]").disabled===false','round frozen again');
  await click('[data-ag="open-approve"]');await waitFor('!!document.querySelector("#agents-modal [data-id=shell-access]")','approval dialog');
  for(const id of ['shell-access','network','isolation-by-audit'])await click(`#agents-modal [data-id="${id}"]`);
  await click('#agents-modal [data-ag="approve-launch"]');await waitFor('!document.querySelector("#agents-modal [role=dialog]")','dialog closed');
  await waitFor('document.querySelectorAll("#ag-runs tbody tr").length===1&&/DISCARDED/.test(document.querySelector("#ag-runs tbody").textContent)','a DISCARDED pilot',120000);
  const discardedText=await text('#ag-runs');assert.match(discardedText,/Directional only, n = 0\./);assert.match(discardedText,/Discarded: 1/);
  await click('#ag-runs [data-ag-key="run-1"]');await waitFor('!!document.querySelector("#agents-modal .ag-classify")','discarded drawer');
  assert.ok(await evaluate('document.querySelectorAll("#agents-modal .ag-table tbody tr").length>=1'),'violations are listed');
  assert.match(await text('#agents-modal'),/DISCARDED/);assert.match(await text('#agents-modal'),/Classification is disabled because this run is DISCARDED/);
  assert.equal(await evaluate('document.querySelector("#agents-modal fieldset.ag-classify").disabled'),true,'classification is disabled for DISCARDED');
  assert.equal(await evaluate('document.querySelector("#agents-modal [data-ag=save-class]").disabled'),true);
  assert.equal(await evaluate('document.querySelector("#agents-modal").innerHTML.includes("<img")'),false,'violation text is escaped');
  await screenshot('desktop-discarded',1440,1000);
  await click('#agents-modal [data-ag="close-overlay"]');
  await click('[data-ag="export-add"]');await waitFor('!!document.querySelector("#agents-modal [data-ag=export-confirm]")','export confirmation for discarded round');
  assert.equal(await evaluate('document.querySelector("#agents-modal [data-ag=export-confirm]").disabled'),true,'a DISCARDED run is not exported');
  await click('#agents-modal [data-ag="close-overlay"]');
  checks.push('a DISCARDED pilot is kept and explained, cannot be classified, and is left out of the export');

  /* 11. Global assertions. */
  const web=requests.filter(u=>/^https?:/.test(u));
  assert.ok(web.length>0,'the companion was exercised');
  for(const url of web){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1','request left the machine: '+url);assert.ok(allowedPorts.has(u.port),'request to an unknown port: '+url);}
  const api=web.filter(u=>new URL(u).pathname.startsWith('/api/'));assert.ok(api.length>0);
  assert.deepEqual(dialogs,[],'no alert, confirm or prompt dialog may open');
  assert.equal(errors.length,0,'Browser console/runtime errors: '+JSON.stringify(errors));
  checks.push('every request went to 127.0.0.1; zero console errors and zero dialogs');
  fs.writeFileSync(path.join(out,'browser-report.json'),JSON.stringify({passed:true,checks,requestCount:web.length,apiRequestCount:api.length,hosts:[...new Set(web.map(u=>new URL(u).hostname))],consoleErrors:errors,dialogs,browser:'Isolated headless Chromium',browserVersion,node:process.version,viewports:[{width:1440,height:1000},{width:390,height:844}],server:'backend/server.cjs with the stub agent runtime; no model was started',qaData:'Synthetic packet only.'},null,2));
  console.log(JSON.stringify({passed:true,checks},null,2));
}catch(error){console.error(error);fs.writeFileSync(path.join(out,'browser-report.json'),JSON.stringify({passed:false,checks,error:String(error),errors,dialogs,requests:requests.filter(u=>/^https?:/.test(u)).slice(-40)},null,2));process.exitCode=1;}finally{await stopServer().catch(()=>{});if(ws){try{await call('Browser.close');}catch{}ws.close();}if(proc){const gone=proc.exitCode!==null?Promise.resolve():new Promise(r=>{proc.once('exit',r);setTimeout(r,4000);});proc.kill();await gone;}if(packetDir)fs.rmSync(packetDir,{recursive:true,force:true});if(companionRoot)fs.rmSync(companionRoot,{recursive:true,force:true});try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:150});}catch{/* a leftover temporary profile is harmless and must not fail a passing suite */}}})();
