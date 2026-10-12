/* Mission model: the pure data side of the Mission Control view (SPEC 2.4). No DOM, no clock (`now` is an argument), no
   network, no storage, and it never mutates or aliases its inputs. It turns the companion's round rows
   (GET /api/agents/rounds), the pilot feed rows (GET /api/agents/runs) and the imported evaluation records into
   task cards, a next action per task, a run feed, and the exact score wording.
   Rules this file keeps:
   - It computes no percentage, rate, ratio, trend or difficulty. Counts are counts. "k of n pilots finished" is process
     progress, and a score is only ever shown as the two strings the person recorded.
   - The pilot tally is the Agents page's tally(): a pilot counts when it is completed AND its audit is CLEAN. It never
     reads counts.clean, which also counts failed runs that were never audited away.
   - Text it emits is plain text (the view escapes it). It never echoes a runtime-supplied reason or terminal code: an
     unknown code gets a fixed sentence, so a stray word can never reach the page.
   - While a round runs the companion withholds details (row.redacted, or the `redacted` input). A redacted pilot keeps
     its state, tool-call count, audit status, character count and verdict name, and says "Details withheld while a round runs".
   Ordering is total and does not depend on the order of the input arrays (apart from which of two identical-key rows
   with the same arrival time is kept). Keys are opaque strings, not selectors.
   Inputs: rounds = round rows (SPEC 2.1), runs = pilot feed rows (2.1), evals = imported evaluation records, which may carry
   packetSha256 and/or roundId so a result can be called an earlier version. A row is redacted when row.redacted is true
   or the `redacted` input is. In every `counts`, `running` means in flight (running plus waiting). */
(function(scope){'use strict';
  const VERSION='1.0.0';
  const WITHHELD='Details withheld while a round runs';
  const OFFLINE_MESSAGE='Local agents need the companion: run npm start.';
  const EMPTY_SCORE='No score recorded. Pilots and the simulated grader are not scored.';
  const EMPTY_BOARD='No task has a round yet. Freeze a round in Agents and its task appears here. Nothing has run.';
  const RUNNING_NEXT='A round is running. Start the next round when it has ended: while a round runs, the companion withholds the gold and the prompt from this page.';
  const CLASSIFY_WAITS='Classification waits until no round is running.';
  const LAUNCH_WAITS='Another round is running. Launch waits until it has ended.';
  const UNASSIGNED='Unassigned';
  const NAME_MAX=120;
  const MAX_LINEAGE=5000;
  /* The label the Agents form gives a round when the person leaves it empty. It names nothing, so it never names a task. */
  const GENERIC_LABELS=new Set(['pilot round','round']);
  const ID_RE=/^[a-z0-9-]{4,64}$/;
  const VERDICTS=Object.freeze({'matches-frozen-gold':'Matches the frozen gold',fingerprint:'Lands on a frozen fingerprint',unclear:'Unclear, or neither'});
  const ENDED=Object.freeze(['finished','cancelled','failed']);
  /* A glyph and a WORD for every state: colour is never the only signal. */
  const mkState=(key,word,glyph)=>Object.freeze({key,word,glyph});
  const STATES=Object.freeze({
    running:mkState('running','RUNNING','●'),
    queued:mkState('waiting','WAITING','○'),
    completed:mkState('completed','COMPLETED','✓'),
    failed:mkState('failed','FAILED','✕'),
    cancelled:mkState('cancelled','CANCELLED','■'),
    discarded:mkState('discarded','DISCARDED','⊘'),
    unknown:mkState('unknown','UNKNOWN','?')
  });
  /* Urgency of a next step, most urgent first: watch (pilots running) 1, classify (clean pilots without your verdict) 2,
     launch (approved) 3, approve (frozen) 4, freeze (draft) 5, export 6, start-next 7, open 8, start 9.
     A task takes its most urgent step across its rounds, except that a draft, frozen or approved round a newer round
     replaced is ignored. The one yellow primary goes to the task with the most urgent step among 1 to 5 that is not blocked
     (a step that waits for the running round is blocked). Ties break on the freshest lastActivityAt, then the name without
     regard to case, then the key. Nobody is primary offline. Export and start-next are housekeeping and never primary. */
  const URGENCY=Object.freeze({watch:1,classify:2,launch:3,approve:4,freeze:5,export:6,'start-next':7,open:8,start:9});
  const PRIMARY_MAX=5;
  const CTA='Open in Agents';

  /* ---------- small helpers ---------- */
  const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const text=v=>typeof v==='string'?v:'';
  const oneLine=(v,max)=>text(v).replace(/\s+/gu,' ').trim().slice(0,max===undefined?NAME_MAX:max);
  const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const nonNeg=v=>{const n=num(v);return n!==null&&n>=0?Math.floor(n):null;};
  /* Only an ISO date or date-time counts: the engine's lenient parsing would read "12" as a date. */
  const time=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(v))return null;const t=Date.parse(v);return Number.isFinite(t)?t:null;};
  const cmp=(a,b)=>a<b?-1:a>b?1:0;
  /* Descending order on a timestamp that may be -Infinity: never NaN. */
  const newer=(a,b)=>cmp(b,a);
  const plural=(n,one,many)=>n+' '+(n===1?one:many||one+'s');
  const stamp=iso=>{const t=time(iso);return t===null?-Infinity:t;};
  const list=v=>Array.isArray(v)?v:[];
  const normKey=name=>{const s=oneLine(name);let k=s;try{k=s.normalize('NFC');}catch{k=s;}return 'task:'+k.toLowerCase();};
  const roundName=(label,id)=>{const l=oneLine(label);return l&&!GENERIC_LABELS.has(l.toLowerCase())?l:text(id);};
  const maxIso=values=>{let best=null,at=-Infinity;for(const v of values){const t=time(v);if(t!==null&&t>at){at=t;best=v;}}return best;};
  const minStamp=values=>{let at=Infinity;for(const v of values){const t=time(v);if(t!==null&&t<at)at=t;}return at;};

  /* "4m 12s": the same wording as the Agents page (spanText) for a span in milliseconds. */
  function formatDuration(ms){
    const n=typeof ms==='number'?ms:NaN;
    if(!Number.isFinite(n))return '-';
    const s=Math.max(0,Math.round(n/1000));
    return Math.floor(s/60)+'m '+String(s%60).padStart(2,'0')+'s';
  }
  /* The first n characters of a hash (12 by default), without a leading "sha256:". */
  function shortHash(sha,n){
    const k=Number.isInteger(n)&&n>0?Math.min(n,128):12;
    return text(sha).replace(/^sha256:/i,'').slice(0,k);
  }
  function evidencePath(roundId,n){
    return typeof roundId==='string'&&ID_RE.test(roundId)&&Number.isInteger(n)&&n>=1&&n<=99?'private/agent-rounds/'+roundId+'/runs/'+n+'/outputs/':null;
  }
  /* A folder the page may show: relative, no traversal. An absolute path never reaches the page. */
  const safeRelative=v=>{const s=text(v).trim();return s&&s.length<=300&&!/^(?:[/\\]|[a-z]:)/i.test(s)&&!/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(s)&&!/[\u0000-\u001f]/.test(s)?s:null;};

  /* ---------- task identity and lineage ---------- */
  /* makeResolver(rounds) -> { resolveRow(row), resolveId(id) }. A round's task is, in order: its own `task`; the nearest
     ancestor's `task` along carriedFrom; the lineage root's label when the root is in the list and its label names
     something; else Unassigned. A cycle or a parent that is not in the list leaves the root unknown. */
  function makeResolver(rounds){
    const byId=new Map();
    for(const r of list(rounds))if(isObj(r)&&typeof r.id==='string'&&r.id&&!byId.has(r.id))byId.set(r.id,r);
    const memo=new Map();
    function make(name,via,depth,end,rootId){
      return {key:normKey(name),name:oneLine(name),unassigned:false,via,depth,end,rootId};
    }
    function resolveRow(row){
      if(!isObj(row))return {key:'unassigned',name:UNASSIGNED,unassigned:true,via:'none',depth:0,end:'missing',rootId:''};
      const chain=[row],seen=new Set(),start=text(row.id);
      if(start)seen.add(start);
      let end='root',cur=row;
      for(let guard=0;;guard++){
        const parent=text(cur.carriedFrom);
        if(!parent){end='root';break;}
        const next=byId.get(parent);
        if(!next){end='missing';break;}
        if(seen.has(next.id)||guard>=MAX_LINEAGE){end='cycle';break;}
        seen.add(next.id);chain.push(next);cur=next;
      }
      const given=nonNeg(row.carriedDepth);
      const depth=Number.isInteger(row.carriedDepth)&&given!==null?given:end==='cycle'?0:chain.length-1;
      const rootId=end==='root'?text(chain[chain.length-1].id):'';
      const own=oneLine(row.task);
      if(own)return make(own,'task',depth,end,rootId);
      for(let i=1;i<chain.length;i++){const t=oneLine(chain[i].task);if(t)return make(t,'ancestor-task',depth,end,rootId);}
      if(end==='root'){
        const label=oneLine(chain[chain.length-1].label);
        if(label&&!GENERIC_LABELS.has(label.toLowerCase()))return make(label,'root-label',depth,end,rootId);
      }
      return {key:'unassigned',name:UNASSIGNED,unassigned:true,via:'none',depth,end,rootId};
    }
    function resolveId(id){
      if(!memo.has(id))memo.set(id,byId.has(id)?resolveRow(byId.get(id)):null);
      return memo.get(id);
    }
    return {resolveRow,resolveId};
  }
  /* taskKey/taskName(row, rounds?): rounds is the list the row's lineage is looked up in; without it only row.task counts. */
  const resolveTask=(row,rounds)=>makeResolver(rounds).resolveRow(row);
  const taskKey=(row,rounds)=>resolveTask(row,rounds).key;
  const taskName=(row,rounds)=>resolveTask(row,rounds).name;

  /* ---------- run rows ---------- */
  /* One canonical pilot row (primitives only, so nothing aliases the input). null when it has no round id and number. */
  function normRun(row,defaults){
    if(!isObj(row))return null;
    const d=isObj(defaults)?defaults:{};
    const roundId=text(row.roundId)||text(d.roundId),n=row.n===undefined?d.n:row.n;
    if(!roundId||!Number.isInteger(n)||n<1)return null;
    const calls=isObj(row.toolCalls)?row.toolCalls:{};
    const audit=isObj(row.audit)?{status:text(row.audit.status)||null,violationCount:nonNeg(row.audit.violationCount)!==null?nonNeg(row.audit.violationCount):Array.isArray(row.audit.violations)?row.audit.violations.length:null}:null;
    const cls=isObj(row.classification)?row.classification:null;
    let human='';
    if(cls){
      if(isObj(cls.human)&&typeof cls.human.verdict==='string')human=cls.human.verdict;
      else if(typeof cls.humanVerdict==='string')human=cls.humanVerdict;
    }
    const endedAt=text(row.endedAt)||null,startedAt=text(row.startedAt)||null;
    return {
      key:roundId+':'+n,roundId,n,runId:text(row.runId)||text(row.id)||roundId+'-'+n,
      roundLabel:oneLine(row.roundLabel!==undefined?row.roundLabel:d.roundLabel),task:oneLine(row.task!==undefined?row.task:d.task),roundStatus:text(row.roundStatus)||text(d.roundStatus),
      state:text(row.state),startedAt,endedAt,arrivedAt:text(row.arrivedAt)||endedAt||startedAt||null,
      exitCode:Number.isInteger(row.exitCode)?row.exitCode:null,
      requestedModel:oneLine(row.requestedModel,80),resolvedModel:oneLine(row.resolvedModel,80),
      numTurns:nonNeg(row.numTurns),terminalReason:text(row.terminalReason).slice(0,80),failureReason:text(row.failureReason).slice(0,40),
      toolCalls:{total:nonNeg(calls.total),bash:nonNeg(calls.bash),file:nonNeg(calls.file)},
      audit,finalChars:isObj(row.final)?nonNeg(row.final.chars):null,outputCount:nonNeg(row.outputCount),
      workingFolder:safeRelative(row.workingFolder!==undefined?row.workingFolder:row.folder),
      evidencePath:row.evidencePath===undefined?undefined:safeRelative(row.evidencePath),
      humanVerdict:human,maxBudgetUsd:num(row.maxBudgetUsd),redacted:row.redacted===true
    };
  }
  /* Keep one row per key: the one that arrived later; on a tie the one later in the input. */
  function dedupeRuns(rows,defaults){
    const byKey=new Map();
    for(const raw of list(rows)){
      const r=normRun(raw,defaults);
      if(!r)continue;
      const old=byKey.get(r.key);
      if(!old||stamp(r.arrivedAt)>=stamp(old.arrivedAt))byKey.set(r.key,r);
    }
    return [...byKey.values()];
  }
  const isActive=r=>r.state==='queued'||r.state==='running';
  const isDiscarded=r=>!isActive(r)&&!!r.audit&&r.audit.status==='DISCARDED';
  const isClean=r=>r.state==='completed'&&!!r.audit&&r.audit.status==='CLEAN';
  function stateOf(r){
    if(isDiscarded(r))return STATES.discarded;
    return has(STATES,r.state)&&r.state!=='discarded'&&r.state!=='unknown'?STATES[r.state]:STATES.unknown;
  }
  /* The Agents page's tally() over canonical rows, plus the process counts its status strip shows. `needs` lists the
     pilot numbers of clean completed pilots with no verdict yet. */
  function tallyRuns(rows){
    const t={total:0,queued:0,running:0,active:0,proc:{completed:0,failed:0,cancelled:0},discarded:0,failed:0,cancelled:0,clean:0,classified:0,unclassified:0,matchedGold:0,fingerprint:0,unclear:0,needs:[]};
    for(const r of list(rows)){
      t.total++;
      if(r.state==='queued'){t.queued++;t.active++;continue;}
      if(r.state==='running'){t.running++;t.active++;continue;}
      if(has(t.proc,r.state))t.proc[r.state]++;
      if(isDiscarded(r)){t.discarded++;continue;}
      if(r.state==='failed'){t.failed++;continue;}
      if(r.state==='cancelled'){t.cancelled++;continue;}
      if(isClean(r)){
        t.clean++;
        if(r.humanVerdict){
          t.classified++;
          if(r.humanVerdict==='matches-frozen-gold')t.matchedGold++;
          else if(r.humanVerdict==='fingerprint')t.fingerprint++;
          else t.unclear++;
        }else{t.unclassified++;t.needs.push(r.n);}
      }
    }
    t.needs.sort((a,b)=>a-b);
    return t;
  }

  /* ---------- failure and ending reasons, in words ---------- */
  const usd=n=>'USD '+(Math.round(n*100)/100).toFixed(2);
  const REASONS=Object.freeze({
    'exit-code':r=>'The program exited with code '+(Number.isInteger(r.exitCode)?r.exitCode:'(unknown)')+'.',
    timeout:()=>'The pilot ran out of time (50 minutes) and was stopped.',
    'no-result':()=>'The program ended without sending a final result.',
    'error-result':()=>'The runtime reported an error as its result.',
    budget:r=>'The pilot reached its spending cap'+(num(r.maxBudgetUsd)!==null&&r.maxBudgetUsd>=0?' ('+usd(r.maxBudgetUsd)+')':'')+' and the runtime stopped it before it finished.',
    'empty-result':()=>'The program finished with an empty result.',
    'spawn-error':()=>'The program could not be started.',
    'setup-error':()=>'The pilot folder could not be built, so nothing was started.',
    signal:()=>'The program was stopped by a signal.',
    'no-exit-code':()=>'The program ended without an exit code.',
    interrupted:()=>'The companion stopped while this pilot was running.'
  });
  /* What the runtime reports as the reason it stopped, as a clause that follows "because". The list is the set the
     runtime documents plus the one this app raises itself (budget_exhausted); anything else gets one fixed clause. */
  const TERMINAL=Object.freeze({
    max_turns:'it reached the turn limit',
    budget_exhausted:'it reached its spending cap',
    aborted_streaming:'its response was cut off while streaming',
    aborted_tools:'its tool calls were stopped',
    prompt_too_long:'the conversation grew too long for the model',
    blocking_limit:'a usage limit blocked it',
    model_error:'the model reported an error',
    image_error:'an image could not be read',
    hook_stopped:'a hook stopped it',
    stop_hook_prevented:'a stop hook prevented it from ending',
    tool_deferred:'a tool call was deferred',
    rapid_refill_breaker:'it kept refilling its context too quickly'
  });
  const UNKNOWN_TERMINAL='of a reason this page does not recognise';
  function terminalClause(code){
    const c=text(code);
    if(!c||c==='completed')return '';
    return has(TERMINAL,c)?TERMINAL[c]:UNKNOWN_TERMINAL;
  }
  /* describeFailure(row) -> { kind:'none'|'failed'|'cancelled', code, text, terminalText, withheld }. Accepts a pilot row
     from either route. A redacted row says only that its details are withheld. */
  function describeFailure(input){
    const row=isObj(input)?input:{};
    const state=text(row.state),code=text(row.failureReason);
    const cancelled=state==='cancelled'||code==='cancelled';
    const failed=state==='failed'||(state===''&&!!code&&!cancelled);
    if(!cancelled&&!failed)return {kind:'none',code:null,text:'',terminalText:terminalClause(row.terminalReason),withheld:false};
    const kind=cancelled?'cancelled':'failed';
    if(row.redacted===true)return {kind,code:null,text:WITHHELD+'.',terminalText:'',withheld:true};
    let body;
    if(cancelled)body=row.startedAt?'Cancelled before it finished.':'Cancelled before it started.';
    else if(has(REASONS,code))body=REASONS[code](row);
    else body=code?'It did not finish, for a reason this page does not recognise.':'It did not finish. The companion recorded no reason.';
    const clause=terminalClause(row.terminalReason);
    return {kind,code:has(REASONS,code)||code==='cancelled'?code:code?'unknown':null,text:body,terminalText:clause,withheld:false};
  }

  /* ---------- the feed ---------- */
  function feedItem(r,info,now,boardRedacted){
    const st=stateOf(r),redacted=r.redacted||boardRedacted===true;
    const ended=r.state==='completed'||r.state==='failed'||r.state==='cancelled';
    const start=time(r.startedAt),end=time(r.endedAt);
    let durationMs=null;
    if(start!==null&&end!==null)durationMs=Math.max(0,end-start);
    else if(start!==null&&isActive(r)&&now!==null)durationMs=Math.max(0,now-start);
    const calls=r.toolCalls.total;
    const callText=calls===null?'':plural(calls,'tool call');
    let happened;
    if(st===STATES.running)happened='Running, '+(calls===null||calls===0?'no tool calls yet':calls+' tool '+(calls===1?'call':'calls')+' so far');
    else if(st===STATES.queued)happened='Waiting to start';
    else if(redacted){
      const parts=[st===STATES.completed?'Completed':st===STATES.failed?'Failed':st===STATES.cancelled?'Cancelled':st===STATES.discarded?'Discarded by the audit':'State not recognised'];
      if(callText&&ended)parts.push(callText);
      if(st===STATES.completed)parts.push(r.audit&&r.audit.status==='CLEAN'?'audit CLEAN':'audit pending');
      happened=parts.join(', ');
    }else if(st===STATES.completed){
      const parts=['Completed'+(durationMs!==null?' in '+formatDuration(durationMs):'')];
      if(callText)parts.push(callText);
      parts.push(r.audit&&r.audit.status==='CLEAN'?'audit CLEAN':'audit pending');
      const clause=terminalClause(r.terminalReason);
      if(clause)parts.push('ended because '+clause);
      happened=parts.join(', ');
    }else if(st===STATES.discarded){
      const v=r.audit&&r.audit.violationCount;
      happened='Discarded by the audit'+(v?': '+plural(v,'violation')+' recorded':'')+'. Kept for reading, not classified, not counted';
    }else if(st===STATES.failed||st===STATES.cancelled){
      const d=describeFailure(r);
      happened=d.text.replace(/\.$/,'');
      if(d.terminalText&&!(r.failureReason==='budget'&&r.terminalReason==='budget_exhausted'))happened+='. The runtime said it ended because '+d.terminalText;
    }else happened='The companion reported a state this page does not recognise';
    if(redacted)happened+='. '+WITHHELD;
    const needsVerdict=isClean(r)&&!r.humanVerdict;
    const model=r.resolvedModel||r.requestedModel;
    const evidence=r.evidencePath!==undefined?r.evidencePath:ended?evidencePath(r.roundId,r.n):null;
    return {
      key:r.key,kind:'pilot',roundId:r.roundId,n:r.n,runId:r.runId,
      taskName:info.name,taskKey:info.key,unassigned:info.unassigned,
      roundLabel:r.roundLabel,roundName:roundName(r.roundLabel,r.roundId),roundStatus:r.roundStatus,
      arrivedAt:r.arrivedAt,startedAt:r.startedAt,endedAt:r.endedAt,
      state:r.state,stateKey:st.key,glyph:st.glyph,stateWord:st.word,
      audit:r.audit?{status:r.audit.status,violationCount:r.audit.violationCount}:null,
      auditLabel:r.audit&&r.audit.status?r.audit.status:isActive(r)?'':r.state==='completed'?'Pending':'Not audited',
      what:'Pilot '+r.n+' · '+roundName(r.roundLabel,r.roundId)+(model?' · '+model:''),
      happened,
      output:{files:r.outputCount,chars:r.finalChars,relPath:evidence,workingFolder:r.workingFolder,ready:!!evidence},
      turns:r.numTurns,toolCalls:calls,model:model||'',durationMs,durationText:durationMs===null?'':formatDuration(durationMs),
      needsVerdict,verdict:r.humanVerdict?{id:r.humanVerdict,label:has(VERDICTS,r.humanVerdict)?VERDICTS[r.humanVerdict]:VERDICTS.unclear}:null,
      redacted,ended
    };
  }
  function matchesState(item,state){
    switch(state){
      case 'all':return true;
      case 'running':return item.state==='running'||item.state==='queued';
      case 'needs-verdict':return item.needsVerdict;
      case 'failed':return item.stateKey==='failed';
      case 'discarded':return item.stateKey==='discarded';
      case 'completed':return item.stateKey==='completed';
      case 'cancelled':return item.stateKey==='cancelled';
      case 'waiting':case 'queued':return item.state==='queued';
      default:return true;
    }
  }
  const FILTER_STATES=Object.freeze(['all','running','needs-verdict','failed','discarded','completed','cancelled','waiting']);
  /* buildFeed({ runs, rounds?, filter:{task?,state?}, now, redacted? }) -> { items, groups, counts, filter, skipped }.
     Rounds newest first, pilots ascending inside a round: a state change moves nothing. `rounds` lets a legacy pilot
     (no task field) take the same lineage name the board gives it. */
  function buildFeed(input){
    const inp=isObj(input)?input:{};
    const now=typeof inp.now==='string'?time(inp.now):num(inp.now);
    const rows=dedupeRuns(inp.runs);
    const skipped=list(inp.runs).length-rows.length;
    const resolver=Array.isArray(inp.rounds)?makeResolver(inp.rounds):null;
    const byRound=new Map();
    for(const r of rows){
      if(!byRound.has(r.roundId))byRound.set(r.roundId,[]);
      byRound.get(r.roundId).push(r);
    }
    const infoFor=r=>{
      const known=resolver?resolver.resolveId(r.roundId):null;
      const base=known||{key:'unassigned',name:UNASSIGNED,unassigned:true};
      if(r.task)return {key:normKey(r.task),name:r.task,unassigned:false};
      return base;
    };
    const roundOrder=[];
    for(const [roundId,rs] of byRound){
      rs.sort((a,b)=>a.n-b.n);
      roundOrder.push({roundId,rows:rs,at:minStamp(rs.map(r=>r.arrivedAt))});
    }
    roundOrder.sort((a,b)=>newer(a.at,b.at)||cmp(b.roundId,a.roundId));
    const filterIn=isObj(inp.filter)?inp.filter:{};
    const taskFilter=oneLine(filterIn.task,200);
    const known=new Set(rows.map(r=>infoFor(r).key));
    const wanted=taskFilter?(taskFilter==='unassigned'||known.has(taskFilter)?taskFilter:normKey(taskFilter)):null;
    const stateIn=text(filterIn.state).trim().toLowerCase().replace(/^needs[-_ ]?verdict$/,'needs-verdict');
    const state=FILTER_STATES.includes(stateIn)?stateIn:'all';
    const counts={all:0,running:0,waiting:0,needsVerdict:0,failed:0,discarded:0,completed:0,cancelled:0};
    const items=[],groups=[];
    for(const g of roundOrder){
      const kept=[];
      for(const r of g.rows){
        const item=feedItem(r,infoFor(r),now,inp.redacted===true);
        if(wanted!==null&&item.taskKey!==wanted)continue;
        counts.all++;
        if(item.state==='running'||item.state==='queued')counts.running++;
        if(item.state==='queued')counts.waiting++;
        if(item.needsVerdict)counts.needsVerdict++;
        if(item.stateKey==='failed')counts.failed++;
        else if(item.stateKey==='discarded')counts.discarded++;
        else if(item.stateKey==='completed')counts.completed++;
        else if(item.stateKey==='cancelled')counts.cancelled++;
        if(matchesState(item,state))kept.push(item);
      }
      if(!kept.length)continue;
      items.push(...kept);
      groups.push({roundId:g.roundId,roundName:kept[0].roundName,roundLabel:kept[0].roundLabel,taskName:kept[0].taskName,taskKey:kept[0].taskKey,roundStatus:kept[0].roundStatus,keys:kept.map(i=>i.key),count:kept.length});
    }
    return {items,groups,counts,filter:{task:wanted,state},skipped};
  }

  /* ---------- rounds: facts, version, next action ---------- */
  function normRound(row){
    const cfg=isObj(row.config)?row.config:{},c=isObj(row.counts)?row.counts:null;
    const freezeVersion=Number.isInteger(row.freezeVersion)&&row.freezeVersion>=1?row.freezeVersion:null;
    const counts=c?{queued:nonNeg(c.queued)||0,running:nonNeg(c.running)||0,completed:nonNeg(c.completed)||0,failed:nonNeg(c.failed)||0,cancelled:nonNeg(c.cancelled)||0,discarded:nonNeg(c.discarded)||0,classified:nonNeg(c.classified)||0}:null;
    /* Every pilot is in exactly one state, so the state counts add up to the pilot count when the row does not say. */
    const stated=nonNeg(row.runCount),counted=counts?counts.queued+counts.running+counts.completed+counts.failed+counts.cancelled:null;
    return {
      id:text(row.id),createdAt:text(row.createdAt)||null,label:oneLine(row.label),status:text(row.status),
      packetSha256:text(row.packetSha256),freezeSha256:text(row.freezeSha256),freezeVersion,freezePostHoc:row.freezePostHoc===true,
      contentSha256:text(row.contentSha256),launchedAt:text(row.launchedAt)||null,endedAt:text(row.endedAt)||null,
      lastActivityAt:text(row.lastActivityAt)||null,runCount:stated!==null?stated:counted,plannedCount:nonNeg(cfg.count),
      counts,
      redacted:row.redacted===true
    };
  }
  /* What a round's pilots look like. From the pilot rows when all of them are present; otherwise only the process counts
     the round row carries (and `complete` is false: no verdict tally is made from a partial list). */
  function roundFacts(round,rows){
    const have=rows.length,planned=round.runCount;
    const complete=have>0?planned===null||have>=planned:planned===null||planned===0;
    const total=planned!==null?Math.max(planned,have):have||round.plannedCount||0;
    if(complete){const t=tallyRuns(rows);t.total=Math.max(t.total,planned||0);return {...t,complete:true,source:'rows'};}
    const t=tallyRuns(rows),c=round.counts;
    if(!c)return {...t,total,complete:false,source:'rows',clean:null,classified:null,unclassified:null,needs:[]};
    return {total,queued:c.queued,running:c.running,active:c.queued+c.running,proc:{completed:c.completed,failed:c.failed,cancelled:c.cancelled},
      discarded:c.discarded,failed:c.failed,cancelled:c.cancelled,clean:null,classified:c.classified,unclassified:null,matchedGold:null,fingerprint:null,unclear:null,needs:[],complete:false,source:'counts'};
  }
  const isLive=(round,f)=>round.status==='running'||f.active>0;
  function versionOf(round,depth){
    if(!round)return {label:'',number:0,depth:0,packetShort:'',packetSha256:'',contentShort:'',freezeLabel:'',freezeVersion:null,postHoc:false,frozen:false};
    const packetShort=shortHash(round.packetSha256),number=depth+1;
    const frozen=round.status!=='draft'&&(!!round.freezeSha256||round.freezeVersion!==null);
    const freezeLabel=round.freezeVersion!==null?(round.freezePostHoc?'post-hoc freeze v':'freeze v')+round.freezeVersion:frozen?'frozen':'';
    return {label:'v'+number+(packetShort?' · sha256:'+packetShort:''),number,depth,packetShort,packetSha256:round.packetSha256,contentShort:shortHash(round.contentSha256),freezeLabel,freezeVersion:round.freezeVersion,postHoc:round.freezePostHoc,frozen};
  }
  const carryable=round=>!!(round.freezeSha256||round.freezeVersion!==null);
  const ACTIONS=Object.freeze({
    freeze:{label:'Freeze the round',detail:'Write the gold and freeze it before any run. Nothing runs until you approve the frozen round.',step:'freeze'},
    approve:{label:'Review and approve',detail:'Review the frozen round and approve it in Agents. Nothing runs until you approve it.',step:'round'},
    launch:{label:'Launch',detail:'Approved, not launched. Review and launch it from Agents.',step:'round'},
    export:{label:'Export',detail:'Add the clean, completed pilots to the project experiments, or download the round JSON.',step:'runs'},
    'start-next':{label:'Start next round',detail:'Start a new draft round from this one. It needs its own freeze and approval.',step:'runs'},
    open:{label:CTA,detail:'Pilot details have not loaded yet. Open the round in Agents.',step:'runs'},
    start:{label:'Start a round in Agents',detail:'This task has an imported evaluation result but no round yet.',step:'packet'}
  });
  function makeAction(id,round,o){
    const base=has(ACTIONS,id)?ACTIONS[id]:{label:'',detail:'',step:'runs'};
    const opt=o||{};
    const target={view:'agents',roundId:round&&round.id?round.id:null,step:opt.step||base.step};
    if(opt.runKey)target.runKey=opt.runKey;
    return {id,label:opt.label||base.label,detail:opt.detail||base.detail,cta:CTA,target,urgency:URGENCY[id],blocked:!!opt.blocked,blockedReason:opt.blocked?opt.blockedReason||'':'',primaryEligible:false,roundId:round&&round.id?round.id:null,then:null};
  }
  function thenFor(id,round,anyRunning){
    if(id==='classify')return stripThen(makeAction('export',round));
    if(id==='export')return stripThen(startNext(round,anyRunning));
    return null;
  }
  const stripThen=a=>({id:a.id,label:a.label,detail:a.detail,target:a.target,blocked:a.blocked,blockedReason:a.blockedReason});
  function startNext(round,anyRunning){
    if(anyRunning)return makeAction('start-next',round,{blocked:true,blockedReason:RUNNING_NEXT});
    if(!carryable(round))return makeAction('start-next',round,{blocked:true,blockedReason:'This round has no freeze to carry forward.'});
    return makeAction('start-next',round);
  }
  /* The next step for one round, in the Agents step order: draft -> freeze, frozen -> approve, approved -> launch,
     running -> progress, ended -> classify what is unclassified, then export, then start the next round. */
  function roundAction(round,f,anyRunning){
    const st=round.status;
    if(isLive(round,f)){
      const total=f.total||round.plannedCount||0,done=f.proc.completed;
      const bits=[];
      if(f.running)bits.push(f.running+' running');
      if(f.queued)bits.push(f.queued+' waiting');
      if(f.proc.failed)bits.push(f.proc.failed+' failed');
      if(f.proc.cancelled)bits.push(f.proc.cancelled+' cancelled');
      const label=total?done+' of '+plural(total,'pilot')+' finished':'Pilots are starting';
      return makeAction('watch',round,{label,detail:(bits.length?bits.join(', ')+'. ':'')+'Open the round in Agents to watch the pilots.',step:'runs'});
    }
    if(st==='draft')return makeAction('freeze',round);
    if(st==='frozen')return makeAction('approve',round);
    if(st==='approved')return makeAction('launch',round,anyRunning?{blocked:true,blockedReason:LAUNCH_WAITS}:null);
    if(ENDED.includes(st)){
      if(!f.complete)return makeAction('open',round);
      if(f.unclassified>0){
        const a=makeAction('classify',round,{label:'Classify '+plural(f.unclassified,'clean pilot'),detail:'Open each clean pilot in Agents and record your verdict. Directional only.',runKey:round.id+':'+f.needs[0],blocked:anyRunning,blockedReason:CLASSIFY_WAITS});
        a.then=thenFor('classify',round,anyRunning);
        return a;
      }
      if(f.clean>0){const a=makeAction('export',round);a.then=thenFor('export',round,anyRunning);return a;}
      const a=startNext(round,anyRunning);
      a.detail=carryable(round)&&!anyRunning?'This round has no clean completed pilot to classify or export. Start a new round from it.':a.detail;
      return a;
    }
    return makeAction('open',round,{detail:'This round has a status Finance Task Studio does not recognise. Open it in Agents.'});
  }
  /* nextAction(round, { runs?, anyRunning? }): runs are this round's pilot rows (feed rows, or a round view's runs). */
  function nextAction(input,options){
    const row=isObj(input)?input:{id:'',status:''};
    const o=isObj(options)?options:{};
    const round=normRound(row);
    const rows=dedupeRuns(Array.isArray(o.runs)?o.runs:row.runs,{roundId:round.id}).filter(r=>r.roundId===round.id);
    const f=roundFacts(round,rows);
    return roundAction(round,f,o.anyRunning===true||o.redacted===true||round.redacted);
  }

  /* ---------- imported evaluation records ---------- */
  /* A score is a finite number or a plain numeric string, kept exactly as given. Anything else is not a score. */
  function scoreText(v){
    if(typeof v==='number'&&Number.isFinite(v)){const s=String(v);return /e/i.test(s)?null:s;}
    if(typeof v==='string'){const s=v.trim();return /^-?\d{1,15}(?:\.\d{1,10})?$/.test(s)?s:null;}
    return null;
  }
  function normEval(rec){
    if(!isObj(rec))return null;
    const st=scoreText(rec.score);
    if(st===null)return null;
    const maxText=scoreText(rec.scoreMax);
    const j=rec.judge;
    const judge=isObj(j)?{provider:oneLine(j.provider,80),model:oneLine(j.model,80)}:typeof j==='string'&&j.trim()?{provider:'',model:oneLine(j,80)}:null;
    const attempt=num(rec.attempt)!==null?rec.attempt:typeof rec.attempt==='string'&&rec.attempt.trim()?oneLine(rec.attempt,40):null;
    const at=time(rec.importedAt);
    return {
      id:oneLine(rec.id,120),task:oneLine(rec.task),runId:oneLine(rec.runId,120),attempt,judge,judgeText:judge?[judge.provider,judge.model].filter(Boolean).join(' '):'',
      score:typeof rec.score==='number'?rec.score:rec.score.trim(),scoreText:st,
      scoreMax:maxText===null?null:typeof rec.scoreMax==='number'?rec.scoreMax:rec.scoreMax.trim(),scoreMaxText:maxText,
      scoringMethod:oneLine(rec.scoringMethod,80),importedAt:at===null?'':rec.importedAt,importedDate:at===null?'':new Date(at).toISOString().slice(0,10),
      sourceName:oneLine(rec.sourceName,120),packetSha256:text(rec.packetSha256).trim().toLowerCase().slice(0,128),roundId:text(rec.roundId).slice(0,64)
    };
  }
  /* The latest record per task by importedAt; ties go to the greater id, then run id, then the later in the input. */
  function pickEvaluations(records){
    const best=new Map();
    list(records).forEach((rec,index)=>{
      const e=normEval(rec);
      if(!e)return;
      const key=e.task?normKey(e.task):'unassigned',at=stamp(e.importedAt);
      const old=best.get(key);
      if(old&&(cmp(at,old.at)||cmp(e.id,old.e.id)||cmp(e.runId,old.e.runId)||1)<0)return;
      best.set(key,{e,at});
    });
    const out=new Map();
    for(const [key,v] of best)out.set(key,v.e);
    return out;
  }
  const samePacket=(a,b)=>{
    const x=text(a).toLowerCase(),y=text(b).toLowerCase();
    if(!x||!y)return null;
    if(x===y)return true;
    const [s,l]=x.length<=y.length?[x,y]:[y,x];
    return s.length>=12?l.startsWith(s):null;
  };

  /* ---------- the board ---------- */
  /* The tie-break order for the primary: urgency, then freshest activity, then name, then key (a total order). */
  const rank=(a,b)=>a.urgency-b.urgency||newer(stamp(a.at),stamp(b.at))||cmp(a.name.toLowerCase(),b.name.toLowerCase())||cmp(a.key,b.key);
  const STATUS_LABELS=Object.freeze({running:'Pilots running','needs-verdict':'Needs your verdict',attention:'Needs attention',empty:'No rounds'});
  const IDLE_LABELS=Object.freeze({draft:'Draft round',frozen:'Frozen round',approved:'Approved round',finished:'Round ended',cancelled:'Round cancelled',failed:'Round failed'});
  /* buildBoard({ rounds, runs, evals, now, redacted?, offline? }) -> { status, message, tasks, counts, redacted, ... }.
     status is 'empty' (nothing to show), 'offline' (no companion: file edition or a lost link) or 'live'. */
  function buildBoard(input){
    const inp=isObj(input)?input:{};
    const now=typeof inp.now==='string'?time(inp.now):num(inp.now);
    const offline=inp.offline===true;
    const seenIds=new Set(),rawRounds=[];
    for(const r of list(inp.rounds))if(isObj(r)&&typeof r.id==='string'&&r.id&&!seenIds.has(r.id)){seenIds.add(r.id);rawRounds.push(r);}
    const resolver=makeResolver(rawRounds);
    const rows=dedupeRuns(inp.runs);
    const byRound=new Map();
    for(const r of rows){if(!byRound.has(r.roundId))byRound.set(r.roundId,[]);byRound.get(r.roundId).push(r);}
    let orphanRuns=0;
    for(const [id,rs] of byRound)if(!seenIds.has(id))orphanRuns+=rs.length;
    const rounds=rawRounds.map(raw=>{
      const round=normRound(raw),info=resolver.resolveRow(raw),rs=(byRound.get(round.id)||[]).slice().sort((a,b)=>a.n-b.n);
      return {round,info,rows:rs,facts:roundFacts(round,rs)};
    });
    const redacted=inp.redacted===true||rounds.some(x=>x.round.redacted)||rows.some(r=>r.redacted);
    const anyRunning=redacted||rounds.some(x=>isLive(x.round,x.facts));
    const evals=pickEvaluations(inp.evals);
    const groups=new Map();
    const groupFor=(key,name,unassigned)=>{
      if(!groups.has(key))groups.set(key,{key,name,unassigned,items:[]});
      return groups.get(key);
    };
    for(const x of rounds)groupFor(x.info.key,x.info.name,x.info.unassigned).items.push(x);
    for(const [key,e] of evals)if(!groups.has(key))groupFor(key,e.task||UNASSIGNED,!e.task);
    const incomplete=[];
    const tasks=[...groups.values()].map(g=>{
      const items=g.items.slice().sort((a,b)=>newer(stamp(a.round.createdAt),stamp(b.round.createdAt))||b.info.depth-a.info.depth||cmp(b.round.id,a.round.id));
      const latest=items[0]||null;
      const name=latest&&!latest.info.unassigned?latest.info.name:g.name;
      const ev=evals.get(g.key)||null;
      let active={running:0,waiting:0,total:0,available:!offline,elapsedMs:null};
      let needsVerdict=0,pilotsItem=null,activity=[];
      let best=null;
      const consider=a=>{if(!best||a.urgency<best.urgency)best=a;};
      for(const x of items){
        if(!x.facts.complete)incomplete.push(x.round.id);
        active.running+=x.facts.running;active.waiting+=x.facts.queued;
        needsVerdict+=x.facts.unclassified||0;
        if(!pilotsItem&&x.facts.total>0)pilotsItem=x;
        activity.push(x.round.lastActivityAt,x.round.createdAt,x.round.launchedAt,x.round.endedAt,...x.rows.flatMap(r=>[r.startedAt,r.endedAt]));
        if(isLive(x.round,x.facts)){
          const a=roundAction(x.round,x.facts,anyRunning);
          consider(a);
          const l=time(x.round.launchedAt);
          if(l!==null&&now!==null)active.elapsedMs=Math.max(active.elapsedMs||0,Math.max(0,now-l));
        }
      }
      active.total=active.running+active.waiting;
      const classifyRound=items.find(x=>!isLive(x.round,x.facts)&&ENDED.includes(x.round.status)&&x.facts.complete&&x.facts.unclassified>0);
      if(classifyRound)consider(roundAction(classifyRound.round,classifyRound.facts,anyRunning));
      if(latest&&!isLive(latest.round,latest.facts))consider(roundAction(latest.round,latest.facts,anyRunning));
      if(!latest)best=makeAction('start',null);
      if(offline)active={running:null,waiting:null,total:null,available:false,elapsedMs:null};
      const pilots=pilotsItem?pilotsOf(pilotsItem):null;
      const lastActivityAt=maxIso(activity);
      const running=!offline&&items.some(x=>isLive(x.round,x.facts));
      const lf=latest?latest.facts:null;
      const attention=!!latest&&!isLive(latest.round,latest.facts)&&(latest.round.status==='failed'||(latest.round.status==='finished'&&!!lf&&(lf.discarded>0||lf.failed>0)));
      let status,statusLabel;
      if(!latest){status='empty';statusLabel=STATUS_LABELS.empty;}
      else if(running){status='running';statusLabel=STATUS_LABELS.running;}
      else if(needsVerdict>0){status='needs-verdict';statusLabel=STATUS_LABELS['needs-verdict'];}
      else if(attention){status='attention';statusLabel=STATUS_LABELS.attention;}
      else{status='idle';statusLabel=has(IDLE_LABELS,latest.round.status)?IDLE_LABELS[latest.round.status]:'Idle';}
      let evaluation=null;
      if(ev){
        const recorded=ev.packetSha256||(ev.roundId&&seenIds.has(ev.roundId)?(rounds.find(x=>x.round.id===ev.roundId)||{round:{}}).round.packetSha256:'');
        const same=latest?samePacket(recorded,latest.round.packetSha256):null;
        evaluation={score:ev.score,scoreText:ev.scoreText,scoreMax:ev.scoreMax,scoreMaxText:ev.scoreMaxText,runId:ev.runId,attempt:ev.attempt,judge:ev.judge,judgeText:ev.judgeText,importedAt:ev.importedAt,importedDate:ev.importedDate,sourceName:ev.sourceName,scoringMethod:ev.scoringMethod,id:ev.id,versionNote:same===false?'Earlier version':''};
      }
      return {
        key:g.key,name,unassigned:g.unassigned,
        roundIds:items.map(x=>x.round.id),latestRoundId:latest?latest.round.id:null,latestRoundStatus:latest?latest.round.status:'',
        version:versionOf(latest&&latest.round,latest?latest.info.depth:0),
        active,pilots,evaluation,needsVerdict,
        nextAction:best,lastActivityAt,status,statusLabel,redacted,
        incomplete:items.some(x=>!x.facts.complete),
        _first:minStamp(items.map(x=>x.round.createdAt)),_rank:{urgency:best.urgency,at:lastActivityAt,name,key:g.key,blocked:best.blocked}
      };
    });
    /* Cards keep the order the tasks were started in (a new round never moves a card); Unassigned is last. */
    tasks.sort((a,b)=>(a.unassigned?1:0)-(b.unassigned?1:0)||cmp(a._first,b._first)||cmp(a.name.toLowerCase(),b.name.toLowerCase())||cmp(a.key,b.key));
    let primary=null;
    for(const t of tasks){
      if(offline||t._rank.blocked||t._rank.urgency>PRIMARY_MAX)continue;
      if(!primary||rank(t._rank,primary._rank)<0)primary=t;
    }
    for(const t of tasks){
      t.nextAction.primaryEligible=t===primary;
      delete t._first;delete t._rank;
    }
    const sum=pick=>offline?null:tasks.reduce((n,t)=>n+pick(t),0);
    const status=offline?'offline':tasks.length?'live':'empty';
    return {
      version:VERSION,status,message:offline?OFFLINE_MESSAGE:tasks.length?'':EMPTY_BOARD,tasks,
      counts:{tasks:tasks.length,running:sum(t=>t.active.total),waiting:sum(t=>t.active.waiting),needsVerdict:tasks.reduce((n,t)=>n+t.needsVerdict,0),
        tasksRunning:offline?null:tasks.filter(t=>t.status==='running').length,tasksNeedingVerdict:tasks.filter(t=>t.needsVerdict>0).length},
      redacted,offline,stale:offline&&rawRounds.length>0,incomplete:[...new Set(incomplete)].sort(),orphanRuns,
      primaryTaskKey:primary?primary.key:null,asOf:now===null?null:new Date(now).toISOString()
    };
  }
  function pilotsOf(x){
    const f=x.facts,name=roundName(x.round.label,x.round.id);
    if(!f.complete)return {roundId:x.round.id,roundLabel:x.round.label,roundName:name,n:null,matchedGold:null,fingerprint:null,unclear:null,unclassified:null,discarded:null,failed:null,cancelled:null,active:f.active,total:f.total,complete:false,directional:''};
    return {roundId:x.round.id,roundLabel:x.round.label,roundName:name,n:f.clean,matchedGold:f.matchedGold,fingerprint:f.fingerprint,unclear:f.unclear,unclassified:f.unclassified,discarded:f.discarded,failed:f.failed,cancelled:f.cancelled,active:f.active,total:f.total,complete:true,directional:'Directional only, n = '+f.clean+'.'};
  }

  /* ---------- score rows (SPEC 3.2 wording; three kinds that are never mixed) ---------- */
  function scoreRows(task){
    const t=isObj(task)?task:{};
    const rows=[];
    const p=isObj(t.pilots)?t.pilots:null,e=isObj(t.evaluation)?t.evaluation:null;
    if(p){
      let body;
      const whole=['n','matchedGold','fingerprint','unclear','unclassified','discarded','failed'].every(k=>Number.isInteger(p[k])&&p[k]>=0);
      if(p.complete===false||!whole)body='Latest local pilots (round '+(p.roundName||p.roundLabel||p.roundId||'')+'): the pilot list has not loaded yet. Open the round in Agents.';
      else{
        body='Latest local pilots (round '+(p.roundName||p.roundLabel||p.roundId||'')+'): '+p.matchedGold+' matched the frozen gold, '+p.fingerprint+' landed on a frozen fingerprint, '+p.unclear+' unclear, '+p.unclassified+' not classified. Directional only, n = '+p.n+'. Discarded '+p.discarded+' and failed '+p.failed+' are not counted.';
        const extra=[];
        if(p.cancelled>0)extra.push('cancelled '+p.cancelled);
        if(p.active>0)extra.push('still running '+p.active);
        if(extra.length)body+=' '+extra.join(' and ').replace(/^./,c=>c.toUpperCase())+' are not counted.';
      }
      rows.push({kind:'pilots',label:'Local pilots',text:body,note:'',roundId:p.roundId});
    }
    if(e){
      /* a record straight from the evaluation parser (no scoreText) is read the same way the picker reads it */
      const shown=e.scoreText!==undefined?e.scoreText:scoreText(e.score);
      const maxShown=e.scoreMaxText!==undefined?e.scoreMaxText:scoreText(e.scoreMax);
      const at=time(e.importedAt),date=typeof e.importedDate==='string'&&e.importedDate?e.importedDate:at===null?'':new Date(at).toISOString().slice(0,10);
      if(shown!==null&&shown!==''){
        rows.push({kind:'evaluation',label:'Imported evaluation result',
          text:'Imported evaluation result: '+shown+(maxShown?' / '+maxShown:'')+', run '+(oneLine(e.runId,120)||'not recorded')+', '+(date||'date not recorded')+'. Recorded by you from the evaluation; Finance Task Studio did not compute it.',
          note:e.versionNote==='Earlier version'?'Earlier version':'',roundId:null});
      }
    }
    if(!e||!rows.some(r=>r.kind==='evaluation'))rows.push({kind:'empty',label:'Score',text:EMPTY_SCORE,note:'',roundId:null});
    return rows;
  }

  const api={VERSION,WITHHELD,OFFLINE_MESSAGE,EMPTY_SCORE,EMPTY_BOARD,STATES,VERDICTS,URGENCY,
    taskKey,taskName,resolveTask,makeResolver,tallyRuns:rows=>{const t=tallyRuns(dedupeRuns(rows));delete t.proc;return t;},
    pickEvaluations,buildBoard,scoreRows,nextAction,buildFeed,describeFailure,formatDuration,shortHash,evidencePath};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.FinanceMissionModel=api;
})(typeof window!=='undefined'?window:globalThis);
