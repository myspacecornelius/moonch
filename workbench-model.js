/* Evidence Workbench model. Pure: no DOM, no clock, no network. It reads imported evaluation files, binds each criterion to exact source
   clauses and changed cells, and shapes diff rows for the views. A criterion is `not-met` only when the figure search found no match, an
   explicit token says so, or the writer recorded the verdict; everything else is `unknown`. Text matches are suggestions and never set a
   status. Counts only: no percentage, ratio or rate is computed anywhere in this file. */
(function(scope){'use strict';
  const VERSION='1.0.0';
  const CAP={reasoning:20000,items:200,itemText:4000,result:16000,command:200000,say:200000,messages:20000,json:20000000,quote:1200,range:40,clauseMatches:3,minDigits:3,maxLimit:50};
  const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),arr=v=>Array.isArray(v)?v:[],str=v=>typeof v==='string'?v:'',has=v=>typeof v==='string'&&v!=='';
  const fail=m=>{throw new Error(m);};
  const num=v=>{if(typeof v==='number')return Number.isFinite(v)?v:null;if(typeof v==='string'&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim())){const n=Number(v.trim());return Number.isFinite(n)?n:null;}return null;};
  const cmp=(a,b)=>a<b?-1:a>b?1:0,uniq=a=>[...new Set(a)],slash=s=>String(s??'').replace(/\\/g,'/'),tail=s=>slash(s).split('/').pop().trim();
  const core=()=>{try{return typeof module!=='undefined'&&module.exports?require('./core.js'):scope.FinanceCore||null;}catch{return scope.FinanceCore||null;}};
  const engine=()=>{try{return typeof module!=='undefined'&&module.exports?require('./package-engine.js'):scope.FinancePackageEngine||null;}catch{return scope.FinancePackageEngine||null;}};
  const parseJson=(json,what)=>{if(typeof json!=='string')return json;if(json.length>CAP.json)fail('The '+what+' is larger than 20 MB and was not read.');try{return JSON.parse(json);}catch{fail('The '+what+' is not valid JSON.');}};
  const fnv=s=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h.toString(16).padStart(8,'0');};

  /* ---------- imported evaluation: grading result ---------- */
  const BOLD_HEAD=/^\s*(?:\*\*|__)((?:(?!\*\*|__).)+)(?:\*\*|__)\s*:?\s*$/,BULLET=/^(\s*)(?:[-*\u2022\u00b7\u2013\u2014]|\d{1,3}[.)])\s+(\S.*)$/,GLYPH_LEAD=/^(\s*)([\u2713\u2717\u2714\u2718]\s*\S.*)$/u;
  const EDGE='(?<![\\p{L}\\p{N}_-])',END='(?![\\p{L}\\p{N}_-])';
  const NOT_MET=new RegExp(EDGE+'NOT\\s+MET'+END,'gu'),NOT_TOKEN=new RegExp(EDGE+'FAIL'+END+'|[\\u2717\\u2718]','u'),MET_TOKEN=new RegExp(EDGE+'(?:PASS|MET)'+END+'|[\\u2713\\u2714]','u');
  /* Polarity comes only from an explicit token in the bullet: PASS, FAIL, MET, NOT MET, or a check or cross glyph. Both kinds at once is left unknown. */
  function polarityOf(text){const rest=text.replace(NOT_MET,' '),not=NOT_TOKEN.test(text)||rest!==text,met=MET_TOKEN.test(rest);return met&&!not?'met':not&&!met?'not-met':'unknown';}
  function bulletsOf(reasoning){
    const items=[];let group='',open=null;
    for(const raw of reasoning.split(/\r?\n/)){
      const head=BOLD_HEAD.exec(raw);if(head){group=head[1].trim().replace(/:$/,'').trim();open=null;continue;}
      const b=BULLET.exec(raw)||GLYPH_LEAD.exec(raw)&&[null,GLYPH_LEAD.exec(raw)[1],GLYPH_LEAD.exec(raw)[2]];
      if(b){open={group,text:b[2].trim()};items.push(open);continue;}
      if(open&&/^\s{2,}\S/.test(raw))open.text+=' '+raw.trim();else open=null;
    }
    return items;
  }
  function parseStudioGrading(json){
    const d=parseJson(json,'evaluation result');
    if(!isObj(d))fail('The evaluation result must be a JSON object (a grading results file).');
    if(!Array.isArray(d.grading_runs)||!d.grading_runs.length)fail('This is not an evaluation grading result: grading_runs is missing or empty.');
    const g=d.grading_runs[0],t=d.trajectory_output;
    if(!isObj(g))fail('This is not an evaluation grading result: grading_runs[0] must be an object.');
    if(!isObj(t))fail('This is not an evaluation grading result: trajectory_output is missing.');
    const limits=[],subscores=[];
    for(const reward of arr(t.rewards))if(isObj(reward))for(const s of arr(reward.subscores))if(isObj(s)){let reasoning=str(s.reasoning);if(reasoning.length>CAP.reasoning){reasoning=reasoning.slice(0,CAP.reasoning);limits.push('A reasoning text was cut at '+CAP.reasoning+' characters.');}
      subscores.push({name:str(s.name),score:num(s.score),max:num(s.max_score),weight:num(s.weight),reasoning});}
    const items=[];let capped=false;
    for(const s of subscores)for(const b of bulletsOf(s.reasoning)){if(items.length>=CAP.items){capped=true;continue;}items.push({id:'item-'+(items.length+1),group:b.group,text:b.text.slice(0,CAP.itemText),polarity:polarityOf(b.text)});}
    if(capped)limits.push('Only the first '+CAP.items+' items were kept.');
    const llm=isObj(g.judge)&&isObj(g.judge.llm_model)?g.judge.llm_model:null,judge=llm&&(has(llm.provider)||has(llm.model))?{provider:str(llm.provider),model:str(llm.model)}:null;
    const grade=arr(g.judge_grades).find(isObj),firstReward=arr(t.rewards).find(isObj);
    const problemRunId=[t.problem_run_id,grade&&isObj(grade.verifier_result_values)?grade.verifier_result_values.problem_run_id:'',firstReward?firstReward.problem_run_id:''].find(has)||null;
    const a=num(g.final_score),b=num(t.final_score),finalScore=a!==null?a:b;
    if(a!==null&&b!==null&&a!==b)limits.push('The two final scores in this file differ; the one in grading_runs is used.');
    const maxes=subscores.map(s=>s.max),scoreMax=maxes.length===1&&maxes[0]!==null&&maxes[0]>0?maxes[0]:null;
    if(scoreMax===null)limits.push('The maximum score is not stated unambiguously in this file.');
    return {runId:has(g.grading_run_id)?g.grading_run_id:null,problemRunId,attempt:num(t.attempt_number),scoringMethod:has(g.scoring_method)?g.scoring_method:null,finalScore,scoreMax,judge,status:has(g.grading_run_status)?g.grading_run_status:null,subscores,items,limits:uniq(limits)};
  }
  function normalizeEval(parsed,meta){
    if(!isObj(parsed))fail('normalizeEval needs a parsed evaluation result.');
    const m=isObj(meta)?meta:{},runId=has(parsed.runId)?parsed.runId:null,problem=has(parsed.problemRunId)?parsed.problemRunId:null,attempt=num(parsed.attempt),score=num(parsed.finalScore),scoreMax=num(parsed.scoreMax),sourceName=str(m.sourceName);
    const id='eval-'+(runId||(problem?problem+'-'+(attempt??0):fnv([sourceName,score,scoreMax,attempt,str(m.importedAt)].join('|'))));
    return {id,task:String(m.task??'').trim(),runId,attempt,score,scoreMax,judge:isObj(parsed.judge)?{provider:str(parsed.judge.provider),model:str(parsed.judge.model)}:null,scoringMethod:has(parsed.scoringMethod)?parsed.scoringMethod:null,importedAt:has(m.importedAt)?m.importedAt:null,sourceName};
  }

  /* ---------- imported evaluation: solver messages ---------- */
  const textOf=c=>typeof c==='string'?c:Array.isArray(c)?c.map(p=>typeof p==='string'?p:isObj(p)&&typeof p.text==='string'?p.text:'').filter(Boolean).join('\n'):'';
  const ROLE={assistant:'assistant',tool:'tool',function:'tool',user:'user',system:'system',developer:'system'};
  function callsOf(m,index){
    return arr(m.tool_calls).filter(isObj).map((c,k)=>{const f=isObj(c.function)?c.function:{},raw=typeof f.arguments==='string'?f.arguments:isObj(f.arguments)?JSON.stringify(f.arguments):'';let command=raw;
      if(raw){try{const a=JSON.parse(raw);if(isObj(a)&&typeof a.command==='string')command=a.command;}catch{/* keep the raw arguments */}}
      return {id:has(c.id)?c.id:'',name:str(f.name),command,index:k};});
  }
  function parseStudioMessages(json){
    const all=parseJson(json,'solver messages');
    if(!Array.isArray(all))fail('The solver messages must be a JSON array of messages.');
    const limits=[];let raw=all;if(raw.length>CAP.messages){raw=raw.slice(0,CAP.messages);limits.push('Only the first '+CAP.messages+' messages were read.');}
    let skipped=0;const msgs=[];
    raw.forEach((m,index)=>{const role=isObj(m)?ROLE[m.role]:undefined;if(!role){skipped++;return;}msgs.push({index,role,text:textOf(m.content),calls:role==='assistant'?callsOf(m,index):[],callId:has(m.tool_call_id)?m.tool_call_id:'',placeholder:false});});
    if(skipped)limits.push(skipped+' message'+(skipped===1?' was':'s were')+' skipped: not an object or an unknown role.');
    /* The placeholder: an assistant message with no tool call straight after one that has tool calls, with the same short text at least twice. */
    const seen=new Map();
    msgs.forEach((m,k)=>{if(m.role==='assistant'&&!m.calls.length&&k>0&&msgs[k-1].role==='assistant'&&msgs[k-1].calls.length&&m.text&&m.text.length<=200)seen.set(m.text,(seen.get(m.text)||0)+1);});
    let constant=null,best=1;for(const [text,n] of seen)if(n>best){best=n;constant=text;}
    if(constant!==null)msgs.forEach((m,k)=>{if(m.role==='assistant'&&!m.calls.length&&m.text===constant&&k>0&&msgs[k-1].role==='assistant'&&msgs[k-1].calls.length)m.placeholder=true;});
    /* The final answer is the last assistant message with no tool call, provided nothing (a call or a tool result) follows it. */
    let finalAt=-1;
    for(let k=msgs.length-1;k>=0;k--){const m=msgs[k];if(m.placeholder||m.role==='user'||m.role==='system')continue;if(m.role==='assistant'&&!m.calls.length)finalAt=k;break;}
    const steps=[],byCall=new Map();let cutResults=0,cutCommands=0;
    const push=(m,kind,text,tool)=>steps.push({i:steps.length,message:m.index,role:m.role,kind,text,tool});
    msgs.forEach((m,k)=>{
      if(m.placeholder)return;
      if(m.role==='tool'){let t=m.text;if(t.length>CAP.result){t=t.slice(0,CAP.result);cutResults++;}const c=byCall.get(m.callId);push(m,'result',t,{id:m.callId,name:c?c.name:'',command:c?c.command:''});return;}
      if(m.role==='assistant'&&m.calls.length){if(m.text.trim())push(m,'say',m.text.slice(0,CAP.say),null);
        for(const c of m.calls){let command=c.command;if(command.length>CAP.command){command=command.slice(0,CAP.command);cutCommands++;}const tool={id:c.id,name:c.name,command};if(c.id)byCall.set(c.id,tool);push(m,'command',command,{...tool});}return;}
      if(!m.text.trim())return;
      push(m,k===finalAt?'final':'say',m.text.slice(0,CAP.say),null);
    });
    if(cutResults)limits.push(cutResults+' tool result'+(cutResults===1?' was':'s were')+' cut at '+CAP.result+' characters.');
    if(cutCommands)limits.push(cutCommands+' command'+(cutCommands===1?' was':'s were')+' cut at '+CAP.command+' characters.');
    const final=finalAt>=0&&msgs[finalAt].text.trim()?msgs[finalAt].text.slice(0,CAP.say):null;
    return {steps,finalAnswer:final,limits};
  }

  /* ---------- text and number search ---------- */
  const NUMBER_RE=/(?<![\w.])(-)?(?:[$\u20ac\u00a3\u00a5]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?!\d|[.,]\d)/gu;
  /* Digits, thousands separators and trailing zeros removed, sign kept; two spellings of one value share one key. */
  function decimalKey(negative,digits){let [i,f='']=String(digits).replace(/,/g,'').split('.');f=f.replace(/0+$/,'');if(/^0+$/.test(i))i='0';const zero=i==='0'&&f==='';return (negative&&!zero?'-':'')+i+(f?'.'+f:'');}
  function recordNumbers(text){const out=[];for(const m of String(text).matchAll(NUMBER_RE)){const digits=m[2]+(m[3]||'');out.push({key:decimalKey(!!m[1],digits),token:m[0].trim(),index:m.index,value:Number((m[1]?'-':'')+digits.replace(/,/g,''))});}return out;}
  /* A value to look for: a number (a string such as "$1,200.00", "(1,200)" or "21.4%" counts) becomes a key; any other text of three or more characters is a phrase. */
  function queryOf(value){
    if(typeof value==='number')return Number.isFinite(value)&&!/e/i.test(String(value))?{kind:'number',key:decimalKey(value<0,String(Math.abs(value)))}:null;
    if(typeof value!=='string')return null;
    let t=value.normalize('NFKC').replace(/[\u2212\u2010-\u2015]/g,'-').trim(),neg=false;
    if(/^\(.*\)$/.test(t)){neg=true;t=t.slice(1,-1).trim();}
    const s=t.replace(/[%x]$/i,'').trim(),m=/^([+-]?)\s*[$\u20ac\u00a3\u00a5]?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(s)||/^([+-]?)\s*[$\u20ac\u00a3\u00a5]?\s*(\.\d+)()$/.exec(s);
    if(m)return {kind:'number',key:decimalKey(neg||m[1]==='-',m[2][0]==='.'?'0'+m[2]:m[2]+(m[3]||''))};
    const phrase=value.normalize('NFKC').replace(/\s+/g,' ').trim();
    return phrase.length>=3?{kind:'text',phrase}:null;
  }
  const digitCount=key=>key.replace(/\D/g,'').replace(/^0+/,'').length;
  const phrasePattern=p=>new RegExp((/^[\p{L}\p{N}]/u.test(p)?'(?<![\\p{L}\\p{N}])':'')+p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+')+(/[\p{L}\p{N}]$/u.test(p)?'(?![\\p{L}\\p{N}])':''),'iu');
  const WITHHELD_ROLES=new Set(['evaluator','run-evidence','audit']),SOLVER_ROLES=new Set(['source','template','proposal','prompt']);
  const searchable=pkg=>arr(pkg&&pkg.documents).filter(d=>isObj(d)&&d.status!=='error'&&d.status!=='unsupported'&&!WITHHELD_ROLES.has(d.role));
  const hitOf=(d,r,match)=>({documentId:str(d.id),documentName:str(d.name),sha256:has(d.sha256)?d.sha256:null,locator:str(r.locator),quote:str(r.text).slice(0,CAP.quote),match});
  /* Every record, in package order, that holds the value exactly. Returns the first `limit` and the total. */
  function findClauses(pkg,value,limit,minDigits=0,index=null){
    const q=queryOf(value);if(!q||!isObj(pkg)||!Array.isArray(pkg.documents))return {matches:[],total:0};
    if(q.kind==='number'&&digitCount(q.key)<minDigits)return {matches:[],total:0};
    const matches=[];let total=0;
    if(q.kind==='number'&&index){for(const h of index.get(q.key)||[]){total++;if(matches.length<limit)matches.push(hitOf(h.d,h.r,h.token));}return {matches,total};}
    const re=q.kind==='text'?phrasePattern(q.phrase):null;
    for(const d of searchable(pkg))for(const r of arr(d.records)){if(!isObj(r)||!has(r.locator))continue;const text=str(r.text);let match=null;
      if(q.kind==='number'){const h=recordNumbers(text).find(x=>x.key===q.key);if(h)match=h.token;}else{const m=re.exec(text.normalize('NFKC'));if(m)match=m[0];}
      if(match!==null){total++;if(matches.length<limit)matches.push(hitOf(d,r,match));}}
    return {matches,total};
  }
  function numberIndex(pkg){const map=new Map();for(const d of searchable(pkg))for(const r of arr(d.records)){if(!isObj(r)||!has(r.locator))continue;const seen=new Set();for(const n of recordNumbers(str(r.text))){if(seen.has(n.key))continue;seen.add(n.key);if(!map.has(n.key))map.set(n.key,[]);map.get(n.key).push({d,r,token:n.token});}}return map;}
  const limitOf=o=>{const n=isObj(o)?o.limit:undefined;return Number.isInteger(n)&&n>=1?Math.min(n,CAP.maxLimit):5;};
  function suggestClauses(pkg,value,options){return findClauses(pkg,value,limitOf(options)).matches.map(m=>({...m}));}
  /* The text around the first occurrence of `needle` (exact, then ignoring case): { before, match, after, text, start, end, ellipsisBefore, ellipsisAfter }, or null. */
  function excerptAround(text,needle,radius){
    const t=String(text??''),n=String(needle??'');if(n==='')return null;
    const r=Number.isInteger(radius)&&radius>=0?Math.min(radius,2000):80;
    let i=t.indexOf(n);if(i<0){const lt=t.toLowerCase();if(lt.length===t.length)i=lt.indexOf(n.toLowerCase());}
    if(i<0)return null;
    let start=Math.max(0,i-r),end=Math.min(t.length,i+n.length+r);
    if(start>0&&/[\uDC00-\uDFFF]/.test(t[start]))start--;if(end<t.length&&/[\uD800-\uDBFF]/.test(t[end-1]))end++;
    return {before:t.slice(start,i),match:t.slice(i,i+n.length),after:t.slice(i+n.length,end),text:t.slice(start,end),start,end,index:i,ellipsisBefore:start>0,ellipsisAfter:end<t.length};
  }
  const figureNumber=v=>{const q=queryOf(v);return q&&q.kind==='number'?Number(q.key):null;};
  function locateNumber(text,target,tolerance){const allowed=tolerance+1e-9*Math.max(1,Math.abs(target));for(const n of recordNumbers(text))if(Math.abs(n.value-target)<=allowed)return n.token;return null;}

  /* ---------- clause binding ---------- */
  const fold=s=>String(s??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
  function localResolve(pkg,ref){
    if(!isObj(pkg)||!Array.isArray(pkg.documents)||!isObj(ref)||!has(ref.locator)||!(has(ref.documentId)||has(ref.name)))return null;
    let hit=null,n=0;
    for(const d of pkg.documents){if(!isObj(d)||(has(ref.documentId)&&d.id!==ref.documentId)||(has(ref.name)&&d.name!==ref.name)||(has(ref.sha256)&&d.sha256!==ref.sha256))continue;for(const r of arr(d.records))if(isObj(r)&&r.locator===ref.locator){n++;hit={document:d,record:r};}}
    if(n!==1)return null;
    const out={document:hit.document,record:hit.record,quote:str(hit.record.text).slice(0,CAP.quote)},ex=has(ref.excerpt)?ref.excerpt:has(ref.quote)?ref.quote:'';
    if(ex)out.excerptVerified=fold(hit.record.text).includes(fold(ex));
    return out;
  }
  function resolverOf(opt){
    let f=typeof opt.resolveClause==='function'?opt.resolveClause:null;
    if(!f){const e=opt.engine||engine();if(e&&typeof e.resolveClause==='function')f=e.resolveClause;}
    const use=f||localResolve;
    return (pkg,ref)=>{try{return use(pkg,ref)||null;}catch{return null;}};
  }
  function findDoc(pkg,file){
    if(!has(file))return {doc:null,reason:'No file is named for this source.'};
    const docs=arr(pkg&&pkg.documents).filter(isObj),f=slash(file).trim(),exact=docs.filter(d=>d.name===f||d.name===file);
    if(exact.length===1)return {doc:exact[0]};
    if(exact.length>1)return {doc:null,reason:'More than one file in the package has this exact name, so none was chosen.'};
    const near=docs.filter(d=>tail(d.name)===tail(f));
    if(near.length===1)return {doc:near[0]};
    if(near.length>1)return {doc:null,reason:'More than one file in the package ends with this name, so none was chosen without guessing.'};
    return {doc:null,reason:'This file is not in the loaded package.'};
  }
  const RANGE=/^(text lines?|lines?|rows?|paragraphs?)\s+(\d+)(?:\s*(?:to|through|thru|-|\u2013|\u2014)\s*(\d+))?$/i;
  const CELLREF=/^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?([A-Z]{1,3}\d{1,6})(?::[A-Z]{1,3}\d{1,6})?$/;
  const PREFIX={'text line':'Text line','text lines':'Text line',line:'Line',lines:'Line',row:'Row',rows:'Row',paragraph:'Paragraph',paragraphs:'Paragraph'};
  const NOT_LOCATOR='This is not a locator the package uses (for example Line 2, Row 3 or Sheet!B4).';
  /* The locators an author wrote in a project source, read exactly: a whole locator as written, "Lines 2 to 4" style ranges, and cell references
     (a sheet carries over to the cell references after it; a range keeps its first cell). Anything else is returned as unresolved text. */
  function sourceLocators(source,locs){
    const items=[],notes=[];
    for(const field of [source.cell,source.page]){
      let sheet='';
      const exact=t=>{if(locs&&locs.has(t)){items.push({locator:t});const i=t.lastIndexOf('!');if(i>0)sheet=t.slice(0,i);return true;}return false;};
      for(const piece of str(field).split(';').map(s=>s.trim()).filter(Boolean)){
        if(exact(piece))continue;
        for(const token of piece.includes(',')?piece.split(',').map(s=>s.trim()).filter(Boolean):[piece]){
          if(exact(token))continue;
          const r=RANGE.exec(token);
          if(r){const a=+r[2],b=r[3]===undefined?a:+r[3],prefix=PREFIX[r[1].toLowerCase()];
            if(b<a||b-a+1>CAP.range){items.push({text:token,reason:'This range is reversed or longer than '+CAP.range+' locators, so it was not expanded.'});continue;}
            for(let n=a;n<=b;n++)items.push(r[3]===undefined?{locator:prefix+' '+n}:{locator:prefix+' '+n,range:token});continue;}
          const c=CELLREF.exec(token);
          if(c){if(c[1]!==undefined)sheet=c[1].replace(/''/g,"'");else if(c[2]!==undefined)sheet=c[2].trim();
            if(!sheet){items.push({text:token,reason:'The sheet is not named, so this cell cannot be located.'});continue;}
            if(token.includes(':'))notes.push('The range '+token+' is read as its first cell only.');
            items.push({locator:sheet+'!'+c[3]});continue;}
          items.push({text:token,reason:NOT_LOCATOR});
        }
      }
    }
    return {items,notes};
  }

  /* ---------- diff intersection ---------- */
  const snap=s=>isObj(s)?{...s}:null;

  /* ---------- the case ---------- */
  const validPackage=p=>isObj(p)&&Array.isArray(p.documents)?p:null,validDiff=d=>isObj(d)&&Array.isArray(d.documents)?d:null;
  function buildCase(input,options){
    const o=isObj(input)?input:{},opt=isObj(options)?options:{},notes=[],note=t=>{if(!notes.includes(t))notes.push(t);};
    const pkg=validPackage(o.package),base=validPackage(o.comparePackage),diffIn=validDiff(o.diff),round=isObj(o.round)?o.round:null,run=isObj(o.runDetail)?o.runDetail:null,project=isObj(o.project)?o.project:null,ev=isObj(o.evalParsed)?o.evalParsed:null;
    const resolve=resolverOf(opt),compare=typeof opt.compare==='function'?opt.compare:(core()||{}).compare;
    const links=arr(o.links).filter(l=>isObj(l)&&has(l.criterionId)&&has(l.documentName)&&has(l.locator)&&(!has(o.taskKey)||!has(l.taskKey)||l.taskKey===o.taskKey));
    const withheld=!!((run&&run.redacted===true)||(round&&round.redacted===true)||(run&&isObj(run.final)&&typeof run.final.text!=='string'));
    if(withheld)note('Details withheld while a round runs');
    if(o.package!==undefined&&o.package!==null&&!pkg)note('The task package could not be read, so no source clauses are shown.');
    if(o.diff!==undefined&&o.diff!==null&&!diffIn)note('The package comparison could not be read, so no changed cells are shown.');

    /* The run */
    const suggested=run&&isObj(run.classification)&&isObj(run.classification.suggested)?run.classification.suggested:null,human=run&&isObj(run.classification)&&isObj(run.classification.human)?run.classification.human:null;
    const roundId=round&&has(round.id)?round.id:null,runRef=run?{key:(roundId?roundId+':':'')+String(run.n??''),roundId,n:Number.isInteger(run.n)?run.n:null,runId:has(run.id)?run.id:null}:null;
    const humanOut=human?{verdict:str(human.verdict),fingerprintIds:arr(human.fingerprintIds).filter(has),note:str(human.note),at:has(human.at)?human.at:null,freezeVersion:num(human.freezeVersion)}:null;
    const freezes=round?[round.freeze,...arr(round.postHocFreezes)].filter(f=>isObj(f)&&isObj(f.gold)):[];
    const usedFreeze=suggested&&has(suggested.freezeSha256)?freezes.find(f=>f.sha256===suggested.freezeSha256)||null:null;
    const humanSameFreeze=!!(human&&suggested&&has(human.freezeSha256)&&human.freezeSha256===suggested.freezeSha256),humanGold=!withheld&&!!human&&human.verdict==='matches-frozen-gold';
    if(humanGold&&suggested&&!humanSameFreeze)note('Your verdict was recorded against a different freeze than the one this figure search used, so it is shown but not applied to the figures.');
    const humanApplies=humanGold&&humanSameFreeze;
    if(run&&!withheld&&isObj(run.audit)&&run.audit.status==='DISCARDED')note('This run was DISCARDED by the audit, so its answer was not searched for the frozen figures.');
    let finalText=run&&!withheld&&isObj(run.final)&&typeof run.final.text==='string'?run.final.text:null;
    if(finalText!==null&&finalText.length>CAP.say){finalText=finalText.slice(0,CAP.say);note('The final answer was cut at '+CAP.say+' characters.');}

    /* Diff access. A comparison that names other packages than the loaded ones is stale and is not used at all. */
    const fp=p=>p&&has(p.fingerprint)?p.fingerprint:null,pf=fp(pkg),bf=fp(base),dc=diffIn&&has(diffIn.candFingerprint)?diffIn.candFingerprint:null,db=diffIn&&has(diffIn.baseFingerprint)?diffIn.baseFingerprint:null;
    let orient=null,stale=false;
    if(diffIn&&(dc||db)){
      if(pf){orient=pf===dc?'cand':pf===db?'base':null;if(!orient)stale=true;}
      if(!stale&&bf&&bf!==dc&&bf!==db)stale=true;
      if(!stale&&orient&&bf){const other=orient==='cand'?db:dc;if(other&&other!==bf)stale=true;}
    }
    const diff=stale?null:diffIn;
    if(stale)note('The package comparison was made for different packages than the ones loaded, so it is not used.');
    const diffDocs=diff?diff.documents.filter(isObj):[];
    const diffByName=new Map();for(const d of diffDocs){if(!diffByName.has(d.name))diffByName.set(d.name,[]);diffByName.get(d.name).push(d);}
    if(diff&&pkg&&!orient)note('The package comparison does not name the loaded package by fingerprint, so changed lines (whose numbers depend on the side) are not matched to clauses.');
    if(pkg&&!diffIn)note('No package comparison is loaded, so no changed cells are shown.');
    const locCache=new Map(),locsOf=d=>{if(!d)return null;if(!locCache.has(d))locCache.set(d,new Set(arr(d.records).filter(r=>isObj(r)&&has(r.locator)).map(r=>r.locator)));return locCache.get(d);};

    /* Criteria */
    const criteria=[],ids=new Set(),unique=id=>{let k=id,n=2;while(ids.has(k))k=id+'~'+n++;ids.add(k);return k;};
    const blankConclusion=()=>({runRef:null,where:null,quote:'',figure:null,humanVerdict:null});
    const mk=(c)=>({id:unique(c.id),text:c.text,group:c.group||'',origin:c.origin,status:c.status||'unknown',statusBasis:c.statusBasis||'none',clauses:[],cells:[],lines:[],conclusion:c.conclusion||blankConclusion(),numbers:c.numbers||[],_decision:c.decision});
    const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

    /* freeze gold figures */
    let figures=[];
    if(!withheld){
      if(suggested&&Array.isArray(suggested.matches))figures=suggested.matches.filter(isObj).map((m,i)=>({label:str(m.label),value:m.value,found:typeof m.found==='boolean'?m.found:null,where:m.where==='final'||m.where==='outputs'?m.where:null,tolerance:(()=>{const f=usedFreeze&&arr(usedFreeze.gold.figures)[i];return isObj(f)&&f.label===m.label&&(String(f.value)===String(m.value)||figureNumber(f.value)!==null&&figureNumber(f.value)===figureNumber(m.value))?Math.abs(figureNumber(f.tolerance)??0):0;})(),checked:true}));
      else if(freezes.length)figures=arr(freezes[freezes.length-1].gold.figures).filter(isObj).map(f=>({label:str(f.label),value:f.value,found:null,where:null,tolerance:0,checked:false}));
      if(round&&!figures.length&&!suggested&&!freezes.length)note('The round has no frozen gold figures to list.');
    }else if(run||round)note('The frozen figures are not shown while a round runs.');
    if(!withheld&&suggested&&Array.isArray(suggested.matches)&&!suggested.matches.length)note('The frozen gold has no numeric figures, so no figure criteria are listed.');
    if(figures.length&&!figures.some(f=>f.checked)&&run)note('This run has no figure search: it needs a completed run with a CLEAN audit and a frozen gold.');
    figures.forEach((f,i)=>{
      let status='unknown',basis='none';
      if(f.checked){if(humanApplies){status='met';basis='human-verdict';}else if(f.found===true){status='met';basis='heuristic-figure-search';}else if(f.found===false){status='not-met';basis='heuristic-figure-search';}}
      let quote='';
      if(f.checked&&f.found===true&&f.where==='final'&&finalText){const target=figureNumber(f.value);if(target!==null){const token=locateNumber(finalText,target,f.tolerance),ex=token?excerptAround(finalText,token,90):null;if(ex)quote=((ex.ellipsisBefore?'\u2026':'')+ex.text+(ex.ellipsisAfter?'\u2026':'')).replace(/\s+/g,' ').trim();}}
      criteria.push(mk({id:'figure:'+(slug(f.label)||'n'+(i+1)),text:f.label||'Figure '+(i+1),origin:'freeze-figure',status,statusBasis:basis,conclusion:{runRef:f.checked?runRef:null,where:f.checked?f.where:null,quote,figure:{label:f.label,expected:f.value,found:f.checked?f.found:null},humanVerdict:f.checked?humanOut:null}}));
    });

    /* project outputs */
    const sources=new Map(arr(project&&project.sources).filter(isObj).map(s=>[s.id,s]));
    if(project&&!arr(project.roots).some(r=>isObj(r)&&arr(r.outputs).length))note('The project lists no outputs, so there are no project criteria.');
    const sourceClauses=(output,label)=>{
      const out=[];const seen=new Set();
      const add=c=>{const k=[c.documentName,c.locator,c.basis,c.resolved].join('\u0000');if(!seen.has(k)){seen.add(k);out.push(c);}};
      for(const sid of arr(output.sourceIds)){
        const s=sources.get(sid);if(!s){note(label+' names a source ('+String(sid).slice(0,60)+') that is not in the project.');continue;}
        const found=pkg?findDoc(pkg,s.file):{doc:null,reason:'No task package is loaded.'},doc=found.doc,name=doc?doc.name:str(s.file),locs=locsOf(doc);
        const parsed=sourceLocators(s,locs);parsed.notes.forEach(note);
        const bad=(locator,reason)=>add({documentName:name,locator,quote:'',excerptVerified:null,basis:'source-anchor',...(doc&&has(doc.sha256)?{sha256:doc.sha256}:{}),resolved:false,reason});
        if(!parsed.items.length)bad('',doc?'The source names a file but no location in it.':found.reason);
        const rangeMissing=new Map(),rangeFound=new Map(),made=[],texts=[];
        for(const l of parsed.items){
          if(l.text!==undefined){bad(l.text,doc?l.reason:found.reason);continue;}
          if(!doc){bad(l.locator,found.reason);continue;}
          const res=resolve(pkg,{name:doc.name,sha256:doc.sha256,locator:l.locator});
          if(res){if(l.range)rangeFound.set(l.range,(rangeFound.get(l.range)||0)+1);texts.push(str(res.record&&res.record.text!==undefined?res.record.text:res.quote));
            const before=out.length;add({documentName:doc.name,locator:l.locator,quote:str(res.quote),excerptVerified:null,basis:'source-anchor',...(has(doc.sha256)?{sha256:doc.sha256}:{}),resolved:true});if(out.length>before)made.push(out[out.length-1]);}
          else if(l.range)rangeMissing.set(l.range,(rangeMissing.get(l.range)||0)+1);
          else bad(l.locator,'This file has no record at this locator.');
        }
        /* The excerpt belongs to the source, so it is looked for in the text of all the records the source resolved to. */
        if(has(s.excerpt)&&made.length){const verified=fold(texts.join(' ')).includes(fold(s.excerpt));for(const c of made)c.excerptVerified=verified;}
        for(const [range,missing] of rangeMissing){const got=rangeFound.get(range)||0;if(!got)bad(range,'No record in this file matches any locator in this range.');else note(range+' in '+name+': '+got+' locator'+(got===1?'':'s')+' found, '+missing+' missing.');}
      }
      return out;
    };
    for(const root of arr(project&&project.roots).filter(isObj))arr(root.outputs).filter(isObj).forEach((out,i)=>{
      const rid=has(root.id)?root.id:'root',oid=has(out.id)?out.id:String(i+1),label=has(out.label)?out.label:'Output '+oid;
      let numbers=[],decision;
      try{
        if(typeof compare!=='function')throw new Error('no comparison function is available');
        const c=compare({correct:out.correct,wrong:out.wrong,absTolerance:out.absTolerance??'0',relTolerance:out.relTolerance??'0',threshold:out.threshold??'',direction:out.direction});
        decision=c.decisionChanges===true;numbers=[{label,unit:str(out.unit),correct:c.correct,wrong:c.wrong,delta:c.delta,tolerance:c.tolerance,decisionChanges:decision}];
      }catch(e){note(label+': the comparison is incomplete ('+String(e&&e.message||e).slice(0,160)+').');}
      const c=mk({id:'output:'+rid+'/'+oid,text:label,group:str(root.title),origin:'project-output',numbers,decision});
      c.clauses=sourceClauses(out,label);c._value=out.correct;criteria.push(c);
    });

    /* imported evaluation items */
    if(ev){const key=has(ev.runId)?ev.runId:has(ev.problemRunId)?ev.problemRunId:'eval';
      for(const it of arr(ev.items).filter(isObj)){
        const explicit=!withheld&&(it.polarity==='met'||it.polarity==='not-met');
        criteria.push(mk({id:'studio:'+key+':'+(has(it.id)?it.id:String(criteria.length)),text:str(it.text),group:str(it.group),origin:'studio-item',status:explicit?it.polarity:'unknown',statusBasis:explicit?'explicit-token':'none'}));
      }}

    /* author links, then unconfirmed text matches, then changed cells */
    let index=null;
    const unresolvedReason=(l)=>{if(!pkg)return 'No task package is loaded.';const docs=pkg.documents.filter(d=>isObj(d)&&d.name===l.documentName);if(!docs.length)return 'This file is not in the loaded package.';if(docs.length>1)return 'More than one file in the package has this name.';if(has(l.sha256)&&docs[0].sha256!==l.sha256)return 'This file has changed since you linked the clause (its hash differs).';return 'This file has no record at this locator.';};
    for(const c of criteria){
      for(const l of links.filter(x=>x.criterionId===c.id)){
        const res=pkg?resolve(pkg,{name:l.documentName,...(has(l.sha256)?{sha256:l.sha256}:{}),locator:l.locator}):null;
        const hit=(x)=>c.clauses.some(y=>y.basis==='author-link'&&y.documentName===l.documentName&&y.locator===l.locator&&y.resolved===x);
        if(res){if(!hit(true))c.clauses.push({documentName:str(res.document&&res.document.name)||l.documentName,locator:l.locator,quote:str(res.quote),excerptVerified:null,basis:'author-link',...(res.document&&has(res.document.sha256)?{sha256:res.document.sha256}:has(l.sha256)?{sha256:l.sha256}:{}),resolved:true});}
        else if(!hit(false))c.clauses.push({documentName:l.documentName,locator:l.locator,quote:'',excerptVerified:null,basis:'author-link',...(has(l.sha256)?{sha256:l.sha256}:{}),resolved:false,reason:unresolvedReason(l)});
      }
      if(opt.textMatch!==false&&pkg&&!c.clauses.some(x=>x.resolved&&(x.basis==='source-anchor'||x.basis==='author-link'))){
        const value=c.origin==='freeze-figure'?c.conclusion.figure.expected:c._value;
        const limit=Number.isInteger(opt.textMatchLimit)&&opt.textMatchLimit>=0?Math.min(opt.textMatchLimit,CAP.maxLimit):CAP.clauseMatches;
        if(value!==undefined&&value!==null&&limit>0){
          if(!index)index=numberIndex(pkg);
          const r=findClauses(pkg,value,limit,CAP.minDigits,index);
          for(const m of r.matches)c.clauses.push({documentName:m.documentName,locator:m.locator,quote:m.quote,excerptVerified:null,basis:'text-match-unconfirmed',...(m.sha256?{sha256:m.sha256}:{}),resolved:true,match:m.match});
          if(r.total>r.matches.length)note(c.text+': '+r.total+' records hold this value as text; the first '+r.matches.length+' are listed and none is confirmed.');
        }
      }
      /* changed cells and lines: exact (file name, locator) only, from confirmed references; an unconfirmed text match never counts */
      const seenCell=new Set(),seenLine=new Set();
      for(const cl of c.clauses){
        if(cl.basis==='text-match-unconfirmed'||!has(cl.locator))continue;
        for(const dd of diffByName.get(cl.documentName)||[]){
          const basis=cl.basis==='author-link'?'author-link':'diff-intersect-clause';
          for(const x of arr(dd.cells).filter(isObj)){if(x.locator!==cl.locator)continue;const k=[dd.name,x.locator,x.derivedColumn||''].join('\u0000');if(seenCell.has(k))continue;seenCell.add(k);
            const cell={documentName:dd.name,locator:x.locator,change:x.change,before:snap(x.before),after:snap(x.after),basis,hidden:!!x.hidden};if(has(x.derivedColumn))cell.derivedColumn=x.derivedColumn;if(c._decision!==undefined)cell.decisionChanges=c._decision;c.cells.push(cell);}
          if(orient)for(const op of arr(dd.lines).filter(isObj)){const side=orient==='cand'?op.op==='add'&&op.candLocator:op.op==='del'&&op.baseLocator;if(side!==cl.locator)continue;const k=[dd.name,op.op,op.baseLocator,op.candLocator].join('\u0000');if(seenLine.has(k))continue;seenLine.add(k);
            c.lines.push({documentName:dd.name,op:op.op,baseLocator:op.baseLocator??null,candLocator:op.candLocator??null,before:op.before??null,after:op.after??null,basis});}
        }
      }
    }
    const unresolved=criteria.reduce((n,c)=>n+c.clauses.filter(x=>!x.resolved).length,0);
    if(unresolved)note(unresolved+' source reference'+(unresolved===1?'':'s')+' could not be resolved; each is listed as unresolved with its reason.');
    for(const c of criteria){delete c._decision;delete c._value;}

    /* files */
    const files=[],used=new Set();
    const pkgDocs=pkg?pkg.documents.filter(isObj):[],pkgIds=new Set(pkgDocs.map(d=>d.id).filter(has)),nameCount=new Map();for(const d of pkgDocs)nameCount.set(d.name,(nameCount.get(d.name)||0)+1);
    const diffFor=d=>{const byId=diffDocs.find(x=>has(d.id)&&(x.candId===d.id||x.baseId===d.id));if(byId)return byId;if(nameCount.get(d.name)>1)return null;const by=(diffByName.get(d.name)||[]).filter(x=>!pkgIds.has(x.candId)&&!pkgIds.has(x.baseId));return by.length===1?by[0]:null;};
    const fileOf=(d,dd,inPackage)=>({name:str(d.name),id:str(d.id),role:str(d.role),kind:str(d.kind),extraction:has(d.status)?d.status:null,bytes:Number.isFinite(d.bytes)?d.bytes:null,sha256:has(d.sha256)?d.sha256:null,solverFacing:has(d.role)?SOLVER_ROLES.has(d.role):null,change:dd&&has(dd.status)?dd.status:null,changedCells:dd?arr(dd.cells).length:0,changedLines:dd?arr(dd.lines).filter(x=>isObj(x)&&x.op!=='equal').length:0,metaChanges:dd&&isObj(dd.metaChanges)?arr(dd.metaChanges.sheets).length+arr(dd.metaChanges.definedNames).length:0,inPackage,limits:dd?arr(dd.limits).filter(has):[]});
    if(pkg)for(const d of pkg.documents.filter(isObj)){const dd=diff?diffFor(d):null;if(dd)used.add(dd);files.push(fileOf(d,dd,true));}
    for(const dd of diffDocs)if(!used.has(dd))files.push(fileOf({name:dd.name,id:dd.candId||dd.baseId||'',kind:dd.kind,sha256:dd.candSha256||dd.baseSha256},dd,pkg?false:null));
    files.sort((a,b)=>cmp(a.name,b.name)||cmp(a.id,b.id));

    /* the run's conclusion */
    let conclusion=null;
    if(run){conclusion={runRef,state:str(run.state)||null,audit:isObj(run.audit)&&has(run.audit.status)?run.audit.status:null,suggestedVerdict:suggested&&has(suggested.verdict)?suggested.verdict:null,humanVerdict:humanOut,fingerprintsHit:withheld||!suggested?[]:arr(suggested.fingerprints).filter(f=>isObj(f)&&f.hit===true).map(f=>({id:str(f.id),label:str(f.label)})),decision:!withheld&&suggested&&isObj(suggested.decision)?{keywords:arr(suggested.decision.keywords).filter(has),found:arr(suggested.decision.found).filter(has)}:null,finalChars:isObj(run.final)&&Number.isFinite(run.final.chars)?run.final.chars:null};
}
    const limitList=[...arr(diff&&diff.limits).filter(has),'A criterion is Not met only when the figure search found no match, an explicit token says so, or you recorded the verdict. Everything else stays unknown.','The figure search is a text search of the final answer and the saved output text. It is not grading.','Text matches are unconfirmed suggestions. They never set a status or add a changed cell.'];
    return {files,criteria,solver:{conclusion,finalText,withheld},limits:uniq(limitList),notes};
  }

  /* ---------- diff rows for the views ---------- */
  const colIndex=s=>{let n=0;for(const ch of s)n=n*26+ch.charCodeAt(0)-64;return n-1;};
  const colLetter=i=>{let s='';for(i++;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;};
  function cellPosition(c){
    const loc=str(c.locator),bang=loc.lastIndexOf('!');
    const sheet=typeof c.sheet==='string'?c.sheet:bang>=0?loc.slice(0,bang):'',ref=typeof c.cell==='string'?c.cell:bang>=0?loc.slice(bang+1):'';
    const m=/^([A-Z]{1,3})(\d{1,7})$/.exec(ref);if(m)return {sheet,col:m[1],row:+m[2]};
    const r=/^Row (\d+)$/.exec(loc);if(r&&typeof c.derivedColumn==='string'&&/^[A-Z]{1,3}$/.test(c.derivedColumn))return {sheet:'',col:c.derivedColumn,row:+r[1]};
    return null;
  }
  const withNav=list=>list.map((c,k)=>({...c,index:k,prev:k>0?k-1:null,next:k<list.length-1?k+1:null}));
  /* Changed cells with `context` rows and columns around them, per sheet. Rows and columns that are close share one window. Cell values for the context
     come from options.candDoc (or baseDoc) when given; otherwise they are null, meaning not provided, never empty. */
  function diffViewRows(docDiff,options){
    const o=isObj(options)?options:{},ctx=Number.isInteger(o.context)&&o.context>=0?Math.min(o.context,20):2,maxRows=Number.isInteger(o.maxRows)&&o.maxRows>0?o.maxRows:400,maxCols=Number.isInteger(o.maxCols)&&o.maxCols>0?o.maxCols:30;
    const doc=isObj(o.candDoc)?o.candDoc:isObj(o.baseDoc)?o.baseDoc:null,csv=isObj(docDiff)&&docDiff.kind==='csv';
    const out={sections:[],changes:[],unplaced:[],total:0,collisions:0,truncated:false,context:ctx};
    const cells=arr(docDiff&&docDiff.cells).filter(isObj);out.total=cells.length;if(!cells.length)return out;
    const bySheet=new Map();let collisions=0;
    for(const c of cells){const p=cellPosition(c);if(!p){out.unplaced.push({locator:str(c.locator),change:str(c.change),before:snap(c.before),after:snap(c.after),hidden:!!c.hidden});continue;}
      if(!bySheet.has(p.sheet))bySheet.set(p.sheet,new Map());const m=bySheet.get(p.sheet),k=p.row+'|'+p.col;if(m.has(k)){collisions++;m.get(k).also++;continue;}m.set(k,{...p,c,also:0});}
    out.collisions=collisions;
    const records=new Map();if(doc)for(const r of arr(doc.records))if(isObj(r)&&!records.has(r.locator))records.set(r.locator,r);
    const valueAt=(sheet,col,row)=>{
      if(!doc)return {known:false,value:null};
      if(csv||!sheet&&doc.kind==='csv'){const r=records.get('Row '+row),v=r&&Array.isArray(r.values)?r.values[colIndex(col)]:undefined;return {known:true,value:v===undefined?'':String(v)};}
      const r=records.get(sheet+'!'+col+row);return {known:true,value:r?(r.value!==undefined&&r.value!==null?String(r.value):str(r.text)):''};
    };
    let rowsLeft=maxRows;const all=[];
    for(const sheet of [...bySheet.keys()].sort(cmp)){
      const m=bySheet.get(sheet),list=[...m.values()].sort((a,b)=>a.row-b.row||colIndex(a.col)-colIndex(b.col));
      const rowsWanted=uniq(list.map(x=>x.row)).sort((a,b)=>a-b),colsWanted=uniq(list.map(x=>colIndex(x.col))).sort((a,b)=>a-b);
      const windows=(vals,lo0)=>{const w=[];for(const v of vals){const lo=Math.max(lo0,v-ctx),hi=v+ctx;if(w.length&&lo<=w[w.length-1][1]+1)w[w.length-1][1]=Math.max(w[w.length-1][1],hi);else w.push([lo,hi]);}return w;};
      const rowList=[],colList=[];for(const [lo,hi] of windows(rowsWanted,1))for(let r=lo;r<=hi;r++)rowList.push(r);for(const [lo,hi] of windows(colsWanted,0))for(let c=lo;c<=hi;c++)colList.push(c);
      const shownCols=colList.slice(0,maxCols),section={sheet,columns:shownCols.map(colLetter),rows:[],truncated:false};
      if(colList.length>shownCols.length){section.truncated=true;out.truncated=true;}
      let prev=0;
      for(const r of rowList){
        if(rowsLeft<=0){section.truncated=true;out.truncated=true;break;}rowsLeft--;
        const row={key:sheet+'#'+r,row:r,gapBefore:prev?r-prev-1:r-1,cells:[]};prev=r;
        for(const ci of shownCols){const col=colLetter(ci),hit=m.get(r+'|'+col),locator=csv||!sheet&&doc&&doc.kind==='csv'?'Row '+r:sheet+'!'+col+r;
          if(hit){const ch=hit.c;row.cells.push({col,locator,role:'changed',change:str(ch.change),before:snap(ch.before),after:snap(ch.after),value:ch.after?str(ch.after.value):ch.before?str(ch.before.value):null,known:true,hidden:!!ch.hidden,collisions:hit.also,changeIndex:null});}
          else{const v=valueAt(sheet,col,r);row.cells.push({col,locator,role:'context',change:null,before:null,after:null,value:v.value,known:v.known,hidden:false,collisions:0,changeIndex:null});}}
        section.rows.push(row);
      }
      const shown=new Set(section.rows.map(r=>r.row)),shownColSet=new Set(section.columns);
      for(const x of list)all.push({sheet,x,shown:shown.has(x.row)&&shownColSet.has(x.col)});
      out.sections.push(section);
    }
    const nav=withNav(all.map(({sheet,x,shown})=>({sheet,locator:str(x.c.locator),row:x.row,col:x.col,change:str(x.c.change),shown})));
    out.changes=nav;
    nav.forEach((ch,k)=>{if(!ch.shown)return;const sec=out.sections.find(s=>s.sheet===ch.sheet),row=sec.rows.find(r=>r.row===ch.row),cell=row.cells.find(c=>c.col===ch.col);cell.changeIndex=k;});
    return out;
  }
  /* Lines of a text-like diff with each long run of unchanged lines folded into one `collapsed` row. A change is a run of added or removed lines. */
  function lineDiffRows(docDiff,options){
    const o=isObj(options)?options:{},fold_=Number.isInteger(o.collapseAfter)&&o.collapseAfter>=0?o.collapseAfter:6;
    const ops=arr(docDiff&&docDiff.lines).filter(x=>isObj(x)&&(x.op==='equal'||x.op==='add'||x.op==='del'));
    const rows=[],hunks=[];let i=0,hunk=-1;
    const line=(op,at)=>({type:'line',index:at,op:op.op,baseLocator:op.baseLocator??null,candLocator:op.candLocator??null,before:op.before??null,after:op.after??null,text:op.op==='del'?str(op.before):str(op.after!==undefined&&op.after!==null?op.after:op.before),changeIndex:null});
    while(i<ops.length){
      if(ops[i].op==='equal'){let j=i;while(j<ops.length&&ops[j].op==='equal')j++;
        if(j-i>fold_)rows.push({type:'collapsed',count:j-i,fromIndex:i,toIndex:j,baseFrom:ops[i].baseLocator??null,baseTo:ops[j-1].baseLocator??null,candFrom:ops[i].candLocator??null,candTo:ops[j-1].candLocator??null});
        else for(let k=i;k<j;k++)rows.push(line(ops[k],k));
        i=j;continue;}
      hunk++;const first=rows.length;let adds=0,dels=0;
      while(i<ops.length&&ops[i].op!=='equal'){const r=line(ops[i],i);r.changeIndex=hunk;if(ops[i].op==='add')adds++;else dels++;rows.push(r);i++;}
      hunks.push({firstRow:first,lastRow:rows.length-1,adds,dels});
    }
    return {rows,changes:withNav(hunks),total:hunks.length,collapseAfter:fold_};
  }

  const api={VERSION,parseStudioGrading,parseStudioMessages,normalizeEval,buildCase,suggestClauses,diffViewRows,lineDiffRows,excerptAround};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.FinanceWorkbenchModel=api;
})(typeof window!=='undefined'?window:globalThis);
