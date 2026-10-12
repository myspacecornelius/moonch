/* Shared UI kit for Mission Control and the Evidence Workbench (SPEC 2.6). Global FinanceViews.
   Rules this file keeps:
   - The first half is pure (no DOM, no clock unless one is passed in) and runs under node --test: html/raw, clamp, planKeyed/applyPlan,
     makeAnnouncer, trimRing, stepClass, formatTime/ago/duration, nextListIndex/nextTreeIndex/nextSplitterStep, makeStore.
   - Nothing touches document, navigator, localStorage or timers when the file loads. Every DOM, clipboard, storage and timer use is
     feature-checked or in try/catch, so the kit loads and degrades quietly inside the minimal fake documents of the page tests.
   - Markup goes through html`` (interpolations are escaped unless they are the result of html or raw). A plain string given to setHtml
     or returned by a render callback is trusted markup. Always put an interpolation inside a QUOTED attribute value (title="${x}"):
     escaping keeps text inside its quotes, it cannot protect an unquoted value, and it does not vet URLs for href or src.
     Attributes are written with setAttribute only; the kit never writes an inline style attribute or an event-handler attribute,
     and it never changes the tab title.
   - Expando properties on elements: vkHtml (last markup written), vkAttrs (attributes keyedPatch set), vkListbox (the bound listbox). */
(function(scope){
  'use strict';

  const isFn=f=>typeof f==='function';
  const str=x=>{try{return String(x==null?'':x);}catch{return '';}};
  const int=(x,dflt)=>{const n=Number(x);return Number.isFinite(n)?Math.floor(n):dflt;};
  const nonNeg=(x,dflt)=>{const n=Number(x);return Number.isFinite(n)&&n>=0?n:dflt;};
  const safe=(fn,dflt)=>{try{return fn();}catch{return dflt;}};

  /* ---------- Markup: html tagged template and raw() ---------- */
  const ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'};
  const esc=x=>str(x).replace(/[&<>"'`]/g,c=>ESC[c]);
  class Raw{constructor(text){this.text=text;}toString(){return this.text;}}
  const raw=x=>x instanceof Raw?x:new Raw(str(x));
  const isRaw=x=>x instanceof Raw;
  function part(value){
    if(value instanceof Raw)return value.text;
    if(Array.isArray(value)){let out='';for(const item of value)out+=part(item);return out;}
    if(value===false||value===true||value==null)return '';
    return esc(value);
  }
  function html(strings,...values){
    let out=strings[0];
    for(let i=0;i<values.length;i++)out+=part(values[i])+strings[i+1];
    return new Raw(out);
  }
  const toText=markup=>markup instanceof Raw?markup.text:str(markup);

  /* ---------- Numbers ---------- */
  /* clamp(n, lo, hi) keeps n inside the range; reversed bounds are swapped; NaN counts as 0 (so it lands on lo, 0 or hi). */
  function clamp(n,lo,hi){
    let a=Number(lo),b=Number(hi),x=Number(n);
    if(Number.isNaN(a))a=-Infinity;
    if(Number.isNaN(b))b=Infinity;
    if(a>b){const t=a;a=b;b=t;}
    if(Number.isNaN(x))x=0;
    return Math.min(Math.max(x,a),b);
  }
  /* Class name for one of `steps` discrete sizes (the log drawer has 6): stepClass(3, 6) is "step-3"; out of range is clamped. */
  function stepClass(n,steps,prefix){
    const count=Math.max(1,int(steps,1));
    return (prefix===undefined?'step-':str(prefix))+clamp(Math.round(Number(n)),0,count-1);
  }

  /* ---------- Keyed list plan ---------- */
  function normKeys(list,name){
    if(!Array.isArray(list))throw new TypeError('planKeyed: '+name+' must be an array of keys');
    const keys=new Array(list.length),index=new Map();
    for(let i=0;i<list.length;i++){
      const k=list[i];
      if(typeof k!=='string'&&!(typeof k==='number'&&Number.isFinite(k)))throw new TypeError('planKeyed: '+name+'['+i+'] is not a string or finite number key');
      const s=String(k);
      if(index.has(s))throw new Error('planKeyed: duplicate key "'+(s.length>60?s.slice(0,60)+'...':s)+'" in '+name+' at index '+i+' (first at '+index.get(s)+')');
      index.set(s,i);
      keys[i]=s;
    }
    return {keys,index};
  }
  /* Indexes (into seq) of one longest strictly increasing subsequence of seq (distinct numbers). */
  function longestIncreasing(seq){
    const tails=[],before=new Array(seq.length);
    for(let i=0;i<seq.length;i++){
      let lo=0,hi=tails.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(seq[tails[mid]]<seq[i])lo=mid+1;else hi=mid;}
      before[i]=lo?tails[lo-1]:-1;
      tails[lo]=i;
    }
    const out=[];
    for(let k=tails.length?tails[tails.length-1]:-1;k>=0;k=before[k])out.push(k);
    return out.reverse();
  }
  /* planKeyed(prevKeys, nextKeys) -> ops. Apply them in array order to prevKeys and the result is nextKeys.
       { op:'remove', key, from }            from = index in prevKeys. All removals come first, in prevKeys order.
       { op:'keep',   key, from, to, before }
       { op:'move',   key, from, to, before }
       { op:'insert', key, to, before }      to = index in nextKeys; before = the key that follows it in nextKeys, or null for the end.
     The rest follow in order from the END of nextKeys to its start, so `before` is always already in its final place when the op runs
     (a move or insert puts the key directly in front of `before`, or last when null). Keys on a longest increasing run stay (keep);
     only the others move, so the number of moves is the minimum possible. Duplicate keys, in either list, throw. */
  function planKeyed(prevKeys,nextKeys){
    const P=normKeys(prevKeys,'prevKeys'),N=normKeys(nextKeys,'nextKeys'),prev=P.keys,next=N.keys,ops=[];
    for(let i=0;i<prev.length;i++)if(!N.index.has(prev[i]))ops.push({op:'remove',key:prev[i],from:i});
    const seq=[],at=[];
    for(let i=0;i<next.length;i++){const p=P.index.get(next[i]);if(p!==undefined){seq.push(p);at.push(i);}}
    const stable=new Set(longestIncreasing(seq).map(j=>at[j]));
    for(let i=next.length-1;i>=0;i--){
      const key=next[i],before=i+1<next.length?next[i+1]:null,from=P.index.get(key);
      if(from===undefined)ops.push({op:'insert',key,to:i,before});
      else ops.push({op:stable.has(i)?'keep':'move',key,from,to:i,before});
    }
    return ops;
  }
  /* Apply a plan to a key list (pure). Throws if an op does not fit the list, which means the plan was made for another list. */
  function applyPlan(prevKeys,ops){
    const cur=prevKeys.map(String);
    for(const o of ops){
      if(o.op==='keep'){if(cur.indexOf(o.key)<0)throw new Error('applyPlan: keep of unknown key "'+o.key+'"');continue;}
      if(o.op==='remove'||o.op==='move'){
        const i=cur.indexOf(o.key);
        if(i<0)throw new Error('applyPlan: '+o.op+' of unknown key "'+o.key+'"');
        cur.splice(i,1);
      }else if(o.op==='insert'&&cur.indexOf(o.key)>=0)throw new Error('applyPlan: insert of existing key "'+o.key+'"');
      if(o.op==='insert'||o.op==='move'){
        const at=o.before==null?cur.length:cur.indexOf(o.before);
        if(at<0)throw new Error('applyPlan: unknown anchor "'+o.before+'"');
        cur.splice(at,0,o.key);
      }
    }
    return cur;
  }

  /* ---------- Announcements (pure core) ---------- */
  /* Only these kinds of change may be announced. Tool-call counts, elapsed time and other progress are never announced. */
  const TERMINAL_KINDS=Object.freeze(['completed','failed','discarded','cancelled','new-round','link-lost','link-restored']);
  const TERMINAL_SET=new Set(TERMINAL_KINDS);
  const cleanLine=s=>str(s).replace(/\s+/g,' ').trim();
  function clip(s,max){
    if(s.length<=max)return s;
    let cut=s.slice(0,Math.max(0,max-1));
    if(/[\ud800-\udbff]$/.test(cut))cut=cut.slice(0,-1);
    return cut.replace(/\s+$/,'')+'\u2026';
  }
  /* One announcement from the queued sentences: whole sentences while they fit, then "+N more", never above max characters. */
  function compose(list,max){
    if(list.length===1)return clip(list[0],max);
    const parts=list.map(s=>/[.!?\u2026]$/.test(s)?s:s+'.');
    let out='',used=0;
    for(let i=0;i<parts.length;i++){
      const left=parts.length-(i+1),suffix=left?' +'+left+' more':'',candidate=out?out+' '+parts[i]:parts[i];
      if((candidate+suffix).length>max)break;
      out=candidate;used=i+1;
    }
    if(used===parts.length)return out;
    if(!used){const rest=' +'+(parts.length-1)+' more';return clip(parts[0],Math.max(1,max-rest.length))+rest;}
    return out+' +'+(parts.length-used)+' more';
  }
  /* makeAnnouncer({ now, emit, coalesceMs=4000, minGapMs=8000, maxChars=160 }).
       say(text, { kind })  queue a polite sentence; a kind that is not terminal is dropped. Returns ms until the next emission, or null.
       tick()               emit the queue if it is due; returns ms until the next emission, or null.
       alert(text, { key }) emit now on the assertive path (link loss). With a key it fires once until resolve(key) is called.
       resolve(key), flush(), reset(), pending(), delay()
     Sentences queued within 4 s of the first one go out as one message, and two messages are never closer than 8 s (an alert counts as
     a message and is never delayed). emit(text, { assertive }) is the only side effect. */
  function makeAnnouncer(config){
    const c=config||{};
    const now=isFn(c.now)?c.now:()=>Date.now();
    const out=isFn(c.emit)?c.emit:()=>{};
    const coalesceMs=nonNeg(c.coalesceMs,4000),gapMs=nonNeg(c.minGapMs,8000),maxChars=Math.max(8,int(c.maxChars,160));
    let queue=[],firstAt=null,lastAt=null,droppedKinds=0;
    const latched=new Set();
    const emit=(text,assertive)=>{try{out(text,{assertive});}catch{/* an emit callback must not break the page */}};
    const dueAt=()=>queue.length?Math.max(firstAt+coalesceMs,lastAt===null?-Infinity:lastAt+gapMs):null;
    function delay(){const d=dueAt();return d===null?null:Math.max(0,d-now());}
    function tick(){
      const t=now();
      if(lastAt!==null&&t<lastAt)lastAt=t;
      if(firstAt!==null&&t<firstAt)firstAt=t;
      const d=dueAt();
      if(d!==null&&t>=d){
        const text=compose(queue,maxChars);
        queue=[];firstAt=null;lastAt=t;
        emit(text,false);
        return null;
      }
      return d===null?null:d-t;
    }
    function say(text,opts){
      const kind=opts&&opts.kind;
      if(kind!==undefined&&kind!==null&&!TERMINAL_SET.has(String(kind))){droppedKinds++;return null;}
      const line=cleanLine(text);
      if(!line)return null;
      tick();
      if(!queue.length)firstAt=now();
      if(!queue.includes(line))queue.push(line);
      return delay();
    }
    function alert(text,opts){
      const line=cleanLine(text),key=opts&&opts.key!=null?String(opts.key):'';
      if(!line||(key&&latched.has(key)))return false;
      if(key)latched.add(key);
      lastAt=now();
      emit(clip(line,maxChars),true);
      return true;
    }
    function flush(){
      if(!queue.length)return false;
      const text=compose(queue,maxChars);
      queue=[];firstAt=null;lastAt=now();
      emit(text,false);
      return true;
    }
    return {say,tick,alert,flush,delay,resolve:key=>{latched.delete(String(key));},reset:()=>{queue=[];firstAt=null;},pending:()=>queue.length,dropped:()=>droppedKinds};
  }

  /* ---------- Rings, time ---------- */
  /* How many of the oldest lines to drop from a ring of `length` lines kept within `max`: nothing up to max, then whole steps of
     `trimBy` (so the cut happens once per trimBy new lines, not on every line). Always leaves at least one line. */
  function ringDrop(length,max,trimBy){
    const len=Math.max(0,int(length,0)),m=Math.max(1,int(max,1)),by=clamp(int(trimBy,1),1,m);
    return len<=m?0:Math.ceil((len-m)/by)*by;
  }
  /* trimRing(lines, max, trimBy) -> the lines to keep (the newest ones). Never mutates; returns the same array when nothing is dropped,
     and how many were dropped is lines.length minus the result's length (or ringDrop). */
  function trimRing(lines,max,trimBy){
    if(!Array.isArray(lines))return [];
    const drop=ringDrop(lines.length,max,trimBy);
    return drop?lines.slice(drop):lines;
  }
  const pad2=n=>String(n).padStart(2,'0');
  function toMs(v){
    if(v instanceof Date)return v.getTime();
    if(typeof v==='number')return Number.isFinite(v)?v:NaN;
    if(typeof v==='string'&&v.trim())return Date.parse(v);
    return NaN;
  }
  /* "14:05:09" in local time (an ISO string, a number of milliseconds or a Date). "--:--:--" when it is not a time. */
  function formatTime(value,opts){
    const withSeconds=!(opts&&opts.seconds===false),t=toMs(value),d=Number.isFinite(t)?new Date(t):null;
    if(!d||Number.isNaN(d.getTime()))return withSeconds?'--:--:--':'--:--';
    return pad2(d.getHours())+':'+pad2(d.getMinutes())+(withSeconds?':'+pad2(d.getSeconds()):'');
  }
  /* "just now", "12 s ago", "4 min ago", "3 h ago", "2 d ago". `now` defaults to the clock; a time in the future reads "just now". */
  function ago(then,now){
    const a=toMs(then),b=now===undefined?Date.now():toMs(now);
    if(!Number.isFinite(a)||!Number.isFinite(b))return '';
    const s=Math.floor(Math.max(0,b-a)/1000);
    if(s<5)return 'just now';
    if(s<60)return s+' s ago';
    const m=Math.floor(s/60);
    if(m<60)return m+' min ago';
    const h=Math.floor(m/60);
    return h<24?h+' h ago':Math.floor(h/24)+' d ago';
  }
  /* "4m 12s": the Agents page's wording (spanText) for a span in milliseconds. "-" when it is not a number. */
  function duration(ms){
    const n=typeof ms==='number'?ms:NaN;
    if(!Number.isFinite(n))return '-';
    const s=Math.max(0,Math.round(n/1000));
    return Math.floor(s/60)+'m '+pad2(s%60)+'s';
  }

  /* ---------- Keyboard plans (pure) ---------- */
  /* Listbox cursor: the next index for ArrowUp/Down, Home/End and PageUp/PageDown (by 8), clamped, never wrapping. null when the key
     is not a cursor key or the list is empty. With no current index (-1) Down, PageDown and Home go to the first, the others to the last. */
  function nextListIndex(count,index,key,pageSize){
    const n=int(count,0);
    if(n<1)return null;
    const page=Math.max(1,int(pageSize,8)),cur=Number.isInteger(index)&&index>=0&&index<n?index:-1;
    switch(key){
      case 'ArrowDown':return cur<0?0:Math.min(n-1,cur+1);
      case 'ArrowUp':return cur<0?n-1:Math.max(0,cur-1);
      case 'PageDown':return cur<0?0:Math.min(n-1,cur+page);
      case 'PageUp':return cur<0?n-1:Math.max(0,cur-page);
      case 'Home':return 0;
      case 'End':return n-1;
      default:return null;
    }
  }
  /* tabindex values for a roving-tabindex group: 0 on the current item, -1 on the rest (all -1 when there is no current item). */
  function rovingTabindex(count,index){
    const n=Math.max(0,int(count,0));
    return Array.from({length:n},(_,i)=>i===index?0:-1);
  }
  /* Tree (WAI-ARIA tree view). items are the VISIBLE rows in order: { level (aria-level, from 1), expanded (true|false for a parent,
     absent for a leaf), disabled? }. Returns { index, action } with action 'move' (go to index), 'expand', 'collapse' (act on index)
     or 'none'; null when the key is not a tree key. ArrowRight on a closed parent expands it, on an open parent goes to its first
     child; ArrowLeft on an open parent collapses it, otherwise goes to the parent row. Up/Down/Home/End skip disabled rows. */
  function nextTreeIndex(items,index,key){
    if(!Array.isArray(items)||!items.length)return null;
    const n=items.length,cur=Number.isInteger(index)&&index>=0&&index<n?index:-1;
    const row=i=>items[i]&&typeof items[i]==='object'?items[i]:{};
    const level=i=>Math.max(1,int(row(i).level,1));
    const parent=i=>row(i).expanded===true||row(i).expanded===false;
    const usable=i=>!row(i).disabled;
    const go=j=>({index:j<0?cur:j,action:j<0||j===cur?'none':'move'});
    const scan=(from,step)=>{for(let i=from;i>=0&&i<n;i+=step)if(usable(i))return i;return -1;};
    switch(key){
      case 'ArrowDown':return go(scan(cur<0?0:cur+1,1));
      case 'ArrowUp':return go(scan(cur<0?n-1:cur-1,-1));
      case 'Home':return go(scan(0,1));
      case 'End':return go(scan(n-1,-1));
      case 'ArrowRight':
        if(cur<0||!parent(cur))return {index:cur,action:'none'};
        if(row(cur).expanded===false)return {index:cur,action:'expand'};
        return cur+1<n&&level(cur+1)>level(cur)?{index:cur+1,action:'move'}:{index:cur,action:'none'};
      case 'ArrowLeft':{
        if(cur<0)return {index:cur,action:'none'};
        if(parent(cur)&&row(cur).expanded===true)return {index:cur,action:'collapse'};
        for(let i=cur-1;i>=0;i--)if(level(i)<level(cur))return {index:i,action:'move'};
        return {index:cur,action:'none'};
      }
      default:return null;
    }
  }
  /* Splitter of a bottom drawer with steps 0..5 (0 is collapsed). ArrowUp grows it (the handle moves up), ArrowDown shrinks it,
     PageUp/PageDown change it by 3, Home collapses, End goes to the largest, Enter and Space toggle between collapsed and
     opts.restore (default 3). opts: { max=5, page=3, restore=3, invert }. Returns the new step, or null for any other key
     (Escape never collapses it). */
  const SPLITTER_MAX=5;
  function nextSplitterStep(step,key,opts){
    const o=opts||{},max=Math.max(1,int(o.max,SPLITTER_MAX)),page=Math.max(1,int(o.page,3)),sign=o.invert?-1:1;
    const cur=clamp(Math.round(Number(step)),0,max);
    switch(key){
      case 'ArrowUp':return clamp(cur+sign,0,max);
      case 'ArrowDown':return clamp(cur-sign,0,max);
      case 'PageUp':return clamp(cur+sign*page,0,max);
      case 'PageDown':return clamp(cur-sign*page,0,max);
      case 'Home':return 0;
      case 'End':return max;
      case 'Enter':case ' ':case 'Spacebar':return cur>0?0:clamp(int(o.restore,3),1,max);
      default:return null;
    }
  }

  /* ---------- Storage ---------- */
  const STORE_KEYS=Object.freeze({evals:'fts.evals.v1',links:'fts.links.v1',mc:'fts.mc.v1',wb:'fts.wb.v1'});
  /* A JSON wrapper over a Storage-like object (getBacking returns it, or throws or returns nothing when storage is blocked).
     Nothing here throws. A write that storage refuses is kept in memory for this page, so the session still sees it; set() then
     returns false. get() returns `fallback` for a missing, corrupt or (optional `check` returns false) wrongly shaped value. */
  function makeStore(getBacking){
    const shadow=new Map();
    const backing=()=>{
      try{
        const b=getBacking();
        return b&&isFn(b.getItem)&&isFn(b.setItem)&&isFn(b.removeItem)?b:null;
      }catch{return null;}
    };
    function readRaw(key){
      if(shadow.has(key))return shadow.get(key);
      const b=backing();
      if(!b)return null;
      try{const v=b.getItem(key);return v==null?null:String(v);}catch{return null;}
    }
    function get(key,fallback,check){
      const text=readRaw(String(key));
      if(text===null)return fallback;
      let value;
      try{value=JSON.parse(text);}catch{return fallback;}
      if(isFn(check)&&!safe(()=>check(value),false))return fallback;
      return value;
    }
    function remove(key){
      const k=String(key),b=backing();
      let ok=false;
      if(b){try{b.removeItem(k);ok=true;}catch{ok=false;}}
      if(ok)shadow.delete(k);else shadow.set(k,null);
      return ok;
    }
    function set(key,value){
      const k=String(key);
      let text;
      try{text=JSON.stringify(value);}catch{return false;}
      if(typeof text!=='string'){remove(k);return false;}
      const b=backing();
      if(b){try{b.setItem(k,text);shadow.delete(k);return true;}catch{/* quota or blocked: keep it in memory */}}
      shadow.set(k,text);
      return false;
    }
    function available(){
      const b=backing();
      if(!b)return false;
      try{b.setItem('fts.probe','1');b.removeItem('fts.probe');return true;}catch{return false;}
    }
    return {get,set,remove,available,keys:STORE_KEYS};
  }
  const store=makeStore(()=>scope.localStorage);

  /* ---------- DOM helpers ---------- */
  const docOf=el=>safe(()=>(el&&el.ownerDocument)||scope.document||null,null);
  const getAttr=(n,name)=>safe(()=>n&&isFn(n.getAttribute)?n.getAttribute(name):null,null);
  const setAttr=(n,name,value)=>{try{if(n&&isFn(n.setAttribute))n.setAttribute(name,value);}catch{/* not an element */}};
  const delAttr=(n,name)=>{try{if(n&&isFn(n.removeAttribute))n.removeAttribute(name);}catch{/* not an element */}};
  const hasIn=(root,n)=>safe(()=>{if(!root||!n)return false;if(isFn(root.contains))return root.contains(n);return n.parentNode===root;},false);
  const queryAll=(root,selector)=>safe(()=>root&&isFn(root.querySelectorAll)?Array.prototype.slice.call(root.querySelectorAll(selector)):[],[]);
  /* [name="value"] with the value escaped as a CSS string: quotes and backslashes, and control characters (a raw newline is invalid in a CSS string). */
  const attrSelector=(name,value)=>'['+name+'="'+str(value).replace(/["\\]/g,'\\$&').replace(/[\u0000-\u001f\u007f]/g,c=>'\\'+c.charCodeAt(0).toString(16)+' ')+'"]';
  const detach=n=>{try{if(!n)return;if(isFn(n.remove))n.remove();else if(n.parentNode)n.parentNode.removeChild(n);}catch{/* already gone */}};
  const prevent=e=>{try{if(e&&isFn(e.preventDefault))e.preventDefault();}catch{/* synthetic event */}};
  const INTERACTIVE=new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY']);
  const isInteractive=n=>INTERACTIVE.has(str(n&&n.tagName).toUpperCase());

  /* ---------- setHtml ---------- */
  /* Write markup into el unless it is the markup already there (compared with the last markup this function wrote), and keep what a
     repaint would otherwise lose:
       - scrollTop/scrollLeft of descendants marked data-keep-scroll (their identity is the attribute value, else data-key, else id, else
         their position) and of el itself when it carries the attribute;
       - the open state of <details> (identity data-key, else id, else position);
       - keyboard focus, found again by data-key (else id), without scrolling, with the caret of a text field.
     opts: { force } (or `true`) writes even when the markup is unchanged. Returns true when it wrote. Whoever changes el's children
     another way must call invalidate(el). */
  const keyOfScroller=(n,i)=>getAttr(n,'data-keep-scroll')||getAttr(n,'data-key')||getAttr(n,'id')||'#'+i;
  const keyOfDetails=(n,i)=>getAttr(n,'data-key')||getAttr(n,'id')||'#'+i;
  function snapshot(el){
    const snap={scrolls:new Map(),open:new Set(),key:null,id:null,caret:null};
    const doc=docOf(el),active=doc&&doc.activeElement;
    if(active&&active!==el&&hasIn(el,active)){
      snap.key=getAttr(active,'data-key');
      snap.id=snap.key?null:getAttr(active,'id');
      snap.caret=safe(()=>typeof active.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null,null);
    }
    const keep=(n,id)=>{
      const top=Number(n.scrollTop)||0,left=Number(n.scrollLeft)||0;
      if(top>0||left>0)snap.scrolls.set(id,{top,left});
    };
    if(getAttr(el,'data-keep-scroll')!==null)keep(el,'@self');
    queryAll(el,'[data-keep-scroll]').forEach((n,i)=>keep(n,keyOfScroller(n,i)));
    queryAll(el,'details').forEach((n,i)=>{if(n.open===true||getAttr(n,'open')!==null)snap.open.add(keyOfDetails(n,i));});
    return snap;
  }
  function restore(el,snap){
    if(snap.scrolls.size){
      const put=(n,id)=>{const s=snap.scrolls.get(id);if(s){n.scrollTop=s.top;n.scrollLeft=s.left;}};
      if(getAttr(el,'data-keep-scroll')!==null)put(el,'@self');
      queryAll(el,'[data-keep-scroll]').forEach((n,i)=>put(n,keyOfScroller(n,i)));
    }
    if(snap.open.size)queryAll(el,'details').forEach((n,i)=>{if(snap.open.has(keyOfDetails(n,i))&&n.open!==true)n.open=true;});
    const selector=snap.key?attrSelector('data-key',snap.key):snap.id?attrSelector('id',snap.id):'';
    if(selector){
      const next=safe(()=>el.querySelector(selector),null);
      if(next&&!next.disabled&&isFn(next.focus)){
        next.focus({preventScroll:true});
        if(snap.caret&&isFn(next.setSelectionRange))safe(()=>next.setSelectionRange(snap.caret[0],snap.caret[1]));
      }
    }
  }
  function setHtml(el,markup,opts){
    if(!el)return false;
    const text=toText(markup),force=opts===true||!!(opts&&opts.force);
    if(!force&&el.vkHtml===text)return false;
    let snap=null;
    try{snap=snapshot(el);}catch{snap=null;}
    el.innerHTML=text;
    el.vkHtml=text;
    if(snap)try{restore(el,snap);}catch{/* the write is what matters */}
    return true;
  }
  /* Forget the markup setHtml remembers for el (call it after changing el's children by other means). */
  function invalidate(el){if(el)el.vkHtml=null;}

  /* ---------- keyedPatch ---------- */
  const FALLBACK_ROW='<span class="muted">This row could not be displayed.</span>';
  const RESERVED_ATTR=/^(?:data-key|style|on[a-z]+)$/i;
  function applyAttrs(node,attrs){
    const had=node.vkAttrs||{},next={};
    let changed=false;
    if(attrs&&typeof attrs==='object')for(const name of Object.keys(attrs)){
      if(RESERVED_ATTR.test(name)||attrs[name]==null)continue;
      next[name]=str(attrs[name]);
    }
    for(const name of Object.keys(next))if(getAttr(node,name)!==next[name]){setAttr(node,name,next[name]);changed=true;}
    for(const name of Object.keys(had))if(!(name in next)){delAttr(node,name);changed=true;}
    node.vkAttrs=next;
    return changed;
  }
  /* keyedPatch(container, items, { key, render, attrs, tag='div', scroller, keepScroll, pinThreshold=4 })
     Make the keyed children of `container` match `items`, in order, touching only what changed: a node per key (data-key) persists,
     new keys are inserted in one DocumentFragment per run of neighbours, vanished keys are removed, a reordered key moves (the
     minimum, see planKeyed), and a row's markup (render(item, i), an html`` result or a string) is rewritten only when it changed,
     through setHtml so focus, caret and nested scroll positions survive. attrs(item, i) -> { name: value } puts attributes on the row
     node itself (role, id, aria-selected...): values are strings, null/undefined removes the attribute, data-key, style and on* are
     refused. Children of the container without data-key are left alone (keep them before the rows, or after at least one row).
     Never writes innerHTML on the container. When the scroller was scrolled away from the top, the scroll position is corrected so the
     first visible row stays where it was (a row inserted above the viewport does not push the content). A listbox bound with
     bindListbox to the container is refreshed in the same pass. Duplicate or missing keys throw BEFORE the DOM is touched.
     Returns { keys, inserted, removed, moved, updated, errors, scrolledAway }, or null without a DOM. */
  function keyedPatch(container,items,opts){
    const o=opts||{};
    if(!Array.isArray(items))throw new TypeError('keyedPatch: items must be an array');
    const doc=docOf(container);
    if(!container||!doc||!isFn(doc.createElement)||!isFn(container.insertBefore))return null;
    const keyOf=isFn(o.key)?o.key:item=>item&&item.key;
    const keys=items.map((item,i)=>{
      const k=keyOf(item,i);
      if(k==null||k==='')throw new TypeError('keyedPatch: item '+i+' has no key');
      return String(k);
    });
    /* What is in the container now. */
    const kids=Array.prototype.slice.call(container.childNodes||container.children||[]),nodes=new Map(),current=[],stray=[];
    let lastKeyed=-1;
    kids.forEach((child,i)=>{
      const k=getAttr(child,'data-key');
      if(k===null)return;
      lastKeyed=i;
      if(nodes.has(k)){stray.push(child);return;}
      nodes.set(k,child);current.push(k);
    });
    const ops=planKeyed(current,keys);
    const tail=lastKeyed>=0?(kids[lastKeyed+1]||null):(o.tail||null);
    /* Row content, before anything changes. */
    const errors=[];
    const rows=items.map((item,i)=>{
      let markup,attrs=null;
      try{markup=toText(isFn(o.render)?o.render(item,i):'');}catch(error){markup=FALLBACK_ROW;errors.push({key:keys[i],error});}
      if(isFn(o.attrs)){try{attrs=o.attrs(item,i);}catch(error){errors.push({key:keys[i],error});}}
      return {markup,attrs};
    });
    /* What to put back afterwards: the first visible row's place, and keyboard focus. */
    const scroller=o.scroller||container,top0=Number(scroller.scrollTop)||0;
    const scrolledAway=top0>(o.pinThreshold===undefined?4:Number(o.pinThreshold));
    let anchor=null;
    if(scrolledAway&&o.keepScroll!==false&&isFn(scroller.getBoundingClientRect)){
      try{
        const box=scroller.getBoundingClientRect(),survives=new Set(keys);
        for(const k of current){
          if(!survives.has(k))continue;
          const r=nodes.get(k).getBoundingClientRect();
          if(r.bottom>box.top){anchor={node:nodes.get(k),offset:r.top-box.top};break;}
        }
      }catch{anchor=null;}
    }
    const active=doc.activeElement,hadFocus=!!active&&active!==container&&hasIn(container,active);
    let held=null;
    if(hadFocus){
      let row=active;
      while(row&&row.parentNode!==container)row=row.parentNode;
      const key=getAttr(active,'data-key'),id=key?null:getAttr(active,'id');
      held={row,selector:key?attrSelector('data-key',key):id?attrSelector('id',id):'',caret:safe(()=>typeof active.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null,null)};
    }
    /* Remove, then update content, then place. */
    const removed=[],moved=[],inserted=[],updated=new Set();
    for(const op of ops)if(op.op==='remove'){detach(nodes.get(op.key));removed.push(op.key);}
    stray.forEach(detach);
    const n=keys.length,opAt=new Array(n),placed=new Map();
    for(const op of ops)if(op.op!=='remove')opAt[op.to]=op;
    for(let i=0;i<n;i++){
      let node=nodes.get(keys[i]);
      const fresh=!node;
      if(fresh){node=doc.createElement(o.tag||'div');setAttr(node,'data-key',keys[i]);}
      const wrote=setHtml(node,rows[i].markup),attrsChanged=applyAttrs(node,rows[i].attrs);
      if(!fresh&&(wrote||attrsChanged))updated.add(keys[i]);
      placed.set(keys[i],node);
    }
    for(let i=n-1;i>=0;){
      if(opAt[i].op==='keep'){i--;continue;}
      let j=i;
      while(j>0&&opAt[j-1].op!=='keep')j--;
      const before=i+1<n?placed.get(keys[i+1]):tail,run=[];
      for(let k=j;k<=i;k++){
        run.push(placed.get(keys[k]));
        (opAt[k].op==='insert'?inserted:moved).push(keys[k]);
      }
      if(run.length>1&&isFn(doc.createDocumentFragment)){
        const fragment=doc.createDocumentFragment();
        run.forEach(node=>fragment.appendChild(node));
        container.insertBefore(fragment,before||null);
      }else run.forEach(node=>container.insertBefore(node,before||null));
      i=j-1;
    }
    container.vkHtml=null;
    if(anchor){
      try{
        const box=scroller.getBoundingClientRect(),r=anchor.node.getBoundingClientRect(),delta=(r.top-box.top)-anchor.offset;
        if(Math.abs(delta)>=1)scroller.scrollTop=(Number(scroller.scrollTop)||0)+delta;
      }catch{/* leave the scroll position */}
    }
    /* A moved node loses focus in a browser, and a row that was rewritten AND moved lost the focus its rewrite had just restored:
       put focus back on the same node, or on its successor in the rewritten row (found by data-key or id), without scrolling. */
    if(hadFocus){
      const now=doc.activeElement;
      if(!now||now===doc.body){
        let target=hasIn(container,active)?active:null;
        if(!target&&held.row&&held.selector&&hasIn(container,held.row))target=safe(()=>held.row.querySelector(held.selector),null);
        if(target&&!target.disabled&&isFn(target.focus)){
          safe(()=>target.focus({preventScroll:true}));
          if(held.caret&&isFn(target.setSelectionRange))safe(()=>target.setSelectionRange(held.caret[0],held.caret[1]));
        }
      }
    }
    const listbox=container.vkListbox;
    if(listbox&&isFn(listbox.refresh))safe(()=>listbox.refresh());
    const order=list=>{const set=new Set(list);return keys.filter(k=>set.has(k));};
    return {keys,inserted:order(inserted),removed,moved:order(moved),updated:order([...updated]),errors,scrolledAway};
  }

  /* ---------- bindListbox ---------- */
  let listboxSeq=0;
  /* bindListbox(el, { label, optionSelector='[role="option"]', keyAttr='data-key', activeAttr='data-active', pageSize=8,
                       onActivate(key, optionEl, event), onActive(key, optionEl, { reason }), onKey(event, activeKey), activateOnClick=true })
     Makes el a listbox whose options are its descendants matching optionSelector (each with a data-key). The cursor is virtual:
     el keeps DOM focus (tabindex 0), aria-activedescendant names the active option, and the active option carries data-active="true"
     (style that, with a 2px focus outline). ArrowUp/Down, Home/End, PageUp/PageDown (by 8) move the cursor and scroll el, not the
     page; Enter and Space call onActivate; a click on an option (not on a button, link or field inside it) moves the cursor and calls
     onActivate. The binding never calls focus() and never scrolls on its own: after a repaint, refresh() (keyedPatch calls it for a
     bound container) re-applies the cursor, and when the active key is gone (filtered out, trimmed) the cursor moves to the nearest
     surviving neighbour in the previous order, the following one first. Options without an id get a stable generated one.
     Returns { el, active, setActive(key, { scroll }), refresh(), keys(), activate(), focus(), destroy() }, or null without an element. */
  function bindListbox(el,opts){
    if(!el)return null;
    const o=opts||{};
    if(el.vkListbox&&isFn(el.vkListbox.destroy))el.vkListbox.destroy();
    const selector=o.optionSelector||'[role="option"]',keyAttr=o.keyAttr||'data-key',activeAttr=o.activeAttr||'data-active';
    const page=Math.max(1,int(o.pageSize,8)),uid=++listboxSeq,ids=new Map();
    let active=null,lastKeys=[],bound=true;
    setAttr(el,'role','listbox');
    if(o.label)setAttr(el,'aria-label',o.label);
    if(getAttr(el,'tabindex')===null)setAttr(el,'tabindex','0');
    const options=()=>{
      let found=queryAll(el,selector);
      if(!found.length&&el.children)found=Array.prototype.filter.call(el.children,c=>getAttr(c,'role')==='option');
      return found.filter(opt=>getAttr(opt,keyAttr)!==null);
    };
    const keyOf=opt=>getAttr(opt,keyAttr);
    function idFor(opt,key){
      const own=getAttr(opt,'id');
      if(own)return own;
      if(!ids.has(key))ids.set(key,'vk-lb'+uid+'-opt'+(ids.size+1));
      setAttr(opt,'id',ids.get(key));
      return ids.get(key);
    }
    /* The nearest key that is still there, looking outward from the vanished one in the previous order (following key first). */
    function neighbour(old,gone,now){
      const present=new Set(now),at=old.indexOf(gone);
      if(!now.length)return null;
      if(at<0)return now[0];
      for(let d=1;d<=old.length;d++){
        if(at+d<old.length&&present.has(old[at+d]))return old[at+d];
        if(at-d>=0&&present.has(old[at-d]))return old[at-d];
      }
      return now[0];
    }
    function reveal(opt){
      try{
        const box=o.scroller||el;
        if(!isFn(opt.getBoundingClientRect)||!isFn(box.getBoundingClientRect))return;
        /* The visible part is inside the scroller's border: clientTop and clientHeight, when the scroller reports them. */
        const a=opt.getBoundingClientRect(),b=box.getBoundingClientRect();
        const top=b.top+(Number(box.clientTop)||0),bottom=Number(box.clientHeight)>0?top+Number(box.clientHeight):b.bottom;
        if(a.top<top)box.scrollTop=(Number(box.scrollTop)||0)-(top-a.top);
        else if(a.bottom>bottom)box.scrollTop=(Number(box.scrollTop)||0)+(a.bottom-bottom);
      }catch{/* leave the scroll position */}
    }
    function report(reason){
      const found=options().find(opt=>keyOf(opt)===active)||null;
      if(isFn(o.onActive))o.onActive(active,found,{reason});
    }
    /* Bring the DOM in line with `active`; returns the active option element. */
    function sync(){
      const list=options(),keys=list.map(keyOf);
      let moved=false;
      if(active!==null&&keys.indexOf(active)<0){active=neighbour(lastKeys,active,keys);moved=true;}
      lastKeys=keys;
      let found=null;
      for(const opt of list){
        const on=keyOf(opt)===active;
        if(on)found=opt;
        if(on){if(getAttr(opt,activeAttr)!=='true')setAttr(opt,activeAttr,'true');}
        else if(getAttr(opt,activeAttr)!==null)delAttr(opt,activeAttr);
      }
      if(found)setAttr(el,'aria-activedescendant',idFor(found,active));
      else delAttr(el,'aria-activedescendant');
      if(moved)report('refresh');
      return found;
    }
    function setActive(key,sopts){
      const k=key==null?null:String(key);
      const list=options(),target=k===null?null:list.find(opt=>keyOf(opt)===k);
      if(k!==null&&!target)return false;
      const changed=active!==k;
      active=k;
      sync();
      if(target&&!(sopts&&sopts.scroll===false))reveal(target);
      if(changed)report((sopts&&sopts.reason)||'api');
      return true;
    }
    function activate(event){
      if(active===null)return false;
      const opt=options().find(x=>keyOf(x)===active);
      if(!opt)return false;
      if(isFn(o.onActivate))o.onActivate(active,opt,event);
      return true;
    }
    function onKeydown(e){
      if(!bound||!e||e.ctrlKey||e.metaKey||e.altKey)return;
      if(e.target&&e.target!==el&&isInteractive(e.target))return;
      if(isFn(o.onKey)&&o.onKey(e,active)===true)return;
      sync();
      const k=e.key;
      if(k==='Enter'||k===' '||k==='Spacebar'){if(active!==null){prevent(e);activate(e);}return;}
      const to=nextListIndex(lastKeys.length,lastKeys.indexOf(active),k,page);
      if(to===null)return;
      prevent(e);
      setActive(lastKeys[to],{scroll:true,reason:'key'});
    }
    function onClick(e){
      if(!bound||!e)return;
      let opt=null;
      for(let n=e.target;n&&n!==el;n=n.parentNode){
        if(safe(()=>isFn(n.matches)&&n.matches(selector),false)||(getAttr(n,'role')==='option'&&getAttr(n,keyAttr)!==null)){opt=n;break;}
        if(isInteractive(n))return;
      }
      if(!opt||keyOf(opt)===null)return;
      setActive(keyOf(opt),{scroll:false,reason:'click'});
      if(o.activateOnClick!==false&&isFn(o.onActivate))o.onActivate(active,opt,e);
    }
    function onFocus(){
      if(!bound)return;
      const list=options();
      if(active===null||!list.some(opt=>keyOf(opt)===active)){
        const chosen=list.find(opt=>getAttr(opt,'aria-selected')==='true')||list[0];
        if(chosen){setActive(keyOf(chosen),{scroll:false,reason:'focus'});return;}
      }
      sync();
    }
    const on=(type,fn)=>{if(isFn(el.addEventListener))el.addEventListener(type,fn);};
    on('keydown',onKeydown);on('click',onClick);on('focus',onFocus);
    const api={
      el,
      get active(){return active;},
      setActive,
      refresh(){sync();},
      keys:()=>options().map(keyOf),
      activate:()=>activate(null),
      focus(){if(isFn(el.focus))el.focus({preventScroll:true});},
      destroy(){
        bound=false;
        if(isFn(el.removeEventListener)){el.removeEventListener('keydown',onKeydown);el.removeEventListener('click',onClick);el.removeEventListener('focus',onFocus);}
        delAttr(el,'aria-activedescendant');
        if(el.vkListbox===api)el.vkListbox=null;
      }
    };
    el.vkListbox=api;
    sync();
    return api;
  }

  /* ---------- announcer (DOM) ---------- */
  /* announcer(root, { now, setTimeout, clearTimeout }) -> { say(text, { kind }), alert(text, { key }), resolve(key), flush(), attach(root),
     region(), destroy() }. Puts ONE sr-only role=status aria-live=polite aria-atomic region in root (and a sr-only role=alert region for
     link loss), reusing the ones already there, and recreating them if a repaint of root removed them. Timing is makeAnnouncer's.
     Without a DOM it still returns a controller whose calls do nothing. */
  function announcer(root,opts){
    const o=opts||{};
    let host=root||null,politeEl=null,alertEl=null,timer=null,live=true;
    const after=(fn,ms)=>isFn(o.setTimeout)?o.setTimeout(fn,ms):isFn(scope.setTimeout)?scope.setTimeout(fn,ms):null;
    const cancel=t=>{if(t===null)return;if(isFn(o.clearTimeout))o.clearTimeout(t);else if(isFn(scope.clearTimeout))scope.clearTimeout(t);};
    function region(kind){
      const doc=docOf(host);
      if(!host||!doc||!isFn(doc.createElement))return null;
      const found=safe(()=>host.querySelector(attrSelector('data-views-live',kind)),null);
      if(found)return found;
      const node=doc.createElement('div');
      setAttr(node,'class','sr-only');
      setAttr(node,'data-views-live',kind);
      if(kind==='polite'){setAttr(node,'role','status');setAttr(node,'aria-live','polite');}
      else setAttr(node,'role','alert');
      setAttr(node,'aria-atomic','true');
      safe(()=>host.appendChild(node));
      return node;
    }
    function ensure(kind){
      if(kind==='polite'){if(!politeEl||!hasIn(host,politeEl))politeEl=region('polite');return politeEl;}
      if(!alertEl||!hasIn(host,alertEl))alertEl=region('assertive');
      return alertEl;
    }
    function write(text,detail){
      if(!live)return;
      const node=ensure(detail&&detail.assertive?'assertive':'polite');
      if(!node)return;
      /* The same sentence twice in a row is only announced again if the region changes in between. */
      if(text&&node.textContent===text){
        node.textContent='';
        if(after(()=>{node.textContent=text;},60)!==null)return;
      }
      node.textContent=text;
    }
    const core=makeAnnouncer({now:o.now,emit:write,coalesceMs:o.coalesceMs,minGapMs:o.minGapMs,maxChars:o.maxChars});
    function arm(){
      cancel(timer);
      timer=null;
      const d=core.delay();
      if(!live||d===null)return;
      timer=after(()=>{timer=null;core.tick();arm();},d+5);
    }
    ensure('polite');
    ensure('assertive');
    return {
      say(text,sopts){const d=core.say(text,sopts);arm();return d!==null;},
      alert(text,aopts){const ok=core.alert(text,aopts);arm();return ok;},
      resolve:key=>core.resolve(key),
      flush(){const ok=core.flush();arm();return ok;},
      attach(next){host=next||null;politeEl=null;alertEl=null;ensure('polite');ensure('assertive');},
      region:()=>ensure('polite'),
      destroy(){live=false;cancel(timer);timer=null;detach(politeEl);detach(alertEl);politeEl=alertEl=null;core.reset();}
    };
  }

  /* ---------- copyText ---------- */
  function fallbackCopy(text,env){
    const doc=(env&&env.document)||scope.document;
    try{
      if(!doc||!isFn(doc.createElement)||!doc.body||!isFn(doc.execCommand))return false;
      const before=doc.activeElement,area=doc.createElement('textarea');
      area.value=text;
      setAttr(area,'readonly','');
      setAttr(area,'aria-hidden','true');
      setAttr(area,'tabindex','-1');
      setAttr(area,'class','sr-only');
      doc.body.appendChild(area);
      if(isFn(area.focus))area.focus({preventScroll:true});
      if(isFn(area.select))area.select();
      if(isFn(area.setSelectionRange))safe(()=>area.setSelectionRange(0,text.length));
      let ok=false;
      try{ok=doc.execCommand('copy')===true;}catch{ok=false;}
      detach(area);
      if(before&&before!==doc.body&&isFn(before.focus))safe(()=>before.focus({preventScroll:true}));
      return ok;
    }catch{return false;}
  }
  /* copyText(text, { navigator, document, setTimeout, clearTimeout }) -> Promise<boolean>: the clipboard API when there is one, else a
     hidden textarea and execCommand. A clipboard request that is still pending after 1.5 s (a permission prompt nobody answers) is
     abandoned for the textarea. Always settles, resolves false (never rejects) when nothing works. */
  const COPY_WAIT_MS=1500;
  function copyText(text,env){
    const s=str(text),e=env||{},nav=e.navigator||safe(()=>scope.navigator,null);
    const after=isFn(e.setTimeout)?e.setTimeout:isFn(scope.setTimeout)?(fn,ms)=>scope.setTimeout(fn,ms):null;
    const cancel=isFn(e.clearTimeout)?e.clearTimeout:isFn(scope.clearTimeout)?t=>scope.clearTimeout(t):()=>{};
    return new Promise(resolve=>{
      let done=false,timer=null;
      const finish=value=>{if(done)return;done=true;if(timer!==null)safe(()=>cancel(timer));resolve(value);};
      const viaTextarea=()=>finish(fallbackCopy(s,e));
      try{
        if(nav&&nav.clipboard&&isFn(nav.clipboard.writeText)){
          const pending=nav.clipboard.writeText(s);
          if(pending&&isFn(pending.then)){
            if(after)timer=safe(()=>after(viaTextarea,COPY_WAIT_MS),null);
            pending.then(()=>finish(true),viaTextarea);
            return;
          }
          finish(true);
          return;
        }
      }catch{/* fall through to the textarea */}
      viaTextarea();
    });
  }

  /* ---------- visibility ---------- */
  const isHidden=doc=>safe(()=>!!((doc||scope.document)||{}).hidden,false);
  /* onVisible(fn, { document }) calls fn each time the tab becomes visible again. Returns a function that stops it. */
  function onVisible(fn,env){
    const doc=(env&&env.document)||safe(()=>scope.document,null);
    if(!isFn(fn)||!doc||!isFn(doc.addEventListener))return ()=>{};
    let live=true;
    const handler=()=>{if(live&&!doc.hidden)fn();};
    doc.addEventListener('visibilitychange',handler);
    return ()=>{live=false;if(isFn(doc.removeEventListener))doc.removeEventListener('visibilitychange',handler);};
  }

  /* ---------- frames and motion ---------- */
  /* nextFrame(fn) runs fn once, after the next frame is painted (requestAnimationFrame, else a short timeout, else at once). Returns a
     function that cancels it. Use it for work that must follow a paint, such as setting a size with CSSOM setProperty. */
  function nextFrame(fn){
    if(!isFn(fn))return ()=>{};
    let done=false,cancel=()=>{};
    const run=()=>{if(!done){done=true;fn();}};
    try{
      if(isFn(scope.requestAnimationFrame)){
        const id=scope.requestAnimationFrame(run);
        cancel=()=>{done=true;if(isFn(scope.cancelAnimationFrame))safe(()=>scope.cancelAnimationFrame(id));};
        return cancel;
      }
      if(isFn(scope.setTimeout)){
        const id=scope.setTimeout(run,16);
        cancel=()=>{done=true;if(isFn(scope.clearTimeout))safe(()=>scope.clearTimeout(id));};
        return cancel;
      }
    }catch{/* run it now */}
    run();
    return cancel;
  }
  /* True when the reader asked for reduced motion. True also when that cannot be read (no matchMedia): no motion is the safe answer. */
  function reducedMotion(){
    try{
      if(!isFn(scope.matchMedia))return true;
      const q=scope.matchMedia('(prefers-reduced-motion: reduce)');
      return !q||q.matches!==false;
    }catch{return true;}
  }

  const api={
    VERSION:1,
    html,raw,isRaw,esc,escapeHtml:esc,clamp,stepClass,
    planKeyed,applyPlan,
    makeAnnouncer,TERMINAL_KINDS,trimRing,ringDrop,
    formatTime,ago,formatAgo:ago,duration,formatDuration:duration,
    nextListIndex,rovingTabindex,nextTreeIndex,nextSplitterStep,SPLITTER_MAX,
    makeStore,store,STORE_KEYS,
    setHtml,invalidate,keyedPatch,bindListbox,announcer,copyText,onVisible,isHidden,nextFrame,reducedMotion
  };
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.FinanceViews=api;
})(typeof window!=='undefined'?window:globalThis);
