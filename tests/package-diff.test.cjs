const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm'),fs=require('node:fs');
const E=require('../package-engine.js'),H=require('../candidate-engine.js');
/* Fixtures are hand-built or synthetic (Atlas, Meridian). Each document's sha256 is derived from its content, so a changed document has a new hash. */
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const doc=(name,kind,records,extra={})=>({id:'doc-'+digest(name+JSON.stringify(records)).slice(0,12),name,bytes:100,sha256:digest(name+'\0'+JSON.stringify(records)+JSON.stringify(extra.metadata||{})),role:'source',roleBasis:'QA fixture',status:'extracted',kind,records,metadata:{},warnings:[],...extra});
const pkg=documents=>({schemaVersion:1,kind:'finance-task-package',id:'package-qa',title:'QA fixture',fingerprint:digest(documents.map(d=>d.name+d.sha256).sort().join('\n')),documents});
const cell=(sheet,ref,value,extra={})=>({locator:sheet+'!'+ref,text:String(value),sheet,cell:ref,value:String(value),type:'n',formula:'',hasFormula:false,formulaType:'',cachePresent:true,hidden:false,context:'',...extra});
const text=(sheet,ref,value,extra={})=>cell(sheet,ref,value,{type:'s',...extra});
const fcell=(sheet,ref,formula,cached,extra={})=>cell(sheet,ref,cached===null?'':cached,{text:'='+formula+' [cached: '+(cached===null?'missing':cached)+']',formula,hasFormula:true,cachePresent:cached!==null,...extra});
const sheetList=records=>[...new Set(records.map(r=>r.sheet))].map(name=>({name,state:'visible',populatedCells:records.filter(r=>r.sheet===name).length}));
const xdoc=(name,records,meta={},extra={})=>doc(name,'xlsx',records,{metadata:{sheets:sheetList(records),formulas:records.filter(r=>r.hasFormula).length,missingCaches:records.filter(r=>r.hasFormula&&!r.cachePresent).length,definedNames:[],externalLinks:0,recalculated:false,...meta},...extra});
const csvDoc=(name,rows,extra={})=>doc(name,'csv',rows.map((v,i)=>({locator:'Row '+(i+1),text:v.join(' | ').trim(),values:v})),{metadata:{rows:rows.length},...extra});
const txtDoc=(name,body,kind='txt',extra={})=>doc(name,kind,body.split(/\r?\n/).map((t,i)=>({locator:(kind==='html'?'Text line ':'Line ')+(i+1),text:t.trim()})).filter(r=>r.text),extra);
const only=(d,name)=>{const m=d.documents.filter(x=>x.name===name);assert.equal(m.length,1,name);return m[0];};
const byLoc=dd=>new Map(dd.cells.map(c=>[c.locator+(c.derivedColumn?'|'+c.derivedColumn:''),c]));
const change=(base,cand)=>E.diffPackages(pkg([xdoc('Atlas_Model.xlsx',base)]),pkg([xdoc('Atlas_Model.xlsx',cand)])).documents[0];
const labels=dd=>Object.fromEntries(dd.cells.map(c=>[c.locator,c.change]));

test('identical packages give a summary of zeros, unchanged documents and the standing limits',()=>{
  const p=pkg([xdoc('Atlas_Model.xlsx',[cell('S','A1',1800),fcell('S','B1','A1*2',3600)]),csvDoc('Cash_Facts.csv',[['Label','Value'],['Opening usable cash','100']]),txtDoc('Facility_Terms.txt','Atlas facility terms.\nSecond line.')]);
  for(const r of [E.diffPackages(p,p),E.diffPackages(p,structuredClone(p))]){
    assert.deepEqual(r.summary,{changedDocuments:0,addedDocuments:0,removedDocuments:0,changedCells:0});
    assert.deepEqual(r.documents.map(d=>d.status),['unchanged','unchanged','unchanged']);
    assert.ok(r.documents.every(d=>d.cells.length===0&&d.lines.length===0&&d.metaChanges.sheets.length===0&&d.metaChanges.definedNames.length===0));
    assert.equal(r.baseFingerprint,p.fingerprint);assert.equal(r.candFingerprint,p.fingerprint);
    assert.match(r.limits.join('\n'),/not recalculated/);assert.match(r.limits.join('\n'),/Styles, number formats, comments/);assert.match(r.limits.join('\n'),/Renamed sheets and renamed files appear as a removal plus an addition/);
  }
});

test('result shapes are exactly the contract and survive a JSON round trip',()=>{
  const b=pkg([xdoc('M.xlsx',[cell('S','A1',1),cell('S','A2',2)]),csvDoc('F.csv',[['a','b'],['1','2']]),txtDoc('T.txt','one\ntwo')]),c=pkg([xdoc('M.xlsx',[cell('S','A1',9),cell('S','A3',3)]),csvDoc('F.csv',[['a','b'],['1','5']]),txtDoc('T.txt','one\nthree')]);
  const r=E.diffPackages(b,c);
  assert.deepEqual(Object.keys(r),['baseFingerprint','candFingerprint','documents','summary','limits']);
  assert.deepEqual(Object.keys(r.documents[0]),['name','status','kind','baseId','candId','baseSha256','candSha256','cells','lines','metaChanges','limits']);
  assert.deepEqual(Object.keys(r.documents[0].metaChanges),['sheets','definedNames']);
  assert.deepEqual(Object.keys(r.documents[0].cells[0]),['locator','sheet','cell','change','before','after','hidden']);
  assert.deepEqual(Object.keys(r.documents[0].cells[0].before),['value','type','formula','hasFormula','cachePresent']);
  assert.deepEqual(Object.keys(r.documents[1].cells[0]),['locator','change','before','after','hidden','derivedColumn']);
  assert.deepEqual(Object.keys(r.documents[2].lines[0]),['op','baseLocator','candLocator','before','after']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
  assert.deepEqual(E.diffPackages(b,c),r,'deterministic');
});

test('xlsx: value, formula, type, added, removed and a cleared cell are told apart',()=>{
  const dd=change(
    [cell('S','A1',1800),cell('S','A2',50),fcell('S','A3','A1+A2',1850),cell('S','A4',7),cell('S','A5','keep'),text('S','A6','Atlas'),cell('S','A7',4)],
    [cell('S','A1',2000),cell('S','A2',50),fcell('S','A3','A1-A2',1850),text('S','A4',7),cell('S','A5','keep'),text('S','A6','Atlas'),cell('S','A8',9)]);
  assert.equal(dd.status,'changed');assert.match(dd.limits.join(' '),/Formulas are not recalculated/,'the document itself says its values are saved caches');
  assert.deepEqual(labels(dd),{'S!A1':'value','S!A3':'formula','S!A4':'type','S!A7':'removed','S!A8':'added'});
  const m=byLoc(dd);
  assert.deepEqual(m.get('S!A1'),{locator:'S!A1',sheet:'S',cell:'A1',change:'value',before:{value:'1800',type:'n',formula:'',hasFormula:false,cachePresent:true},after:{value:'2000',type:'n',formula:'',hasFormula:false,cachePresent:true},hidden:false});
  assert.deepEqual(m.get('S!A3').before,{value:'1850',type:'n',formula:'A1+A2',hasFormula:true,cachePresent:true});
  assert.equal(m.get('S!A3').after.formula,'A1-A2');
  assert.equal(m.get('S!A4').before.type,'n');assert.equal(m.get('S!A4').after.type,'s');
  assert.deepEqual(m.get('S!A7'),{locator:'S!A7',sheet:'S',cell:'A7',change:'removed',before:{value:'4',type:'n',formula:'',hasFormula:false,cachePresent:true},after:null,hidden:false},'a cleared cell is a removal, never an empty value');
  assert.equal(m.get('S!A8').before,null);assert.equal(m.get('S!A8').after.value,'9');
});

test('xlsx: a formula flag alone is a formula change even when every other field is identical',()=>{
  const same=(extra)=>({locator:'S!A1',text:'5',value:'5',type:'n',formula:'',cachePresent:true,...extra});
  assert.deepEqual(labels(change([same({hasFormula:false})],[same({hasFormula:true})])),{'S!A1':'formula'});
  assert.deepEqual(labels(change([same({hasFormula:true})],[same({hasFormula:false})])),{'S!A1':'formula'});
  assert.equal(change([same({hasFormula:true})],[same({hasFormula:true})]).cells.length,0);
});

test('xlsx: a constant overwriting a formula, and the reverse, is a formula change',()=>{
  const dd=change([fcell('S','A1','B1+B2',30),cell('S','A2',5)],[cell('S','A1',30),fcell('S','A2','1+4',5)]);
  assert.deepEqual(labels(dd),{'S!A1':'formula','S!A2':'formula'});
  const m=byLoc(dd);assert.equal(m.get('S!A1').before.hasFormula,true);assert.equal(m.get('S!A1').after.hasFormula,false);assert.equal(m.get('S!A2').after.formula,'1+4');
});

test('xlsx: a saved workbook with no cached values is cache-lost, not a zero or a value change',()=>{
  const dd=change([fcell('S','A1','B1+B2',30),fcell('S','A2','B1*B2',200),cell('S','B1',10)],[fcell('S','A1','B1+B2',null),fcell('S','A2','B1*B2',null),cell('S','B1',10)]);
  assert.deepEqual(labels(dd),{'S!A1':'cache-lost','S!A2':'cache-lost'});
  const c=byLoc(dd).get('S!A1');assert.equal(c.before.cachePresent,true);assert.equal(c.after.cachePresent,false);assert.equal(c.after.value,'');assert.equal(c.after.hasFormula,true);
  assert.match(dd.limits.join(' '),/no saved value in the candidate: 2\. Their values are unknown, not zero/);
});

test('xlsx: an edited formula stands out among cells that only lost their cache; cache loss never hides the edit',()=>{
  const dd=change([fcell('S','A1','B1+B2',30),fcell('S','A2','B1*B2',200),fcell('S','A3','B1-B2',-10)],[fcell('S','A1','B1+B2',null),fcell('S','A2','B1*B3',null),fcell('S','A3','B1-B2',null)]);
  assert.deepEqual(labels(dd),{'S!A1':'cache-lost','S!A2':'formula','S!A3':'cache-lost'});
  assert.equal(byLoc(dd).get('S!A2').after.cachePresent,false,'the unknown value is still carried on the formula change');
  assert.match(dd.limits.join(' '),/no saved value in the candidate: 3/);
});

test('xlsx: same formula with a different cache is a value change; a regained cache is a value; two missing caches are no change',()=>{
  const dd=change([fcell('S','A1','B1+B2',30),fcell('S','A2','B1*B2',null),fcell('S','A3','B1-B2',null)],[fcell('S','A1','B1+B2',31),fcell('S','A2','B1*B2',200),fcell('S','A3','B1-B2',null)]);
  assert.deepEqual(labels(dd),{'S!A1':'value','S!A2':'value'});
  assert.equal(byLoc(dd).get('S!A2').before.cachePresent,false);
  /* with no saved value on either side the type attribute means nothing, so it is not compared */
  assert.equal(change([fcell('S','A1','B1+B2',null)],[fcell('S','A1','B1+B2',null,{type:'str'})]).cells.length,0);
  /* a formula cell added without a saved value is unknown too, and the note counts it; an ordinary change does not */
  const added=change([cell('S','A1',1)],[cell('S','A1',2),fcell('S','A2','A1*2',null)]);
  assert.deepEqual(labels(added),{'S!A1':'value','S!A2':'added'});assert.match(added.limits.join(' '),/Changed formula cells with no saved value in the candidate: 1\./);
  assert.doesNotMatch(change([cell('S','A1',1)],[cell('S','A1',2)]).limits.join(' '),/Changed formula cells with no saved value/);
});

test('xlsx: float serialisation is not a change (1800 vs 1800.0), a different number is',()=>{
  const same=[['1800','1800.0'],['1800','1800.00'],['1.8E3','1800'],['1.8e+3','1800'],['0.1','0.10000000000000001'],['0.30000000000000004','0.30000000000000004'],['-0','0'],['.5','0.5'],['5.','5'],['+5','5'],['1E-3','0.001']];
  for(const [a,b] of same){assert.equal(change([cell('S','A1',a)],[cell('S','A1',b)]).cells.length,0,a+' vs '+b);assert.equal(change([cell('S','A1',b)],[cell('S','A1',a)]).cells.length,0,b+' vs '+a);}
  const differ=[['0.1','0.2'],['0.3','0.30000000000000004'],['1800','1800.01'],['100','1E3']];
  for(const [a,b] of differ)assert.deepEqual(labels(change([cell('S','A1',a)],[cell('S','A1',b)])),{'S!A1':'value'},a+' vs '+b);
  /* numbers compare numerically only when BOTH are type n: text that looks like a number stays text */
  assert.deepEqual(labels(change([text('S','A1','1800')],[text('S','A1','1800.0')])),{'S!A1':'value'});
  assert.deepEqual(labels(change([cell('S','A1','1800')],[text('S','A1','1800.0')])),{'S!A1':'type'});
  assert.deepEqual(labels(change([cell('S','A1','007')],[cell('S','A1','7')])),{'S!A1':'value'},'a leading zero is not a number serialisation');
  assert.deepEqual(labels(change([cell('S','A1','abc')],[cell('S','A1','abc ')])),{'S!A1':'value'});
  assert.deepEqual(labels(change([cell('S','A1','1',{type:'b'})],[cell('S','A1','0',{type:'b'})])),{'S!A1':'value'});
  assert.deepEqual(labels(change([cell('S','A1','#REF!',{type:'e'})],[cell('S','A1','#DIV/0!',{type:'e'})])),{'S!A1':'value'});
  assert.deepEqual(labels(change([cell('S','A1','12')],[cell('S','A1','#REF!',{type:'e'})])),{'S!A1':'type'});
});

test('xlsx: string storage (shared vs inline) is not a type change; a record with no value field falls back to its text',()=>{
  assert.equal(change([text('S','A1','Atlas')],[text('S','A1','Atlas',{type:'inlineStr'})]).cells.length,0);
  assert.equal(change([text('S','A1','Atlas',{type:'inlineStr'})],[text('S','A1','Atlas')]).cells.length,0);
  const bare=(t,extra={})=>({locator:'S!A1',text:t,...extra});
  assert.deepEqual(labels(change([bare('#REF!',{type:'e'})],[bare('#DIV/0!',{type:'e'})])),{'S!A1':'value'});
  assert.equal(change([bare('x')],[bare('x')]).status,'unchanged');
  assert.equal(byLoc(change([bare('x')],[bare('y')])).get('S!A1').after.value,'y');
  assert.equal(byLoc(change([bare('x')],[bare('y')])).get('S!A1').sheet,'S','sheet and cell come from the locator when the record lacks them');
  assert.equal(byLoc(change([bare('x')],[bare('y')])).get('S!A1').cell,'A1');
});

test('xlsx: the hidden flag is carried from either side and a hidden-sheet change is reported as a sheet state change',()=>{
  const dd=change([cell('Hidden','A1',5,{hidden:true}),cell('Vis','A1',5),cell('Gone','B2',1,{hidden:true})],[cell('Hidden','A1',6,{hidden:true}),cell('Vis','A1',6),cell('New','C3',2,{hidden:true})]);
  const m=byLoc(dd);
  assert.equal(m.get('Hidden!A1').hidden,true);assert.equal(m.get('Vis!A1').hidden,false);assert.equal(m.get('Gone!B2').hidden,true);assert.equal(m.get('New!C3').hidden,true);
  const base=xdoc('Atlas_Model.xlsx',[cell('S','A1',5)]),cand=xdoc('Atlas_Model.xlsx',[cell('S','A1',5,{hidden:true})],{sheets:[{name:'S',state:'hidden',populatedCells:1}]});
  const r=E.diffPackages(pkg([base]),pkg([cand])).documents[0];
  assert.equal(r.cells.length,0);assert.deepEqual(r.metaChanges.sheets,[{name:'S',change:'state',before:{state:'visible',populatedCells:1},after:{state:'hidden',populatedCells:1}}]);assert.equal(r.status,'changed');
  const cellMoved=byLoc(change([cell('S','A1',5)],[cell('S','A1',5,{hidden:true}),cell('S','A2',1,{hidden:true})]));assert.equal(cellMoved.size,1,'a flag flip alone is not a cell change');
});

test('xlsx metadata: sheets added, removed, hidden; defined names added, removed, repointed; duplicate names handled per ref',()=>{
  const sh=(name,state='visible',n=1)=>({name,state,populatedCells:n}),info=(state='visible',n=1)=>({state,populatedCells:n});
  const b=xdoc('Atlas_Model.xlsx',[cell('S','A1',1)],{sheets:[sh('S'),sh('Old'),sh('Calc')],definedNames:[{name:'Cash',ref:'S!A1'},{name:'Gone',ref:'S!A2'},{name:'Print',ref:'S!A1'},{name:'Print',ref:'Old!A1'},{name:'Same',ref:'S!A1'}]});
  const c=xdoc('Atlas_Model.xlsx',[cell('S','A1',1),cell('S','A2',2)],{sheets:[sh('S',  'visible',2),sh('New'),sh('Calc','veryHidden')],definedNames:[{name:'Cash',ref:'S!B1'},{name:'Added',ref:'S!A9'},{name:'Print',ref:'S!A1'},{name:'Same',ref:'S!A1'}]});
  const m=E.diffPackages(pkg([b]),pkg([c])).documents[0].metaChanges;
  assert.deepEqual(m.sheets,[{name:'Old',change:'removed',before:info(),after:null},{name:'Calc',change:'state',before:info(),after:info('veryHidden')},{name:'New',change:'added',before:null,after:info()}]);
  assert.deepEqual(m.definedNames,[{name:'Cash',change:'ref',before:'S!A1',after:'S!B1'},{name:'Gone',change:'removed',before:'S!A2',after:null},{name:'Print',change:'removed',before:'Old!A1',after:null},{name:'Added',change:'added',before:null,after:'S!A9'}]);
});

test('xlsx: a renamed sheet is a removal plus an addition, as the limits say',()=>{
  const dd=change([cell('Old','A1',1),cell('Old','A2',2)],[cell('New','A1',1),cell('New','A2',2)]);
  assert.deepEqual(labels(dd),{'Old!A1':'removed','Old!A2':'removed','New!A1':'added','New!A2':'added'});
});

test('xlsx: records sharing a locator keep the first and say so; a locator with an exclamation mark in the sheet name splits at the last one',()=>{
  const dd=change([cell('S','A1',1),cell('S','A1',2)],[cell('S','A1',1)]);
  assert.equal(dd.cells.length,0);assert.match(dd.limits.join(' '),/sharing a locator with an earlier record were ignored: 1/);
  const odd=byLoc(change([{locator:'Q4!Plan!B2',text:'1'}],[{locator:'Q4!Plan!B2',text:'2'}])).get('Q4!Plan!B2');assert.equal(odd.sheet,'Q4!Plan');assert.equal(odd.cell,'B2');
});

test('csv: Row N plus values, a derived column letter, numeric equality, additions and removals',()=>{
  const b=csvDoc('Cash_Facts.csv',[['Label','Value'],['Opening usable cash','100'],['Available facility','1800'],['Requested borrowing','2000'],['Note',''],['Gone','1']]);
  const c=csvDoc('Cash_Facts.csv',[['Label','Value'],['Opening usable cash','100'],['Available facility','1800.0'],['Requested borrowing','2500'],['Note','late'],['Gone',''],['Extra','7','x']]);
  const r=E.diffPackages(pkg([b]),pkg([c])),dd=r.documents[0];
  assert.equal(dd.kind,'csv');assert.equal(dd.status,'changed');
  assert.deepEqual(dd.cells,[
    {locator:'Row 4',change:'value',before:{value:'2000',type:'n',formula:'',hasFormula:false,cachePresent:true},after:{value:'2500',type:'n',formula:'',hasFormula:false,cachePresent:true},hidden:false,derivedColumn:'B'},
    {locator:'Row 5',change:'added',before:null,after:{value:'late',type:'s',formula:'',hasFormula:false,cachePresent:true},hidden:false,derivedColumn:'B'},
    {locator:'Row 6',change:'removed',before:{value:'1',type:'n',formula:'',hasFormula:false,cachePresent:true},after:null,hidden:false,derivedColumn:'B'},
    {locator:'Row 7',change:'added',before:null,after:{value:'Extra',type:'s',formula:'',hasFormula:false,cachePresent:true},hidden:false,derivedColumn:'A'},
    {locator:'Row 7',change:'added',before:null,after:{value:'7',type:'n',formula:'',hasFormula:false,cachePresent:true},hidden:false,derivedColumn:'B'},
    {locator:'Row 7',change:'added',before:null,after:{value:'x',type:'s',formula:'',hasFormula:false,cachePresent:true},hidden:false,derivedColumn:'C'}]);
  assert.ok(dd.cells.every(x=>x.sheet===undefined&&x.cell===undefined),'a csv change has no sheet or cell, only the derived column');
  assert.match(dd.limits.join(' '),/column letters are derived/);assert.match(dd.limits.join(' '),/row counts differ \(6 in the base, 7 in the candidate\)/);
  assert.equal(r.summary.changedCells,6);
});

test('csv: wide rows get spreadsheet-style letters; identifiers and long digit strings are never conflated numerically',()=>{
  const wide=n=>Array.from({length:n},(_,i)=>String(i));
  const dd=E.diffPackages(pkg([csvDoc('W.csv',[wide(30)])]),pkg([csvDoc('W.csv',[wide(30).map((v,i)=>i===0||i===25||i===26||i===27?'x'+v:v)])])).documents[0];
  assert.deepEqual(dd.cells.map(c=>c.derivedColumn),['A','Z','AA','AB']);
  const ids=(a,b)=>E.diffPackages(pkg([csvDoc('Ids.csv',[[a]])]),pkg([csvDoc('Ids.csv',[[b]])])).documents[0].cells.map(c=>c.change);
  assert.deepEqual(ids('007','7'),['value'],'leading zeros are text');
  assert.deepEqual(ids('12345678901234567890','12345678901234567891'),['value'],'more than 15 digits compares as text');
  assert.deepEqual(ids('1800','1800.0'),[]);assert.deepEqual(ids('1,800','1800'),['value']);assert.deepEqual(ids('2026-09-29','2026-09-30'),['value']);
  assert.deepEqual(ids('','5'),['added']);assert.deepEqual(ids('5',''),['removed']);assert.deepEqual(ids('1E3','1000'),[]);
});

test('csv: a record with no values array falls back to its text split on the separator',()=>{
  const mk=t=>doc('F.csv','csv',[{locator:'Row 1',text:t}]);
  const dd=E.diffPackages(pkg([mk('a | 1')]),pkg([mk('a | 2')])).documents[0];
  assert.equal(dd.cells.length,1);assert.equal(dd.cells[0].derivedColumn,'B');assert.equal(dd.cells[0].after.value,'2');
});

test('txt: replaced, inserted and deleted lines align with their own locators',()=>{
  const dd=E.diffPackages(pkg([txtDoc('Facility_Terms.txt','Atlas terms.\n\nOnly confirmed draws count.\nAvailable credit is not cash.\nClosing line.')]),pkg([txtDoc('Facility_Terms.txt','Atlas terms.\n\nOnly confirmed funded draws count.\nNew sentence.\nAvailable credit is not cash.\n')])).documents[0];
  assert.equal(dd.status,'changed');assert.equal(dd.cells.length,0);
  assert.deepEqual(dd.lines,[
    {op:'equal',baseLocator:'Line 1',candLocator:'Line 1',before:'Atlas terms.',after:'Atlas terms.'},
    {op:'del',baseLocator:'Line 3',candLocator:null,before:'Only confirmed draws count.',after:null},
    {op:'add',baseLocator:null,candLocator:'Line 3',before:null,after:'Only confirmed funded draws count.'},
    {op:'add',baseLocator:null,candLocator:'Line 4',before:null,after:'New sentence.'},
    {op:'equal',baseLocator:'Line 4',candLocator:'Line 5',before:'Available credit is not cash.',after:'Available credit is not cash.'},
    {op:'del',baseLocator:'Line 5',candLocator:null,before:'Closing line.',after:null}]);
});

test('lines: md, json, html and docx records are all aligned by text, and an insertion does not shift every later line into a change',()=>{
  const body=Array.from({length:40},(_,i)=>'Atlas clause '+i).join('\n');
  for(const kind of ['md','json','html','htm','docx','log']){
    const mk=t=>kind==='docx'?doc('A.docx','docx',t.split('\n').map((x,i)=>({locator:'Paragraph '+(i+1),text:x}))):txtDoc('A.'+kind,t,kind);
    const dd=E.diffPackages(pkg([mk(body)]),pkg([mk('Inserted clause\n'+body)])).documents[0];
    const ops=dd.lines.filter(l=>l.op!=='equal');assert.deepEqual(ops.map(l=>[l.op,l.after]),[['add','Inserted clause']],kind);assert.equal(dd.lines.length,41,kind);
  }
});

test('lines: ops rebuild both sides exactly and the alignment is the longest common subsequence',()=>{
  const lcs=(a,b)=>{const t=Array.from({length:a.length+1},()=>new Array(b.length+1).fill(0));for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)t[i][j]=a[i]===b[j]?t[i+1][j+1]+1:Math.max(t[i+1][j],t[i][j+1]);return t[0][0];};
  const rand=rng(7),vocab=['alpha','beta','gamma','delta','epsilon','zeta'];
  for(let n=0;n<300;n++){
    const a=Array.from({length:Math.floor(rand()*40)},()=>vocab[Math.floor(rand()*vocab.length)]),b=Array.from({length:Math.floor(rand()*40)},()=>vocab[Math.floor(rand()*vocab.length)]);
    const mk=l=>doc('R.txt','txt',l.map((t,i)=>({locator:'Line '+(i*2+1),text:t})));
    const dd=E.diffPackages(pkg([mk(a)]),pkg([mk(b)])).documents[0],ops=dd.lines;
    if(JSON.stringify(a)===JSON.stringify(b)){assert.ok(ops.every(o=>o.op==='equal'));continue;}
    assert.deepEqual(ops.filter(o=>o.op!=='add').map(o=>o.before),a);assert.deepEqual(ops.filter(o=>o.op!=='del').map(o=>o.after),b);
    assert.deepEqual(ops.filter(o=>o.op!=='add').map(o=>o.baseLocator),a.map((_,i)=>'Line '+(i*2+1)));assert.deepEqual(ops.filter(o=>o.op!=='del').map(o=>o.candLocator),b.map((_,i)=>'Line '+(i*2+1)));
    assert.equal(ops.filter(o=>o.op==='equal').length,lcs(a,b),'minimal edit script');
    assert.ok(ops.every(o=>o.op!=='equal'||o.before===o.after));
    assert.ok(ops.every(o=>(o.op==='add')===(o.baseLocator===null)&&(o.op==='del')===(o.candLocator===null)));
  }
});

test('lines: a 6000-line file with one edit is exact; a changed region over 5000 lines is capped with a note and still rebuilds',()=>{
  const lines=n=>Array.from({length:n},(_,i)=>'Meridian line '+i);
  const big=lines(6000),edited=big.slice();edited[3000]='Meridian line 3000 EDITED';
  const one=E.diffPackages(pkg([txtDoc('Big.txt',big.join('\n'))]),pkg([txtDoc('Big.txt',edited.join('\n'))])).documents[0];
  assert.deepEqual(one.lines.filter(l=>l.op!=='equal').map(l=>[l.op,l.baseLocator,l.candLocator]),[['del','Line 3001',null],['add',null,'Line 3001']]);assert.equal(one.lines.length,6001);assert.equal(one.limits.length,0);
  const other=lines(6000).map(l=>l+' changed'),r=E.diffPackages(pkg([txtDoc('Big.txt',big.join('\n'))]),pkg([txtDoc('Big.txt',other.join('\n'))])),dd=r.documents[0];
  assert.match(dd.limits.join(' '),/limited to 5000 lines per side: the changed region \(6000 base lines, 6000 candidate lines\)/);
  assert.match(r.limits.join('\n'),/Big\.txt: Line alignment is limited to 5000 lines/);
  assert.deepEqual(dd.lines.filter(o=>o.op!=='add').map(o=>o.before),big);assert.deepEqual(dd.lines.filter(o=>o.op!=='del').map(o=>o.after),other);
  assert.equal(dd.lines.filter(o=>o.op==='equal').length,0);
  /* the boundary: exactly 5000 differing lines on each side is aligned (half of them match), 5001 is not */
  const mid=n=>Array.from({length:n},(_,i)=>'row '+i),edit=(n,i)=>i%2===0||i===n-1;
  const around=n=>E.diffPackages(pkg([txtDoc('Edge.txt','head\n'+mid(n).join('\n')+'\ntail')]),pkg([txtDoc('Edge.txt','head\n'+mid(n).map((l,i)=>edit(n,i)?l+'!':l).join('\n')+'\ntail')])).documents[0];
  const at5000=around(5000),at5001=around(5001);
  assert.equal(at5000.limits.length,0);assert.equal(at5000.lines.filter(o=>o.op==='equal').length,2+2500-1);
  assert.deepEqual(at5000.lines.filter(o=>o.op!=='add').map(o=>o.before).slice(0,3),['head','row 0','row 1']);
  assert.equal(at5001.limits.length,1);assert.equal(at5001.lines.filter(o=>o.op==='equal').length,2);
  /* one side empty after trimming is never "capped": it is a plain run of additions */
  const grow=E.diffPackages(pkg([txtDoc('G.txt','top')]),pkg([txtDoc('G.txt','top\n'+mid(7000).join('\n'))])).documents[0];
  assert.equal(grow.limits.length,0);assert.equal(grow.lines.filter(o=>o.op==='add').length,7000);
});

test('lines: the worst case inside the cap (5000 against 5000 with scattered matches) finishes quickly',()=>{
  const a=Array.from({length:5000},(_,i)=>'x'+(i*7%1301)),b=Array.from({length:5000},(_,i)=>'x'+(i*11%1303));
  const t=process.hrtime.bigint();const dd=E.diffPackages(pkg([doc('W.txt','txt',a.map((x,i)=>({locator:'Line '+(i+1),text:x})))]),pkg([doc('W.txt','txt',b.map((x,i)=>({locator:'Line '+(i+1),text:x})))])).documents[0];
  const ms=Number(process.hrtime.bigint()-t)/1e6;
  assert.deepEqual(dd.lines.filter(o=>o.op!=='add').map(o=>o.before),a);assert.deepEqual(dd.lines.filter(o=>o.op!=='del').map(o=>o.after),b);assert.equal(dd.limits.length,0);
  assert.ok(ms<3000,'took '+ms+' ms');
});

test('documents pair by exact name; equal sha256 is unchanged and skipped even when its records disagree',()=>{
  const a=txtDoc('Facility_Terms.txt','Atlas terms.'),twin={...txtDoc('Facility_Terms.txt','Atlas terms CHANGED.'),sha256:a.sha256,id:'twin'};
  const r=E.diffPackages(pkg([a]),pkg([twin]));assert.equal(r.documents[0].status,'unchanged');assert.equal(r.documents[0].lines.length,0);assert.deepEqual(r.summary,{changedDocuments:0,addedDocuments:0,removedDocuments:0,changedCells:0});
  /* with no hash on either side nothing is skipped: the records decide */
  const noSha=(d,over={})=>{const x={...d,...over};delete x.sha256;return x;};
  const same=E.diffPackages(pkg([noSha(a)]),pkg([noSha(a,{id:'z'})])).documents[0];assert.equal(same.status,'unchanged');assert.equal(same.baseSha256,null);
  const diff=E.diffPackages(pkg([noSha(a)]),pkg([noSha(twin)])).documents[0];assert.equal(diff.status,'changed');assert.equal(diff.lines.filter(l=>l.op!=='equal').length,2);
});

test('documents: added, removed, and a renamed file is an addition plus a removal with no cells or lines',()=>{
  const old=xdoc('Model_v1.xlsx',[cell('S','A1',1)]),next=xdoc('Model_v2.xlsx',[cell('S','A1',1)]),keep=txtDoc('Facility_Terms.txt','Atlas.'),added=csvDoc('Cash_Facts.csv',[['a']]);
  const r=E.diffPackages(pkg([old,keep]),pkg([next,keep,added]));
  assert.deepEqual(r.documents.map(d=>[d.name,d.status]),[['Model_v1.xlsx','removed'],['Facility_Terms.txt','unchanged'],['Model_v2.xlsx','added'],['Cash_Facts.csv','added']]);
  assert.deepEqual(r.summary,{changedDocuments:0,addedDocuments:2,removedDocuments:1,changedCells:0});
  const rm=r.documents[0],ad=r.documents[2];assert.equal(rm.candId,null);assert.equal(rm.candSha256,null);assert.equal(rm.baseId,old.id);assert.equal(rm.baseSha256,old.sha256);assert.equal(ad.baseId,null);assert.equal(ad.candId,next.id);assert.equal(ad.kind,'xlsx');
  assert.ok([rm,ad].every(d=>d.cells.length===0&&d.lines.length===0&&d.limits.length===0),'no match was possible, so no ambiguity note either');
});

test('documents: a unique tail name pairs across folders; the move is labelled and an identical moved file is unchanged',()=>{
  const b=pkg([txtDoc('Atlas/Facility_Terms.txt','Atlas terms.'),csvDoc('Cash_Facts.csv',[['a','1']])]),c=pkg([txtDoc('Archive/Facility_Terms.txt','Atlas terms revised.'),{...csvDoc('Inputs/Cash_Facts.csv',[['a','1']]),sha256:b.documents[1].sha256}]);
  const r=E.diffPackages(b,c);
  assert.deepEqual(r.documents.map(d=>[d.name,d.status]),[['Archive/Facility_Terms.txt','changed'],['Inputs/Cash_Facts.csv','unchanged']]);
  assert.equal(r.documents[0].baseId,b.documents[0].id);assert.equal(r.documents[0].candId,c.documents[0].id);
  assert.match(r.documents[0].limits.join(' '),/Matched by file name only: base path "Atlas\/Facility_Terms\.txt", candidate path "Archive\/Facility_Terms\.txt"/);
  assert.match(r.documents[1].limits.join(' '),/Matched by file name only/);
  assert.match(r.limits.join('\n'),/Files matched by file name only \(the folder differs\): 2/);
  assert.equal(r.documents[0].lines.filter(l=>l.op!=='equal').length,2);
  /* archive members use ' / ' in their names; the tail still pairs them */
  const z=E.diffPackages(pkg([txtDoc('a.zip / Terms.txt','one')]),pkg([txtDoc('b.zip / Terms.txt','two')]));assert.equal(z.documents.length,1);assert.equal(z.documents[0].status,'changed');
});

test('documents: an ambiguous tail name is never paired; both sides are listed with a limit note',()=>{
  const x1=csvDoc('Atlas/Cash_Facts.csv',[['a','1']]),x2=csvDoc('Meridian/Cash_Facts.csv',[['a','2']]),y=csvDoc('Cobalt/Cash_Facts.csv',[['a','3']]);
  const r=E.diffPackages(pkg([x1,x2]),pkg([y]));
  assert.deepEqual(r.documents.map(d=>[d.name,d.status]),[['Atlas/Cash_Facts.csv','removed'],['Meridian/Cash_Facts.csv','removed'],['Cobalt/Cash_Facts.csv','added']]);
  assert.deepEqual(r.summary,{changedDocuments:0,addedDocuments:1,removedDocuments:2,changedCells:0});
  assert.ok(r.documents.every(d=>/File name "Cash_Facts\.csv" appears 2 times in the base package and 1 in the candidate package/.test(d.limits.join(' '))),'every involved document carries the note');
  assert.equal(r.limits.filter(l=>/Cash_Facts\.csv/.test(l)).length,1,'one package-level note per ambiguous name');
  assert.ok(r.documents.every(d=>d.cells.length===0));
  /* ambiguous on the candidate side only, and a single-sided tail that is not ambiguous at all */
  const r2=E.diffPackages(pkg([y]),pkg([x1,x2]));assert.deepEqual(r2.documents.map(d=>d.status),['removed','added','added']);assert.match(r2.documents[0].limits.join(' '),/1 time in the base package and 2 in the candidate/);
  const r3=E.diffPackages(pkg([x1]),pkg([x1,x2]));assert.deepEqual(r3.documents.map(d=>[d.name,d.status]),[['Atlas/Cash_Facts.csv','unchanged'],['Meridian/Cash_Facts.csv','added']],'an exact name wins before any tail is considered');
  assert.equal(r3.documents[1].limits.length,0);
  const r4=E.diffPackages(pkg([x1,x2]),pkg([x1]));assert.deepEqual(r4.documents.map(d=>d.status),['unchanged','removed']);assert.equal(r4.documents[1].limits.length,0);
});

test('documents: the same exact name twice in a package pairs identical content and refuses to guess the rest',()=>{
  const a1={...txtDoc('Notes.txt','one'),id:'a1'},a2={...txtDoc('Notes.txt','two'),id:'a2'},b1={...txtDoc('Notes.txt','one'),id:'b1'},b2={...txtDoc('Notes.txt','three'),id:'b2'},b3={...txtDoc('Notes.txt','four'),id:'b3'};
  const r=E.diffPackages(pkg([a1,a2]),pkg([b1,b2]));
  assert.deepEqual(r.documents.map(d=>[d.baseId,d.candId,d.status]),[['a1','b1','unchanged'],['a2','b2','changed']],'the identical pair is matched by hash, the lone remainder pairs');
  const amb=E.diffPackages(pkg([a1,a2]),pkg([b2,b3]));
  assert.deepEqual(amb.documents.map(d=>[d.baseId,d.candId,d.status]),[['a1',null,'removed'],['a2',null,'removed'],[null,'b2','added'],[null,'b3','added']]);
  assert.match(amb.limits.join('\n'),/File name "Notes\.txt" appears 2 times in the base package and 2 in the candidate package and cannot be paired/);
  assert.ok(amb.documents.every(d=>d.limits.length===1));
  /* a document already reported as ambiguous by exact name gets that one note, not a second one from the tail rule */
  const moved={...txtDoc('Elsewhere/Notes.txt','one'),id:'m1'};
  const heldBase=E.diffPackages(pkg([a1,a2]),pkg([b2,b3,moved]));assert.deepEqual(heldBase.documents.map(d=>[d.baseId||d.candId,d.status,d.limits.length]),[['a1','removed',1],['a2','removed',1],['b2','added',1],['b3','added',1],['m1','added',0]]);
  const heldCand=E.diffPackages(pkg([a1,a2,moved]),pkg([b2,b3]));assert.deepEqual(heldCand.documents.map(d=>[d.baseId||d.candId,d.status,d.limits.length]),[['a1','removed',1],['a2','removed',1],['m1','removed',0],['b2','added',1],['b3','added',1]]);
});

test('documents: a type the engine cannot read, or two different types, are compared by hash only and say so',()=>{
  const pdf=(sha,extra={})=>({...doc('Atlas_Memo.pdf','pdf',[],{status:'unsupported',warnings:['PDF extraction is not implemented.']}),sha256:sha,...extra});
  const r=E.diffPackages(pkg([pdf('a'.repeat(64),{id:'p1'})]),pkg([pdf('b'.repeat(64),{id:'p2'})])),d=r.documents[0];
  assert.equal(d.status,'changed');assert.equal(d.cells.length,0);assert.equal(d.lines.length,0);assert.match(d.limits.join(' '),/No text could be extracted from either version of this file, so only its hash is compared/);
  assert.match(r.limits.join('\n'),/Changed files with no extracted text to compare, or of a different type: 1\. They are compared by hash only/);
  assert.equal(E.diffPackages(pkg([pdf('a'.repeat(64),{id:'p1'})]),pkg([pdf('a'.repeat(64),{id:'p2'})])).documents[0].status,'unchanged');
  const ok=txtDoc('Same.txt','one'),broken={...txtDoc('Same.txt','two'),status:'error',kind:'',records:[]};
  assert.match(E.diffPackages(pkg([ok]),pkg([broken])).documents[0].limits.join(' '),/from the candidate version|No text could be extracted from the candidate of this file/);
  assert.match(E.diffPackages(pkg([broken]),pkg([ok])).documents[0].limits.join(' '),/from the base of this file/);
  const kinds=E.diffPackages(pkg([doc('Same.dat','csv',[{locator:'Row 1',text:'a',values:['a']}])]),pkg([doc('Same.dat','txt',[{locator:'Line 1',text:'a'}])])).documents[0];
  assert.equal(kinds.status,'changed');assert.match(kinds.limits.join(' '),/file type differs \(base csv, candidate txt\)/);assert.equal(kinds.cells.length+kinds.lines.length,0);
});

test('documents: differing bytes with nothing extracted to show is changed and says what that means',()=>{
  const a=xdoc('Atlas_Model.xlsx',[cell('S','A1',1)]),b={...xdoc('Atlas_Model.xlsx',[cell('S','A1',1)]),sha256:digest('restyled'),id:'other'};
  const d=E.diffPackages(pkg([a]),pkg([b])).documents[0];assert.equal(d.status,'changed');assert.equal(d.cells.length,0);assert.match(d.limits.join(' '),/bytes differ but no extracted text or cell differs/);
  const t=E.diffPackages(pkg([txtDoc('A.txt','same')]),pkg([{...txtDoc('A.txt','same'),sha256:digest('x'),id:'o'}])).documents[0];assert.equal(t.status,'changed');assert.match(t.limits.join(' '),/bytes differ/);assert.ok(t.lines.every(l=>l.op==='equal'),'the edit script still rebuilds both sides');
});

test('bad input is refused with a clear error, and the inputs are never modified',()=>{
  for(const bad of [null,undefined,{},{documents:'x'},{documents:[null]},{documents:[{}]}])assert.throws(()=>E.diffPackages(bad,pkg([])),/needs two task packages/);
  assert.throws(()=>E.diffPackages(pkg([]),null),/needs two task packages/);
  assert.deepEqual(E.diffPackages(pkg([]),pkg([])).summary,{changedDocuments:0,addedDocuments:0,removedDocuments:0,changedCells:0});
  const deepFreeze=o=>{if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.freeze(o);Object.values(o).forEach(deepFreeze);}return o;};
  const b=deepFreeze(pkg([xdoc('M.xlsx',[cell('S','A1',1),fcell('S','A2','A1',1)]),csvDoc('F.csv',[['a','1']]),txtDoc('T.txt','one\ntwo')])),c=deepFreeze(pkg([xdoc('M.xlsx',[cell('S','A1',2),fcell('S','A2','A1',null)]),csvDoc('F.csv',[['a','2']]),txtDoc('T.txt','one\nthree')]));
  const before=JSON.stringify([b,c]);const r=E.diffPackages(b,c);assert.equal(JSON.stringify([b,c]),before);
  r.documents[0].cells[0].after.value='tampered';assert.equal(c.documents[0].records[0].value,'2','the result holds copies, not the package records');
});

/* ---------- property tests: apply the changes to the base and rebuild the candidate ---------- */
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const letter=i=>String.fromCharCode(65+i);
const snap=r=>({value:r.value??'',type:r.type||'n',formula:r.formula??'',hasFormula:!!r.hasFormula,cachePresent:r.cachePresent});
const numeric=v=>/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v);
const equivalent=(a,b)=>a.type===b.type&&a.formula===b.formula&&a.hasFormula===b.hasFormula&&a.cachePresent===b.cachePresent&&(a.value===b.value||(a.type==='n'&&numeric(a.value)&&numeric(b.value)&&Number(a.value)===Number(b.value)));
const WORDS=['Revenue','Cash','Atlas facility','Meridian lending','Borealis','Cobalt','Payments due'];
function randomBook(rand,rows=14,cols=5){
  const records=[];
  for(const sheet of ['Inputs','Calc','Hidden'])for(let r=1;r<=rows;r++)for(let c=0;c<cols;c++){
    if(rand()<0.3)continue;const ref=letter(c)+r,k=rand(),h=sheet==='Hidden';
    if(k<0.45)records.push(cell(sheet,ref,(Math.round(rand()*1e6)/100).toString(),{hidden:h}));
    else if(k<0.65)records.push(text(sheet,ref,WORDS[Math.floor(rand()*WORDS.length)]+' '+Math.floor(rand()*50),{hidden:h}));
    else if(k<0.85)records.push(fcell(sheet,ref,letter((c+1)%cols)+r+'+'+letter((c+2)%cols)+r,String(Math.round(rand()*1e5)/10),{hidden:h}));
    else if(k<0.92)records.push(cell(sheet,ref,rand()<0.5?'1':'0',{type:'b',hidden:h}));
    else records.push(fcell(sheet,ref,'"a"&"b"','ab',{type:'str',hidden:h}));
  }
  return records;
}
function mutateBook(rand,base,cols=5){
  const out=[],expect={};
  for(const r of base){
    const u=rand(),loc=r.locator,constant=!r.hasFormula;
    if(u<0.08){expect[loc]='removed';continue;}
    if(u<0.16){const v=r.type==='n'?String(Number(r.value)+1):r.type==='b'?(r.value==='1'?'0':'1'):r.value+' x';out.push({...r,value:v,text:r.hasFormula?'='+r.formula+' [cached: '+v+']':v});expect[loc]='value';continue;}
    if(u<0.20&&constant&&(r.type==='n'||r.type==='s')){out.push({...r,type:r.type==='n'?'s':'n'});expect[loc]='type';continue;}
    if(u<0.24){if(r.hasFormula)out.push({...r,formula:r.formula+'+1'});else out.push({...r,hasFormula:true,formula:'1+1'});expect[loc]='formula';continue;}
    if(u<0.28&&r.hasFormula&&r.cachePresent){out.push({...r,value:'',cachePresent:false,text:'='+r.formula+' [cached: missing]'});expect[loc]='cache-lost';continue;}
    if(u<0.34&&constant&&r.type==='n'){out.push({...r,value:/\./.test(r.value)?r.value+'0':r.value+'.0',text:r.value+'.0'});continue;}
    if(u<0.38){out.push({...r,hidden:!r.hidden});continue;}
    out.push({...r});
  }
  const have=new Set(base.map(r=>r.locator));
  for(const sheet of ['Inputs','Calc','Hidden'])for(let r=1;r<=14;r++)for(let c=cols;c<cols+2;c++){const ref=letter(c)+r;if(!have.has(sheet+'!'+ref)&&rand()<0.1){out.push(cell(sheet,ref,String(Math.floor(rand()*999)),{hidden:sheet==='Hidden'}));expect[sheet+'!'+ref]='added';}}
  return {records:out,expect};
}
const flip={added:'removed',removed:'added','cache-lost':'value',value:'value',formula:'formula',type:'type'};
test('property (xlsx): changes rebuild the candidate cell map from the base, with exactly the mutations applied',()=>{
  for(let seed=1;seed<=120;seed++){
    const rand=rng(seed),base=randomBook(rand),{records,expect}=mutateBook(rand,base);
    const bp=pkg([xdoc('Atlas_Model.xlsx',base)]),cp=pkg([xdoc('Atlas_Model.xlsx',records)]),r=E.diffPackages(bp,cp),dd=r.documents[0];
    assert.deepEqual(labels(dd),expect,'seed '+seed);assert.equal(dd.cells.length,Object.keys(expect).length);assert.equal(r.summary.changedCells,dd.cells.length);
    const rebuilt=new Map(base.map(x=>[x.locator,snap(x)]));
    for(const c of dd.cells){if(c.change==='removed'){assert.ok(rebuilt.delete(c.locator),'removal of a cell the base had');assert.equal(c.after,null);}else{if(c.change==='added')assert.ok(!rebuilt.has(c.locator));else assert.ok(rebuilt.has(c.locator));assert.deepEqual(rebuilt.get(c.locator)&&c.before?c.before:null,rebuilt.get(c.locator)&&c.before?snap(base.find(x=>x.locator===c.locator)):null);rebuilt.set(c.locator,c.after);}}
    const want=new Map(records.map(x=>[x.locator,snap(x)]));
    assert.deepEqual([...rebuilt.keys()].sort(),[...want.keys()].sort(),'seed '+seed);
    for(const [k,v] of want){assert.ok(equivalent(rebuilt.get(k),v),'seed '+seed+' '+k+' '+JSON.stringify([rebuilt.get(k),v]));if(expect[k]&&expect[k]!=='removed')assert.deepEqual(rebuilt.get(k),v,'a changed cell carries the candidate cell exactly');}
    /* hidden flag: every change on a hidden sheet is flagged, none elsewhere */
    for(const c of dd.cells)assert.equal(c.hidden,c.locator.startsWith('Hidden!')||!!(records.find(x=>x.locator===c.locator)?.hidden||base.find(x=>x.locator===c.locator)?.hidden),c.locator);
    /* the diff of the rebuilt map against the candidate is empty, the reverse diff mirrors this one, and a document against itself is empty */
    const again=E.diffPackages(pp(base,rebuilt),cp);assert.equal(again.documents[0].cells.length,0,'seed '+seed);
    const back=E.diffPackages(cp,bp).documents[0];assert.deepEqual(Object.fromEntries(back.cells.map(c=>[c.locator,c.change])),Object.fromEntries(Object.entries(expect).map(([k,v])=>[k,flip[v]])),'reverse, seed '+seed);
    assert.equal(E.diffPackages(bp,bp).documents[0].status,'unchanged');
  }
  function pp(base,rebuilt){const recs=[...rebuilt].map(([loc,s])=>cell(loc.split('!')[0],loc.split('!')[1],s.value,{type:s.type,formula:s.formula,hasFormula:s.hasFormula,cachePresent:s.cachePresent}));return pkg([xdoc('Atlas_Model.xlsx',recs)]);}
});

test('property (csv): changes rebuild the candidate cells from the base',()=>{
  const canon=v=>/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)?String(Number(v)):v;
  for(let seed=1;seed<=150;seed++){
    const rand=rng(1000+seed),rows=Array.from({length:Math.floor(rand()*8)},()=>Array.from({length:1+Math.floor(rand()*5)},()=>rand()<0.2?'':rand()<0.5?String(Math.floor(rand()*300)):WORDS[Math.floor(rand()*WORDS.length)]));
    const cand=rows.map(r=>r.map(v=>{const u=rand();return u<0.15?'':u<0.3?String(Math.floor(rand()*300)):u<0.4&&/^\d+$/.test(v)?v+'.0':v;}));
    for(let n=Math.floor(rand()*3);n>0;n--)cand.push(Array.from({length:1+Math.floor(rand()*6)},()=>rand()<0.2?'':'n'+Math.floor(rand()*9)));
    if(rand()<0.2&&cand.length)cand.pop();
    const key=(row,col)=>'Row '+(row+1)+'|'+colName(col);
    const dd=E.diffPackages(pkg([csvDoc('Cash_Facts.csv',rows)]),pkg([csvDoc('Cash_Facts.csv',cand)])).documents[0];
    const m=new Map();rows.forEach((r,i)=>r.forEach((v,j)=>{if(v!=='')m.set(key(i,j),v);}));
    for(const c of dd.cells){const k=c.locator+'|'+c.derivedColumn;if(c.change==='removed'){assert.ok(m.delete(k),'seed '+seed);assert.equal(c.after,null);}else{assert.equal(m.has(k),c.change==='value','seed '+seed+' '+k);if(c.change==='value')assert.equal(m.get(k),c.before.value);else assert.equal(c.before,null);m.set(k,c.after.value);}}
    const want=new Map();cand.forEach((r,i)=>r.forEach((v,j)=>{if(v!=='')want.set(key(i,j),v);}));
    assert.deepEqual([...m.keys()].sort(),[...want.keys()].sort(),'seed '+seed);for(const [k,v] of want)assert.equal(canon(m.get(k)),canon(v),'seed '+seed+' '+k);
    assert.equal(new Set(dd.cells.map(c=>c.locator+'|'+c.derivedColumn)).size,dd.cells.length,'one change per cell');
  }
  function colName(i){return i<26?letter(i):letter(Math.floor(i/26)-1)+letter(i%26);}
});

/* ---------- performance ---------- */
function bigBook(n,seed,variant){
  const rand=rng(seed),records=[],sheets=['Inputs','Calc','Plan','Notes'],per=Math.ceil(n/sheets.length);let expected=0;
  for(const sheet of sheets)for(let i=0;i<per;i++){
    const ref=letter(i%26)+(Math.floor(i/26)+1),k=i%10,r=rand();
    let rec=k<6?cell(sheet,ref,String(Math.round(r*1e6)/100)):k<8?text(sheet,ref,'Atlas '+i):fcell(sheet,ref,'A1+B1',String(Math.round(r*1e5)/10));
    if(variant){
      if(i%100===7){rec={...rec,value:rec.value+'1',text:rec.text+'1'};expected++;}
      else if(i%250===11){expected++;continue;}
      else if(i%400===13&&rec.hasFormula){rec={...rec,value:'',cachePresent:false};expected++;}
      else if(i%50===3&&k<6){rec={...rec,value:/\./.test(rec.value)?rec.value+'0':rec.value+'.0'};}
    }
    records.push(rec);
    if(variant&&i%300===5){records.push(cell(sheet,'ZZ'+i,'1'));expected++;}
  }
  return {records,expected};
}
test('a 100,000-record package diffs in well under a second',()=>{
  const b=bigBook(100000,5,false),c=bigBook(100000,5,true);
  assert.ok(b.records.length>=100000);
  const bp=pkg([xdoc('Atlas_Model.xlsx',b.records),csvDoc('Cash_Facts.csv',Array.from({length:10000},(_,i)=>['Label '+i,String(i),'x'])),txtDoc('Facility_Terms.txt',Array.from({length:10000},(_,i)=>'Atlas clause '+i).join('\n'))]);
  const cp=pkg([xdoc('Atlas_Model.xlsx',c.records),csvDoc('Cash_Facts.csv',Array.from({length:10000},(_,i)=>['Label '+i,i===5000?'-1':String(i),'x'])),txtDoc('Facility_Terms.txt',Array.from({length:10000},(_,i)=>i===5000?'Atlas clause edited':'Atlas clause '+i).join('\n'))]);
  let best=Infinity,r;for(let n=0;n<3;n++){const t=process.hrtime.bigint();r=E.diffPackages(bp,cp);best=Math.min(best,Number(process.hrtime.bigint()-t)/1e6);}
  assert.equal(r.documents[0].cells.length,c.expected,'every synthetic edit found and no serialisation variant reported');
  assert.equal(r.documents[1].cells.length,1);assert.deepEqual(r.documents[2].lines.filter(l=>l.op!=='equal').map(l=>l.op),['del','add']);
  assert.equal(r.summary.changedCells,c.expected+1);assert.equal(r.summary.changedDocuments,3);
  assert.ok(best<1000,'best of three took '+best.toFixed(1)+' ms');
  assert.equal(E.diffPackages(bp,bp).summary.changedCells,0);
});

/* ---------- integration with the synthetic illustration packages ---------- */
const bytes=s=>new TextEncoder().encode(s);
async function ingest(files){return E.ingestFiles(Object.entries(files).map(([name,body])=>({name,arrayBuffer:async()=>bytes(body).buffer})));}
const csvText=d=>d.records.map(r=>r.values.join(',')).join('\n')+'\n',lineText=d=>d.records.map(r=>r.text).join('\n')+'\n';
async function sources(key){const p=await H.illustration(key);return {p,files:Object.fromEntries(p.documents.map(d=>[d.name,d.kind==='csv'?csvText(d):lineText(d)]))};}
test('illustration packages: a changed figure, float serialisation, a removed row, a reworded policy line and an added file',async()=>{
  const {p,files}=await sources('cash');
  const cand=await ingest({...files,'Cash_Facts.csv':files['Cash_Facts.csv'].replace('Available facility,1800','Available facility,1800.0').replace('Requested borrowing,2000','Requested borrowing,2500').replace('Total facility,3000\n',''),'Treasury_Procedure.txt':files['Treasury_Procedure.txt'].replace('bank settlement evidence governs','settlement evidence from the bank governs'),'Facility_Terms.txt':'Atlas facility terms, synthetic.\n'});
  const r=E.diffPackages(p,cand),facts=only(r,'Cash_Facts.csv'),policy=only(r,'Treasury_Procedure.txt');
  assert.equal(only(r,'Task_Prompt.txt').status,'changed','re-serialised text bytes differ from the original even though the lines match');
  assert.ok(only(r,'Task_Prompt.txt').lines.every(l=>l.op==='equal'));assert.match(only(r,'Task_Prompt.txt').limits.join(' '),/bytes differ/);
  assert.equal(only(r,'Facility_Terms.txt').status,'added');
  assert.deepEqual(facts.cells.map(c=>[c.locator,c.derivedColumn,c.change,c.before?.value??null,c.after?.value??null]),[['Row 7','A','value','Total facility','Requested borrowing'],['Row 7','B','value','3000','2500'],['Row 8','A','removed','Requested borrowing',null],['Row 8','B','removed','2000',null]],'rows shift after the deletion: positional by design, and the limit says so');
  assert.match(facts.limits.join(' '),/row counts differ \(8 in the base, 7 in the candidate\)/);
  assert.equal(facts.cells.some(c=>/Available facility/.test(c.before?.value||'')),false,'1800 against 1800.0 is no change');
  assert.deepEqual(policy.lines.filter(l=>l.op!=='equal').map(l=>[l.op,l.baseLocator,l.candLocator]),[['del','Line 3',null],['add',null,'Line 3']]);
  assert.equal(r.summary.addedDocuments,1);assert.equal(r.baseFingerprint,p.fingerprint);assert.equal(r.candFingerprint,cand.fingerprint);
  /* every diffed location resolves in its own package by exact locator and hash */
  for(const c of facts.cells){const side=c.after?cand:p,d=side.documents.find(x=>x.id===(c.after?facts.candId:facts.baseId)),hit=E.resolveClause(side,{name:facts.name,sha256:d.sha256,locator:c.locator});assert.ok(hit,c.locator);assert.ok(hit.record.values.includes((c.after||c.before).value));}
});

test('illustration packages: a one-cell figure change in a csv beside an untouched text file',async()=>{
  const {p,files}=await sources('dividend');
  const cand=await ingest({...files,'Trade_Facts.csv':files['Trade_Facts.csv'].replace('Proposed trade shares,3900','Proposed trade shares,4100')});
  const r=E.diffPackages(p,cand);
  assert.deepEqual(r.documents.map(d=>[d.name,d.status]).sort(),[['Lending_Terms.txt','changed'],['Task_Prompt.txt','changed'],['Trade_Facts.csv','changed']],'all three were re-serialised');
  const facts=only(r,'Trade_Facts.csv');assert.deepEqual(facts.cells.map(c=>[c.locator,c.derivedColumn,c.change,c.before.value,c.after.value]),[['Row 6','B','value','3900','4100']]);
  assert.equal(r.summary.changedCells,1);
  const same=E.diffPackages(p,structuredClone(p));assert.deepEqual(same.summary,{changedDocuments:0,addedDocuments:0,removedDocuments:0,changedCells:0});
});

/* ---------- resolveClause ---------- */
test('resolveClause: exact locator equality, so Sheet!A1 never resolves to Sheet!A10',()=>{
  const d=xdoc('Atlas_Model.xlsx',[cell('Sheet','A10','ten'),cell('Sheet','A100','hundred'),cell('Sheet','A1','one'),cell('Sheet','B1','b')]),p=pkg([d]);
  assert.equal(E.resolveClause(p,{documentId:d.id,locator:'Sheet!A1'}).record.value,'one');
  assert.equal(E.resolveClause(p,{documentId:d.id,locator:'Sheet!A10'}).record.value,'ten');
  assert.equal(E.resolveClause(p,{documentId:d.id,locator:'Sheet!A100'}).record.value,'hundred');
  const noOne=pkg([xdoc('Atlas_Model.xlsx',[cell('Sheet','A10','ten'),cell('Sheet','A100','hundred')])]);
  for(const loc of ['Sheet!A1','Sheet!A','Sheet!','Sheet','sheet!a10','Sheet!A10 ','Sheet!A1:A10','Sheet!A1;A10'])assert.equal(E.resolveClause(noOne,{name:'Atlas_Model.xlsx',locator:loc}),null,loc);
  const rows=pkg([csvDoc('Cash_Facts.csv',Array.from({length:12},(_,i)=>['r'+(i+1)]))]);
  assert.equal(E.resolveClause(rows,{name:'Cash_Facts.csv',locator:'Row 1'}).record.values[0],'r1');assert.equal(E.resolveClause(rows,{name:'Cash_Facts.csv',locator:'Row 12'}).record.values[0],'r12');assert.equal(E.resolveClause(rows,{name:'Cash_Facts.csv',locator:'Row 13'}),null);
});

test('resolveClause: no fallback to the first record or to a similar document, and every identifier given must agree',()=>{
  const a=txtDoc('Atlas/Facility_Terms.txt','First line.\nSecond line.'),b=txtDoc('Meridian/Other.txt','Other.'),p=pkg([a,b]);
  assert.equal(E.resolveClause(p,{name:'Atlas/Facility_Terms.txt',locator:'Line 99'}),null,'an unknown locator is unresolved, not the first record');
  assert.equal(E.resolveClause(p,{documentId:'nope',locator:'Line 1'}),null);assert.equal(E.resolveClause(p,{name:'Facility_Terms.txt',locator:'Line 1'}),null,'a bare tail name is not an exact name');
  assert.equal(E.resolveClause(p,{name:'Atlas/Facility_Terms.txt',locator:'Line 1'}).record.text,'First line.');
  assert.equal(E.resolveClause(p,{documentId:a.id,name:'Atlas/Facility_Terms.txt',sha256:a.sha256,locator:'Line 2'}).record.text,'Second line.');
  assert.equal(E.resolveClause(p,{documentId:a.id,name:'Meridian/Other.txt',locator:'Line 1'}),null,'id and name disagree');
  assert.equal(E.resolveClause(p,{documentId:a.id,sha256:b.sha256,locator:'Line 1'}),null,'a stale hash is unresolved');
  assert.equal(E.resolveClause(p,{documentId:a.id,sha256:'0'.repeat(64),locator:'Line 1'}),null);
  assert.equal(E.resolveClause(p,{locator:'Line 1'}),null,'a locator alone names no document');assert.equal(E.resolveClause(p,{sha256:a.sha256,locator:'Line 1'}),null,'a hash alone names no document');
  for(const bad of [null,undefined,'x',{},{name:'Atlas/Facility_Terms.txt'},{name:'Atlas/Facility_Terms.txt',locator:''},{name:'Atlas/Facility_Terms.txt',locator:5},{name:5,locator:'Line 1'},{documentId:{},locator:'Line 1'},{name:'Atlas/Facility_Terms.txt',sha256:7,locator:'Line 1'}])assert.equal(E.resolveClause(p,bad),null,JSON.stringify(bad));
  for(const badPkg of [null,undefined,{},{documents:null},{documents:[null,{records:null}]}])assert.equal(E.resolveClause(badPkg,{name:'x',locator:'Line 1'}),null);
  assert.equal(E.resolveClause(pkg([{...a,records:null}]),{name:a.name,locator:'Line 1'}),null);
  assert.equal(E.resolveClause(p,{documentId:'',name:'Atlas/Facility_Terms.txt',sha256:'',locator:'Line 1'}).document,a,'empty identifiers count as not given');
  assert.equal(E.resolveClause(p,{documentId:null,name:'Atlas/Facility_Terms.txt',locator:'Line 1'}).document,a);
});

test('resolveClause: a locator present in two same-named documents needs a sha256; identical copies stay ambiguous',()=>{
  const one={...txtDoc('Notes.txt','Alpha text.'),id:'n1'},two={...txtDoc('Notes.txt','Beta text.'),id:'n2'},copy={...txtDoc('Notes.txt','Alpha text.'),id:'n3'},long={...txtDoc('Notes.txt','Alpha.\nMore.'),id:'n4'};
  const p=pkg([one,two]);
  assert.equal(E.resolveClause(p,{name:'Notes.txt',locator:'Line 1'}),null,'two documents answer, nothing tells them apart');
  assert.equal(E.resolveClause(p,{name:'Notes.txt',sha256:one.sha256,locator:'Line 1'}).document,one);assert.equal(E.resolveClause(p,{name:'Notes.txt',sha256:two.sha256,locator:'Line 1'}).record.text,'Beta text.');
  assert.equal(E.resolveClause(p,{documentId:'n2',locator:'Line 1'}).document,two,'an id is already unique');
  assert.equal(E.resolveClause(pkg([one,copy]),{name:'Notes.txt',sha256:one.sha256,locator:'Line 1'}),null,'identical bytes under one name cannot be told apart either');
  assert.equal(E.resolveClause(pkg([one,long]),{name:'Notes.txt',locator:'Line 2'}).document,long,'only one of the same-named documents has the locator');
  assert.equal(E.resolveClause(pkg([one,long]),{name:'Notes.txt',locator:'Line 1'}),null);
  assert.equal(E.resolveClause(pkg([{...one,records:[{locator:'Line 1',text:'a'},{locator:'Line 1',text:'b'}]}]),{name:'Notes.txt',locator:'Line 1'}),null,'a locator repeated inside one document is ambiguous too');
});

test('resolveClause: the result carries the document, the record and the citation quote; excerptVerified is a normalised substring test',()=>{
  const d=xdoc('Atlas_Model.xlsx',[text('S','A1','Only \u201Cconfirmed\u201D funded draws\u00A0count \u2014 available credit is not cash.'),fcell('S','B1','A1+1',2)]),p=pkg([d]);
  const hit=E.resolveClause(p,{name:d.name,locator:'S!A1'});
  assert.equal(hit.document,d);assert.equal(hit.record,d.records[0]);assert.equal(hit.quote,E.citation(d,d.records[0]).quote);assert.deepEqual(Object.keys(hit),['document','record','quote'],'no excerptVerified unless an excerpt was passed');
  const check=(excerpt,key='excerpt')=>E.resolveClause(p,{name:d.name,locator:'S!A1',[key]:excerpt}).excerptVerified;
  assert.equal(check('confirmed funded draws count'),false,'the quote marks are still part of the text');
  assert.equal(check('"confirmed" funded draws count'),true,'curly quotes, a no-break space and case are normalised');
  assert.equal(check('ONLY   \u201Cconfirmed\u201D\nfunded DRAWS count - available credit'),true,'case, runs of whitespace and dashes are normalised');
  assert.equal(check('available credit is cash'),false);assert.equal(check('credit is not cash. and more'),false,'the excerpt may not be longer than the text');
  assert.equal(check(''),undefined,'an empty excerpt is nothing to verify, not a failed check');assert.equal(check('   '),undefined);assert.equal(check('\u00A0\n'),undefined);
  assert.equal(check('not cash','quote'),true,'quote is accepted as the excerpt');assert.equal(E.resolveClause(p,{name:d.name,locator:'S!A1',excerpt:'zzz',quote:'not cash'}).excerptVerified,false,'excerpt wins over quote');
  assert.equal(E.resolveClause(p,{name:d.name,locator:'S!B1',excerpt:'A1+1'}).excerptVerified,true,'a formula record verifies against its formula text');
  assert.equal(E.resolveClause(p,{name:d.name,locator:'S!A1',excerpt:null}).excerptVerified,undefined);
  const longText='Atlas '.repeat(300)+'TAILMARK',lp=pkg([txtDoc('Long.txt',longText)]);
  const lh=E.resolveClause(lp,{name:'Long.txt',locator:'Line 1',excerpt:'TAILMARK'});assert.equal(lh.quote.length,1200);assert.ok(!lh.quote.includes('TAILMARK'));assert.equal(lh.excerptVerified,true,'verification reads the whole record, not the 1200 character quote');
});

test('resolveClause does not modify the package and tolerates frozen input',()=>{
  const deepFreeze=o=>{if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.freeze(o);Object.values(o).forEach(deepFreeze);}return o;};
  const p=deepFreeze(pkg([txtDoc('Atlas_Terms.txt','Atlas line.')])),ref=deepFreeze({name:'Atlas_Terms.txt',locator:'Line 1',excerpt:'atlas'});
  assert.equal(E.resolveClause(p,ref).excerptVerified,true);
});

/* ---------- the browser build ---------- */
test('the browser build exposes the same two functions on FinancePackageEngine and they run without a DOM',()=>{
  const context=vm.createContext({TextDecoder,TextEncoder});vm.runInContext(fs.readFileSync(__dirname+'/../package-engine.js','utf8'),context);
  const B=context.FinancePackageEngine;assert.equal(typeof B.diffPackages,'function');assert.equal(typeof B.resolveClause,'function');
  const b=pkg([txtDoc('A.txt','one\ntwo')]),c=pkg([txtDoc('A.txt','one\nthree')]);
  const r=B.diffPackages(structuredClone(b),structuredClone(c));assert.deepEqual(JSON.parse(JSON.stringify(r)),JSON.parse(JSON.stringify(E.diffPackages(b,c))));
  assert.equal(B.resolveClause(structuredClone(b),{name:'A.txt',locator:'Line 2'}).record.text,'two');
});

test('existing exports are untouched',()=>{
  for(const k of ['ENGINE_VERSION','LIMITS','readZip','crc32','sha256','parseCsv','parseDocument','ingestFiles','inferRole','classifyPath','WITHHELD_ROLES','GAF_PATTERN','detectedFacts','analyzePackage','validatePackage','validateAnalysisRuns','citation','adapterBoundary'])assert.ok(k in E,k);
  assert.equal(E.ENGINE_VERSION,'2.0.0');
});
