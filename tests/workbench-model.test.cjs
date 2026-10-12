const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const W=require('../workbench-model.js'),C=require('../core.js'),E=require('../package-engine.js'),H=require('../candidate-engine.js');
/* Synthetic fixtures only (Atlas, Meridian, Borealis, Cobalt). Documents are hand-built records in the package-engine shape; diffs are hand-made objects in the
   DocDiff contract shape, so nothing here depends on diffPackages. Imported-evaluation files are built with the real key names and invented content. */
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const deepFreeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.freeze(v);Object.values(v).forEach(deepFreeze);}return v;};
const copy=v=>JSON.parse(JSON.stringify(v));
const doc=(name,kind,records,extra={})=>({id:'doc-'+digest(name).slice(0,10),name,bytes:100,sha256:digest(name+JSON.stringify(records)),role:'source',roleBasis:'QA fixture',status:'extracted',kind,records,metadata:{},warnings:[],...extra});
const txt=(name,lines,extra)=>doc(name,'txt',lines.map((t,i)=>({locator:'Line '+(i+1),text:t})).filter(r=>r.text),extra);
const csv=(name,rows,extra)=>doc(name,'csv',rows.map((v,i)=>({locator:'Row '+(i+1),text:v.join(' | '),values:v})),extra);
const cell=(sheet,ref,value,extra={})=>({locator:sheet+'!'+ref,text:String(value),sheet,cell:ref,value:String(value),type:'n',formula:'',hasFormula:false,formulaType:'',cachePresent:true,hidden:false,context:'',...extra});
const xlsx=(name,records,extra)=>doc(name,'xlsx',records,extra);
const pkg=(documents,title='QA fixture')=>({schemaVersion:1,kind:'finance-task-package',id:'package-qa',title,fingerprint:digest(documents.map(d=>d.name+d.sha256).sort().join('\n')),documents});
const snap=(value,extra={})=>({value:String(value),type:'n',formula:'',hasFormula:false,cachePresent:true,...extra});
const change=(sheet,ref,kind,before,after,extra={})=>({locator:sheet+'!'+ref,sheet,cell:ref,change:kind,before:before===null?null:snap(before),after:after===null?null:snap(after),hidden:false,...extra});
const docDiff=(name,status,kind,extra={})=>({name,status,kind,baseId:'b-'+name,candId:'c-'+name,baseSha256:digest('b'+name),candSha256:digest('c'+name),cells:[],lines:[],metaChanges:{sheets:[],definedNames:[]},limits:[],...extra});
const diffOf=(base,cand,documents,limits=['Formulas are not recalculated: values are the saved workbook caches, so a cell with no saved value is unknown, not zero.'])=>({baseFingerprint:base.fingerprint,candFingerprint:cand.fingerprint,documents,summary:{changedDocuments:documents.filter(d=>d.status==='changed').length,addedDocuments:0,removedDocuments:0,changedCells:documents.reduce((n,d)=>n+d.cells.length,0)},limits});
const FORBIDDEN=/%|pass rate|success rate|failure rate|difficulty|caught/i;
const strings=(v,out=[])=>{if(typeof v==='string')out.push(v);else if(Array.isArray(v))v.forEach(x=>strings(x,out));else if(v&&typeof v==='object')Object.values(v).forEach(x=>strings(x,out));return out;};
const keysOf=(v,out=new Set())=>{if(Array.isArray(v))v.forEach(x=>keysOf(x,out));else if(v&&typeof v==='object')Object.entries(v).forEach(([k,x])=>{out.add(k);keysOf(x,out);});return out;};

/* ---------- the shared case fixture ---------- */
const TERMS=()=>txt('Facility_Terms.txt',['Atlas Holdings owes Meridian Partners 2,480 units','Facility limit is 3,000 units','','Borealis review on 2026-09-30','Cobalt reserve 1,200.00 units']);
const FACTS=()=>csv('Cash_Facts.csv',[['Label','Value'],['Opening usable cash','100'],['Payments due','1850'],['Requested draw','2,480']]);
const MODEL=b3=>xlsx('Atlas_Model.xlsx',[cell('Bridge','B2',1850),cell('Bridge','B3',b3),cell('Bridge','B10',77),cell('Bridge','C9',1200),cell('Summary','A1','Atlas',{type:'s'})]);
const NOTES=()=>txt('Grader_Notes.txt',['Expected bridge 1,200 units and headroom 500 units'],{role:'evaluator'});
const basePkg=()=>pkg([TERMS(),FACTS(),MODEL(100),NOTES()]);
const candPkg=()=>pkg([TERMS(),FACTS(),MODEL(150),NOTES()]);
const FREEZE=(over={})=>({version:1,frozenAt:'2026-10-01T00:00:00.000Z',sha256:digest('freeze-1'),gold:{decision:'',figures:[{label:'Cash bridge',value:'1,200',tolerance:0},{label:'Facility headroom',value:500,tolerance:0},{label:'Requested draw',value:'2,480',tolerance:0}],notes:''},fingerprints:[{id:'fp-alpha',label:'Credit counted as cash',tokens:['credit'],figures:[]}],postHoc:false,contentSha256:digest('content-1'),...over});
const ROUND=(over={})=>({id:'round-qa-1',label:'Atlas round 1',status:'completed',freeze:FREEZE(),postHocFreezes:[],...over});
const MATCHES=()=>[{label:'Cash bridge',value:'1,200',found:true,where:'final'},{label:'Facility headroom',value:500,found:false,where:null},{label:'Requested draw',value:'2,480',found:true,where:'outputs'}];
const FINAL='Review of the Atlas facility. The cash bridge is 1,200 units after the funded draw. The requested draw is stated in the workbook. Headroom was not computed.';
const RUN=(over={})=>({id:'round-qa-1-1',n:1,state:'completed',audit:{status:'CLEAN',violations:[],inputsModified:[],notes:[]},final:{text:FINAL,chars:FINAL.length},outputs:[],solverFiles:['Facility_Terms.txt'],classification:{suggested:{verdict:'unclear',matches:MATCHES(),fingerprints:[{id:'fp-alpha',label:'Credit counted as cash',hit:false,tokensFound:[],figuresFound:[]}],decision:{keywords:[],found:[]},label:'heuristic',freezeVersion:1,freezeSha256:FREEZE().sha256},human:null},...over});
const PROJECT=()=>({title:'Atlas bridge (QA fixture)',versions:{prompt:'v1',workbook:'v1',evaluator:'v1'},sources:[
  {id:'s-terms',title:'Terms',file:'Facility_Terms.txt',page:'Lines 1 to 2',cell:'',date:'',authority:'',version:'',excerpt:'Atlas Holdings owes Meridian Partners 2,480 units',reviewStatus:'pending',suppliedToSolver:true},
  {id:'s-model',title:'Model',file:'Atlas_Model.xlsx',page:'',cell:'Bridge!B3; B2',date:'',authority:'',version:'',excerpt:'',reviewStatus:'pending',suppliedToSolver:true},
  {id:'s-facts',title:'Facts',file:'Cash_Facts.csv',page:'',cell:'Row 3',date:'',authority:'',version:'',excerpt:'Payments due 1850',reviewStatus:'pending',suppliedToSolver:true},
  {id:'s-bad',title:'Clause',file:'Facility_Terms.txt',page:'Clause 4.2',cell:'',date:'',authority:'',version:'',excerpt:'',reviewStatus:'pending',suppliedToSolver:true},
  {id:'s-gone',title:'Gone',file:'Missing_File.txt',page:'Line 1',cell:'',date:'',authority:'',version:'',excerpt:'',reviewStatus:'pending',suppliedToSolver:true}],
 roots:[{id:'r1',title:'Credit counted as cash',outputs:[
  {id:'o-bridge',label:'Cash bridge',unit:'units',correct:'1200',wrong:'0',absTolerance:'0',relTolerance:'0',threshold:'0',direction:'at-most',calculation:'',sourceIds:['s-terms','s-model','s-facts']},
  {id:'o-limit',label:'Facility headroom',unit:'units',correct:'500',wrong:'500.2',absTolerance:'0',relTolerance:'0',threshold:'',direction:'at-least',calculation:'',sourceIds:['s-bad','s-gone']}]}]});
const DIFF=(base,cand)=>diffOf(base,cand,[
  docDiff('Atlas_Model.xlsx','changed','xlsx',{cells:[change('Bridge','B3','value',100,150),change('Bridge','B20','added',null,5),change('Bridge','B100','removed',9,null)]}),
  docDiff('Cash_Facts.csv','changed','csv',{cells:[{locator:'Row 3',change:'value',before:snap(1850,{type:'n'}),after:snap(1900),hidden:false,derivedColumn:'B'}]}),
  docDiff('Facility_Terms.txt','changed','txt',{lines:[{op:'equal',baseLocator:'Line 1',candLocator:'Line 1',before:'x',after:'x'},{op:'del',baseLocator:'Line 2',candLocator:null,before:'Facility limit is 2,000 units',after:null},{op:'add',baseLocator:null,candLocator:'Line 2',before:null,after:'Facility limit is 3,000 units'}],limits:['Matched by file name only.']}),
  docDiff('Grader_Notes.txt','unchanged','txt',{baseSha256:digest('same'),candSha256:digest('same')}),
  docDiff('Old_Schedule.csv','removed','csv',{candId:null,candSha256:null})]);
const SCENE=(over={})=>{const base=basePkg(),cand=candPkg();return {package:cand,comparePackage:base,diff:DIFF(base,cand),round:ROUND(),runDetail:RUN(),project:PROJECT(),links:[],evalParsed:null,...over};};
const byId=(c,id)=>c.criteria.find(x=>x.id===id);
const figure=(c,label)=>byId(c,'figure:'+label.toLowerCase().replace(/[^a-z0-9]+/g,'-'));

/* ---------- module shape ---------- */
test('exports exactly the documented functions and nothing reads a clock, a random source, the DOM or the network',()=>{
  for(const k of ['parseStudioGrading','parseStudioMessages','normalizeEval','buildCase','suggestClauses','diffViewRows','lineDiffRows','excerptAround'])assert.equal(typeof W[k],'function',k);
  const src=fs.readFileSync(path.join(__dirname,'..','workbench-model.js'),'utf8');
  for(const bad of [/Date\.now|new Date|Math\.random/,/(?<![.\w'\"])document\.|navigator\.|localStorage|sessionStorage|querySelector|createElement|innerHTML/,/\bfetch\b|XMLHttpRequest|WebSocket/,/\beval\s*\(|new Function/,/style\s*=\s*"/,/https?:\/\//])assert.ok(!bad.test(src),String(bad));
  assert.match(src,/if\(typeof module!=='undefined'&&module\.exports\)module\.exports=api;else scope\.FinanceWorkbenchModel=api;/);
});
test('browser path: loaded as a plain script it sets the global and reads FinanceCore and the package engine from globals',()=>{
  const window={FinanceCore:C,FinancePackageEngine:E},ctx=vm.createContext({window});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','workbench-model.js'),'utf8'),ctx);
  const M=window.FinanceWorkbenchModel;assert.equal(typeof M.buildCase,'function');
  const c=copy(M.buildCase(SCENE()));
  assert.deepEqual(c,copy(W.buildCase(SCENE())),'the global edition gives the same case as the Node edition');
  assert.equal(byId(c,'output:r1/o-bridge').numbers[0].decisionChanges,true);
  const loneWindow={},lone=vm.createContext({window:loneWindow});vm.runInContext(fs.readFileSync(path.join(__dirname,'..','workbench-model.js'),'utf8'),lone);
  const noDeps=copy(loneWindow.FinanceWorkbenchModel.buildCase(SCENE()));
  assert.deepEqual(byId(noDeps,'output:r1/o-bridge').numbers,[],'without FinanceCore there is no comparison and so no number');
  assert.match(noDeps.notes.join('\n'),/comparison is incomplete/);
  assert.equal(byId(noDeps,'output:r1/o-bridge').clauses.find(x=>x.locator==='Line 1').resolved,true,'clause binding still works with the built-in exact resolver');
});

/* ---------- parseStudioGrading ---------- */
const REASONING=['Lead paragraph about Borealis.','','**Inputs**','- PASS Used the funded draw (invented bullet)','- FAIL Counted the facility as cash (invented bullet)','- Checked the dates (no token)','  and kept the order (continuation line)','','**Outputs:**','* ✓ Bridge figure stated','* ✗ Headroom missing','* NOT MET Reserve not shown','','Trailing summary paragraph.'].join('\n');
const GRADING=(over={})=>({grading_runs:[{grading_run_id:'gr-qa-1',final_score:0.5,scoring_method:'rubric',scoring_config_id:'cfg-qa',grading_run_status:'completed',judge:{judge_id:'j1',llm_model:{llm_model_id:'m1',provider:'qa-provider',model:'qa-judge'}},judge_grades:[{verifier_result_values:{problem_run_id:'pr-qa-1'}}]}],trajectory_output:{attempt_number:2,final_score:0.5,problem_run_id:'pr-qa-1',rewards:[{subscores:[{name:'overall',score:0.5,max_score:1,weight:1,reasoning:REASONING,grading_criteria:null}]}]},...over});
test('parseStudioGrading: reads the identifiers, score, judge and the items under each bold heading',()=>{
  const g=W.parseStudioGrading(GRADING());
  assert.deepEqual(Object.keys(g),['runId','problemRunId','attempt','scoringMethod','finalScore','scoreMax','judge','status','subscores','items','limits']);
  assert.equal(g.runId,'gr-qa-1');assert.equal(g.problemRunId,'pr-qa-1');assert.equal(g.attempt,2);assert.equal(g.scoringMethod,'rubric');assert.equal(g.finalScore,0.5);assert.equal(g.scoreMax,1);assert.equal(g.status,'completed');
  assert.deepEqual(g.judge,{provider:'qa-provider',model:'qa-judge'});
  assert.deepEqual(g.subscores,[{name:'overall',score:0.5,max:1,weight:1,reasoning:REASONING}]);
  assert.deepEqual(g.items.map(i=>[i.id,i.group,i.polarity]),[['item-1','Inputs','met'],['item-2','Inputs','not-met'],['item-3','Inputs','unknown'],['item-4','Outputs','met'],['item-5','Outputs','not-met'],['item-6','Outputs','not-met']]);
  assert.equal(g.items[2].text,'Checked the dates (no token) and kept the order (continuation line)');
  assert.deepEqual(g.limits,[]);
  assert.deepEqual(W.parseStudioGrading(JSON.stringify(GRADING())),g,'a JSON string is accepted');
});
test('parseStudioGrading: absent keys, extra keys and null grading_criteria are tolerated',()=>{
  const g=W.parseStudioGrading({grading_runs:[{}],trajectory_output:{}});
  assert.deepEqual(g,{runId:null,problemRunId:null,attempt:null,scoringMethod:null,finalScore:null,scoreMax:null,judge:null,status:null,subscores:[],items:[],limits:['The maximum score is not stated unambiguously in this file.']});
  const extra=W.parseStudioGrading({...GRADING(),mystery:{a:[1,2,3]},grading_runs:[{...GRADING().grading_runs[0],extra_key:1,judge:null}]});
  assert.equal(extra.judge,null);assert.equal(extra.items.length,6);
  const odd=W.parseStudioGrading({grading_runs:[{final_score:'0.25',grading_run_id:7}],trajectory_output:{attempt_number:'3',rewards:[null,{subscores:[null,'x',{name:5,score:'0.25',max_score:'1',weight:null,reasoning:12}]},'bad']}});
  assert.equal(odd.finalScore,0.25,'a numeric string is kept as the number it says');assert.equal(odd.attempt,3);assert.equal(odd.runId,null,'a non-string id is not an id');
  assert.deepEqual(odd.subscores,[{name:'',score:0.25,max:1,weight:null,reasoning:''}]);assert.deepEqual(odd.items,[]);
  const judgeOnly=W.parseStudioGrading({grading_runs:[{judge:{llm_model:{model:'qa-judge'}}}],trajectory_output:{}});assert.deepEqual(judgeOnly.judge,{provider:'',model:'qa-judge'});
  const fallback=W.parseStudioGrading({grading_runs:[{}],trajectory_output:{final_score:0.75,problem_run_id:'pr-x'}});assert.equal(fallback.finalScore,0.75);assert.equal(fallback.problemRunId,'pr-x');
});
test('parseStudioGrading: a file that is not a grading result throws a message that names what is missing',()=>{
  for(const bad of [null,undefined,5,true,[],[GRADING()]])assert.throws(()=>W.parseStudioGrading(bad),/must be a JSON object/);
  assert.throws(()=>W.parseStudioGrading('{nope'),/not valid JSON/);
  assert.throws(()=>W.parseStudioGrading('"text"'),/must be a JSON object/);
  assert.throws(()=>W.parseStudioGrading({}),/grading_runs is missing or empty/);
  assert.throws(()=>W.parseStudioGrading({grading_runs:[]}),/grading_runs is missing or empty/);
  assert.throws(()=>W.parseStudioGrading({grading_runs:{},trajectory_output:{}}),/grading_runs is missing or empty/);
  assert.throws(()=>W.parseStudioGrading({grading_runs:[5],trajectory_output:{}}),/grading_runs\[0\] must be an object/);
  assert.throws(()=>W.parseStudioGrading({grading_runs:[{}]}),/trajectory_output is missing/);
  assert.throws(()=>W.parseStudioGrading({grading_runs:[{}],trajectory_output:[]}),/trajectory_output is missing/);
  assert.throws(()=>W.parseStudioGrading('x'.repeat(20000001)),/larger than 20 MB/);
});
test('parseStudioGrading: polarity comes only from an explicit token; headings and tone never decide it',()=>{
  const polarity=bullet=>W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'s',reasoning:'**Group**\n- '+bullet}]}]}})).items[0].polarity;
  const table=[['PASS the check','met'],['[PASS] the check','met'],['the check: PASS','met'],['**PASS** shown','met'],['MET','met'],['Requirement MET.','met'],['✓ stated','met'],['✔ stated','met'],['FAIL the check','not-met'],['(FAIL)','not-met'],['NOT MET','not-met'],['NOT  MET twice spaced','not-met'],['Result: NOT MET.','not-met'],['✗ missing','not-met'],['✘ missing','not-met'],
    ['passed the check','unknown'],['Pass','unknown'],['met','unknown'],['Not met','unknown'],['The requirement was satisfied','unknown'],['The figure is wrong','unknown'],['UNMET','unknown'],['METHOD used','unknown'],['METRIC shown','unknown'],['FAILED','unknown'],['FAIL-SAFE design','unknown'],['bypass','unknown'],['PASSING grade','unknown'],['PASS and FAIL both written','unknown'],['PASS/FAIL','unknown'],['✓ and ✗','unknown'],['NOT MET but MET later','unknown'],['MET yet FAIL','unknown']];
  for(const [bullet,want] of table)assert.equal(polarity(bullet),want,JSON.stringify(bullet));
  const fromHeading=W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'s',reasoning:'**PASS items**\n- first\n\n**FAIL items**\n- second\n\n**Failures and misses**\n- third'}]}]}})).items;
  assert.deepEqual(fromHeading.map(i=>[i.group,i.polarity]),[['PASS items','unknown'],['FAIL items','unknown'],['Failures and misses','unknown']],'heading text never sets polarity');
});
test('parseStudioGrading: heading and bullet layout variants',()=>{
  const items=r=>W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'s',reasoning:r}]}]}})).items.map(i=>[i.group,i.text,i.polarity]);
  assert.deepEqual(items('- before any heading\n**Late heading**\n- after'),[['','before any heading','unknown'],['Late heading','after','unknown']]);
  assert.deepEqual(items('**A** and **B**\n- not a heading line'),[['','not a heading line','unknown']]);
  assert.deepEqual(items('__Under__\n1. one\n2) two\n• dot\n✓ glyph lead'),[['Under','one','unknown'],['Under','two','unknown'],['Under','dot','unknown'],['Under','✓ glyph lead','met']]);
  assert.deepEqual(items('**Head**:\n-\n- \n**Bold line** with text after\nplain paragraph'),[],'a bare marker and prose are not items');
  assert.deepEqual(items('**Head:**\n- one\n\nparagraph ends it\n  indented after a paragraph\n- two'),[['Head','one','unknown'],['Head','two','unknown']]);
  assert.deepEqual(items('**H**\r\n- crlf one\r\n- crlf two'),[['H','crlf one','unknown'],['H','crlf two','unknown']]);
});
test('parseStudioGrading: caps on the reasoning text and on the item count are applied and stated',()=>{
  const long='**G**\n- first\n'+'x'.repeat(25000);
  const g=W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'s',reasoning:long}]}]}}));
  assert.equal(g.subscores[0].reasoning.length,20000);assert.match(g.limits.join(' '),/cut at 20000 characters/);
  const many='**G**\n'+Array.from({length:230},(_,i)=>'- item '+i).join('\n');
  const m=W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'s',reasoning:many}]}]}}));
  assert.equal(m.items.length,200);assert.equal(m.items[199].id,'item-200');assert.equal(m.items[199].text,'item 199');assert.match(m.limits.join(' '),/first 200 items/);
  const wide=W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'a',reasoning:'**G**\n'+Array.from({length:150},(_,i)=>'- a'+i).join('\n')},{name:'b',reasoning:'**H**\n'+Array.from({length:150},(_,i)=>'- b'+i).join('\n')}]}]}}));
  assert.equal(wide.items.length,200,'the cap is across subscores');assert.equal(wide.items[150].group,'H');
  const huge=W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'s',reasoning:'**G**\n- '+'y'.repeat(9000)}]}]}}));assert.equal(huge.items[0].text.length,4000);
});
test('parseStudioGrading: the maximum score is stated only when exactly one subscore states it; two files that disagree say so',()=>{
  assert.equal(W.parseStudioGrading(GRADING()).scoreMax,1);
  const two=W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'a',score:1,max_score:1},{name:'b',score:1,max_score:1}]}]}}));assert.equal(two.scoreMax,null);assert.match(two.limits.join(' '),/maximum score is not stated/);
  assert.equal(W.parseStudioGrading(GRADING({trajectory_output:{rewards:[{subscores:[{name:'a',score:1,max_score:0}]}]}})).scoreMax,null,'a zero maximum is not a maximum');
  const differ=W.parseStudioGrading(GRADING({trajectory_output:{...GRADING().trajectory_output,final_score:0.9}}));assert.equal(differ.finalScore,0.5);assert.match(differ.limits.join(' '),/two final scores/);
});
test('parseStudioGrading: never mutates its input and returns fresh objects',()=>{
  const input=deepFreeze(GRADING()),a=W.parseStudioGrading(input),b=W.parseStudioGrading(input);
  assert.deepEqual(a,b);assert.notEqual(a.items,b.items);a.items[0].text='changed';assert.notEqual(b.items[0].text,'changed');
  assert.deepEqual(input,GRADING());
});

/* ---------- parseStudioMessages ---------- */
const PLACEHOLDER='(invented placeholder text)';
const call=(id,command,name='bash')=>({id,type:'function',function:{name,arguments:JSON.stringify({command})}});
const CONVERSATION=()=>[
  {role:'assistant',content:'I will open the workbook.',tool_calls:[call('c1','python3 open_workbook.py')]},{role:'assistant',content:PLACEHOLDER},{role:'tool',content:'Opened Atlas_Model with 5 cells.',tool_call_id:'c1'},
  {role:'assistant',content:'',tool_calls:[call('c2','echo done'),call('c3','ls')]},{role:'assistant',content:PLACEHOLDER},{role:'tool',content:'done',tool_call_id:'c2'},{role:'tool',content:'',tool_call_id:'c3'},
  {role:'assistant',content:'The bridge is 1,200 units.'}];
test('parseStudioMessages: calls, results and the final answer; the repeated placeholder is skipped',()=>{
  const r=W.parseStudioMessages(CONVERSATION());
  assert.deepEqual(Object.keys(r),['steps','finalAnswer','limits']);
  assert.deepEqual(r.steps.map(s=>[s.i,s.message,s.role,s.kind]),[[0,0,'assistant','say'],[1,0,'assistant','command'],[2,2,'tool','result'],[3,3,'assistant','command'],[4,3,'assistant','command'],[5,5,'tool','result'],[6,6,'tool','result'],[7,7,'assistant','final']]);
  assert.deepEqual(r.steps[1].tool,{id:'c1',name:'bash',command:'python3 open_workbook.py'});assert.equal(r.steps[1].text,'python3 open_workbook.py');
  assert.deepEqual(r.steps[2].tool,{id:'c1',name:'bash',command:'python3 open_workbook.py'},'a result carries the call it answers');
  assert.equal(r.steps[6].text,'','an empty result is kept: a command that printed nothing');assert.equal(r.steps[0].tool,null);assert.equal(r.steps[7].tool,null);
  assert.equal(r.finalAnswer,'The bridge is 1,200 units.');assert.deepEqual(r.limits,[]);
  assert.ok(!r.steps.some(s=>s.text===PLACEHOLDER));
});
test('parseStudioMessages: the final answer is the last assistant message with no tool call, and only if nothing follows it',()=>{
  const c=CONVERSATION();
  assert.equal(W.parseStudioMessages([...c,{role:'user',content:'thanks'}]).finalAnswer,'The bridge is 1,200 units.','a trailing user message does not hide it');
  const cut=W.parseStudioMessages(c.slice(0,7));assert.equal(cut.finalAnswer,null,'a transcript that ends on a tool result has no final answer');assert.ok(!cut.steps.some(s=>s.kind==='final'));
  const endsOnCall=W.parseStudioMessages(c.slice(0,4));assert.equal(endsOnCall.finalAnswer,null);
  const sayThenCall=W.parseStudioMessages([{role:'assistant',content:'Thinking aloud.'},{role:'assistant',content:null,tool_calls:[call('z','ls')]},{role:'tool',content:'x',tool_call_id:'z'}]);assert.equal(sayThenCall.finalAnswer,null);assert.equal(sayThenCall.steps[0].kind,'say');
  const finalIsConstant=W.parseStudioMessages([...c.slice(0,3),{role:'assistant',content:PLACEHOLDER}]);assert.equal(finalIsConstant.finalAnswer,PLACEHOLDER,'a final answer is never dropped as a placeholder');
  assert.equal(W.parseStudioMessages([{role:'assistant',content:'  '}]).finalAnswer,null,'an empty final is no answer');
  assert.deepEqual(W.parseStudioMessages([]),{steps:[],finalAnswer:null,limits:[]});
});
test('parseStudioMessages: one lone placeholder cannot be told from speech and is kept; a short repeated text elsewhere is not dropped',()=>{
  const one=W.parseStudioMessages([{role:'assistant',content:'go',tool_calls:[call('a','ls')]},{role:'assistant',content:PLACEHOLDER},{role:'tool',content:'x',tool_call_id:'a'},{role:'assistant',content:'Done.'}]);
  assert.deepEqual(one.steps.map(s=>s.kind),['say','command','say','result','final']);
  const spoken=W.parseStudioMessages([{role:'assistant',content:'Ok.'},{role:'assistant',content:'Ok.'},{role:'assistant',content:'Ok.'}]);assert.deepEqual(spoken.steps.map(s=>s.kind),['say','say','final'],'repeated speech that does not follow a tool call is kept');
  const longText='z'.repeat(300),long=W.parseStudioMessages([{role:'assistant',content:'a',tool_calls:[call('1','ls')]},{role:'assistant',content:longText},{role:'tool',content:'r',tool_call_id:'1'},{role:'assistant',content:'b',tool_calls:[call('2','ls')]},{role:'assistant',content:longText},{role:'tool',content:'r',tool_call_id:'2'},{role:'assistant',content:'end'}]);
  assert.equal(long.steps.filter(s=>s.text===longText).length,2,'a long repeated text is real content, not a placeholder');
});
test('parseStudioMessages: caps, odd arguments, content parts and unusable messages',()=>{
  const big=W.parseStudioMessages([{role:'assistant',content:'x',tool_calls:[call('1','y'.repeat(210000))]},{role:'tool',content:'z'.repeat(16001),tool_call_id:'1'},{role:'assistant',content:'q'.repeat(210000)}]);
  assert.equal(big.steps.find(s=>s.kind==='command').text.length,200000);assert.equal(W.parseStudioMessages([{role:'assistant',content:'x',tool_calls:[call('1','y'.repeat(17000))]}]).steps[1].text.length,17000,'only the tool result is held to 16000 characters; a long command is kept');assert.equal(big.steps.find(s=>s.kind==='result').text.length,16000);assert.equal(big.finalAnswer.length,200000);
  assert.match(big.limits.join(' '),/1 tool result was cut at 16000/);assert.match(big.limits.join(' '),/1 command was cut at 200000/);
  const odd=W.parseStudioMessages([{role:'assistant',content:null,tool_calls:[{id:'a',type:'function',function:{name:'edit',arguments:'not json at all'}},{id:'b',function:{name:'edit',arguments:{path:'x.txt'}}},{function:{name:'bash',arguments:JSON.stringify({restart:true})}},{id:'d'}]}]);
  assert.deepEqual(odd.steps.map(s=>[s.tool.id,s.tool.name,s.text]),[['a','edit','not json at all'],['b','edit','{"path":"x.txt"}'],['','bash','{"restart":true}'],['d','','']]);
  const parts=W.parseStudioMessages([{role:'user',content:[{type:'text',text:'Task one'},{type:'image'},'plain',{text:'two'}]},{role:'system',content:'rules'},{role:'function',content:'out',tool_call_id:'q'},{role:'developer',content:'dev'},{role:'wizard',content:'?'},null,5,[]]);
  assert.deepEqual(parts.steps.map(s=>[s.role,s.kind,s.text]),[['user','say','Task one\nplain\ntwo'],['system','say','rules'],['tool','result','out'],['system','say','dev']]);
  assert.equal(parts.steps[2].tool.name,'');assert.match(parts.limits.join(' '),/4 messages were skipped/);
  assert.throws(()=>W.parseStudioMessages({}),/must be a JSON array/);assert.throws(()=>W.parseStudioMessages('[1'),/not valid JSON/);assert.throws(()=>W.parseStudioMessages(null),/must be a JSON array/);
  assert.equal(W.parseStudioMessages(JSON.stringify(CONVERSATION())).finalAnswer,'The bridge is 1,200 units.');
  const lots=W.parseStudioMessages(Array.from({length:20005},()=>({role:'user',content:'u'})));assert.equal(lots.steps.length,20000);assert.match(lots.limits.join(' '),/first 20000 messages/);
});
test('parseStudioMessages: never mutates its input',()=>{const input=deepFreeze(CONVERSATION()),a=W.parseStudioMessages(input),b=W.parseStudioMessages(input);assert.deepEqual(a,b);assert.deepEqual(input,CONVERSATION());});

/* ---------- normalizeEval ---------- */
test('normalizeEval: the stored record, scores kept as given and never divided',()=>{
  const parsed=W.parseStudioGrading(GRADING({grading_runs:[{...GRADING().grading_runs[0],final_score:3}],trajectory_output:{...GRADING().trajectory_output,final_score:3,rewards:[{subscores:[{name:'a',score:3,max_score:4,weight:1,reasoning:''}]}]}}));
  const e=W.normalizeEval(parsed,{task:'  Atlas  ',sourceName:'grading_results.json',importedAt:'2026-10-12T10:00:00.000Z'});
  assert.deepEqual(e,{id:'eval-gr-qa-1',task:'Atlas',runId:'gr-qa-1',attempt:2,score:3,scoreMax:4,judge:{provider:'qa-provider',model:'qa-judge'},scoringMethod:'rubric',importedAt:'2026-10-12T10:00:00.000Z',sourceName:'grading_results.json'});
  assert.ok(!JSON.stringify(e).includes('0.75'),'3 / 4 is never turned into a ratio');assert.deepEqual(Object.keys(e),['id','task','runId','attempt','score','scoreMax','judge','scoringMethod','importedAt','sourceName']);
  assert.deepEqual(W.normalizeEval(parsed,{task:'Atlas'}),W.normalizeEval(parsed,{task:'Atlas'}),'deterministic');
});
test('normalizeEval: ids are stable, missing metadata is tolerated, a non-result throws',()=>{
  const a=W.normalizeEval({finalScore:'2',scoreMax:'5',problemRunId:'pr-9',attempt:1}),b=W.normalizeEval({finalScore:2,scoreMax:5,problemRunId:'pr-9',attempt:1});
  assert.equal(a.id,'eval-pr-9-1');assert.equal(a.score,2);assert.equal(a.scoreMax,5);assert.deepEqual(a,b);assert.equal(a.task,'');assert.equal(a.sourceName,'');assert.equal(a.importedAt,null);assert.equal(a.judge,null);assert.equal(a.runId,null);
  const anon1=W.normalizeEval({finalScore:2},{sourceName:'a.json',importedAt:'t'}),anon2=W.normalizeEval({finalScore:2},{sourceName:'b.json',importedAt:'t'});
  assert.match(anon1.id,/^eval-[0-9a-f]{8}$/);assert.notEqual(anon1.id,anon2.id);assert.equal(W.normalizeEval({finalScore:2},{sourceName:'a.json',importedAt:'t'}).id,anon1.id);
  assert.equal(W.normalizeEval({finalScore:'abc',scoreMax:null}).score,null);
  for(const bad of [null,undefined,'x',5,[]])assert.throws(()=>W.normalizeEval(bad),/needs a parsed evaluation result/);
  const frozen=deepFreeze({finalScore:1,scoreMax:1,runId:'r'});assert.equal(W.normalizeEval(frozen,deepFreeze({task:'t'})).id,'eval-r');
});

/* ---------- suggestClauses / excerptAround ---------- */
test('suggestClauses: one value in many spellings finds the same records',async()=>{
  const p=pkg([txt('Facility_Terms.txt',['Atlas owes 2,480 units','Reserve 2480.00 held','Fee 2,480.5 due','Total 12,480 units','Pool 2,480,000 units','Code 2,4801','Ref A2480','Cobalt 0.80 rate','Negative -2,480 owed']),csv('Cash_Facts.csv',[['Label','Value'],['Requested draw','2480'],['Dividend per share','0.8']]),xlsx('Atlas_Model.xlsx',[cell('S','A10',99),cell('S','A1',98),cell('S','C3','$2,480')])]);
  const want=['Facility_Terms.txt@Line 1','Facility_Terms.txt@Line 2','Cash_Facts.csv@Row 2','Atlas_Model.xlsx@S!C3'];
  const at=v=>W.suggestClauses(p,v,{limit:10}).map(m=>m.documentName+'@'+m.locator);
  for(const v of [2480,'2480','2,480','2480.00','2,480.0','$2,480','$ 2,480.00',2480.0,'+2480'])assert.deepEqual(at(v),want,JSON.stringify(v));
  assert.deepEqual(at('(2,480)'),['Facility_Terms.txt@Line 9'],'a bracketed value is the negative one');
  assert.deepEqual(at(-2480),['Facility_Terms.txt@Line 9']);assert.deepEqual(at('-2,480.000'),['Facility_Terms.txt@Line 9']);
  assert.deepEqual(at(2480.5),['Facility_Terms.txt@Line 3']);assert.deepEqual(at('0.80'),['Facility_Terms.txt@Line 8','Cash_Facts.csv@Row 3']);assert.deepEqual(at(0.8),at('0.8'));assert.deepEqual(at('.8'),at('0.8'));
  assert.deepEqual(at(10),[],'10 is not found inside the cell reference A10');
  assert.deepEqual(at(1),[],'1 is not found inside A1 or S!A1');
  assert.deepEqual(W.suggestClauses(p,'2,480',{limit:10}).map(m=>m.match),['2,480','2480.00','2480','$2,480'],'the match is the text as written');
});
test('suggestClauses: zero is one value however it is written',()=>{
  const p=pkg([txt('Facility_Terms.txt',['Reserve 0 held','Reserve 0.00 held','Reserve -0 held','Reserve 000 held','Reserve 0.5 held','Reserve 10 held'])]);
  assert.deepEqual(W.suggestClauses(p,0,{limit:10}).map(m=>m.locator),['Line 1','Line 2','Line 3','Line 4']);assert.deepEqual(W.suggestClauses(p,'-0.0',{limit:10}).map(m=>m.locator),['Line 1','Line 2','Line 3','Line 4']);assert.deepEqual(W.suggestClauses(p,0.5).map(m=>m.locator),['Line 5']);
});
test('suggestClauses: shape, limit, order, and which documents are searched',()=>{
  const p=pkg([txt('A_Source.txt',['value 777 one','value 777 two','value 777 three']),txt('B_Source.txt',['value 777 four'],{id:'doc-b'}),txt('Grader_Key.txt',['value 777 secret'],{role:'evaluator'}),txt('Run_Log.txt',['value 777 log'],{role:'run-evidence'}),txt('Review.txt',['value 777 audit'],{role:'audit'}),txt('Broken.txt',['value 777 broken'],{status:'error'}),txt('Scan.pdf',['value 777 scan'],{status:'unsupported'}),txt('Task_Prompt.txt',['value 777 prompt'],{role:'prompt'})]);
  const all=W.suggestClauses(p,777,{limit:50});
  assert.deepEqual(all.map(m=>m.documentName+'@'+m.locator),['A_Source.txt@Line 1','A_Source.txt@Line 2','A_Source.txt@Line 3','B_Source.txt@Line 1','Task_Prompt.txt@Line 1'],'package order; grader, run evidence, audit, error and unsupported files are never offered');
  assert.deepEqual(Object.keys(all[0]),['documentId','documentName','sha256','locator','quote','match']);assert.equal(all[3].documentId,'doc-b');assert.equal(all[0].sha256,p.documents[0].sha256);assert.equal(all[0].quote,'value 777 one');
  assert.equal(W.suggestClauses(p,777).length,5,'the default limit is five');assert.equal(W.suggestClauses(p,777,{limit:2}).length,2);assert.equal(W.suggestClauses(p,777,{limit:0}).length,5,'a limit below one is ignored');assert.equal(W.suggestClauses(p,777,{limit:1000}).length,5);
  assert.deepEqual(W.suggestClauses(p,777,{limit:2}),all.slice(0,2),'a smaller limit is a prefix');
  const frozen=deepFreeze(copy(p));assert.deepEqual(W.suggestClauses(frozen,777,{limit:3}),all.slice(0,3));
  const fresh=W.suggestClauses(p,777);fresh[0].quote='changed';assert.equal(W.suggestClauses(p,777)[0].quote,'value 777 one');
});
test('suggestClauses: phrases, unusable values and unusable packages',()=>{
  const p=pkg([txt('Facility_Terms.txt',['Atlas Holdings owes Meridian Partners 2,480 units','The ATLAS HOLDINGS name','Atlases are maps','Meridian  Partners  (spaced)'])]);
  assert.deepEqual(W.suggestClauses(p,'atlas holdings').map(m=>m.locator),['Line 1','Line 2']);assert.deepEqual(W.suggestClauses(p,'Meridian Partners').map(m=>m.locator),['Line 1','Line 4'],'any run of whitespace matches');
  assert.deepEqual(W.suggestClauses(p,'Atlas').map(m=>m.locator),['Line 1','Line 2'],'whole words only: Atlases is not Atlas');assert.deepEqual(W.suggestClauses(p,'tlas'),[]);
  for(const v of ['','  ','ab',null,undefined,true,{},[],NaN,Infinity,1e21,'x'])assert.deepEqual(W.suggestClauses(p,v),[],JSON.stringify(v));
  for(const bad of [null,undefined,{},{documents:5},'pkg',[]])assert.deepEqual(W.suggestClauses(bad,2480),[]);
  assert.deepEqual(W.suggestClauses(pkg([txt('A.txt',['bad'],{records:[null,5,{text:'2480'},{locator:'Line 2',text:'2480'}]})]),2480).map(m=>m.locator),['Line 2'],'records without a locator are skipped');
  assert.deepEqual(W.suggestClauses(p,'$%^(',{}),[],'regex characters in a phrase are literal');
});
test('excerptAround: the text around a needle, with offsets and edge flags',()=>{
  const t='The quick brown fox jumps over the lazy dog';
  assert.deepEqual(W.excerptAround(t,'brown',5),{before:'uick ',match:'brown',after:' fox ',text:'uick brown fox ',start:5,end:20,index:10,ellipsisBefore:true,ellipsisAfter:true});
  const head=W.excerptAround(t,'The',4);assert.equal(head.ellipsisBefore,false);assert.equal(head.ellipsisAfter,true);assert.equal(head.text,'The qui');
  const end=W.excerptAround(t,'dog',4);assert.equal(end.ellipsisAfter,false);assert.equal(end.text,'azy dog');
  assert.equal(W.excerptAround(t,'BROWN',0).text,'brown','falls back to ignoring case and keeps the original spelling');assert.equal(W.excerptAround(t,'BROWN',0).match,'brown');
  assert.equal(W.excerptAround(t,'dog',-1).text,t,'a negative radius falls back to the default');
  assert.equal(W.excerptAround(t,'dog').text,t);assert.equal(W.excerptAround(t,'dog',99999).text,t);
  for(const bad of [['',  'x'],['text',''],['text','missing'],[null,'x'],['abc',null],[undefined,undefined]])assert.equal(W.excerptAround(bad[0],bad[1]),null);
  const emoji='aaa\u{1F600}needle\u{1F600}bbb';const cut=W.excerptAround(emoji,'needle',1);assert.ok(!/[\uDC00-\uDFFF]$/.test(cut.text.slice(0,1))||cut.text.codePointAt(0)>0xffff,'a surrogate pair is not split');
  assert.equal(cut.text.length%1,0);assert.ok(cut.text.includes('needle'));
  assert.equal(W.excerptAround(5,'5').text,'5');
});

/* ---------- diff rows ---------- */
const XDIFF=cells=>docDiff('Atlas_Model.xlsx','changed','xlsx',{cells});
test('diffViewRows: changed cells with two rows and columns of context, merged windows, gaps and change order',()=>{
  const d=XDIFF([change('Bridge','D10','value',1,2),change('Bridge','B3','value',3,4),change('Bridge','B5','added',null,9),change('Bridge','F30','removed',7,null)]);
  const v=W.diffViewRows(d);
  assert.deepEqual(Object.keys(v),['sections','changes','unplaced','total','collisions','truncated','context']);assert.equal(v.total,4);assert.equal(v.context,2);assert.equal(v.truncated,false);
  assert.equal(v.sections.length,1);const s=v.sections[0];assert.equal(s.sheet,'Bridge');
  assert.deepEqual(s.rows.map(r=>r.row),[1,2,3,4,5,6,7,8,9,10,11,12,28,29,30,31,32],'rows 1-7 are one window (B3 and B5 overlap), 8-12 another, 28-32 the last');
  assert.deepEqual(s.rows.map(r=>r.gapBefore).filter(Boolean),[15],'only the jump from 12 to 28 hides rows');assert.equal(s.rows[0].gapBefore,0);
  assert.deepEqual(s.columns,['A','B','C','D','E','F','G','H'],'columns B..F plus two each side, clamped at A');
  const row3=s.rows.find(r=>r.row===3),b3=row3.cells.find(c=>c.col==='B');
  assert.deepEqual(Object.keys(b3),['col','locator','role','change','before','after','value','known','hidden','collisions','changeIndex']);
  assert.equal(b3.role,'changed');assert.equal(b3.locator,'Bridge!B3');assert.equal(b3.value,'4');assert.deepEqual(b3.before,snap(3));assert.deepEqual(b3.after,snap(4));assert.equal(row3.key,'Bridge#3');
  const ctxCell=row3.cells.find(c=>c.col==='C');assert.equal(ctxCell.role,'context');assert.equal(ctxCell.value,null);assert.equal(ctxCell.known,false);assert.equal(ctxCell.change,null);assert.equal(ctxCell.changeIndex,null);
  assert.deepEqual(v.changes.map(c=>[c.index,c.locator,c.prev,c.next]),[[0,'Bridge!B3',null,1],[1,'Bridge!B5',0,2],[2,'Bridge!D10',1,3],[3,'Bridge!F30',2,null]],'sorted by row then column, with previous and next indexes');
  assert.deepEqual(v.changes.map(c=>c.shown),[true,true,true,true]);
  assert.equal(row3.cells.find(c=>c.col==='B').changeIndex,0);assert.equal(s.rows.find(r=>r.row===30).cells.find(c=>c.col==='F').changeIndex,3);
  assert.equal(s.rows.find(r=>r.row===30).cells.find(c=>c.col==='F').value,'7','a removed cell shows its old value');
});
test('diffViewRows: the order does not depend on the order of the input, context radius is an option, sheets sort by name',()=>{
  const cells=[change('Summary','A1','value',1,2),change('Bridge','C4','value',1,2),change('Bridge','A2','value',1,2),change('Inputs','B7','added',null,1)];
  const a=W.diffViewRows(XDIFF(cells)),b=W.diffViewRows(XDIFF([...cells].reverse())),c=W.diffViewRows(XDIFF([cells[2],cells[0],cells[3],cells[1]]));
  assert.deepEqual(a,b);assert.deepEqual(a,c);assert.deepEqual(a.sections.map(s=>s.sheet),['Bridge','Inputs','Summary']);assert.deepEqual(a.changes.map(x=>x.locator),['Bridge!A2','Bridge!C4','Inputs!B7','Summary!A1']);
  const none=W.diffViewRows(XDIFF([change('S','C5','value',1,2)]),{context:0});assert.deepEqual(none.sections[0].rows.map(r=>r.row),[5]);assert.deepEqual(none.sections[0].columns,['C']);
  const wide=W.diffViewRows(XDIFF([change('S','C5','value',1,2)]),{context:1});assert.deepEqual(wide.sections[0].rows.map(r=>r.row),[4,5,6]);assert.deepEqual(wide.sections[0].columns,['B','C','D']);assert.equal(wide.sections[0].rows[0].gapBefore,3,'rows above the window are hidden');
  const corner=W.diffViewRows(XDIFF([change('S','A1','value',1,2)]));assert.deepEqual(corner.sections[0].rows.map(r=>r.row),[1,2,3],'rows and columns stop at the first row and column');assert.deepEqual(corner.sections[0].columns,['A','B','C']);assert.equal(corner.sections[0].rows[0].gapBefore,0);
  const second=W.diffViewRows(XDIFF([change('S','B2','value',1,2)]),{context:5});assert.deepEqual(second.sections[0].rows.map(r=>r.row),Array.from({length:7},(_,i)=>i+1));assert.deepEqual(second.sections[0].columns,['A','B','C','D','E','F','G']);
  assert.equal(W.diffViewRows(XDIFF([change('S','C5','value',1,2)]),{context:-3}).context,2);assert.equal(W.diffViewRows(XDIFF([change('S','C5','value',1,2)]),{context:99}).context,20);
});
test('diffViewRows: context values come from the document when given, never invented when not',()=>{
  const cand=MODEL(150),v=W.diffViewRows(docDiff('Atlas_Model.xlsx','changed','xlsx',{cells:[change('Bridge','B3','value',100,150)]}),{context:1,candDoc:cand});
  const rows=Object.fromEntries(v.sections[0].rows.map(r=>[r.row,r]));
  assert.equal(rows[2].cells.find(c=>c.col==='B').value,'1850');assert.equal(rows[2].cells.find(c=>c.col==='B').known,true);assert.equal(rows[2].cells.find(c=>c.col==='B').role,'context');
  assert.equal(rows[4].cells.find(c=>c.col==='B').value,'','a cell with nothing in it is known to be empty');assert.equal(rows[4].cells.find(c=>c.col==='B').known,true);
  assert.equal(rows[3].cells.find(c=>c.col==='B').value,'150');
  const viaBase=W.diffViewRows(docDiff('Atlas_Model.xlsx','changed','xlsx',{cells:[change('Bridge','B3','value',100,150)]}),{context:1,baseDoc:MODEL(100)});assert.equal(viaBase.sections[0].rows.find(r=>r.row===2).cells.find(c=>c.col==='B').value,'1850');
  const sheetIsolated=W.diffViewRows(docDiff('Atlas_Model.xlsx','changed','xlsx',{cells:[change('Summary','A1','value','Atlas','Borealis')]}),{context:1,candDoc:cand});assert.equal(sheetIsolated.sections[0].rows.find(r=>r.row===2).cells.find(c=>c.col==='A').value,'','another sheet\'s cells are not borrowed');
});
test('diffViewRows: csv rows use the derived column; several columns of one row stay separate; same-cell collisions are counted',()=>{
  const d=docDiff('Cash_Facts.csv','changed','csv',{cells:[{locator:'Row 3',change:'value',before:snap(1),after:snap(2),hidden:false,derivedColumn:'C'},{locator:'Row 3',change:'added',before:null,after:snap(9),hidden:false,derivedColumn:'A'},{locator:'Row 3',change:'value',before:snap(5),after:snap(6),hidden:false,derivedColumn:'C'}]});
  const v=W.diffViewRows(d,{context:0});
  assert.equal(v.total,3);assert.equal(v.collisions,1);assert.deepEqual(v.sections[0].columns,['A','C']);assert.equal(v.sections[0].sheet,'');
  assert.deepEqual(v.sections[0].rows[0].cells.map(c=>[c.col,c.locator,c.value,c.collisions]),[['A','Row 3','9',0],['C','Row 3','2',1]],'the first change in a cell is shown and the other is counted');
  assert.deepEqual(v.changes.map(c=>[c.locator,c.col]),[['Row 3','A'],['Row 3','C']]);
  const withDoc=W.diffViewRows(d,{context:1,candDoc:csv('Cash_Facts.csv',[['Label','Value'],['Opening usable cash','100'],['Payments due','1850'],['Requested draw','2,480']])});
  assert.equal(withDoc.sections[0].rows.find(r=>r.row===2).cells.find(c=>c.col==='B').value,'100');assert.equal(withDoc.sections[0].rows.find(r=>r.row===2).cells.find(c=>c.col==='B').locator,'Row 2');
});
test('diffViewRows: cells without a position, empty diffs and the row cap',()=>{
  const odd=W.diffViewRows(XDIFF([{locator:'Something odd',change:'value',before:snap(1),after:snap(2),hidden:true},change('S','A1','value',1,2)]));
  assert.equal(odd.total,2);assert.deepEqual(odd.unplaced,[{locator:'Something odd',change:'value',before:snap(1),after:snap(2),hidden:true}]);assert.equal(odd.changes.length,1);
  for(const empty of [XDIFF([]),null,undefined,{},{cells:'x'},docDiff('A.txt','changed','txt',{lines:[]})]){const v=W.diffViewRows(empty);assert.deepEqual([v.sections,v.changes,v.unplaced,v.total,v.truncated],[[],[],[],0,false]);}
  const spread=Array.from({length:30},(_,i)=>change('S','A'+(1+i*100),'value',1,2)),capped=W.diffViewRows(XDIFF(spread),{maxRows:20});
  assert.equal(capped.truncated,true);assert.equal(capped.sections[0].truncated,true);assert.equal(capped.sections[0].rows.length,20);assert.equal(capped.total,30);assert.equal(capped.changes.length,30,'every change keeps its index');
  assert.ok(capped.changes.some(c=>!c.shown)&&capped.changes[0].shown);
  const cols=W.diffViewRows(XDIFF([change('S','A1','value',1,2),change('S','AZ1','value',1,2)]),{maxCols:5});assert.equal(cols.sections[0].columns.length,5);assert.equal(cols.truncated,true);
  assert.deepEqual(W.diffViewRows(XDIFF([change('S','AB7','value',1,2)]),{context:0}).sections[0].columns,['AB'],'multi-letter columns');
});
test('diffViewRows: never mutates its input',()=>{const d=deepFreeze(XDIFF([change('S','B2','value',1,2),change('S','A1','added',null,1)]));assert.deepEqual(W.diffViewRows(d),W.diffViewRows(d));});

const OPS=(spec)=>{let b=0,c=0;return spec.split(' ').map(t=>{const op={E:'equal',A:'add',D:'del'}[t[0]],text=t.slice(1)||t;let o;if(op==='equal'){b++;c++;o={op,baseLocator:'Line '+b,candLocator:'Line '+c,before:text,after:text};}else if(op==='add'){c++;o={op,baseLocator:null,candLocator:'Line '+c,before:null,after:text};}else{b++;o={op,baseLocator:'Line '+b,candLocator:null,before:text,after:null};}return o;});};
test('lineDiffRows: long equal runs fold into one row, short ones stay, every change keeps its operation and both locators',()=>{
  const eq=n=>Array.from({length:n},(_,i)=>'Eq'+i).join(' ');
  const six=W.lineDiffRows(docDiff('A.txt','changed','txt',{lines:OPS(eq(6)+' Dold Anew '+eq(6))}));
  assert.equal(six.rows.length,6+2+6,'a run of exactly six equal lines is not folded');assert.ok(six.rows.every(r=>r.type==='line'));
  const seven=W.lineDiffRows(docDiff('A.txt','changed','txt',{lines:OPS(eq(7)+' Dold Anew '+eq(9))}));
  assert.deepEqual(seven.rows.map(r=>r.type),['collapsed','line','line','collapsed']);
  assert.deepEqual(seven.rows[0],{type:'collapsed',count:7,fromIndex:0,toIndex:7,baseFrom:'Line 1',baseTo:'Line 7',candFrom:'Line 1',candTo:'Line 7'});
  assert.deepEqual(seven.rows[3],{type:'collapsed',count:9,fromIndex:9,toIndex:18,baseFrom:'Line 9',baseTo:'Line 17',candFrom:'Line 9',candTo:'Line 17'},'after one line was removed and one added the sides still count up together');
  assert.deepEqual(seven.rows[1],{type:'line',index:7,op:'del',baseLocator:'Line 8',candLocator:null,before:'old',after:null,text:'old',changeIndex:0});
  assert.deepEqual(seven.rows[2],{type:'line',index:8,op:'add',baseLocator:null,candLocator:'Line 8',before:null,after:'new',text:'new',changeIndex:0});
  assert.deepEqual(seven.changes,[{firstRow:1,lastRow:2,adds:1,dels:1,index:0,prev:null,next:null}]);assert.equal(seven.total,1);assert.equal(seven.collapseAfter,6);
  const expanded=seven.rows.flatMap(r=>r.type==='collapsed'?Array.from({length:r.count},(_,k)=>r.fromIndex+k):[r.index]);assert.deepEqual(expanded,Array.from({length:18},(_,k)=>k),'the index range of a folded row recovers every folded line');
});
test('lineDiffRows: the threshold is an option; changes are runs of added or removed lines with previous and next',()=>{
  const ops=OPS('Ea Eb Ec Dx Dy Ay Ed Ee Ef Eg Ah Ei');
  const folded=W.lineDiffRows(docDiff('A.txt','changed','txt',{lines:ops}),{collapseAfter:2});
  assert.deepEqual(folded.rows.map(r=>r.type+(r.count||'')),['collapsed3','line','line','line','collapsed4','line','line']);
  assert.deepEqual(folded.changes.map(c=>[c.index,c.prev,c.next,c.adds,c.dels]),[[0,null,1,1,2],[1,0,null,1,0]]);assert.equal(folded.rows[1].changeIndex,0);assert.equal(folded.rows[5].changeIndex,1);assert.equal(folded.rows[6].changeIndex,null);
  assert.equal(W.lineDiffRows(docDiff('A.txt','changed','txt',{lines:ops}),{collapseAfter:0}).rows.filter(r=>r.type==='collapsed').length,3,'zero folds every equal run');
  assert.equal(W.lineDiffRows(docDiff('A.txt','changed','txt',{lines:ops}),{collapseAfter:'x'}).collapseAfter,6);assert.equal(W.lineDiffRows(docDiff('A.txt','changed','txt',{lines:ops}),{collapseAfter:-1}).collapseAfter,6);
  const unchanged=W.lineDiffRows(docDiff('A.txt','unchanged','txt'));assert.deepEqual([unchanged.rows,unchanged.changes,unchanged.total],[[],[],0]);
  assert.deepEqual(W.lineDiffRows(docDiff('A.txt','changed','txt',{lines:[{op:'move'},null,5,{op:'add',candLocator:'Line 1',after:'k'}]})).rows.map(r=>r.op),['add'],'unknown operations are ignored');
  assert.deepEqual(W.lineDiffRows(null).rows,[]);
});
test('lineDiffRows: never mutates its input and is deterministic',()=>{const d=deepFreeze(docDiff('A.txt','changed','txt',{lines:OPS('Ea Eb Ec Ed Ee Ef Eg Dh Ai')}));assert.deepEqual(W.lineDiffRows(d),W.lineDiffRows(d));});

/* ---------- buildCase ---------- */
test('buildCase: the result has the documented shape',()=>{
  const c=W.buildCase(SCENE());
  assert.deepEqual(Object.keys(c),['files','criteria','solver','limits','notes']);
  assert.deepEqual(Object.keys(c.solver),['conclusion','finalText','withheld']);
  assert.deepEqual(Object.keys(c.criteria[0]),['id','text','group','origin','status','statusBasis','clauses','cells','lines','conclusion','numbers']);
  assert.deepEqual(Object.keys(c.criteria[0].conclusion),['runRef','where','quote','figure','humanVerdict']);
  assert.deepEqual(c.criteria.map(x=>x.origin),['freeze-figure','freeze-figure','freeze-figure','project-output','project-output']);
  assert.deepEqual(c.criteria.map(x=>x.id),['figure:cash-bridge','figure:facility-headroom','figure:requested-draw','output:r1/o-bridge','output:r1/o-limit']);
  assert.deepEqual(copy(c),copy(W.buildCase(SCENE())),'deterministic');
});
test('buildCase: a freeze figure is Met when found, Not met when not found, and the quote is located in the final answer',()=>{
  const c=W.buildCase(SCENE());
  const bridge=figure(c,'Cash bridge'),headroom=figure(c,'Facility headroom'),draw=figure(c,'Requested draw');
  assert.deepEqual([bridge.status,bridge.statusBasis],['met','heuristic-figure-search']);
  assert.deepEqual([headroom.status,headroom.statusBasis],['not-met','heuristic-figure-search']);
  assert.deepEqual([draw.status,draw.statusBasis],['met','heuristic-figure-search'],'found in the saved outputs counts as found');
  assert.deepEqual(bridge.conclusion,{runRef:{key:'round-qa-1:1',roundId:'round-qa-1',n:1,runId:'round-qa-1-1'},where:'final',quote:'Review of the Atlas facility. The cash bridge is 1,200 units after the funded draw. The requested draw is stated in the workbook. Headroom was n\u2026',figure:{label:'Cash bridge',expected:'1,200',found:true},humanVerdict:null});
  assert.deepEqual(headroom.conclusion.figure,{label:'Facility headroom',expected:500,found:false});assert.equal(headroom.conclusion.where,null);assert.equal(headroom.conclusion.quote,'');
  assert.equal(draw.conclusion.where,'outputs');assert.equal(draw.conclusion.quote,'','nothing is quoted from output files the model cannot read');
  const long='x'.repeat(300)+' the figure 1,200 units '+'y'.repeat(300),far=W.buildCase(SCENE({runDetail:RUN({final:{text:long,chars:long.length}})}));
  const q=figure(far,'Cash bridge').conclusion.quote;assert.ok(q.startsWith('…')&&q.endsWith('…'));assert.ok(q.includes('the figure 1,200 units'));assert.ok(q.length<260);
  const toleranceRound=ROUND({freeze:FREEZE({gold:{decision:'',figures:[{label:'Cash bridge',value:1200,tolerance:5},{label:'Facility headroom',value:500,tolerance:0},{label:'Requested draw',value:'2,480',tolerance:0}],notes:''}})});
  const near=W.buildCase(SCENE({round:toleranceRound,runDetail:RUN({final:{text:'The bridge is 1,203 units.',chars:25}})}));assert.match(figure(near,'Cash bridge').conclusion.quote,/1,203 units/,'the tolerance the freeze recorded is used to find the number');
  const noTol=W.buildCase(SCENE({round:ROUND({postHocFreezes:[],freeze:FREEZE({sha256:digest('other')})}),runDetail:RUN({final:{text:'The bridge is 1,203 units.',chars:25}})}));assert.equal(figure(noTol,'Cash bridge').conclusion.quote,'','no matching freeze means no tolerance and nothing is quoted');
});
test('buildCase: the solver conclusion carries state, audit and both verdicts',()=>{
  const human={verdict:'fingerprint',fingerprintIds:['fp-alpha'],note:'Landed on the credit reading.',at:'2026-10-02T09:00:00.000Z',freezeVersion:1,freezeSha256:FREEZE().sha256};
  const run=RUN();run.classification.suggested.fingerprints[0].hit=true;run.classification.suggested.decision={keywords:['proceed'],found:['proceed']};run.classification.human=human;
  const c=W.buildCase(SCENE({runDetail:run}));
  assert.deepEqual(c.solver,{conclusion:{runRef:{key:'round-qa-1:1',roundId:'round-qa-1',n:1,runId:'round-qa-1-1'},state:'completed',audit:'CLEAN',suggestedVerdict:'unclear',humanVerdict:{verdict:'fingerprint',fingerprintIds:['fp-alpha'],note:'Landed on the credit reading.',at:'2026-10-02T09:00:00.000Z',freezeVersion:1},fingerprintsHit:[{id:'fp-alpha',label:'Credit counted as cash'}],decision:{keywords:['proceed'],found:['proceed']},finalChars:FINAL.length},finalText:FINAL,withheld:false});
  assert.deepEqual(figure(c,'Cash bridge').status,'met','a fingerprint verdict does not change a figure the search found');
  assert.deepEqual(figure(c,'Facility headroom').statusBasis,'heuristic-figure-search');
  assert.equal(figure(c,'Cash bridge').conclusion.humanVerdict.verdict,'fingerprint');
});
test('buildCase: your Matches-the-frozen-gold verdict outranks the search, only for the freeze it was recorded against',()=>{
  const human=over=>({verdict:'matches-frozen-gold',fingerprintIds:[],note:'',at:'2026-10-02T09:00:00.000Z',freezeVersion:1,freezeSha256:FREEZE().sha256,...over});
  const run=RUN();run.classification.human=human();
  const c=W.buildCase(SCENE({runDetail:run}));
  for(const label of ['Cash bridge','Facility headroom','Requested draw']){const f=figure(c,label);assert.deepEqual([f.status,f.statusBasis],['met','human-verdict'],label);}
  assert.equal(figure(c,'Facility headroom').conclusion.figure.found,false,'the search result is still shown next to the verdict');
  const stale=RUN();stale.classification.human=human({freezeSha256:digest('freeze-0'),freezeVersion:0});
  const s=W.buildCase(SCENE({runDetail:stale}));assert.deepEqual([figure(s,'Facility headroom').status,figure(s,'Facility headroom').statusBasis],['not-met','heuristic-figure-search']);assert.match(s.notes.join('\n'),/different freeze/);
  const noHash=RUN();noHash.classification.human=human({freezeSha256:undefined});assert.equal(figure(W.buildCase(SCENE({runDetail:noHash})),'Facility headroom').status,'not-met');
  const unclear=RUN();unclear.classification.human=human({verdict:'unclear'});assert.equal(figure(W.buildCase(SCENE({runDetail:unclear})),'Facility headroom').statusBasis,'heuristic-figure-search');
});
const WITHHELD_RUN=()=>({id:'round-qa-1-1',n:1,state:'completed',audit:{status:'CLEAN',violationCount:0},final:{chars:420},outputs:[],classification:{suggested:{verdict:'unclear',label:'heuristic',freezeVersion:1,freezeSha256:FREEZE().sha256},human:{verdict:'matches-frozen-gold',at:'2026-10-02T09:00:00.000Z',freezeVersion:1,freezeSha256:FREEZE().sha256}},redacted:true});
const STUB_ROUND=()=>({id:'round-qa-1',label:'Atlas round 1',status:'running',freeze:{sha256:FREEZE().sha256,frozenAt:FREEZE().frozenAt},postHocFreezes:[],redacted:true});
test('buildCase: a withheld run is withheld, with every status unknown and no data invented',()=>{
  const flagged=W.buildCase(SCENE({runDetail:WITHHELD_RUN(),round:STUB_ROUND(),evalParsed:W.parseStudioGrading(GRADING())}));
  assert.equal(flagged.solver.withheld,true);assert.equal(flagged.solver.finalText,null);
  assert.ok(flagged.notes.includes('Details withheld while a round runs'));
  assert.ok(flagged.criteria.length>0,'criteria that do not come from the round are still listed');
  assert.ok(flagged.criteria.every(c=>c.status==='unknown'&&c.statusBasis==='none'),JSON.stringify(flagged.criteria.map(c=>[c.id,c.status,c.statusBasis])));
  assert.ok(!flagged.criteria.some(c=>c.origin==='freeze-figure'),'no gold figure is listed: it is withheld, not zero');
  assert.deepEqual(flagged.solver.conclusion,{runRef:{key:'round-qa-1:1',roundId:'round-qa-1',n:1,runId:'round-qa-1-1'},state:'completed',audit:'CLEAN',suggestedVerdict:'unclear',humanVerdict:{verdict:'matches-frozen-gold',fingerprintIds:[],note:'',at:'2026-10-02T09:00:00.000Z',freezeVersion:1},fingerprintsHit:[],decision:null,finalChars:420});
  assert.ok(flagged.criteria.every(c=>c.conclusion.quote===''&&c.conclusion.where===null&&c.conclusion.figure===null),'no quote and no figure result for a withheld run');
  const leaky=RUN({redacted:true}),roundLeak=W.buildCase(SCENE({runDetail:RUN(),round:{...STUB_ROUND()}}));
  assert.equal(W.buildCase(SCENE({runDetail:leaky})).solver.finalText,null,'a run flagged redacted never shows text, even if the response still carried some');assert.equal(roundLeak.solver.finalText,null,'a redacted round withholds its runs\' text too');assert.equal(roundLeak.solver.withheld,true);
  assert.ok(W.buildCase(SCENE({runDetail:leaky})).criteria.every(c=>c.status==='unknown'&&c.conclusion.quote===''));
  const onlyChars=W.buildCase(SCENE({runDetail:{...WITHHELD_RUN(),redacted:undefined},round:ROUND()}));assert.equal(onlyChars.solver.withheld,true,'a final answer that is only a character count is withheld');
  const roundOnly=W.buildCase(SCENE({runDetail:null,round:STUB_ROUND()}));assert.equal(roundOnly.solver.withheld,true);assert.equal(roundOnly.solver.conclusion,null);
  const nothing=W.buildCase({runDetail:WITHHELD_RUN(),round:STUB_ROUND()});assert.deepEqual(nothing.criteria,[]);assert.ok(nothing.notes.includes('Details withheld while a round runs'),'with nothing to list the page still says why');
  assert.match(flagged.notes.join('\n'),/frozen figures are not shown while a round runs/);
  const keepsCells=flagged.criteria.find(c=>c.id==='output:r1/o-bridge');assert.ok(keepsCells.cells.length>0,'changed cells come from the packages, which are not round data');assert.equal(keepsCells.numbers[0].decisionChanges,true);
});
test('buildCase: a run that is not withheld but has no figure search lists the frozen figures as unknown',()=>{
  const cases={'no run':SCENE({runDetail:null}),'discarded':SCENE({runDetail:RUN({audit:{status:'DISCARDED',violations:[{tool:'Read',kind:'absolute-path',path:'/x',call:'c'}]},classification:null})}),'queued':SCENE({runDetail:RUN({state:'queued',audit:null,final:{text:'',chars:0},classification:null})})};
  for(const [name,scene] of Object.entries(cases)){
    const c=W.buildCase(scene),figs=c.criteria.filter(x=>x.origin==='freeze-figure');
    assert.deepEqual(figs.map(f=>f.text),['Cash bridge','Facility headroom','Requested draw'],name);
    assert.ok(figs.every(f=>f.status==='unknown'&&f.statusBasis==='none'&&f.conclusion.figure.found===null),name);
    assert.equal(c.solver.withheld,false,name);
  }
  assert.match(W.buildCase(cases.discarded).notes.join('\n'),/DISCARDED by the audit/);assert.match(W.buildCase(cases.discarded).notes.join('\n'),/no figure search/);
  assert.equal(W.buildCase(cases['no run']).solver.conclusion,null);assert.equal(W.buildCase(cases['no run']).solver.finalText,null);
  const noRound=W.buildCase(SCENE({round:null,runDetail:null}));assert.ok(!noRound.criteria.some(x=>x.origin==='freeze-figure'));
  const draft=W.buildCase(SCENE({round:ROUND({freeze:null}),runDetail:null}));assert.match(draft.notes.join('\n'),/no frozen gold figures/);
  const wordsOnly=RUN();wordsOnly.classification.suggested.matches=[];assert.match(W.buildCase(SCENE({runDetail:wordsOnly})).notes.join('\n'),/no numeric figures/);
});
test('buildCase: the latest post-hoc freeze lists the figures when the run has no search of its own',()=>{
  const post=FREEZE({version:2,sha256:digest('freeze-2'),postHoc:true,gold:{decision:'',figures:[{label:'Cobalt reserve',value:'1,200',tolerance:0}],notes:''}});
  const c=W.buildCase(SCENE({runDetail:null,round:ROUND({postHocFreezes:[post]})}));
  assert.deepEqual(c.criteria.filter(x=>x.origin==='freeze-figure').map(x=>x.text),['Cobalt reserve']);
});
test('buildCase: criteria ids are stable, readable and unique',()=>{
  const run=RUN();run.classification.suggested.matches=[{label:'Cash bridge',value:1,found:true,where:'final'},{label:'Cash  Bridge!',value:2,found:false,where:null},{label:'',value:3,found:false,where:null},{label:'',value:4,found:false,where:null}];
  const ids=W.buildCase(SCENE({runDetail:run,project:null})).criteria.map(c=>c.id);
  assert.deepEqual(ids,['figure:cash-bridge','figure:cash-bridge~2','figure:n3','figure:n4']);assert.equal(new Set(ids).size,ids.length);
  assert.equal(W.buildCase(SCENE({runDetail:run,project:null})).criteria[2].text,'Figure 3');
});
test('buildCase: project outputs become criteria whose numbers come from the comparison; the decision flag is the comparison\'s own',()=>{
  const c=W.buildCase(SCENE()),bridge=byId(c,'output:r1/o-bridge'),limit=byId(c,'output:r1/o-limit');
  assert.deepEqual([bridge.text,bridge.group,bridge.origin,bridge.status,bridge.statusBasis],['Cash bridge','Credit counted as cash','project-output','unknown','none'],'an output has no status of its own');
  assert.deepEqual(bridge.numbers,[{label:'Cash bridge',unit:'units',correct:1200,wrong:0,delta:-1200,tolerance:0,decisionChanges:true}]);
  assert.deepEqual(bridge.numbers[0],{label:'Cash bridge',unit:'units',...(({correct,wrong,delta,tolerance,decisionChanges})=>({correct,wrong,delta,tolerance,decisionChanges}))(C.compare(PROJECT().roots[0].outputs[0]))},'identical to FinanceCore.compare');
  assert.equal(limit.numbers[0].decisionChanges,false,'a difference with no threshold does not change a decision');assert.equal(limit.numbers[0].delta,C.compare(PROJECT().roots[0].outputs[1]).delta,'the raw number from the comparison, not rounded here');
  assert.deepEqual(bridge.conclusion,{runRef:null,where:null,quote:'',figure:null,humanVerdict:null});
  const spy=[],fake=o=>{spy.push(o.correct);return {correct:1,wrong:2,delta:1,tolerance:0,distinct:true,correctDecision:true,wrongDecision:false,decisionChanges:o.correct==='500'};};
  const injected=W.buildCase(SCENE(),{compare:fake});
  assert.deepEqual(spy,['1200','500']);assert.equal(byId(injected,'output:r1/o-bridge').numbers[0].decisionChanges,false);assert.equal(byId(injected,'output:r1/o-limit').numbers[0].decisionChanges,true,'the flag follows the comparison, not the data');
  assert.ok(byId(injected,'output:r1/o-limit').cells.every(x=>x.decisionChanges===true)||byId(injected,'output:r1/o-limit').cells.length===0);
  const tolerant=PROJECT();tolerant.roots[0].outputs[0].absTolerance='2000';assert.equal(W.buildCase(SCENE({project:tolerant})).criteria.find(x=>x.id==='output:r1/o-bridge').numbers[0].tolerance,2000);
});
test('buildCase: an output the comparison cannot read keeps its criterion, has no number, and says so',()=>{
  const p=PROJECT();p.roots[0].outputs[1].correct='1,000';p.roots[0].outputs.push({id:'o-bare',label:'',correct:'4',wrong:'5',sourceIds:[]});
  const c=W.buildCase(SCENE({project:p})),bad=byId(c,'output:r1/o-limit'),bare=byId(c,'output:r1/o-bare');
  assert.deepEqual(bad.numbers,[]);assert.match(c.notes.join('\n'),/Facility headroom: the comparison is incomplete/);
  assert.equal(bare.text,'Output o-bare');assert.equal(bare.numbers[0].decisionChanges,false,'absent tolerances count as zero and an absent threshold means no decision');
  assert.ok(bare.cells.every(x=>x.decisionChanges===false));
  assert.match(W.buildCase(SCENE({project:{...PROJECT(),roots:[{id:'r',title:'t',outputs:[]}]}})).notes.join('\n'),/lists no outputs/);
  assert.deepEqual(W.buildCase(SCENE({project:{},round:null,runDetail:null})).criteria,[]);
});
test('buildCase: the source clause of an output is resolved by an exact locator; unresolved stays unresolved',()=>{
  const c=W.buildCase(SCENE()),bridge=byId(c,'output:r1/o-bridge'),limit=byId(c,'output:r1/o-limit');
  const terms=bridge.clauses.filter(x=>x.documentName==='Facility_Terms.txt');
  assert.deepEqual(terms.map(x=>[x.locator,x.basis,x.resolved]),[['Line 1','source-anchor',true],['Line 2','source-anchor',true]],'"Lines 1 to 2" is read as Line 1 and Line 2');
  assert.deepEqual(terms[0],{documentName:'Facility_Terms.txt',locator:'Line 1',quote:'Atlas Holdings owes Meridian Partners 2,480 units',excerptVerified:true,basis:'source-anchor',sha256:candPkg().documents[0].sha256,resolved:true});
  assert.equal(terms[1].excerptVerified,true,'the excerpt belongs to the source, so it is looked for in the text of all the records the source resolved to');
  const spanning=PROJECT();spanning.sources[0].excerpt='Facility limit is 3,000 units';const span=byId(W.buildCase(SCENE({project:spanning})),'output:r1/o-bridge').clauses.filter(x=>x.documentName==='Facility_Terms.txt').map(x=>[x.locator,x.excerptVerified]);
  assert.deepEqual(span,[['Line 1',true],['Line 2',true]],'an excerpt found in any record of the source verifies the source');
  spanning.sources[0].excerpt='A sentence nobody wrote';assert.deepEqual(byId(W.buildCase(SCENE({project:spanning})),'output:r1/o-bridge').clauses.filter(x=>x.documentName==='Facility_Terms.txt').map(x=>x.excerptVerified),[false,false]);
  assert.deepEqual(bridge.clauses.filter(x=>x.documentName==='Atlas_Model.xlsx').map(x=>[x.locator,x.resolved,x.excerptVerified]),[['Bridge!B3',true,null],['Bridge!B2',true,null]],'a sheet carries over to the bare cell after it; no excerpt means not checked');
  assert.deepEqual(bridge.clauses.find(x=>x.documentName==='Cash_Facts.csv'),{documentName:'Cash_Facts.csv',locator:'Row 3',quote:'Payments due | 1850',excerptVerified:false,basis:'source-anchor',sha256:candPkg().documents[1].sha256,resolved:true},'a paraphrased excerpt is reported as not found word for word');
  assert.deepEqual(bridge.clauses.map(x=>x.basis),Array(bridge.clauses.length).fill('source-anchor'));
  const bad=limit.clauses.filter(x=>x.basis==='source-anchor');
  assert.deepEqual(bad.map(x=>[x.documentName,x.locator,x.resolved,x.quote,x.excerptVerified]),[['Facility_Terms.txt','Clause 4.2',false,'',null],['Missing_File.txt','Line 1',false,'',null]]);
  assert.match(bad[0].reason,/not a locator the package uses/);assert.match(bad[1].reason,/not in the loaded package/);
  assert.ok(!bad.some(x=>x.locator==='Line 1'&&x.documentName==='Facility_Terms.txt'),'there is no fall-back to the first record of the file');
});
test('buildCase: locators written in prose, quoted sheet names, ranges and partial matches',()=>{
  const sheetDoc=xlsx('Atlas_Model.xlsx',[cell('My Sheet','A1',1),cell('My Sheet','B2',2),cell('Other','C3',3)]),p=pkg([sheetDoc,TERMS(),FACTS()]);
  const project=sources=>({sources:sources.map((s,i)=>({id:'s'+i,title:'',file:'',page:'',cell:'',excerpt:'',...s})),roots:[{id:'r',title:'Root',outputs:[{id:'o',label:'Out',unit:'',correct:'1',wrong:'2',absTolerance:'0',relTolerance:'0',threshold:'',direction:'at-least',sourceIds:sources.map((s,i)=>'s'+i)}]}]});
  const clauses=(sources,extra)=>W.buildCase({package:p,project:project(sources),...extra}).criteria[0].clauses.map(x=>[x.documentName,x.locator,x.resolved]);
  assert.deepEqual(clauses([{file:'Atlas_Model.xlsx',cell:"'My Sheet'!A1; B2, Other!C3"}]),[['Atlas_Model.xlsx','My Sheet!A1',true],['Atlas_Model.xlsx','My Sheet!B2',true],['Atlas_Model.xlsx','Other!C3',true]]);
  const apostrophe=pkg([xlsx('Atlas_Model.xlsx',[cell("Owner's Sheet",'A1',1)])]);assert.deepEqual(W.buildCase({package:apostrophe,project:project([{file:'Atlas_Model.xlsx',cell:"'Owner''s Sheet'!A1"}])}).criteria[0].clauses.map(x=>[x.locator,x.resolved]),[["Owner's Sheet!A1",true]],'a doubled apostrophe in a quoted sheet name is one apostrophe');
  assert.deepEqual(clauses([{file:'Atlas_Model.xlsx',cell:'A1'}]),[['Atlas_Model.xlsx','A1',false]],'a cell with no sheet is unresolved, not placed on a guessed sheet');
  assert.deepEqual(clauses([{file:'Atlas_Model.xlsx',cell:'Other!C3:C9'}]),[['Atlas_Model.xlsx','Other!C3',true]]);
  assert.ok(W.buildCase({package:p,project:project([{file:'Atlas_Model.xlsx',cell:'Other!C3:C9'}])}).notes.includes('The range Other!C3:C9 is read as its first cell only.'));
  assert.deepEqual(clauses([{file:'Cash_Facts.csv',cell:'Rows 2 to 3'}]),[['Cash_Facts.csv','Row 2',true],['Cash_Facts.csv','Row 3',true]]);
  assert.deepEqual(clauses([{file:'Cash_Facts.csv',cell:'Row 2, Row 4'}]),[['Cash_Facts.csv','Row 2',true],['Cash_Facts.csv','Row 4',true]]);
  assert.deepEqual(clauses([{file:'Facility_Terms.txt',page:'Lines 4 to 7'}]),[['Facility_Terms.txt','Line 4',true],['Facility_Terms.txt','Line 5',true]],'locators of a range that do not exist are left out and counted in a note');
  const partial=W.buildCase({package:p,project:project([{file:'Facility_Terms.txt',page:'Lines 4 to 7'}])});assert.ok(partial.notes.includes('Lines 4 to 7 in Facility_Terms.txt: 2 locators found, 2 missing.'));
  assert.deepEqual(clauses([{file:'Facility_Terms.txt',page:'Lines 8 to 9'}]),[['Facility_Terms.txt','Lines 8 to 9',false]],'a range with nothing in it is one unresolved reference');
  assert.deepEqual(clauses([{file:'Facility_Terms.txt',page:'Line 3'}]),[['Facility_Terms.txt','Line 3',false]],'Line 3 was a blank line and has no record');
  assert.deepEqual(clauses([{file:'Facility_Terms.txt',page:'Lines 5 to 2'}]),[['Facility_Terms.txt','Lines 5 to 2',false]]);
  assert.deepEqual(clauses([{file:'Facility_Terms.txt',page:'Lines 1 to 99'}]),[['Facility_Terms.txt','Lines 1 to 99',false]]);
  assert.deepEqual(clauses([{file:'Facility_Terms.txt'}]),[['Facility_Terms.txt','',false]]);
  assert.deepEqual(clauses([{file:'Facility_Terms.txt',page:'Line 1',cell:'Line 1'}]),[['Facility_Terms.txt','Line 1',true]],'the same clause from two fields appears once');
  assert.deepEqual(clauses([{page:'Line 1'}]),[['','Line 1',false]]);
  const reasons=W.buildCase({package:p,project:project([{file:'',page:'Line 1'},{file:'Atlas_Model.xlsx',cell:'Other!C4'},{file:'Facility_Terms.txt',page:'Line 9'}])}).criteria[0].clauses.map(x=>x.reason);
  assert.deepEqual(reasons,['No file is named for this source.','This file has no record at this locator.','This file has no record at this locator.']);
  assert.ok(!W.buildCase({package:p,project:project([{file:'Atlas_Model.xlsx',cell:'Other!C3'}])}).notes.some(n=>/could not be resolved/.test(n)),'a clean resolution reports nothing unresolved');
  const noPkg=W.buildCase({project:project([{file:'Facility_Terms.txt',page:'Line 1'}])});assert.deepEqual(noPkg.criteria[0].clauses.map(x=>[x.resolved,x.reason]),[[false,'No task package is loaded.']]);
});
test('buildCase: a file is found by its exact name, then by a tail name that is unique; an ambiguous name is never guessed',()=>{
  const a=txt('inputs/Facility_Terms.txt',['Atlas line one','Atlas line two']),b=txt('archive/Facility_Terms.txt',['Old line one']),c=txt('inputs/Unique_Notes.txt',['Meridian note']);
  const p=pkg([a,b,c]),out=file=>({id:'o',label:'L',unit:'',correct:'1',wrong:'2',absTolerance:'0',relTolerance:'0',threshold:'',direction:'at-least',sourceIds:['s']}),proj=file=>({sources:[{id:'s',title:'',file,page:'Line 1',cell:'',excerpt:''}],roots:[{id:'r',title:'',outputs:[out(file)]}]});
  const cl=file=>W.buildCase({package:p,project:proj(file)}).criteria[0].clauses[0];
  assert.deepEqual([cl('inputs/Facility_Terms.txt').quote,cl('archive/Facility_Terms.txt').quote],['Atlas line one','Old line one'],'exact names win');
  assert.equal(cl('Unique_Notes.txt').quote,'Meridian note');assert.equal(cl('Unique_Notes.txt').documentName,'inputs/Unique_Notes.txt','the clause names the file the package knows');
  assert.equal(cl('other/Unique_Notes.txt').documentName,'inputs/Unique_Notes.txt','a unique tail name is accepted');
  assert.equal(cl('inputs\\Unique_Notes.txt').resolved,true,'backslashes are read as folder separators');
  const amb=cl('Facility_Terms.txt');assert.equal(amb.resolved,false);assert.match(amb.reason,/More than one file/);assert.equal(amb.quote,'');
  assert.equal(cl('Missing.txt').resolved,false);
  const dup=pkg([txt('Same.txt',['a']),txt('Same.txt',['b'])]);assert.match(W.buildCase({package:dup,project:proj('Same.txt')}).criteria[0].clauses[0].reason,/exact name/);
});
test('buildCase: author links add a clause only when they resolve; a changed file or a missing locator is reported as such',()=>{
  const cand=candPkg(),terms=cand.documents[0],link=(over)=>({taskKey:'atlas',criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',sha256:terms.sha256,locator:'Line 5',...over});
  const case1=W.buildCase(SCENE({links:[link()]})),bridge=figure(case1,'Cash bridge');
  const hit=bridge.clauses.find(x=>x.basis==='author-link');
  assert.deepEqual(hit,{documentName:'Facility_Terms.txt',locator:'Line 5',quote:'Cobalt reserve 1,200.00 units',excerptVerified:null,basis:'author-link',sha256:terms.sha256,resolved:true});
  assert.ok(!bridge.clauses.some(x=>x.basis==='text-match-unconfirmed'),'a confirmed clause replaces the unconfirmed suggestions');
  const stale=figure(W.buildCase(SCENE({links:[link({sha256:digest('older version')})]})),'Cash bridge').clauses.find(x=>x.basis==='author-link');
  assert.deepEqual([stale.resolved,stale.quote,stale.reason],[false,'','This file has changed since you linked the clause (its hash differs).']);
  assert.equal(figure(W.buildCase(SCENE({links:[link({locator:'Line 99'})]})),'Cash bridge').clauses.find(x=>x.basis==='author-link').reason,'This file has no record at this locator.');
  assert.equal(figure(W.buildCase(SCENE({links:[link({documentName:'Gone.txt'})]})),'Cash bridge').clauses.find(x=>x.basis==='author-link').reason,'This file is not in the loaded package.');
  assert.equal(figure(W.buildCase(SCENE({links:[link({locator:'Line 3'})]})),'Cash bridge').clauses.find(x=>x.basis==='author-link').resolved,false,'a blank line has no record');
  const other=W.buildCase(SCENE({links:[link({criterionId:'figure:facility-headroom'})]}));assert.ok(!figure(other,'Cash bridge').clauses.some(x=>x.basis==='author-link'));assert.equal(figure(other,'Facility headroom').clauses.filter(x=>x.basis==='author-link').length,1);
  const filtered=W.buildCase(SCENE({taskKey:'borealis',links:[link(),link({taskKey:undefined,locator:'Line 1'})]}));assert.deepEqual(figure(filtered,'Cash bridge').clauses.filter(x=>x.basis==='author-link').map(x=>x.locator),['Line 1'],'a link for another task is ignored; one with no task is kept');
  const junk=W.buildCase(SCENE({links:[null,5,'x',{},{criterionId:'figure:cash-bridge'},link({locator:''}),link({documentName:''}),link({criterionId:''})]}));assert.ok(!junk.criteria.some(c=>c.clauses.some(x=>x.basis==='author-link')));
  const twice=figure(W.buildCase(SCENE({links:[link(),link()]})),'Cash bridge').clauses.filter(x=>x.basis==='author-link');assert.equal(twice.length,1);
  const noHash=figure(W.buildCase(SCENE({links:[link({sha256:undefined})]})),'Cash bridge').clauses.find(x=>x.basis==='author-link');assert.equal(noHash.resolved,true);assert.equal(noHash.sha256,terms.sha256);
  const noPackage=figure(W.buildCase({round:ROUND(),runDetail:RUN(),links:[link()]}),'Cash bridge').clauses.find(x=>x.basis==='author-link');assert.equal(noPackage.reason,'No task package is loaded.');
  const studio=W.parseStudioGrading(GRADING()),id='studio:gr-qa-1:item-3',linked=W.buildCase(SCENE({evalParsed:studio,links:[link({criterionId:id,locator:'Line 2'})]}));assert.equal(byId(linked,id).clauses.length,1,'an imported evaluation item can be linked too');
  const outLink=W.buildCase(SCENE({links:[link({criterionId:'output:r1/o-limit',locator:'Line 2'})]}));assert.equal(byId(outLink,'output:r1/o-limit').clauses.filter(x=>x.basis==='author-link'&&x.resolved).length,1);
});
test('buildCase: unconfirmed text matches are labelled, limited, skipped for tiny numbers, and never change a status or a cell',()=>{
  const c=W.buildCase(SCENE()),draw=figure(c,'Requested draw'),bridge=figure(c,'Cash bridge');
  assert.deepEqual(draw.clauses.map(x=>[x.documentName,x.locator,x.basis,x.resolved,x.excerptVerified,x.match]),[['Facility_Terms.txt','Line 1','text-match-unconfirmed',true,null,'2,480'],['Cash_Facts.csv','Row 4','text-match-unconfirmed',true,null,'2,480']]);
  assert.deepEqual(bridge.clauses.map(x=>[x.documentName,x.locator,x.basis]),[['Facility_Terms.txt','Line 5','text-match-unconfirmed'],['Atlas_Model.xlsx','Bridge!C9','text-match-unconfirmed']],'1,200 and 1,200.00 are the same value; the grader file is never offered');
  assert.ok(draw.clauses.every(x=>x.quote&&x.sha256));
  const withCell=SCENE();withCell.diff.documents[0].cells.push(change('Bridge','C9','value',1100,1200));
  const lured=W.buildCase(withCell);assert.ok(figure(lured,'Cash bridge').clauses.some(x=>x.basis==='text-match-unconfirmed'&&x.locator==='Bridge!C9'),'the suggestion points at the cell that changed');
  assert.deepEqual(figure(lured,'Cash bridge').cells,[],'but a suggestion is not a confirmed clause, so its changed cell is not attached');
  const without=W.buildCase(SCENE(),{textMatch:false});
  assert.ok(without.criteria.every(x=>!x.clauses.some(y=>y.basis==='text-match-unconfirmed')));
  assert.deepEqual(c.criteria.map(x=>[x.id,x.status,x.statusBasis]),without.criteria.map(x=>[x.id,x.status,x.statusBasis]),'statuses are identical with and without text matches');
  assert.deepEqual(c.criteria.map(x=>x.cells),without.criteria.map(x=>x.cells),'cells are identical with and without text matches');
  assert.ok(draw.cells.length===0&&bridge.cells.length===0,'a text match never brings a changed cell with it');
  const small=PROJECT();small.roots[0].outputs[0].correct='7';small.roots[0].outputs[1].correct='0';assert.ok(W.buildCase(SCENE({project:small})).criteria.filter(x=>x.origin==='project-output').every(x=>x.clauses.every(y=>y.basis!=='text-match-unconfirmed')),'a value of fewer than three digits is too common to suggest');
  const many=pkg(['a','b','c','d','e'].map(n=>txt(n.toUpperCase()+'_Source.txt',['figure 4,444 stated'])));
  const m=W.buildCase({package:many,round:ROUND(),runDetail:RUN({classification:{suggested:{verdict:'unclear',matches:[{label:'Big',value:4444,found:false,where:null}],fingerprints:[],decision:{keywords:[],found:[]},freezeSha256:FREEZE().sha256}}})});
  assert.equal(m.criteria[0].clauses.length,3);assert.ok(m.notes.includes('Big: 5 records hold this value as text; the first 3 are listed and none is confirmed.'));assert.equal(m.criteria[0].status,'not-met');
  assert.equal(W.buildCase({package:many,round:ROUND(),runDetail:m.solver.conclusion?RUN({classification:{suggested:{verdict:'unclear',matches:[{label:'Big',value:4444,found:false,where:null}],fingerprints:[],decision:{keywords:[],found:[]},freezeSha256:FREEZE().sha256}}}):null},{textMatchLimit:1}).criteria[0].clauses.length,1);
  const spread=W.buildCase(SCENE({links:[{criterionId:'figure:requested-draw',documentName:'Facility_Terms.txt',locator:'Line 1'}]}));assert.deepEqual(figure(spread,'Requested draw').clauses.map(x=>x.basis),['author-link'],'any confirmed clause removes the suggestions');
  const unresolvedOnly=W.buildCase(SCENE());assert.ok(byId(unresolvedOnly,'output:r1/o-limit').clauses.every(x=>x.basis==='source-anchor'||x.basis==='text-match-unconfirmed'));
});
test('buildCase: changed cells are found by an exact file name and locator, never by prefix, and carry the decision flag of their output',()=>{
  const c=W.buildCase(SCENE()),bridge=byId(c,'output:r1/o-bridge');
  assert.deepEqual(bridge.cells.map(x=>[x.documentName,x.locator,x.change,x.basis,x.decisionChanges]),[['Atlas_Model.xlsx','Bridge!B3','value','diff-intersect-clause',true],['Cash_Facts.csv','Row 3','value','diff-intersect-clause',true]]);
  assert.deepEqual(bridge.cells[0],{documentName:'Atlas_Model.xlsx',locator:'Bridge!B3',change:'value',before:snap(100),after:snap(150),basis:'diff-intersect-clause',hidden:false,decisionChanges:true});
  assert.equal(bridge.cells[1].derivedColumn,'B','a csv change keeps its derived column letter');
  assert.ok(!bridge.cells.some(x=>x.locator==='Bridge!B20'||x.locator==='Bridge!B100'),'B2 does not bring B20, B3 does not bring B30, nothing matches by prefix');
  assert.deepEqual(byId(c,'output:r1/o-limit').cells,[],'unresolved references bring no cells');
  bridge.cells[0].before.value='changed';assert.equal(W.buildCase(SCENE()).criteria.find(x=>x.id==='output:r1/o-bridge').cells[0].before.value,'100','cells are copies of the diff entries');
  const sameLocatorOtherFile=SCENE();sameLocatorOtherFile.diff.documents.push(docDiff('Atlas_Model_Copy.xlsx','changed','xlsx',{cells:[change('Bridge','B3','value',1,2)]}));assert.equal(W.buildCase(sameLocatorOtherFile).criteria.find(x=>x.id==='output:r1/o-bridge').cells.length,2,'the same locator in another file is not the same cell');
  const noDiff=W.buildCase(SCENE({diff:null}));assert.deepEqual(byId(noDiff,'output:r1/o-bridge').cells,[]);assert.ok(noDiff.notes.includes('No package comparison is loaded, so no changed cells are shown.'));assert.deepEqual(noDiff.files.map(f=>f.change),[null,null,null,null]);
  const noPkg=W.buildCase(SCENE({package:null,comparePackage:null}));assert.deepEqual(byId(noPkg,'output:r1/o-bridge').clauses.map(x=>x.resolved),[false,false,false,false,false],'with no package every reference is unresolved');assert.deepEqual(byId(noPkg,'output:r1/o-bridge').cells.map(x=>x.locator),['Bridge!B3','Row 3'],'the written file name and locator still meet the comparison exactly, and nothing else does');
});
test('buildCase: a source cell that was cleared still shows as a removed cell although its clause no longer resolves',()=>{
  const base=pkg([xlsx('Atlas_Model.xlsx',[cell('Bridge','B3',100),cell('Bridge','B4',5)])]),cand=pkg([xlsx('Atlas_Model.xlsx',[cell('Bridge','B4',5)])]);
  const diff=diffOf(base,cand,[docDiff('Atlas_Model.xlsx','changed','xlsx',{cells:[change('Bridge','B3','removed',100,null)]})]);
  const project={sources:[{id:'s',file:'Atlas_Model.xlsx',cell:'Bridge!B3',page:'',excerpt:''}],roots:[{id:'r',title:'',outputs:[{id:'o',label:'Out',unit:'',correct:'1',wrong:'2',absTolerance:'0',relTolerance:'0',threshold:'',direction:'at-least',sourceIds:['s']}]}]};
  const c=W.buildCase({package:cand,comparePackage:base,diff,project}).criteria[0];
  assert.deepEqual(c.clauses.map(x=>[x.locator,x.resolved,x.reason]),[['Bridge!B3',false,'This file has no record at this locator.']]);
  assert.deepEqual(c.cells.map(x=>[x.locator,x.change,x.before.value,x.after]),[['Bridge!B3','removed','100',null]]);
});
test('buildCase: changed lines match a clause only by the line number of the side that was loaded',()=>{
  const c=W.buildCase(SCENE({links:[{criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',locator:'Line 2'}]})),b=figure(c,'Cash bridge');
  assert.deepEqual(b.lines,[{documentName:'Facility_Terms.txt',op:'add',baseLocator:null,candLocator:'Line 2',before:null,after:'Facility limit is 3,000 units',basis:'author-link'}],'the added line is matched; the removed line carries the base side\'s number and is not');
  const baseLoaded=SCENE({package:basePkg(),comparePackage:candPkg()}),baseCase=W.buildCase({...baseLoaded,links:[{criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',locator:'Line 2'}]});
  assert.deepEqual(figure(baseCase,'Cash bridge').lines.map(x=>[x.op,x.baseLocator]),[['del','Line 2']],'with the base loaded the removed line is the one that matches');
  const nameless=SCENE();nameless.diff.baseFingerprint=null;nameless.diff.candFingerprint=null;
  const unsure=W.buildCase({...nameless,links:[{criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',locator:'Line 2'}]});
  assert.deepEqual(figure(unsure,'Cash bridge').lines,[],'a comparison that does not say which side is loaded cannot be matched by line number');assert.match(unsure.notes.join('\n'),/does not name the loaded package by fingerprint/);
  assert.equal(byId(unsure,'output:r1/o-bridge').cells.length,2,'cell addresses mean the same on both sides, so cells are still matched');
  assert.equal(figure(unsure,'Cash bridge').clauses.filter(x=>x.basis==='author-link').length,1);
});
test('buildCase: a comparison made for other packages than the loaded ones is stale and is not used',()=>{
  const link=[{criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',locator:'Line 2'}];
  const stale=(edit)=>{const s=SCENE({links:link});edit(s);return W.buildCase(s);};
  for(const [name,edit] of [['neither side matches',s=>{s.diff.baseFingerprint=digest('x');s.diff.candFingerprint=digest('y');}],['only the loaded side is named, wrongly',s=>{s.diff.candFingerprint=digest('y');s.diff.baseFingerprint=null;}],['the other side does not match the comparison package',s=>{s.diff.baseFingerprint=digest('another base');}],['a different package was loaded after the comparison',s=>{s.package=pkg([TERMS()]);}]]){
    const c=stale(edit);
    assert.ok(c.notes.includes('The package comparison was made for different packages than the ones loaded, so it is not used.'),name);
    assert.ok(c.criteria.every(x=>x.cells.length===0&&x.lines.length===0),name+': no changed cell or line from a stale comparison');
    assert.ok(c.files.every(f=>f.change===null&&f.changedCells===0),name);assert.ok(!c.files.some(f=>f.name==='Old_Schedule.csv'),name+': files only the stale comparison knew are not listed');
    assert.ok(!c.limits.some(x=>/^Formulas are not recalculated/.test(x)),name+': its limits are not shown either');
  }
  assert.ok(W.buildCase({...SCENE(),comparePackage:candPkg()}).notes.some(n=>/different packages/.test(n)),'the comparison package must be the base the comparison was made from, not the loaded package again');
  const noPkg=W.buildCase({...SCENE(),package:null});assert.ok(!noPkg.notes.some(n=>/different packages/.test(n)),'with no package loaded the comparison cannot be judged stale by it');
  const swapped=W.buildCase({...SCENE(),comparePackage:basePkg()});assert.ok(!swapped.notes.some(n=>/different packages/.test(n)));
  const onlyBase=W.buildCase({comparePackage:basePkg(),diff:DIFF(basePkg(),candPkg())});assert.ok(!onlyBase.notes.some(n=>/different packages/.test(n)));
  const wrongBase=W.buildCase({comparePackage:candPkg(),diff:diffOf(basePkg(),pkg([TERMS()]),[])});assert.ok(wrongBase.notes.some(n=>/different packages/.test(n)));
});
test('buildCase: imported evaluation items are criteria; only an explicit token gives them a status',()=>{
  const parsed=W.parseStudioGrading(GRADING()),c=W.buildCase({evalParsed:parsed}),items=c.criteria;
  assert.deepEqual(items.map(x=>[x.id,x.origin,x.status,x.statusBasis,x.group]),[['studio:gr-qa-1:item-1','studio-item','met','explicit-token','Inputs'],['studio:gr-qa-1:item-2','studio-item','not-met','explicit-token','Inputs'],['studio:gr-qa-1:item-3','studio-item','unknown','none','Inputs'],['studio:gr-qa-1:item-4','studio-item','met','explicit-token','Outputs'],['studio:gr-qa-1:item-5','studio-item','not-met','explicit-token','Outputs'],['studio:gr-qa-1:item-6','studio-item','not-met','explicit-token','Outputs']]);
  assert.equal(items[2].text,'Checked the dates (no token) and kept the order (continuation line)');assert.deepEqual(items[0].conclusion,{runRef:null,where:null,quote:'',figure:null,humanVerdict:null});assert.deepEqual(items[0].numbers,[]);
  assert.equal(W.buildCase({evalParsed:{...parsed,runId:null,problemRunId:'pr-7'}}).criteria[0].id,'studio:pr-7:item-1');assert.equal(W.buildCase({evalParsed:{...parsed,runId:null,problemRunId:null}}).criteria[0].id,'studio:eval:item-1');
  assert.deepEqual(W.buildCase({evalParsed:{items:[null,5,{id:'x',text:'t',polarity:'maybe'},{text:'no id',polarity:'met'}]}}).criteria.map(x=>[x.id,x.status]),[['studio:eval:x','unknown'],['studio:eval:1','met']]);
  assert.deepEqual(W.buildCase({evalParsed:{}}).criteria,[]);
});
test('buildCase: files merge the package with the comparison, sorted by name, with change counts',()=>{
  const c=W.buildCase(SCENE());
  assert.deepEqual(c.files.map(f=>[f.name,f.change,f.changedCells,f.changedLines,f.inPackage,f.role,f.solverFacing]),[
    ['Atlas_Model.xlsx','changed',3,0,true,'source',true],['Cash_Facts.csv','changed',1,0,true,'source',true],['Facility_Terms.txt','changed',0,2,true,'source',true],['Grader_Notes.txt','unchanged',0,0,true,'evaluator',false],['Old_Schedule.csv','removed',0,0,false,'',null]]);
  assert.deepEqual(Object.keys(c.files[0]),['name','id','role','kind','extraction','bytes','sha256','solverFacing','change','changedCells','changedLines','metaChanges','inPackage','limits']);
  assert.deepEqual(c.files[2].limits,['Matched by file name only.']);assert.equal(c.files[0].extraction,'extracted');assert.equal(c.files[0].sha256,candPkg().documents[2].sha256);
  const meta=SCENE();meta.diff.documents[0].metaChanges={sheets:[{name:'Old',change:'removed',before:{},after:null}],definedNames:[{name:'N',change:'ref',before:'a',after:'b'}]};assert.equal(W.buildCase(meta).files[0].metaChanges,2);
  const onlyDiff=W.buildCase({diff:DIFF(basePkg(),candPkg())});assert.deepEqual(onlyDiff.files.map(f=>[f.name,f.inPackage]),[['Atlas_Model.xlsx',null],['Cash_Facts.csv',null],['Facility_Terms.txt',null],['Grader_Notes.txt',null],['Old_Schedule.csv',null]]);
  const onlyPackage=W.buildCase({package:candPkg()});assert.deepEqual(onlyPackage.files.map(f=>[f.name,f.change,f.inPackage]),[['Atlas_Model.xlsx',null,true],['Cash_Facts.csv',null,true],['Facility_Terms.txt',null,true],['Grader_Notes.txt',null,true]]);
  const dupNames=pkg([txt('Same.txt',['a'],{id:'doc-a1'}),txt('Same.txt',['b'],{id:'doc-a2'})]),dupDiff={baseFingerprint:null,candFingerprint:null,documents:[docDiff('Same.txt','changed','txt',{candId:'doc-a2',baseId:'x'})],summary:{},limits:[]};
  const d=W.buildCase({package:dupNames,diff:dupDiff});assert.deepEqual(d.files.map(f=>[f.id,f.change]),[['doc-a1',null],['doc-a2','changed']],'a diff entry is matched to the file by its id when names collide');
});
test('buildCase: the standing limits and the diff\'s own limits are stated; notes are unique',()=>{
  const c=W.buildCase(SCENE());
  assert.ok(c.limits[0].startsWith('Formulas are not recalculated'));assert.ok(c.limits.some(x=>/Not met only when/.test(x)));assert.ok(c.limits.some(x=>/not grading/.test(x)));assert.ok(c.limits.some(x=>/never set a status/.test(x)));
  assert.equal(new Set(c.limits).size,c.limits.length);assert.equal(new Set(c.notes).size,c.notes.length);
  const twice=SCENE();twice.diff.limits=['same','same'];assert.equal(W.buildCase(twice).limits.filter(x=>x==='same').length,1);
  assert.ok(W.buildCase({}).limits.length>=3,'the standing limits are always present');
});
test('buildCase: garbage and missing inputs never throw and never invent data',()=>{
  const empty=W.buildCase();assert.deepEqual(empty,{files:[],criteria:[],solver:{conclusion:null,finalText:null,withheld:false},limits:empty.limits,notes:[]});
  for(const bad of [null,5,'x',[],{package:5,diff:'x',round:[],runDetail:7,project:'p',links:'l',evalParsed:3},{package:{documents:'x'},diff:{documents:{}},comparePackage:[]},{runDetail:{classification:{suggested:{matches:'x'},human:5}},round:{freeze:5,postHocFreezes:'x'}},{project:{roots:[null,{outputs:[null,5,{}]}],sources:[null,{id:1}]}},{diff:{documents:[null,5,{name:'A'},{name:'B',cells:[null,{locator:'x'}],lines:[null,{op:'add'}]}]},package:{documents:[null,{name:'B',records:[null]}]}}]){
    assert.doesNotThrow(()=>W.buildCase(bad),JSON.stringify(bad));const r=W.buildCase(bad);assert.ok(Array.isArray(r.criteria)&&Array.isArray(r.files)&&Array.isArray(r.notes)&&Array.isArray(r.limits));
  }
  assert.match(W.buildCase({package:'x'}).notes.join('\n'),/task package could not be read/);assert.match(W.buildCase({package:candPkg(),diff:'x'}).notes.join('\n'),/package comparison could not be read/);
  assert.doesNotThrow(()=>W.buildCase(SCENE(),{compare:()=>{throw new Error('boom');},resolveClause:()=>{throw new Error('boom');}}));
  assert.doesNotThrow(()=>W.buildCase(SCENE(),null));assert.doesNotThrow(()=>W.buildCase(SCENE(),'x'));
  const brokenCompare=W.buildCase(SCENE(),{compare:()=>{throw new Error('boom');}});assert.deepEqual(byId(brokenCompare,'output:r1/o-bridge').numbers,[]);assert.ok(byId(brokenCompare,'output:r1/o-bridge').cells.every(x=>!('decisionChanges' in x)),'no comparison result means no decision flag at all');
  const noResolve=W.buildCase(SCENE(),{resolveClause:()=>{throw new Error('boom');}});assert.ok(byId(noResolve,'output:r1/o-bridge').clauses.every(x=>x.resolved===false||x.basis==='text-match-unconfirmed'),'a resolver that fails leaves clauses unresolved');
});
test('buildCase: the clause resolver can be injected, and the built-in exact resolver agrees with the engine\'s',()=>{
  const seen=[],spy=(p,ref)=>{seen.push(ref);return E.resolveClause(p,ref);};
  const c=W.buildCase(SCENE(),{resolveClause:spy});
  assert.ok(seen.length>0&&seen.every(r=>typeof r.name==='string'&&typeof r.sha256==='string'&&typeof r.locator==='string'&&r.documentId===undefined),'references are sent by exact file name, hash and locator');
  assert.deepEqual(copy(c),copy(W.buildCase(SCENE())));
  const builtIn=W.buildCase(SCENE(),{engine:{}});assert.deepEqual(copy(builtIn),copy(c),'with no engine resolver the built-in one gives the same case');
  const refuse=W.buildCase(SCENE(),{resolveClause:()=>null});assert.ok(byId(refuse,'output:r1/o-bridge').clauses.every(x=>x.basis!=='source-anchor'||x.resolved===false));
  const stub=W.buildCase(SCENE(),{resolveClause:(p,ref)=>({document:{name:ref.name,sha256:ref.sha256},quote:'stubbed '+ref.locator})});
  assert.equal(byId(stub,'output:r1/o-bridge').clauses.find(x=>x.locator==='Line 1').quote,'stubbed Line 1');
});
test('buildCase: outputs have no sweep-worthy words, no rate, no percentage, and carry no verdict ratios',()=>{
  const human={verdict:'fingerprint',fingerprintIds:['fp-alpha'],note:'Landed on the credit reading.',at:'2026-10-02T09:00:00.000Z',freezeVersion:1,freezeSha256:FREEZE().sha256},run=RUN();run.classification.human=human;
  const scenes=[SCENE(),SCENE({runDetail:run,links:[{criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',locator:'Line 5'}],evalParsed:W.parseStudioGrading(GRADING())}),SCENE({runDetail:WITHHELD_RUN(),round:STUB_ROUND()}),SCENE({runDetail:null}),{}];
  for(const s of scenes){const c=W.buildCase(s);for(const text of strings(c))assert.ok(!FORBIDDEN.test(text),'forbidden wording in: '+text);for(const k of keysOf(c))assert.ok(!/rate|percent|ratio|share|difficulty/i.test(k),'key '+k);}
  for(const text of strings([W.parseStudioGrading(GRADING()),W.parseStudioMessages(CONVERSATION()),W.normalizeEval(W.parseStudioGrading(GRADING()),{task:'Atlas'}),W.diffViewRows(XDIFF([change('S','B2','value',1,2)])),W.lineDiffRows(docDiff('A.txt','changed','txt',{lines:OPS('Ea Db Ac')})),W.suggestClauses(candPkg(),2480)]))assert.ok(!FORBIDDEN.test(text),'forbidden wording in: '+text);
  const nums=byId(W.buildCase(SCENE()),'output:r1/o-limit').numbers[0];assert.ok(Object.values(nums).every(v=>typeof v==='string'||typeof v==='boolean'||Number.isFinite(v)));
});
const BASIS_OF={'heuristic-figure-search':'freeze-figure','human-verdict':'freeze-figure','explicit-token':'studio-item'};
const checkCase=(c,label='')=>{
  assert.ok(Array.isArray(c.files)&&Array.isArray(c.criteria)&&Array.isArray(c.limits)&&Array.isArray(c.notes)&&c.solver&&typeof c.solver.withheld==='boolean',label);
  const ids=new Set();
  for(const x of c.criteria){
    assert.ok(!ids.has(x.id),label+' duplicate id '+x.id);ids.add(x.id);
    assert.ok(['met','not-met','unknown'].includes(x.status),label);assert.ok(['heuristic-figure-search','human-verdict','explicit-token','none'].includes(x.statusBasis),label);
    assert.equal(x.status==='unknown',x.statusBasis==='none',label+' '+x.id+' '+x.status+' '+x.statusBasis);
    if(x.status!=='unknown')assert.equal(BASIS_OF[x.statusBasis],x.origin,label+' '+x.id+': a status of this basis belongs to another kind of criterion');
    if(x.status==='not-met')assert.ok((x.statusBasis==='heuristic-figure-search'&&x.conclusion.figure&&x.conclusion.figure.found===false)||x.statusBasis==='explicit-token',label+' '+x.id+' is Not met without a reason');
    if(x.origin==='project-output')assert.equal(x.status,'unknown');
    if(c.solver.withheld){assert.equal(x.status,'unknown',label);assert.equal(x.conclusion.quote,'');assert.equal(x.conclusion.figure,null);}
    for(const k of Object.keys(x))assert.ok(!k.startsWith('_'),label+' private key '+k);
    for(const cl of x.clauses){assert.ok(['source-anchor','author-link','text-match-unconfirmed'].includes(cl.basis),label);assert.equal(typeof cl.resolved,'boolean');if(!cl.resolved){assert.equal(cl.quote,'');assert.ok(cl.reason,label);}if(cl.basis==='text-match-unconfirmed')assert.equal(cl.excerptVerified,null);}
    for(const cell of x.cells)assert.ok(['diff-intersect-clause','author-link'].includes(cell.basis),label);
    for(const n of x.numbers)assert.equal(typeof n.decisionChanges,'boolean',label);
  }
  assert.equal(new Set(c.notes).size,c.notes.length,label);
  assert.doesNotThrow(()=>JSON.stringify(c),label);
};
test('buildCase: every criterion obeys the status rules, whatever the scenario',()=>{
  const human=over=>{const r=RUN();r.classification.human={verdict:'matches-frozen-gold',fingerprintIds:[],note:'',at:'t',freezeVersion:1,freezeSha256:FREEZE().sha256,...over};return r;};
  const scenes=[SCENE(),SCENE({runDetail:human()}),SCENE({runDetail:human({freezeSha256:'other'})}),SCENE({runDetail:null}),SCENE({runDetail:WITHHELD_RUN(),round:STUB_ROUND(),evalParsed:W.parseStudioGrading(GRADING())}),SCENE({evalParsed:W.parseStudioGrading(GRADING())}),SCENE({runDetail:RUN({audit:{status:'DISCARDED'},classification:null})})];
  scenes.forEach((s,i)=>{const c=W.buildCase(s);assert.ok(c.criteria.length>0);checkCase(c,'scene '+i);});
});
test('buildCase table: run state x project x links x comparison',()=>{
  const runs={none:()=>null,found:()=>RUN(),'not found':()=>{const r=RUN();r.classification.suggested.matches=MATCHES().map(m=>({...m,found:false,where:null}));return r;},withheld:()=>WITHHELD_RUN(),discarded:()=>RUN({audit:{status:'DISCARDED'},classification:null})};
  const link=[{criterionId:'output:r1/o-bridge',documentName:'Facility_Terms.txt',locator:'Line 5'},{criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',locator:'Line 5'}];
  const want={none:{figures:3,statuses:['unknown','unknown','unknown']},found:{figures:3,statuses:['met','not-met','met']},'not found':{figures:3,statuses:['not-met','not-met','not-met']},withheld:{figures:0,statuses:[]},discarded:{figures:3,statuses:['unknown','unknown','unknown']}};
  let combos=0;
  for(const [runName,makeRun] of Object.entries(runs))for(const withProject of [true,false])for(const withLinks of [true,false])for(const withDiff of [true,false]){
    combos++;const label=[runName,withProject?'project':'no project',withLinks?'links':'no links',withDiff?'diff':'no diff'].join(' / ');
    const run=makeRun(),scene=SCENE({runDetail:run,round:runName==='withheld'?STUB_ROUND():ROUND(),project:withProject?PROJECT():null,links:withLinks?link:[],diff:withDiff?DIFF(basePkg(),candPkg()):null});
    const c=W.buildCase(scene);checkCase(c,label);
    const figs=c.criteria.filter(x=>x.origin==='freeze-figure'),outs=c.criteria.filter(x=>x.origin==='project-output');
    assert.equal(figs.length,want[runName].figures,label);assert.deepEqual(figs.map(x=>x.status),want[runName].statuses,label);
    assert.equal(outs.length,withProject?2:0,label);
    assert.equal(c.solver.withheld,runName==='withheld',label);assert.equal(c.solver.conclusion===null,runName==='none',label);assert.equal(c.solver.finalText!==null,runName==='found'||runName==='not found'||runName==='discarded',label);
    const bridge=outs.find(x=>x.id==='output:r1/o-bridge');
    if(withProject){assert.equal(bridge.cells.length,withDiff?2:0,label);assert.equal(bridge.clauses.some(x=>x.basis==='author-link'&&x.resolved),withLinks,label);assert.equal(bridge.numbers.length,1,label);}
    const figLink=figs.find(x=>x.id==='figure:cash-bridge');if(figLink)assert.equal(figLink.clauses.some(x=>x.basis==='author-link'&&x.resolved),withLinks,label);
    assert.equal(c.files.length,withDiff?5:4,label);assert.equal(c.files.every(f=>f.change===null),!withDiff,label);
    if(runName==='withheld')assert.ok(c.notes.includes('Details withheld while a round runs'),label);
  }
  assert.equal(combos,40);
});
const mulberry=a=>()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
test('buildCase: corrupting any one or two fields of a full scene never throws and never breaks the status rules',()=>{
  const junk=[null,undefined,0,-1,1e30,NaN,'','x','Line 1','Row 3','Bridge!B3','1,200',[],{},[null],[{}],true,false,'\u{1F600}'.repeat(3)];
  const rnd=mulberry(20261012);
  const paths=(v,base=[],out=[])=>{if(v&&typeof v==='object'){for(const k of Object.keys(v)){out.push([...base,k]);paths(v[k],[...base,k],out);}}return out;};
  const scene0=()=>SCENE({links:[{taskKey:'t',criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',sha256:candPkg().documents[0].sha256,locator:'Line 5'}],evalParsed:W.parseStudioGrading(GRADING()),runDetail:(()=>{const r=RUN();r.classification.human={verdict:'matches-frozen-gold',fingerprintIds:[],note:'',at:'t',freezeVersion:1,freezeSha256:FREEZE().sha256};return r;})()});
  const all=paths(scene0());assert.ok(all.length>400,'the scene is big enough to corrupt meaningfully');
  for(let n=0;n<600;n++){
    const scene=scene0();let label='';
    for(let k=0;k<1+Math.floor(rnd()*2);k++){const path=all[Math.floor(rnd()*all.length)];let node=scene;for(let i=0;i<path.length-1;i++){if(node===null||typeof node!=='object')break;node=node[path[i]];}
      if(node!==null&&typeof node==='object'){const last=path[path.length-1];if(rnd()<0.2){delete node[last];label+=' delete '+path.join('.');}else{node[last]=junk[Math.floor(rnd()*junk.length)];label+=' set '+path.join('.');}}}
    let c;try{c=W.buildCase(scene);}catch(e){assert.fail('threw on'+label+': '+e.message);}
    try{checkCase(c,'corruption '+n);}catch(e){e.message+='\n'+label;throw e;}
  }
});
test('buildCase: never mutates its input, returns fresh objects, and is deterministic',()=>{
  const scene=deepFreeze(SCENE({links:[{taskKey:'atlas',criterionId:'figure:cash-bridge',documentName:'Facility_Terms.txt',locator:'Line 5'}],evalParsed:W.parseStudioGrading(GRADING())})),snapshot=copy(scene);
  const a=W.buildCase(scene),b=W.buildCase(scene);
  assert.deepEqual(copy(a),copy(b));assert.deepEqual(copy(scene),snapshot);
  a.criteria[3].cells[0].after.value='changed';a.criteria[0].clauses.push({});a.files.pop();
  const c=W.buildCase(scene);assert.deepEqual(copy(c),copy(b),'results share nothing mutable with each other or the input');
  const flipped=W.buildCase(SCENE({links:[],evalParsed:W.parseStudioGrading(GRADING())}));assert.deepEqual(copy(W.buildCase(SCENE({links:[],evalParsed:W.parseStudioGrading(GRADING())}))),copy(flipped));
  assert.deepEqual(copy(a).criteria.length,copy(c).criteria.length);
  assert.deepEqual(JSON.parse(JSON.stringify(b)),b);
});
test('buildCase works end to end on a package built by the real engine and the real comparison',async()=>{
  const p=await H.illustration('cash'),project=C.parseProject(JSON.stringify(require('../examples.js')('cash')));
  const run=RUN({final:{text:'The cash bridge is 1200 units.',chars:30}});run.classification.suggested.matches=[{label:'Cash bridge',value:1200,found:true,where:'final'}];
  const c=W.buildCase({package:p,project,round:ROUND(),runDetail:run});
  const out=c.criteria.find(x=>x.id==='output:fm-credit-as-cash/o-bridge');
  assert.ok(out,c.criteria.map(x=>x.id).join());assert.equal(out.numbers[0].correct,1200);assert.equal(out.numbers[0].decisionChanges,C.compare(project.roots[0].outputs[0]).decisionChanges);
  assert.deepEqual(out.clauses.filter(x=>x.documentName==='Treasury_Procedure.txt').map(x=>[x.locator,x.resolved]),[['Line 2',true],['Line 3',true]]);
  assert.match(out.clauses.find(x=>x.locator==='Line 2').quote,/Only confirmed funded draws/);
  assert.ok(out.clauses.filter(x=>x.documentName==='Cash_Facts.csv').some(x=>x.locator==='Row 2'&&x.resolved),'"Rows 2 to 9" finds the rows that exist');
  assert.ok(c.notes.some(x=>/Rows 2 to 9 in Cash_Facts.csv: 7 locators found, 1 missing/.test(x)));
  assert.equal(figure(c,'Cash bridge').status,'met');
});
