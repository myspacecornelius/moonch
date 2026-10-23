/* Offline extraction and deterministic package checks. No model, network, or workbook execution. */
(function(scope){
  'use strict';
  const ENGINE_VERSION='2.0.0';
  const LIMITS={fileBytes:50*1024*1024,totalBytes:100*1024*1024,entries:1500,documents:150,records:100000,nesting:3};
  const utf8=new TextDecoder('utf-8');
  const clean=s=>String(s??'').replace(/\u0000/g,'').trim();
  const fail=m=>{throw new Error(m);};
  function safePath(s){const p=String(s).replace(/\\/g,'/');if(p.startsWith('/')||p.split('/').includes('..')||/^[A-Za-z]:/.test(p))fail('Archive contains an unsafe path: '+p);return p;}
  const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  async function sha256(bytes){return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)));}
  let crcTable;
  function crc32(bytes){if(!crcTable){crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});}let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
  async function readZip(input,budget={bytes:0}){
    const bytes=input instanceof Uint8Array?input:new Uint8Array(input);if(bytes.length>LIMITS.fileBytes)fail('Archive exceeds the 50 MB file limit.');const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(v.getUint32(i,true)===0x06054b50){end=i;break;}
    if(end<0)fail('Invalid ZIP: end record missing.');if(v.getUint16(end+4,true)||v.getUint16(end+6,true))fail('Multi-disk ZIP archives are not supported.');const count=v.getUint16(end+10,true),offset=v.getUint32(end+16,true);if(count===65535||offset===0xffffffff)fail('ZIP64 archives are not supported.');if(count>LIMITS.entries)fail('Too many archive entries.');
    const entries=new Map();let cursor=offset;
    for(let i=0;i<count;i++){
      if(cursor+46>bytes.length||v.getUint32(cursor,true)!==0x02014b50)fail('Invalid ZIP directory.');const flags=v.getUint16(cursor+8,true),method=v.getUint16(cursor+10,true),crc=v.getUint32(cursor+16,true),compressed=v.getUint32(cursor+20,true),size=v.getUint32(cursor+24,true),nlen=v.getUint16(cursor+28,true),extra=v.getUint16(cursor+30,true),comment=v.getUint16(cursor+32,true),local=v.getUint32(cursor+42,true);
      if(cursor+46+nlen+extra+comment>bytes.length)fail('Truncated ZIP directory.');const name=safePath(utf8.decode(bytes.subarray(cursor+46,cursor+46+nlen)));cursor+=46+nlen+extra+comment;
      if(name.endsWith('/'))continue;if(flags&1)fail('Encrypted archives cannot be read locally.');if(![0,8].includes(method))fail('Unsupported ZIP compression for '+name);if(entries.has(name))fail('Duplicate ZIP entry: '+name);if(size>LIMITS.fileBytes||budget.bytes+size>LIMITS.totalBytes)fail('Expanded package exceeds the 100 MB limit.');
      if(local+30>bytes.length||v.getUint32(local,true)!==0x04034b50)fail('Invalid ZIP local entry.');const start=local+30+v.getUint16(local+26,true)+v.getUint16(local+28,true);if(start+compressed>bytes.length)fail('Truncated ZIP entry.');
      entries.set(name,{name,size,crc,method,start,compressed});budget.bytes+=size;
    }
    async function get(name){const e=entries.get(name);if(!e)return null;const raw=bytes.subarray(e.start,e.start+e.compressed);let result;
      if(e.method===0)result=raw.slice();else{
        let stream;try{stream=new DecompressionStream('deflate-raw');}catch{fail('This browser does not support local ZIP decompression. Use a current browser or load plain text files.');}
        const reader=new Blob([raw]).stream().pipeThrough(stream).getReader(),parts=[];let length=0;
        for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>e.size||length>LIMITS.fileBytes){await reader.cancel();fail('ZIP expansion exceeded its declared size.');}parts.push(value);}
        result=new Uint8Array(length);let n=0;for(const part of parts){result.set(part,n);n+=part.length;}
      }
      if(result.length!==e.size||crc32(result)!==e.crc)fail('ZIP size or checksum mismatch: '+name);return result;
    }
    return {entries,get,text:async name=>{const b=await get(name);return b?utf8.decode(b):null;}};
  }
  /* A stored (uncompressed) ZIP with UTF-8 names and a fixed 1980-01-01 timestamp, so the same files always give the same bytes. */
  function writeZip(files){
    if(files.length>LIMITS.entries)fail('Too many files for one archive.');
    const enc=new TextEncoder(),parts=[],central=[];let offset=0,total=0;
    for(const f of files){
      const name=enc.encode(f.name),data=f.bytes instanceof Uint8Array?f.bytes:new Uint8Array(f.bytes),crc=crc32(data);total+=data.length;if(total>LIMITS.totalBytes)fail('The archive would exceed 100 MB.');
      const local=new DataView(new ArrayBuffer(30));[[0,0x04034b50,4],[4,20],[6,0x0800],[12,0x21],[14,crc,4],[18,data.length,4],[22,data.length,4],[26,name.length]].forEach(([at,v,n])=>n===4?local.setUint32(at,v,true):local.setUint16(at,v,true));
      const cd=new DataView(new ArrayBuffer(46));[[0,0x02014b50,4],[4,20],[6,20],[8,0x0800],[14,0x21],[16,crc,4],[20,data.length,4],[24,data.length,4],[28,name.length],[42,offset,4]].forEach(([at,v,n])=>n===4?cd.setUint32(at,v,true):cd.setUint16(at,v,true));
      parts.push(new Uint8Array(local.buffer),name,data);central.push(new Uint8Array(cd.buffer),name);offset+=30+name.length+data.length;
    }
    const size=central.reduce((n,x)=>n+x.length,0),end=new DataView(new ArrayBuffer(22));end.setUint32(0,0x06054b50,true);end.setUint16(8,files.length,true);end.setUint16(10,files.length,true);end.setUint32(12,size,true);end.setUint32(16,offset,true);
    const all=[...parts,...central,new Uint8Array(end.buffer)],out=new Uint8Array(all.reduce((n,x)=>n+x.length,0));let at=0;for(const x of all){out.set(x,at);at+=x.length;}return out;
  }
  /* The upload pack, in the card layout of the platform's task form: the prompt text (card 1.2), the new input files (1.3), the
     answer files (1.4 Response Files) and the grader guidance (1.4 Response Text), with an upload README and a SHA-256 manifest.
     Files are copied byte for byte and their properties are not rewritten, because pilots must run on the bytes that ship; the
     upload checks on Overview flag properties to scrub. It refuses what the form refuses or what must never be resent. */
  const PACK_ANSWER_TYPES=/\.(?:xlsx|xlsm|docx|pptx|pdf)$/i;
  async function buildUploadPack({folder,prompt,guidance,inputs=[],answers=[],promptBlockers=[],now}={}){
    const base=(String(folder??'').replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,80))||'upload_pack',leaf=f=>String(f?.name??'').split('/').pop();
    const promptText=String(prompt??'').trim(),guidanceText=String(guidance??'').replace(/\s+$/,'');
    if(!promptText)fail('Write the business prompt before building the upload pack.');if(!guidanceText.trim())fail('Write the grader guidance before building the upload pack.');if(!answers.length)fail('Add the answer file before building the upload pack.');
    const blocked=(Array.isArray(promptBlockers)?promptBlockers:[]).map(b=>String(b?.message??b).trim()).filter(Boolean);if(blocked.length)fail('The business prompt has '+blocked.length+' blocker'+(blocked.length>1?'s':'')+' and is not packed: '+blocked.join(' ')+' Fix '+(blocked.length>1?'them':'it')+' in the Workspace first.');
    const files=[...inputs.map(f=>({card:'1.3',name:leaf(f),bytes:f.bytes})),...answers.map(f=>({card:'1.4',name:leaf(f),bytes:f.bytes}))];
    const spaced=files.filter(f=>/\s/.test(f.name));if(spaced.length)fail('The platform refuses a file name with a space: '+spaced.map(f=>f.name).join('; ')+'. Rename it with underscores.');
    const seen=new Set();for(const f of files){if(!f.name)fail('A file has no name.');const k=f.name.toLowerCase();if(seen.has(k))fail('Two files share the name '+f.name+'.');seen.add(k);}
    const gaf=inputs.filter(f=>GAF_PATTERN.test(String(f?.name??'')));if(gaf.length)fail('A gaf file is the parent\'s and is never resent: '+gaf.map(leaf).join('; ')+'.');
    const withheld=inputs.map(f=>[leaf(f),classifyPath(leaf(f))]).filter(([,c])=>WITHHELD_ROLES.includes(c.role));if(withheld.length)fail('An input file reaches the solver, but its name marks it as withheld material: '+withheld.map(([n,c])=>n+' ('+c.reason.replace(/^Withheld by default: /,'').replace(/\.$/,'')+')').join('; ')+'. Rename it if it is an ordinary source file; otherwise leave it out of the pack.');
    const notOffice=answers.map(leaf).filter(n=>!PACK_ANSWER_TYPES.test(n));if(notOffice.length)fail('An answer file must be Excel, Word, PowerPoint or PDF: '+notOffice.join('; ')+'.');
    const warnings=[];
    for(const n of answers.map(leaf)){if(pathWords(n.replace(/\.[^.]+$/,'')).some(w=>ANSWER_NAME_WORDS.has(w))||/(?:^|[_-])v\d+(?=[_.-]|$)/i.test(n))warnings.push('Answer file '+n+' breaks the naming rule (company, document type and period; never GAF, SAF, a version, Final, Untitled or Copy).');if(!guidanceText.includes(n))warnings.push('The grader guidance does not name the answer file '+n+' exactly.');}
    if(/\b[\w-]+\.(?:xlsx|xlsm|xls|csv|docx|doc|pdf|pptx|ppt|txt|zip)\b/i.test(promptText))warnings.push('The prompt names a file; the project guide does not allow file names in the prompt.');
    const enc=new TextEncoder(),words=t=>t.trim().split(/\s+/).filter(Boolean).length;
    const entries=[{path:'1.2_prompt.txt',bytes:enc.encode(promptText+'\n')},...files.map(f=>({path:(f.card==='1.3'?'1.3_new_input_files/':'1.4_answer_file_ResponseFiles/')+f.name,bytes:f.bytes instanceof Uint8Array?f.bytes:new Uint8Array(f.bytes)})),{path:'1.4_grader_guidelines_ResponseText.txt',bytes:enc.encode(guidanceText+'\n')}];
    const list=card=>files.filter(f=>f.card===card).map(f=>'    - '+f.name+'   ('+(f.bytes.byteLength??f.bytes.length)+' bytes)').join('\n');
    const readme=['UPLOAD PACK: '+base,'Built '+(now||new Date().toISOString()).slice(0,10)+'. Every file here is NEW material for the task. The task already holds its original input files and its gaf folder: leave them exactly as they are.','',
      'Card 1.2, the prompt: paste the full text of 1.2_prompt.txt as one paragraph, with no heading and no extra line breaks ('+promptText.length+' characters, '+words(promptText)+' words).','',
      'Card 1.3, input files: upload each file in 1.3_new_input_files at the top level, next to the original files, one at a time. Do not upload into the gaf folder.',list('1.3')||'    (none)','',
      'Card 1.4, Response Files: upload each file in 1.4_answer_file_ResponseFiles. An answer file never goes to card 1.3.',list('1.4'),'',
      'Card 1.4, Response Text: paste the full text of 1.4_grader_guidelines_ResponseText.txt, keeping the blank lines between sections ('+guidanceText.length+' characters).','',
      'Then save, reload, and check that every card still holds what was pasted or uploaded. Do not open and re-save a Word or Excel file before uploading: that rewrites its bytes and its document properties. manifest_sha256.txt lists a checksum for every file.','',
      'Checks when the pack was built:',...(warnings.length?warnings.map(w=>'  - '+w):['  - none']),''].join('\n');
    entries.push({path:'README_UPLOAD.txt',bytes:enc.encode(readme)});
    const manifest=[];for(const e of entries)manifest.push((await sha256(e.bytes))+'  '+e.bytes.length+'  '+e.path);entries.push({path:'manifest_sha256.txt',bytes:enc.encode(manifest.join('\n')+'\n')});
    return {name:base+'_upload_pack_PRIVATE.zip',bytes:writeZip(entries.map(e=>({name:base+'/'+e.path,bytes:e.bytes}))),files:entries.map(e=>({path:base+'/'+e.path,bytes:e.bytes.length})),warnings};
  }
  function xml(text,name){if(!text)fail('Missing XML part: '+name);if(/<!DOCTYPE|<!ENTITY/i.test(text))fail('Unsupported XML entity declarations.');if(typeof DOMParser==='undefined')fail('XML extraction requires the browser parser. The analysis engine itself can run in Node.');const d=new DOMParser().parseFromString(text,'application/xml');if(d.getElementsByTagName('parsererror').length)fail('Malformed XML: '+name);return d;}
  const nodes=(el,name)=>Array.from(el.getElementsByTagNameNS('*',name));
  const textOf=el=>nodes(el,'t').map(x=>x.textContent).join('');
  const child=(el,name)=>Array.from(el.children).find(x=>x.localName===name);
  function partPath(base,target){if(target.startsWith('/'))return safePath(target.slice(1));const parts=base.split('/').slice(0,-1);for(const t of target.split('/')){if(t==='..')parts.pop();else if(t&&t!=='.')parts.push(t);}return safePath(parts.join('/'));}
  /* Role of a file from its relative path. One rule for the browser and the local companion (backend/agents/pilot-folder.cjs,
     backend/agents/constants.cjs). Folder conventions first: a grader/, evaluator/, reference/, answers/ or private/ folder is
     withheld; a gaf/ folder is the solver-visible template. Then whole words only (split on punctuation, spaces, camel case and
     digits). Grading words fail closed; run and audit hints need context, so runway, run-rate, rerun, analysis and audit
     committee stay sources. Every withheld role carries a reason. */
  const WITHHELD_ROLES=Object.freeze(['evaluator','run-evidence','audit']);
  const words=s=>new Set(s.split(' '));
  const WITHHELD_FOLDERS=words('grader graders grading evaluator evaluators reference references answer answers private');
  const GRADING_WORDS=words('guideline guidelines guidance grading grader graders rubric rubrics solution solutions expected answer answers golden gold reference references memo memos evaluator evaluators fingerprint fingerprints attestation attestations private');
  const GRADING_AFFIXES=words('key keys note notes sheet guide response responses output outputs standard model sample final set'); /* run-together names: answerkey, goldenresponse */
  const RUN_WORDS=words('run runs batch batches'),RUN_ACTORS=words('pilot pilots agent agents solver harness eval');
  const RUN_EVIDENCE=words('log logs record records transcript transcripts receipt receipts trace traces output outputs result results score scores'),RUN_FILES=words('id ids json jsonl');
  const AUDIT_WORDS=words('review reviews audit audits candidate candidates');
  const ORDINARY_AFTER_AUDIT=words('committee committees opinion opinions fee fees trail trails'),ORDINARY_BEFORE_REVIEW=words('credit loan annual quarterly portfolio business');
  /* A gaf file: gaf as a word of the path, after the start, a slash, an underscore, a space or a dash, and before a slash,
     an underscore, a dot, a space, a dash or the end (gaf/x.csv, gaf-hedge.csv, GAF_notes.txt; not gafHedge.csv, gaf2024.xlsx
     or x.gaf.csv). One pattern for the template role here, the companion's gaf setting (backend/agents/pilot-folder.cjs) and
     the page's gaf toggle (agents.js isGaf), so a file the role table calls a gaf template is always one the toggle hides. */
  const GAF_PATTERN=/(?:^|[/_ -])gaf(?:[/_. -]|$)/i;
  function pathWords(name){return String(name??'').replace(/(\p{Ll})(\p{Lu})/gu,'$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu,'$1 $2').replace(/(\p{L})(\p{N})/gu,'$1 $2').replace(/(\p{N})(\p{L})/gu,'$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);}
  /* Guideline and guidance also name ordinary business documents (investment guidelines, revenue guidance). They mark grading
     material in a plain-text or markdown file, and in an Office or PDF file unless its own name (never a folder name) carries a
     content word besides them: single letters, digits, version words (v2, final, draft, copy, rev, updated) and grading-adjacent words
     (key, scoring, grader, answer, rubric, instructions, ...) do not count, so Guidelines_Key.docx, Guidelines_v2.docx, Scoring_Guidelines.pdf
     and inputs/Guidelines.docx stay withheld while Lending_Guidelines.pdf is a source. A word beside another grading word is caught on its own. */
  const SOFT_GRADING_WORDS=words('guideline guidelines guidance');
  const NOT_CONTENT_WORDS=words('draft final copy rev revised updated key keys scoring score scores evaluation evaluator marking mark marks grader grading rubric answer response responses solution reference gold golden criteria review reviews instruction instructions task tasks sheet sheets set sets');
  function businessDocument(name){const m=String(name??'').split('/').pop().match(/^(.*)\.(?:docx?|docm|pdf|xlsx?|xlsm|pptx?)$/i);return !!m&&pathWords(m[1]).some(w=>w.length>1&&!/^\d+$/.test(w)&&!SOFT_GRADING_WORDS.has(w)&&!NOT_CONTENT_WORDS.has(w));}
  function gradingWord(w){if(GRADING_WORDS.has(w))return w;for(let i=2;i<=w.length-2;i++){const a=w.slice(0,i),b=w.slice(i);if(GRADING_WORDS.has(a)&&(GRADING_WORDS.has(b)||GRADING_AFFIXES.has(b)))return a;if(GRADING_AFFIXES.has(a)&&GRADING_WORDS.has(b))return b;}return '';}
  function runPhrase(t){for(let i=0;i<t.length;i++){const w=t[i],prev=t[i-1]||'',next=t[i+1]||'';if(w==='trajectory'||w==='trajectories')return w;if(RUN_WORDS.has(w)&&/^\d{1,3}$/.test(next))return w+' '+next;if((w==='run'||w==='runs')&&(RUN_EVIDENCE.has(next)||RUN_FILES.has(next)))return w+' '+next;if((w==='run'||w==='runs')&&RUN_ACTORS.has(prev))return prev+' '+w;if(RUN_ACTORS.has(w)&&RUN_EVIDENCE.has(next))return w+' '+next;}return '';}
  function auditWord(t){for(let i=0;i<t.length;i++){const w=t[i];if(!AUDIT_WORDS.has(w))continue;if(/^audits?$/.test(w)&&ORDINARY_AFTER_AUDIT.has(t[i+1]))continue;if(/^reviews?$/.test(w)&&ORDINARY_BEFORE_REVIEW.has(t[i-1]))continue;return w;}return '';}
  function classifyPath(name){
    const withheld=(role,reason)=>({role,withheld:true,reason:'Withheld by default: '+reason}),kept=role=>({role,withheld:false,reason:''});
    const folders=String(name??'').split('/').slice(0,-1).map(s=>s.replace(/^ +| +$/g,'').toLowerCase()),folder=folders.find(s=>WITHHELD_FOLDERS.has(s));
    if(folder)return withheld('evaluator','it is under '+folder+'/, a folder that by convention holds grading or private material.');
    if(folders.includes('gaf'))return kept('template');
    const t=pathWords(name);let hit;
    const document=businessDocument(name);
    if((hit=t.map(gradingWord).find(w=>w&&!(document&&SOFT_GRADING_WORDS.has(w)))))return withheld('evaluator','the name contains the word "'+hit+'", which usually marks grading or private material.');
    if(GAF_PATTERN.test(String(name??''))||t.some(w=>w==='template'||w==='templates'))return kept('template');
    if(t.some((w,i)=>/^(?:prompts?|instructions?)$/.test(w)||w==='task'&&t[i+1]==='request'))return kept('prompt');
    if((hit=runPhrase(t)))return withheld('run-evidence','"'+hit+'" looks like evidence from an earlier run.');
    if((hit=auditWord(t)))return withheld('audit','"'+hit+'" looks like a review or audit of the task, not a solver file.');
    return kept('source');
  }
  function inferRole(name){return classifyPath(name).role;}
  function record(locator,text,extra={}){return {locator,text:clean(text),...extra};}
  /* Who an Office file says made it, and its comments: the core and app properties, comment authors and comment text. Kept as
     metadata for the upload checks in analyzePackage, never as extracted records. A missing or unreadable part is skipped, because
     a file without one is the clean case. */
  async function officeMeta(z){
    const properties={},comments=[],attr=(el,name)=>Array.from(el.attributes).find(a=>a.localName===name)?.value||'';
    const part=async name=>{try{const t=await z.text(name);return t?xml(t,name):null;}catch{return null;}};
    const core=await part('docProps/core.xml');if(core)for(const tag of ['creator','lastModifiedBy','title','subject','keywords','description','revision']){const v=clean(nodes(core,tag)[0]?.textContent);if(v)properties[tag]=v;}
    const app=await part('docProps/app.xml');if(app)for(const tag of ['Company','Manager','Template']){const v=clean(nodes(app,tag)[0]?.textContent);if(v)properties[tag[0].toLowerCase()+tag.slice(1)]=v;}
    const people=await part('xl/persons/person.xml'),person=new Map(people?nodes(people,'person').map(x=>[attr(x,'id'),clean(attr(x,'displayName'))]):[]);
    for(const name of z.entries.keys()){
      if(name==='word/comments.xml'){const d=await part(name);if(d)nodes(d,'comment').forEach((c,i)=>comments.push({author:clean(attr(c,'author')),locator:'Comment '+(i+1),text:clean(textOf(c))}));}
      else if(/^xl\/comments\d*\.xml$/.test(name)){const d=await part(name);if(d){const authors=nodes(d,'author').map(a=>clean(a.textContent));nodes(d,'comment').forEach(c=>comments.push({author:authors[Number(attr(c,'authorId'))]||'',locator:'Note '+attr(c,'ref'),text:clean(textOf(c))}));}}
      else if(/^xl\/threadedComments\/threadedComment\d*\.xml$/.test(name)){const d=await part(name);if(d)nodes(d,'threadedComment').forEach(c=>comments.push({author:person.get(attr(c,'personId'))||'',locator:'Comment '+attr(c,'ref'),text:clean(nodes(c,'text')[0]?.textContent)}));}
    }
    return {properties,comments:comments.slice(0,500)};
  }
  async function parseXlsx(bytes,name,budget){const z=await readZip(bytes,budget),book=xml(await z.text('xl/workbook.xml'),'workbook'),rels=xml(await z.text('xl/_rels/workbook.xml.rels'),'workbook relationships'),relMap={};nodes(rels,'Relationship').forEach(x=>{if(x.getAttribute('TargetMode')!=='External')relMap[x.getAttribute('Id')]=partPath('xl/workbook.xml',x.getAttribute('Target'));});
    const ss=await z.text('xl/sharedStrings.xml'),strings=ss?nodes(xml(ss,'shared strings'),'si').map(textOf):[];
    const records=[],sheets=[],definedNames=nodes(book,'definedName').map(x=>({name:x.getAttribute('name'),ref:x.textContent}));let formulas=0,missingCaches=0;
    for(const sh of nodes(book,'sheet')){
      const sheetName=sh.getAttribute('name'),rid=sh.getAttribute('r:id')||Array.from(sh.attributes).find(a=>a.localName==='id')?.value,part=relMap[rid];if(!part)fail('Missing worksheet relationship: '+sheetName);const d=xml(await z.text(part),part),cells=[];
      for(const c of nodes(d,'c')){const ref=c.getAttribute('r'),type=c.getAttribute('t')||'n',f=child(c,'f'),v=child(c,'v');let value=type==='inlineStr'?textOf(c):v?.textContent??'';if(type==='s')value=strings[Number(value)]??'';if(value===''&&!f)continue;
        const formula=f?.textContent??'',hasFormula=!!f;if(hasFormula){formulas++;if(!v||v.textContent==='')missingCaches++;}const r=record(sheetName+'!'+ref,hasFormula?'='+formula+' [cached: '+(value===''?'missing':value)+']':value,{sheet:sheetName,cell:ref,value,type,formula,hasFormula,formulaType:f?.getAttribute('t')||'',cachePresent:!!v&&v.textContent!=='',hidden:sh.getAttribute('state')==='hidden'||sh.getAttribute('state')==='veryHidden'});records.push(r);cells.push(r);if(records.length>LIMITS.records)fail('Workbook exceeds the 100,000 populated-cell limit.');
      }
      const byRow=new Map();for(const c of cells){const row=c.cell?.match(/\d+$/)?.[0];if(!byRow.has(row))byRow.set(row,[]);byRow.get(row).push(c);}for(const row of byRow.values()){const context=row.filter(c=>!c.hasFormula&&c.type!=='n').map(c=>c.value).filter(Boolean).slice(0,4).join(' · ');row.forEach(c=>c.context=context);}
      sheets.push({name:sheetName,state:sh.getAttribute('state')||'visible',populatedCells:cells.length});
    }
    const calc=nodes(book,'calcPr')[0],office=await officeMeta(z);return {kind:'xlsx',records,metadata:{...office,sheets,formulas,missingCaches,definedNames,externalLinks:[...z.entries.keys()].filter(x=>/^xl\/externalLinks\/externalLink\d+\.xml$/.test(x)).length,calculationSettings:calc?Object.fromEntries(Array.from(calc.attributes).map(a=>[a.name,a.value])):{},recalculated:false},warnings:['Formula values are saved workbook caches. This browser does not recalculate Excel formulas.']};
  }
  async function parseDocx(bytes,name,budget){const z=await readZip(bytes,budget),d=xml(await z.text('word/document.xml'),'document'),records=[];let p=0,table=0;const body=nodes(d,'body')[0];if(!body)fail('DOCX body is missing.');
    for(const element of body.children){if(element.localName==='p'){p++;const t=textOf(element);if(clean(t))records.push(record('Paragraph '+p,t));}else if(element.localName==='tbl'){table++;let row=0;for(const tr of Array.from(element.children).filter(x=>x.localName==='tr')){row++;let col=0;for(const tc of Array.from(tr.children).filter(x=>x.localName==='tc')){col++;records.push(record('Table '+table+', row '+row+', cell '+col,textOf(tc)));}}}}
    const headers=[...z.entries.keys()].filter(n=>/^word\/(header|footer)\d+\.xml$/.test(n));for(const n of headers){const t=textOf(xml(await z.text(n),n));if(clean(t))records.push(record(n,t));}
    for(const [part,label,tag] of [['word/footnotes.xml','Footnote','footnote'],['word/endnotes.xml','Endnote','endnote']]){const x=await z.text(part);if(!x)continue;for(const note of nodes(xml(x,part),tag)){const type=Array.from(note.attributes).find(a=>a.localName==='type')?.value;if(type==='separator'||type==='continuationSeparator'||type==='continuationNotice')continue;const t=textOf(note);if(clean(t))records.push(record(label+' '+(Array.from(note.attributes).find(a=>a.localName==='id')?.value??''),t));}}
    return {kind:'docx',records,metadata:{paragraphs:p,tables:table,...await officeMeta(z)},warnings:['DOCX locations use paragraph/table indices. Page numbers require a rendered document.']};
  }
  function parseCsv(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}if(quoted)fail('CSV contains an unclosed quoted value.');if(cell||row.length){row.push(cell);rows.push(row);}return rows;}
  function parseText(bytes,name){const text=utf8.decode(bytes);if(text.includes('\u0000'))fail('Binary text encoding is not supported. Export UTF-8 text.');const ext=name.split('.').pop().toLowerCase();let records,metadata={};if(ext==='csv'){const rows=parseCsv(text);records=rows.map((row,i)=>record('Row '+(i+1),row.join(' | '),{values:row}));metadata.rows=rows.length;}else if(ext==='json'){const data=JSON.parse(text);metadata.jsonKind=data.kind||null;metadata.schemaVersion=data.schemaVersion||null;records=text.split(/\r?\n/).map((line,i)=>record('Line '+(i+1),line)).filter(r=>r.text);}else if(ext==='html'||ext==='htm'){const d=new DOMParser().parseFromString(text,'text/html');d.querySelectorAll('script,style').forEach(x=>x.remove());records=(d.body.textContent||'').split(/\n/).map((t,i)=>record('Text line '+(i+1),t)).filter(r=>r.text);}else records=text.split(/\r?\n/).map((line,i)=>record('Line '+(i+1),line)).filter(r=>r.text);
    if(records.length>LIMITS.records)fail('Text exceeds the record limit.');return {kind:ext,records,metadata,warnings:[]};
  }
  const textExtensions=new Set(['txt','md','csv','json','html','htm','log','py','js','xml','yaml','yml']);
  async function parseDocument(bytes,name,budget){const ext=name.split('.').pop().toLowerCase();if(ext==='xlsx'||ext==='xlsm')return parseXlsx(bytes,name,budget);if(ext==='docx')return parseDocx(bytes,name,budget);if(textExtensions.has(ext))return parseText(bytes,name);return {kind:ext||'unknown',records:[],metadata:{},warnings:[ext==='pdf'?'PDF extraction is not implemented. Add a text export for analysis.':'This file type is not parsed. It remains in the inventory.'],unsupported:true};}
  async function ingestFiles(files,{onProgress=()=>{}}={}){
    const documents=[],budget={bytes:0};let processed=0;const add=async(bytes,name,depth=0)=>{if(depth>LIMITS.nesting)fail('Nested archive limit exceeded.');if(bytes.length>LIMITS.fileBytes)fail(name+' exceeds the 50 MB file limit.');if(documents.length>=LIMITS.documents)fail('Package exceeds the 150-document limit.');onProgress({phase:'extracting',name,processed,total:files.length});
      if(/\.zip$/i.test(name)){const z=await readZip(bytes,budget);for(const e of z.entries.values()){if(e.name.startsWith('__MACOSX/')||e.name.endsWith('.DS_Store'))continue;await add(await z.get(e.name),name+' / '+e.name,depth+1);}return;}
      const hash=await sha256(bytes),doc={id:'file-'+hash.slice(0,16)+'-'+documents.length,name,bytes:bytes.length,sha256:hash,role:inferRole(name),roleBasis:'Filename heuristic; review the role if needed.',status:'extracted',kind:'',records:[],metadata:{},warnings:[]};
      try{Object.assign(doc,await parseDocument(bytes,name,budget));if(doc.unsupported)doc.status='unsupported';}catch(error){doc.status='error';doc.warnings=[error.message];}
      documents.push(doc);processed++;onProgress({phase:'extracted',name,processed,records:doc.records.length});await new Promise(resolve=>setTimeout(resolve,0));
    };
    for(const file of files)await add(new Uint8Array(await file.arrayBuffer()),safePath(file.webkitRelativePath||file.name));
    const fingerprint=await sha256(new TextEncoder().encode(documents.map(d=>d.name+'\0'+d.sha256).sort().join('\n')));return {schemaVersion:1,kind:'finance-task-package',id:'package-'+fingerprint.slice(0,16),title:files.length===1?files[0].name:'Imported task package',fingerprint,importedAt:new Date().toISOString(),documents,provenance:'Extracted locally from files selected by the user.',extractionVersion:ENGINE_VERSION};
  }
  function citation(doc,r){return {documentId:doc.id,file:doc.name,locator:r.locator,quote:r.text.slice(0,1200),sha256:doc.sha256};}
  function detectedFacts(pkg){const facts=[];for(const d of pkg.documents){if(!['source','template','proposal','prompt'].includes(d.role))continue;for(const r of d.records){if(r.hasFormula)continue;const text=[r.context,r.text].filter(Boolean).join(' ');if(!/\d/.test(text)||(!/(?:\$|%|million|shares?|options?|capital|proceeds|price|cap|sale|date|20\d\d|\d\.\d+\s*x\b)/i.test(text)&&d.kind!=='xlsx'))continue;facts.push({id:'fact-'+facts.length,text:text.slice(0,420),kind:d.kind==='xlsx'?'Extracted cell':'Extracted statement',citation:citation(d,r)});if(facts.length>=400)return facts;}}return facts;}
  /* Upload checks. RESIDUE: build wording and generic platform terms that must not reach a solver file (project guide p. 5 and the
     standing residue rule; platform names come from the writer's private terms); an ordinary word can match (a pilot scheme, a value trap), so a hit is a review cue with its citations. TOOLING:
     property values that name a generator, a default account, a path or an e-mail address. ANSWER_NAME_WORDS: words the guide bans
     from an answer file name (pp. 26, 31; the platform's name comes from the private terms). LOOKALIKE: punctuation a rewriting pass leaves behind. */
  const RESIDUE=/\b(?:GAF|SAF|Claude|Anthropic|ChatGPT|LLM|golden|grader|grading|rubric|trap|decoy|variant|pilot|fingerprint|reference answer|answer file|derivative (?:task|\d)|hardened|trajector(?:y|ies))\b/i;
  const TOOLING=/\b(?:python-docx|openpyxl|xlsxwriter|docx4j|apache poi|aspose|libreoffice|openoffice|pandas|microsoft office user|claude|anthropic|chatgpt|openai|administrator|admin|user|author|unknown)\b|[\\/]|@/i;
  const ANSWER_NAME_WORDS=words('gaf saf final untitled copy draft');
  const LOOKALIKE=/[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0\u2009\u202f]/;
  function termsMatcher(terms){const list=(Array.isArray(terms)?terms:[]).filter(t=>typeof t==='string'&&t.trim()).map(t=>t.trim().replace(/[.*+?^${}()|[\]\\/]/g,'\\$&').replace(/\s+/g,'\\s+'));return list.length?new RegExp('(?<![\\p{L}\\p{N}_])(?:'+list.join('|')+')(?![\\p{L}\\p{N}_])','iu'):null;}
  function uploadChecks(pkg,add,privateTerms){
    const base=d=>d.name.split('/').pop().trim(),office=/\.(?:xlsx|xlsm|docx|pptx|pdf)$/i,mine=termsMatcher(privateTerms);
    /* Files that are uploaded: new or changed solver files, and answer files. The gaf/ template is the parent's and is never changed. */
    const uploads=pkg.documents.filter(d=>['source','proposal'].includes(d.role)||d.role==='evaluator'&&office.test(d.name));
    const spaced=uploads.filter(d=>/\s/.test(base(d)));if(spaced.length)add('error','structural','File names with spaces',spaced.map(base).join('; ')+'. The platform refuses an upload whose file name has a space (project guide pp. 38, 41).',[],'Rename these files with underscores before upload.');
    const badAnswer=uploads.filter(d=>d.role==='evaluator'&&(pathWords(base(d).replace(/\.[^.]+$/,'')).some(w=>ANSWER_NAME_WORDS.has(w))||/(?:^|[_\s-])v\d+(?=[_.\s-]|$)/i.test(base(d))||/task[_-]?[0-9a-f]{8,}/i.test(base(d))));
    if(badAnswer.length)add('review','structural','Answer file name breaks the naming rule',badAnswer.map(base).join('; ')+'. Name an answer file by company, document type and period; never GAF, SAF, a version, Final, Untitled, a task id or the platform\'s name (project guide pp. 26, 31).',[],'Rename the answer file and the name the grader guidance gives it.');
    for(const d of pkg.documents.filter(x=>['source','proposal','prompt'].includes(x.role))){
      const meta=d.metadata||{},extra=[...(Array.isArray(meta.comments)?meta.comments:[]),...['title','subject','keywords','description'].filter(k=>meta.properties?.[k]).map(k=>({locator:'Document property '+k,text:meta.properties[k]}))].filter(c=>typeof c?.text==='string'&&c.text);
      const hits=[...d.records,...extra].filter(r=>RESIDUE.test(r.text)||mine?.test(r.text));
      if(hits.length){const terms=[...new Set(hits.flatMap(r=>[...r.text.matchAll(mine?new RegExp(RESIDUE.source+'|'+mine.source,'giu'):new RegExp(RESIDUE.source,'gi'))].map(m=>m[0].toLowerCase())))];add('review','heuristic','Build or platform words in '+d.name,'Matched: '+terms.join(', ')+'. A solver file must not carry build wording (GAF, golden, grader, rubric, trap, decoy, variant, pilot, derivative) or platform terms. An ordinary word can match, so read each citation.',hits.slice(0,8).map(r=>citation(d,r)),'Reword or remove the cited text in a new file; never edit the parent GAF.');}
      const odd=[...d.records,...extra].filter(r=>LOOKALIKE.test(r.text));if(odd.length)add('info','heuristic','Lookalike punctuation in '+d.name,odd.length+' passage'+(odd.length>1?'s':'')+' carry curly quotes, long dashes or non-breaking spaces. These are normal in a document typed in Word; in text produced by a rewriting pass they are a tell.',odd.slice(0,4).map(r=>citation(d,r)));
    }
    const listed=[];for(const d of uploads){
      const props=d.metadata?.properties||{},people=[['creator',props.creator],['lastModifiedBy',props.lastModifiedBy],['company',props.company],['manager',props.manager],['template',/^normal(?:\.dotm)?$/i.test(props.template||'')?'':props.template],...(Array.isArray(d.metadata?.comments)?[...new Set(d.metadata.comments.map(c=>c.author).filter(Boolean))].map(a=>['comment author',a]):[])].filter(([,v])=>typeof v==='string'&&v.trim());
      if(!people.length)continue;const flagged=people.filter(([,v])=>TOOLING.test(v)||mine?.test(v));
      if(flagged.length)add('review','structural','Document properties to scrub in '+d.name,flagged.map(([k,v])=>k+' "'+v+'"').join('; ')+'. Properties and comment authors must carry no personal names or build tooling. Scrub new files only, never the GAF.',[],'Clear the properties in a copy of the file and re-check it.');
      else listed.push(base(d)+': '+people.map(([k,v])=>k+' "'+v+'"').join(', '));
    }
    if(listed.length)add('info','structural',listed.length+' file'+(listed.length>1?'s':'')+' carry author or company properties',listed.slice(0,12).join('; ')+'. Each looks like an in-world name; confirm none is a real person. Files shipped with their properties removed show nothing here.');
  }
  function analyzePackage(pkg,{runId,now,durationMs=0,privateTerms=[]}={}){
    validatePackage(pkg);const findings=[],proposals=[];let serial=0;const add=(severity,kind,title,summary,citations=[],suggestion='')=>{const id='finding-'+(++serial);findings.push({id,severity,kind,title,summary,citations});if(suggestion)proposals.push({id:'proposal-'+serial,findingId:id,title:suggestion,reason:summary,citations,status:'For review; no source file changed'});};
    const sourceDocs=pkg.documents.filter(d=>['source','template','proposal'].includes(d.role)),prompts=pkg.documents.filter(d=>d.role==='prompt');
    for(const d of pkg.documents){if(d.status==='error')add('error','structural','Could not extract '+d.name,d.warnings.join(' '),[],'Resolve the extraction error before relying on this package.');if(d.status==='unsupported')add('review','coverage','Unparsed file: '+d.name,d.warnings.join(' '),[],'Provide a supported text or Office version for analysis.');
      if(d.kind==='xlsx'){const errorCells=d.records.filter(r=>r.type==='e');if(errorCells.length)add('error','structural',errorCells.length+' saved formula error'+(errorCells.length>1?'s':'')+' in '+d.name,'These errors are present in the saved workbook. This pass did not recalculate it.',errorCells.slice(0,8).map(r=>citation(d,r)),'Inspect and recalculate the cited workbook cells.');const missing=d.records.filter(r=>r.hasFormula&&!r.cachePresent);if(missing.length)add('review','coverage',missing.length+' formulas have no saved value','Formula text was extracted, but these cells cannot be treated as recomputed numeric evidence.',missing.slice(0,6).map(r=>citation(d,r)),'Recalculate in a supported spreadsheet engine and retain the resulting artifact.');if(d.metadata.externalLinks)add('review','structural','Workbook depends on external links',d.name+' contains '+d.metadata.externalLinks+' external workbook link part(s). Availability and saved values need review.',[],'Include the linked source or document the fixed-value basis.');}
    }
    if(!prompts.length)add('review','coverage','No task prompt was identified','The filename-based inventory did not identify a solver prompt. Source extraction still completed.',[],'Add the actual prompt or set its role in the file inventory.');
    for(const d of prompts){const named=d.records.filter(r=>/\b[\w-]+\.(?:xlsx|xlsm|xls|csv|docx|doc|pdf|pptx|ppt|txt|zip|json|md)\b/i.test(r.text));if(named.length)add('review','structural','The prompt names a file','The project guide does not allow file names or extensions in the prompt (p. 33); say the material is in the pack.',named.slice(0,3).map(r=>citation(d,r)),'Replace each file name with a plain description of the document.');
      const teaching=d.records.filter(r=>/\b(?:round down|fixed.point|trap|gotcha|use the formula|subtract .*? from|include .*? in the denominator)\b/i.test(r.text));if(teaching.length)add('review','heuristic','Inspect potentially answer-bearing prompt wording','A wording rule matched the cited phrases. This is a review cue, not a verified financial defect. General directions to use supplied documents are allowed.',teaching.slice(0,4).map(r=>citation(d,r)),'Check whether the prompt gives away the governing interpretation.');}
    const hashes=new Map();for(const d of pkg.documents){const group=hashes.get(d.sha256)||[];group.push(d);hashes.set(d.sha256,group);}for(const group of hashes.values())if(group.length>1)add('info','structural','Duplicate file contents',group.map(d=>d.name).join('; ')+'. Identical bytes can be legitimate copies; no contradiction is inferred.');
    const versions=[...new Set(sourceDocs.flatMap(d=>[...d.name.matchAll(/(?:^|[_\s-])v(\d+)(?=[_.\s-]|$)/gi)].map(m=>'v'+m[1])))];if(versions.length>1)add('review','heuristic','Several filename version labels appear',versions.join(', ')+'. Filenames do not prove which terms govern. Historical records may be intentional; compare the authoritative package manifest before changing anything.',[],'Confirm source precedence against the actual receipt and content.');
    const hidden=sourceDocs.flatMap(d=>d.records.filter(r=>r.hidden).map(r=>({d,r})));if(hidden.length)add('review','coverage','Solver package includes hidden worksheet content',hidden.length+' populated cells are on hidden sheets. Inspect visibility and evaluator-only content; hidden does not mean wrong.',hidden.slice(0,4).map(({d,r})=>citation(d,r)),'Review hidden-sheet contents against the intended solver package.');
    uploadChecks(pkg,add,privateTerms);
    const facts=detectedFacts(pkg);return {schemaVersion:1,kind:'deterministic-analysis-run',id:runId||'local-'+new Date().toISOString().replace(/[^0-9]/g,''),startedAt:now||new Date().toISOString(),completedAt:new Date().toISOString(),durationMs,engineVersion:ENGINE_VERSION,packageId:pkg.id,packageFingerprint:pkg.fingerprint,status:'completed',analysisType:'Deterministic local package checks',coverage:{files:pkg.documents.length,extracted:pkg.documents.filter(d=>d.status==='extracted').length,records:pkg.documents.reduce((n,d)=>n+d.records.length,0),formulas:pkg.documents.reduce((n,d)=>n+(d.metadata.formulas||0),0),facts: facts.length},findings,facts,proposals,limits:['No model was called. Keyword matches are review cues, not financial conclusions.','No arbitrary Excel formula recalculation, source-contradiction adjudication, or task-difficulty estimate was performed.','Historical source differences are not assumed to be errors. Correctness requires source precedence and business interpretation.']};
  }
  function validatePackage(p){
    if(!p||p.kind!=='finance-task-package'||p.schemaVersion!==1||!Array.isArray(p.documents)||p.documents.length>LIMITS.documents||typeof p.id!=='string'||typeof p.title!=='string'||!(/^[a-f0-9]{64}$/).test(p.fingerprint))fail('Unsupported package snapshot.');
    const ids=new Set();let count=0;for(const d of p.documents){if(!d||typeof d.id!=='string'||ids.has(d.id)||typeof d.name!=='string'||typeof d.kind!=='string'||!Number.isFinite(d.bytes)||d.bytes<0||!['extracted','error','unsupported'].includes(d.status)||!d.metadata||typeof d.metadata!=='object'||!Array.isArray(d.warnings)||d.warnings.some(x=>typeof x!=='string')||!Array.isArray(d.records)||d.records.length>LIMITS.records)fail('Invalid package document.');ids.add(d.id);if(!/^[a-f0-9]{64}$/.test(d.sha256)||!['source','template','proposal','evaluator','prompt','run-evidence','audit'].includes(d.role))fail('Invalid document hash or role.');count+=d.records.length;if(count>500000)fail('Package snapshot has too many total records.');for(const r of d.records)if(!r||typeof r.text!=='string'||typeof r.locator!=='string')fail('Invalid extracted record.');}return p;
  }
  function validateAnalysisRuns(runs){
    const str=(x)=>typeof x==='string',cit=c=>c&&['documentId','file','locator'].every(k=>str(c[k]));
    if(!Array.isArray(runs)||runs.length>1000)fail('Invalid analysis history.');for(const r of runs){if(!r||r.kind!=='deterministic-analysis-run'||!['id','packageFingerprint','completedAt','analysisType','engineVersion'].every(k=>str(r[k]))||!Number.isFinite(r.durationMs)||r.durationMs<0||!r.coverage||!['files','records','extracted','formulas'].every(k=>Number.isFinite(r.coverage[k])&&r.coverage[k]>=0)||!Array.isArray(r.findings)||r.findings.some(f=>!f||!['id','kind','severity','title','summary'].every(k=>str(f[k]))||!Array.isArray(f.citations)||f.citations.some(c=>!cit(c)))||!Array.isArray(r.facts)||r.facts.some(f=>!f||!str(f.text)||!cit(f.citation))||!Array.isArray(r.proposals)||r.proposals.some(p=>!p||!['title','reason','status'].every(k=>str(p[k])))||!Array.isArray(r.limits)||r.limits.some(x=>!str(x)))fail('Invalid analysis history.');}return runs;
  }
  const adapters=new Map();
  const adapterBoundary={status:()=>adapters.size?{connected:true,names:[...adapters.keys()]}:{connected:false,message:'No model or harness adapter is connected.'},register:adapter=>{if(!adapter||typeof adapter.name!=='string'||typeof adapter.analyze!=='function'||adapter.credentials)fail('Adapters must provide an analysis function without browser-side credentials.');adapters.set(adapter.name,adapter);},run:async(name,pkg)=>{const adapter=adapters.get(name);if(!adapter)fail('No connected analysis adapter. No model run has started.');return adapter.analyze(validatePackage(pkg));}};
  /* Package diff and exact clause lookup. Pure, no DOM. Saved values only: nothing is recalculated and nothing guesses a match.
     Documents pair by exact name, then by a tail name that is unique in both packages; an ambiguous name is never paired.
     xlsx compares by locator (numbers numerically), csv by Row N plus a derived column letter, every other kind by line alignment. */
  const LINE_CAP=5000,DECIMAL=/^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const DIFF_LIMITS=['Formulas are not recalculated: values are the saved workbook caches, so a cell with no saved value is unknown, not zero.','Styles, number formats, comments, merged cells and charts are not compared.','Renamed sheets and renamed files appear as a removal plus an addition.'];
  const hasText=s=>typeof s==='string'&&s!=='',recs=d=>Array.isArray(d?.records)?d.records:[],tailOf=n=>String(n??'').split('/').pop().trim(),plural=(n,w)=>n+' '+w+(n===1?'':'s');
  function decimal(s,digits=Infinity){s=String(s).trim();if(!DECIMAL.test(s))return null;if(digits<Infinity&&s.replace(/[eE].*$/,'').replace(/\D/g,'').replace(/^0+/,'').length>digits)return null;const n=Number(s);return Number.isFinite(n)?n:null;}
  function minus(a,b){const used=new Map();for(const v of b)used.set(v,(used.get(v)||0)+1);return a.filter(v=>{const n=used.get(v)||0;if(n>0){used.set(v,n-1);return false;}return true;});}
  function indexRecords(list){const map=new Map();let dup=0;for(const r of list){const k=String(r.locator);if(map.has(k))dup++;else map.set(k,r);}return {map,dup};}
  function cellSnap(r){const hasFormula=!!r.hasFormula,value=r.value!==undefined&&r.value!==null?String(r.value):hasFormula?'':String(r.text??'');return {value,type:r.type||'n',formula:String(r.formula??''),hasFormula,cachePresent:typeof r.cachePresent==='boolean'?r.cachePresent:value!==''};}
  const typeClass=t=>t==='inlineStr'?'s':t;
  function sameValue(a,b){if(a.value===b.value)return true;if(typeClass(a.type)==='n'&&typeClass(b.type)==='n'){const x=decimal(a.value),y=decimal(b.value);return x!==null&&y!==null&&x===y;}return false;}
  /* One label per changed cell. Order: an edited formula first (it must stand out among cells that merely lost their cache), then a lost cache, then type, then value. */
  function classifyCell(a,b){
    if(a.hasFormula!==b.hasFormula||a.formula!==b.formula)return 'formula';
    if(a.cachePresent!==b.cachePresent)return a.cachePresent?'cache-lost':'value';
    if(!a.cachePresent)return a.value===b.value?null:'value';
    if(typeClass(a.type)!==typeClass(b.type))return 'type';
    return sameValue(a,b)?null:'value';
  }
  function xlsxChange(locator,change,b,c){const r=c||b,i=locator.lastIndexOf('!'),sheet=r.sheet??(i>=0?locator.slice(0,i):undefined),cell=r.cell??(i>=0?locator.slice(i+1):undefined),out={locator};if(sheet!==undefined)out.sheet=sheet;if(cell!==undefined)out.cell=cell;return Object.assign(out,{change,before:b?cellSnap(b):null,after:c?cellSnap(c):null,hidden:!!(b?.hidden||c?.hidden)});}
  function diffCells(bd,cd){
    const bi=indexRecords(recs(bd)),ci=indexRecords(recs(cd)),cells=[];
    for(const [k,b] of bi.map){const c=ci.map.get(k);if(!c){cells.push(xlsxChange(k,'removed',b,null));continue;}
      if(b.value===c.value&&b.text===c.text&&b.type===c.type&&b.formula===c.formula&&!b.hasFormula===!c.hasFormula&&b.cachePresent===c.cachePresent)continue;
      const change=classifyCell(cellSnap(b),cellSnap(c));if(change)cells.push(xlsxChange(k,change,b,c));}
    for(const [k,c] of ci.map)if(!bi.map.has(k))cells.push(xlsxChange(k,'added',null,c));
    return {cells,dup:bi.dup+ci.dup};
  }
  const colLetter=i=>{let s='';for(i++;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;};
  const csvValues=r=>Array.isArray(r.values)?r.values.map(v=>String(v??'')):String(r.text??'').split(' | ');
  const csvSnap=v=>({value:v,type:decimal(v,15)===null?'s':'n',formula:'',hasFormula:false,cachePresent:true});
  function diffCsv(bd,cd){
    const bi=indexRecords(recs(bd)),ci=indexRecords(recs(cd)),cells=[];
    const row=(k,bv,cv)=>{for(let col=0,w=Math.max(bv.length,cv.length);col<w;col++){const x=bv[col]??'',y=cv[col]??'';if(x===y)continue;const nx=decimal(x,15),ny=decimal(y,15),change=x===''?'added':y===''?'removed':nx!==null&&nx===ny?null:'value';
      if(change)cells.push({locator:k,change,before:x===''?null:csvSnap(x),after:y===''?null:csvSnap(y),hidden:false,derivedColumn:colLetter(col)});}};
    for(const [k,b] of bi.map){const c=ci.map.get(k);row(k,csvValues(b),c?csvValues(c):[]);}
    for(const [k,c] of ci.map)if(!bi.map.has(k))row(k,[],csvValues(c));
    return {cells,dup:bi.dup+ci.dup,rows:[bi.map.size,ci.map.size]};
  }
  /* Line alignment. The equal head and tail are trimmed first, so one edit in a long file is exact. The differing middle is aligned
     (longest common subsequence over line ids) only when it is at most LINE_CAP lines on each side; a longer middle is reported as removed
     then added, unmatched. The ops always rebuild both sides: base = equal+del, candidate = equal+add. */
  function diffLines(bd,cd){
    const a=recs(bd),b=recs(cd),at=a.map(r=>String(r.text??'')),bt=b.map(r=>String(r.text??'')),n=a.length,m=b.length,lines=[];
    const loc=(list,i)=>i<0?null:String(list[i].locator??''),op=(o,i,j)=>lines.push({op:o,baseLocator:loc(a,i),candLocator:loc(b,j),before:i<0?null:at[i],after:j<0?null:bt[j]});
    let p=0,s=0;while(p<n&&p<m&&at[p]===bt[p])p++;while(s<n-p&&s<m-p&&at[n-1-s]===bt[m-1-s])s++;
    for(let i=0;i<p;i++)op('equal',i,i);
    const x=n-p-s,y=m-p-s,capped=x>0&&y>0&&(x>LINE_CAP||y>LINE_CAP);
    if(x===0||y===0||capped){for(let i=0;i<x;i++)op('del',p+i,-1);for(let j=0;j<y;j++)op('add',-1,p+j);}
    else{
      const ids=new Map(),id=t=>{let v=ids.get(t);if(v===undefined){v=ids.size;ids.set(t,v);}return v;},A=Int32Array.from(at.slice(p,p+x),id),B=Int32Array.from(bt.slice(p,p+y),id),w=y+1,dp=new Uint16Array((x+1)*w);
      for(let i=x-1;i>=0;i--)for(let j=y-1;j>=0;j--)dp[i*w+j]=A[i]===B[j]?dp[(i+1)*w+j+1]+1:Math.max(dp[(i+1)*w+j],dp[i*w+j+1]);
      for(let i=0,j=0;i<x||j<y;){if(i<x&&j<y&&A[i]===B[j]){op('equal',p+i,p+j);i++;j++;}else if(j>=y||(i<x&&dp[(i+1)*w+j]>=dp[i*w+j+1])){op('del',p+i,-1);i++;}else{op('add',-1,p+j);j++;}}
    }
    for(let k=0;k<s;k++)op('equal',n-s+k,m-s+k);
    return {lines,capped,x,y};
  }
  function diffMeta(bd,cd){
    const index=(list,key)=>{const map=new Map();for(const x of Array.isArray(list)?list:[])if(x&&typeof x[key]==='string'&&!map.has(x[key]))map.set(x[key],x);return map;};
    const info=x=>({state:x.state||'visible',populatedCells:Number.isFinite(x.populatedCells)?x.populatedCells:null}),bs=index(bd.metadata?.sheets,'name'),cs=index(cd.metadata?.sheets,'name'),sheets=[],definedNames=[];
    for(const [name,b] of bs){const c=cs.get(name);if(!c)sheets.push({name,change:'removed',before:info(b),after:null});else if(info(b).state!==info(c).state)sheets.push({name,change:'state',before:info(b),after:info(c)});}
    for(const [name,c] of cs)if(!bs.has(name))sheets.push({name,change:'added',before:null,after:info(c)});
    const names=list=>{const map=new Map();for(const x of Array.isArray(list)?list:[]){if(!x||typeof x.name!=='string')continue;if(!map.has(x.name))map.set(x.name,[]);map.get(x.name).push(String(x.ref??''));}return map;},bn=names(bd.metadata?.definedNames),cn=names(cd.metadata?.definedNames);
    for(const name of new Set([...bn.keys(),...cn.keys()])){const x=bn.get(name)||[],y=cn.get(name)||[],gone=minus(x,y),made=minus(y,x);
      if(gone.length===1&&made.length===1)definedNames.push({name,change:'ref',before:gone[0],after:made[0]});
      else{for(const ref of gone)definedNames.push({name,change:'removed',before:ref,after:null});for(const ref of made)definedNames.push({name,change:'added',before:null,after:ref});}}
    return {sheets,definedNames};
  }
  function matchDocuments(bl,cl){
    const pair=new Map(),cUsed=new Set(),held=new Set(),heldC=new Set(),bNotes=new Map(),cNotes=new Map(),pkgNotes=[];
    const link=(i,j,by)=>{pair.set(i,{j,by});cUsed.add(j);},note=(map,i,text)=>{if(!map.has(i))map.set(i,[]);map.get(i).push(text);};
    const group=(list,key)=>{const map=new Map();list.forEach((d,i)=>{const k=key(d);if(!map.has(k))map.set(k,[]);map.get(k).push(i);});return map;};
    const bn=group(bl,d=>d.name),cn=group(cl,d=>d.name);
    for(const [name,B] of bn){const C=cn.get(name);if(!C)continue;const restB=[],restC=[...C];
      for(const i of B){const k=hasText(bl[i].sha256)?restC.findIndex(j=>cl[j].sha256===bl[i].sha256):-1;if(k>=0)link(i,restC.splice(k,1)[0],'name');else restB.push(i);}
      if(restB.length===1&&restC.length===1)link(restB[0],restC[0],'name');
      else if(restB.length&&restC.length){const text='File name "'+name+'" appears '+plural(B.length,'time')+' in the base package and '+C.length+' in the candidate package and cannot be paired, so those files are reported as removed and added.';pkgNotes.push(text);restB.forEach(i=>{note(bNotes,i,text);held.add(i);});restC.forEach(j=>{note(cNotes,j,text);heldC.add(j);});}}
    const bt=group(bl,d=>tailOf(d.name)),ct=group(cl,d=>tailOf(d.name)),said=new Set();
    bl.forEach((b,i)=>{if(pair.has(i)||held.has(i))return;const k=tailOf(b.name),js=(ct.get(k)||[]).filter(j=>!cUsed.has(j)&&!heldC.has(j));if(!js.length)return;
      if(bt.get(k).length===1&&ct.get(k).length===1){link(i,js[0],'tail');return;}
      const text='File name "'+k+'" appears '+plural(bt.get(k).length,'time')+' in the base package and '+ct.get(k).length+' in the candidate package under different folders, so files with this name are reported as removed and added, not compared.';
      if(!said.has(k)){said.add(k);pkgNotes.push(text);js.forEach(j=>note(cNotes,j,text));}note(bNotes,i,text);});
    const items=bl.map((d,i)=>({i,j:pair.has(i)?pair.get(i).j:-1,by:pair.has(i)?pair.get(i).by:null}));cl.forEach((d,j)=>{if(!cUsed.has(j))items.push({i:-1,j,by:null});});
    return {items,bNotes,cNotes,pkgNotes};
  }
  function diffDocument(b,c,by,notes,agg){
    const d=c||b,out={name:d.name,status:'unchanged',kind:String(c?.kind||b?.kind||''),baseId:b?b.id:null,candId:c?c.id:null,baseSha256:b&&hasText(b.sha256)?b.sha256:null,candSha256:c&&hasText(c.sha256)?c.sha256:null,cells:[],lines:[],metaChanges:{sheets:[],definedNames:[]},limits:[...notes]};
    if(!b||!c){out.status=b?'removed':'added';return out;}
    if(by==='tail'){agg.moved++;out.limits.push('Matched by file name only: base path "'+b.name+'", candidate path "'+c.name+'".');}
    const known=!!(out.baseSha256&&out.candSha256);if(known&&out.baseSha256===out.candSha256)return out;
    const usable=x=>x.status!=='error'&&x.status!=='unsupported',kb=String(b.kind||''),kc=String(c.kind||'');let compared=true;
    if(!usable(b)||!usable(c)){compared=false;agg.hashOnly++;out.limits.push('No text could be extracted from '+(usable(b)?'the candidate':usable(c)?'the base':'either version')+' of this file, so only its hash is compared.');}
    else if(kb!==kc){compared=false;agg.hashOnly++;out.limits.push('The file type differs (base '+(kb||'unknown')+', candidate '+(kc||'unknown')+'), so contents are not compared.');}
    if(compared){
      if(kc==='xlsx'){const r=diffCells(b,c);out.cells=r.cells;out.metaChanges=diffMeta(b,c);out.limits.push(DIFF_LIMITS[0]);
        if(r.dup)out.limits.push('Records sharing a locator with an earlier record were ignored: '+r.dup+'.');
        const lost=r.cells.filter(x=>x.after&&x.after.hasFormula&&!x.after.cachePresent).length;
        if(lost)out.limits.push('Changed formula cells with no saved value in the candidate: '+lost+'. Their values are unknown, not zero.');}
      else if(kc==='csv'){const r=diffCsv(b,c);out.cells=r.cells;
        if(r.dup)out.limits.push('Records sharing a locator with an earlier record were ignored: '+r.dup+'.');
        out.limits.push('Rows compare by row number and columns by position; column letters are derived, not stored in the file.'+(r.rows[0]!==r.rows[1]?' The row counts differ ('+r.rows[0]+' in the base, '+r.rows[1]+' in the candidate), so an inserted or deleted row shifts every later row.':''));}
      else{const r=diffLines(b,c);out.lines=r.lines;
        if(r.capped){const text='Line alignment is limited to '+LINE_CAP+' lines per side: the changed region ('+plural(r.x,'base line')+', '+plural(r.y,'candidate line')+') is shown as removed then added, without matching lines inside it.';out.limits.push(text);agg.capped.push(d.name+': '+text);}}
    }
    const found=out.cells.length>0||out.lines.some(x=>x.op!=='equal')||out.metaChanges.sheets.length>0||out.metaChanges.definedNames.length>0;
    out.status=known||!compared||found?'changed':'unchanged';
    if(out.status==='unchanged')out.lines=[];
    else if(compared&&!found)out.limits.push('The file bytes differ but no extracted text or cell differs; formatting or other content that is not extracted may have changed.');
    return out;
  }
  function diffPackages(base,cand){
    for(const p of [base,cand])if(!p||!Array.isArray(p.documents)||p.documents.some(d=>!d||typeof d.name!=='string'))fail('A package diff needs two task packages whose documents have names.');
    const bl=base.documents,cl=cand.documents,match=matchDocuments(bl,cl),agg={moved:0,hashOnly:0,capped:[]},documents=[],summary={changedDocuments:0,addedDocuments:0,removedDocuments:0,changedCells:0};
    for(const it of match.items){const d=diffDocument(it.i>=0?bl[it.i]:null,it.j>=0?cl[it.j]:null,it.by,[...(match.bNotes.get(it.i)||[]),...(match.cNotes.get(it.j)||[])],agg);documents.push(d);
      if(d.status==='changed')summary.changedDocuments++;else if(d.status==='added')summary.addedDocuments++;else if(d.status==='removed')summary.removedDocuments++;summary.changedCells+=d.cells.length;}
    const limits=[...DIFF_LIMITS,...match.pkgNotes];
    if(agg.moved)limits.push('Files matched by file name only (the folder differs): '+agg.moved+'.');
    if(agg.hashOnly)limits.push('Changed files with no extracted text to compare, or of a different type: '+agg.hashOnly+'. They are compared by hash only.');
    limits.push(...agg.capped);
    return {baseFingerprint:hasText(base.fingerprint)?base.fingerprint:null,candFingerprint:hasText(cand.fingerprint)?cand.fingerprint:null,documents,summary,limits};
  }
  const foldText=s=>String(s??'').normalize('NFKC').replace(/[\u2018\u2019\u201B]/g,"'").replace(/[\u201C\u201D\u201F]/g,'"').replace(/[\u2010-\u2015\u2212]/g,'-').replace(/\s+/g,' ').trim().toLowerCase();
  /* ref = {documentId?|name?, sha256?, locator, excerpt?|quote?}. Every identifier given must match; the locator must be equal, not a prefix. Exactly one
     record may answer: no match, or a locator found in two documents (or twice in one) that the identifiers cannot tell apart, is null. */
  function resolveClause(pkg,ref){
    if(!pkg||!Array.isArray(pkg.documents)||!ref||typeof ref!=='object'||typeof ref.locator!=='string'||ref.locator==='')return null;
    const given=v=>v!==undefined&&v!==null&&v!=='';for(const k of ['documentId','name','sha256'])if(given(ref[k])&&typeof ref[k]!=='string')return null;
    if(!given(ref.documentId)&&!given(ref.name))return null;
    let hit=null,count=0;
    for(const d of pkg.documents){if(!d||(given(ref.documentId)&&d.id!==ref.documentId)||(given(ref.name)&&d.name!==ref.name)||(given(ref.sha256)&&d.sha256!==ref.sha256))continue;
      for(const r of recs(d))if(r&&r.locator===ref.locator){count++;hit={document:d,record:r};}}
    if(count!==1)return null;
    const out={document:hit.document,record:hit.record,quote:String(hit.record.text??'').slice(0,1200)},excerpt=given(ref.excerpt)?ref.excerpt:ref.quote;
    const want=given(excerpt)?foldText(excerpt):'';if(want!=='')out.excerptVerified=foldText(hit.record.text).includes(want);
    return out;
  }
  const api={ENGINE_VERSION,LIMITS,readZip,writeZip,buildUploadPack,crc32,sha256,parseCsv,parseDocument,ingestFiles,inferRole,classifyPath,WITHHELD_ROLES,GAF_PATTERN,detectedFacts,analyzePackage,validatePackage,validateAnalysisRuns,citation,adapterBoundary,diffPackages,resolveClause};if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.FinancePackageEngine=api;
})(typeof window!=='undefined'?window:globalThis);
