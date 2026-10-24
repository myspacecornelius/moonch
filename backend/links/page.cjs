'use strict';
/* Reading a task page: evaluations in the isolated world that turn the DOM into plain data, then pure functions on that data.
   Deterministic, no model. extractPage and pageOps are CONSTANT functions: they are sent to the page as text, they use nothing from
   this module, and their arguments go in as JSON (tab.evalFn), so nothing from the page, the link or the person can become code.

   SAFETY BY ALLOWLIST. The loader requests or presses only these, and nothing else:
     (a) a link whose address path ENDS IN A FILE EXTENSION (Q3.pdf, archive.tar.gz), or whose last path segment is exactly "download"
         (/files/12/download), with no action word (delete, remove, submit, cancel, archive, trash, share ...) in any directory of the
         path and none in a query parameter; and a link with a download attribute whose address passes the same test;
     (b) a link or a control whose accessible name is a download phrase ("Download", "Download file", "Download all", "Download Q3.pdf",
         an icon titled Download) that is not in a form, cannot submit one and does not run a script that submits or sends something;
     (c) controls that only expose content: tabs, <details>/summary, aria-expanded expanders and tree items (a folder called "Archive"
         is navigation, not an action), "Load more" / "Show more" / "View all" / "See all" / "Next page" controls and pagers, and the
         "show all files" switch (a switch, checkbox, radio, tab, pressed button or <select> option, or a plain button, whose label says
         show or view, all, and files; none of clear, delete, remove, reset, archive, move, apply, bulk, select all ...).
   Whatever names a file and is not allowed is listed in skipped ("not clearly a download: download it yourself"), never requested or
   pressed. Every click goes through pageOps' activate, which needs a kind and checks the live element against the rule of that kind.

   extractPage reads, nothing clicked, nothing submitted. It walks the document in order, open shadow roots and same-origin iframes
   included, and returns
     sections   the page text cut at every heading: [{ heading, text }] (text capped per section, section count capped)
     links, buttons   the ones that look like FILES (with the heading above them, as their group), only those a person can see; a
                button called just "Download" takes the text of its table row or list item as its label; names: every name the element has
     hidden     file-like links and buttons that are not visible (a closed dialog, a drawer): [{ href, text }]
     frames     { blocked }: frames of another site (or sandboxed) that cannot be read
     toggles    every switch, checkbox, pressed-button, radio, tab, <select> option and "show all files" button, with its label, its state
                and a stable key (id or data-testid) for when it has no label
     signals    what the sign-in classifier needs (a password field, a one-time-code field, a CAPTCHA, how much text there is)
     truncated  what was cut: { elements, links, buttons, toggles, sections, text, time }
   It never reads password, hidden and file inputs, nor any control whose name looks like a secret or a code, and never cookies or storage.
   The values hold full URLs and a signed link carries its signature in the query string: the result stays in memory and is never logged.

   pageOps does the few things the loader does to a page, one small step per call: open <details> and expanders, list tabs, "load more"
   buttons and pagers, scroll the scrollable boxes one step, and activate ONE element of a given kind (see above).

   Exports: extractPage, pageOps, pageOp, takePage, pageArgs, RULES, fileCandidates, droppedCandidates, classify, linkVerdict, addressProblem,
   nameIsDownload, pagerSteps, pageLinkOk, navigateKey, namePhrase, findAllFilesToggle, findAllFilesState, TOGGLE_LABEL_RE, TOGGLE_NEVER_RE,
   LIMITS, NOT_CLEAR, NEVER_TEXT_RE, NEVER_HREF_RE, NEVER_ACTION_PARAM_RE, ACTION_WORDS. */

const LIMITS = {
  maxMs: 2500, maxElements: 40000, maxRoots: 40, sections: 200, sectionChars: 20000, valueChars: 400,
  linksMax: 2000, buttonsMax: 2000, togglesMax: 300, headingsMax: 80, selectOptions: 20, hiddenMax: 200, tabsMax: 50, moreMax: 50,
};
const NOT_CLEAR = 'not clearly a download: download it yourself';

/* File extensions the loader treats as documents. */
const EXT_SRC = 'pdf|docx?|xlsx?|xlsm|xlsb|csv|tsv|txt|md|json|zip|7z|tar|gz|tgz|rar|rtf|pptx?|odt|ods|odp|png|jpe?g|gif|svg|eml|msg|xml|parquet|bin|dat|log|ya?ml|ics|vcf|tiff?|bmp|webp|heic|mp3|mp4|mov|wav|epub|dwg';
const FILE_EXTENSIONS = new RegExp(`^(?:${EXT_SRC})$`, 'i');
const FILE_NAME_END = /\.([A-Za-z0-9]{1,8})$/;

/* Words that name an action. A path directory, a query parameter or a name with one of these is never requested or pressed as a file
   (a file NAME may hold one: Reset_policy.pdf, Archive_2025_Q4.zip). */
const ACTION_WORDS = ['delete', 'del', 'remove', 'destroy', 'trash', 'purge', 'wipe', 'erase', 'discard', 'clear', 'empty', 'detach', 'unlink', 'disconnect', 'revoke',
  'unsubscribe', 'logout', 'logoff', 'signout', 'signoff', 'reset', 'approve', 'reject', 'deny', 'decline', 'submit', 'publish', 'unpublish', 'cancel', 'archive',
  'unarchive', 'restore', 'undelete', 'share', 'unshare', 'send', 'post', 'move', 'rename', 'edit', 'update', 'save', 'upload', 'import', 'sync', 'lock', 'unlock',
  'duplicate', 'clone', 'activate', 'deactivate', 'enable', 'disable', 'toggle', 'mark', 'flag', 'assign', 'subscribe', 'invite', 'notify', 'execute', 'trigger', 'void',
  'actions', 'action', 'method'];
const ACTION_SET = new Set(ACTION_WORDS);
/* Parameters that carry a verb: only a harmless value is accepted. */
const ACTION_PARAMS = new Set(['action', 'actions', 'act', 'op', 'do', 'cmd', 'command', 'method', '_method', 'verb', 'operation']);
const DOWNLOAD_VALUES = new Set(['download', 'downloads', 'get', 'view', 'open', 'fetch', 'read', 'raw', 'preview', 'file', 'attachment', 'export', 'content', 'show', 'stream', 'inline']);
/* Parameters whose value is a file name or a header: not read for words. */
const VALUE_FREE_PARAMS = new Set(['filename', 'file', 'name', 'fn', 'title', 'response-content-disposition', 'response-content-type', 'content-disposition', 'dl', 'download', 'label', 'text']);

/* Second layer, plain text rules that predate the allowlist (kept: a bug in the first layer must not be the last word). The text rule is
   anchored at the start ("Delete file", "Sign out") so a file called Archive_2026.zip still qualifies; the address rule looks for the
   verb as a whole path segment or as an action parameter. */
const NEVER_TEXT_RE = /^(delete|remove|log ?out|sign ?out|cancel|revoke|reset|unsubscribe|submit|approve|reject|publish|archive|destroy|trash|detach|share)\b/i;
const NEVER_HREF_RE = /(^|\/)(delete|del|remove|logout|log-out|signout|sign-out|revoke|unsubscribe|reset|approve|reject|publish|submit|actions?|cancel|archive|destroy|trash|detach|share|move|restore)(\/|$|\?|#)|[?&](action|actions|op|do|cmd|command|method|_method)=(delete|remove|logout|revoke|approve|reject|publish|submit|cancel|archive|destroy|trash)/i;
const NEVER_ACTION_PARAM_RE = /[?&](action|actions|op|do|cmd|command|method|_method)=(delete|remove|logout|revoke|approve|reject|publish|submit|cancel|archive|destroy|trash)/i;
/* Query parameters that sign or time-limit an address and change every time it is issued. */
const SIGNATURE_PARAM_RE = /^(x-amz-.*|x-goog-.*|x-ms-.*|x-sig.*|x-expires|x-token|signature|sig|se|sp|sv|sr|st|spr|skoid|sktid|expires?|token|policy|key-pair-id|awsaccesskeyid|googleaccessid)$/i;

/* The accessible name of a download control: "Download", "Download file", "Download all (12)", "Download Q3.pdf". Not "Download app" and not
   "Downloads". Bounded: it runs on at most 160 characters. */
const DL_THING = '(?:files?|attachments?|documents?|docs?|reports?|copy|originals?|everything|zip|archive|bundle|pdf|csv|xlsx?|docx?|txt|json|all)';
const DOWNLOAD_NAME_SRC = `^[^a-z0-9]*(?:download(?:\\s+(?:the|this|a|your|my))?(?:\\s+(?:all|every|selected|attached|original|full))*(?:\\s+${DL_THING})?|download\\s+\\S.*\\.(?:${EXT_SRC}))(?:\\s*[(\\[][^)\\]]{0,30}[)\\]])?[^a-z0-9]*$`;
const DOWNLOAD_NAME_RE = new RegExp(DOWNLOAD_NAME_SRC, 'i');
const ALL_BUTTON_RE = /^[^a-z0-9]*download\s+(all|everything|zip|archive|bundle)\b/i;
/* A control that shows more of a list: "Load more", "Show 20 more", "View all (12)", "See all", "Show remaining 8", "More", "Next". */
const MORE_SRC = '^[^a-z0-9]*(?:(?:load|show|view|see|display|get|fetch)\\s+(?:(?:\\d+|more|all|remaining|older|earlier|additional|the rest(?: of)?|next)\\s*)+(?:files?|attachments?|documents?|docs?|items?|results?|rows?|entries|comments|messages|activity|records?|versions?)?|more(?:\\s+(?:files?|attachments?|documents?|items?|results?))?|\\+\\s*\\d+(?:\\s+more)?|\\d+\\s+more|expand\\s+all|next(?:\\s+page)?|older)(?:\\s*[(\\[][^)\\]]{0,20}[)\\]])?[^a-z0-9]*$';
/* The "next page" control of a pager: Next, Next page, Older, an arrow. */
const NEXT_SRC = '^(?:go to\\s+)?(?:(?:next|older)(?:\\s+page)?[\\s\\u203a\\u00bb>\\u2192]*|[\\u203a\\u00bb>\\u2192]+)$';
/* Script in an onclick attribute that submits a form or sends something. */
const SCRIPTED_SRC = '\\b(?:submit|form|forms|fetch|xhr|xmlhttprequest|ajax|post|put|delete|patch|sendbeacon)\\b';

/* The label of the "show all files" control: a label with show or view, with all, every or world, and with files, attachments, documents
   or downloads (in any order), or exactly "All files". "Show only added files" and "Show details" do not match. Lookaheads from the start
   of the text: every one is a single linear scan. */
const TOGGLE_LABEL_RE = /^(?=[\s\S]*\b(?:show|view)\b)(?=[\s\S]*\b(?:all|every|world)\b)(?=[\s\S]*\b(?:files?|attachments?|documents?|downloads?)\b)|^\s*all files\s*$/i;
/* A label with one of these is never the "show all files" control, whatever else it says. */
const TOGGLE_NEVER_RE = /\b(?:clear|delete|remove|reset|archiv\w*|move|apply|bulk|select all|discard|detach|unlink|trash|empty|wipe|purge|mark|notify|notification|notifications|email|digest|newsletter|subscribe|share|send|upload|import|lock|restore)\b/i;
const TOGGLE_KINDS = new Set(['switch', 'checkbox', 'radio', 'tab', 'pressed', 'option', 'button']);

/* What the page side needs, as plain strings (regex sources) so that nothing is spliced into code. */
const RULES = {
  ext: EXT_SRC, download: DOWNLOAD_NAME_SRC, toggle: TOGGLE_LABEL_RE.source, toggleNever: TOGGLE_NEVER_RE.source, more: MORE_SRC, next: NEXT_SRC,
  scripted: SCRIPTED_SRC, never: NEVER_TEXT_RE.source, actions: ACTION_WORDS,
};
const pageArgs = (extra = {}) => ({ limits: LIMITS, rules: RULES, ...extra });

/* Page side. Must be self-contained: it is serialised with toString() and run in the page's isolated world. */
function extractPage(opts) {
  const T0 = performance.now();
  const L = opts.limits;
  const R = opts.rules;
  const toggleRe = new RegExp(R.toggle || '(?!)', 'i');   /* without a pattern nothing counts as a "show all files" button */
  const toggleNever = new RegExp(R.toggleNever || '(?!)', 'i');
  const downloadRe = new RegExp(R.download || '(?!)', 'i');
  const scriptedRe = new RegExp(R.scripted || '(?!)', 'i');
  const trunc = {};
  const HIDDEN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'g');
  const STRIP = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'g');
  const norm = (s) => String(s == null ? '' : s).replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const over = () => performance.now() - T0 > L.maxMs;
  const visible = (el) => { try { return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true; } catch (e) { return true; } };

  /* every element of the document, of its open shadow roots and of its same-origin iframes, in document order */
  const all = [];
  let roots = 1;
  let blockedFrames = 0;
  const collect = (root) => {
    const found = root.querySelectorAll('*');
    for (let j = 0; j < found.length; j += 1) {
      if (all.length >= L.maxElements) { trunc.elements = true; return; }
      const el = found[j];
      all.push(el);
      if (el.shadowRoot) { if (roots < L.maxRoots) { roots += 1; collect(el.shadowRoot); } else trunc.roots = true; }
      if (el.tagName === 'IFRAME') {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }   /* another origin: not readable */
        if (inner && inner.documentElement) { if (roots < L.maxRoots) { roots += 1; collect(inner); } else trunc.roots = true; }
        else if (!inner) {
          const src = el.getAttribute('src') || '';
          if (src && !/^(about:|javascript:)/i.test(src) && !/recaptcha|hcaptcha|turnstile|captcha|challenge/i.test(src) && visible(el)) {
            let big = true;
            try { const r = el.getBoundingClientRect(); big = r.width >= 40 && r.height >= 30; } catch (e) { big = true; }
            if (big) blockedFrames += 1;
          }
        }
      }
    }
  };
  collect(document);

  /* A path that finds the element again: one CSS path per document it sits in (anchored at the root or at an element with a unique id),
     joined with " >>> " (the host of a shadow root, or the iframe, is the next link of the chain). null when there is no way back. */
  const segmentOf = (n, rootNode) => {
    const parts = [];
    for (let m = n; m && m.nodeType === 1 && parts.length < 40; m = m.parentElement) {
      const t = m.tagName.toLowerCase();
      if (m.id && rootNode.querySelectorAll('#' + CSS.escape(m.id)).length === 1) { parts.unshift(t + '#' + CSS.escape(m.id)); break; }
      let idx = 1; for (let s = m.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === m.tagName) idx += 1;
      parts.unshift(t + ':nth-of-type(' + idx + ')');
    }
    return parts.join(' > ');
  };
  const cssPath = (el) => {
    const segs = [];
    let node = el;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const rootNode = node.getRootNode();
      segs.unshift(segmentOf(node, rootNode));
      if (rootNode === document) return segs.join(' >>> ');
      if (rootNode.host) node = rootNode.host;
      else if (rootNode.defaultView && rootNode.defaultView.frameElement) node = rootNode.defaultView.frameElement;
      else return null;
    }
    return null;
  };
  const FILE_EXT = new RegExp('^(?:' + R.ext + ')$', 'i');
  const EXTS = R.ext;
  const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || ''); return m ? m[1].toLowerCase() : null; };
  /* the file-name phrase at the start of a line of row text: everything up to the end of the first extension ("Entity 01 Budget.txt", "archive.tar.gz") */
  const NAME_RE = new RegExp('^(.*?\\.(?:' + EXTS + ')(?:\\.(?:' + EXTS + '))*)(?![A-Za-z0-9])', 'i');
  /* what a row says besides the control: its label (the row text without the control's own text), the file-name phrase it holds, and the
     NAME CELL (the first cell or line that is not a size, a date, a time or "5 min ago", cut where such a thing starts), which is what tells
     two rows apart when the other cells of a row change every minute (a status, a count of views) */
  const VOLATILE_CELL = /^[\d\s.,:%$\/-]+$|^\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|bytes?)$/i;
  const VOLATILE_CUT = /\s*(?:\b(?:updated|modified|created|edited|uploaded|added|ago|today|yesterday|just now)\b|\b\d+\s*(?:s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?|years?)\b|\b\d+(?:\.\d+)?\s?(?:KB|MB|GB|bytes?)\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}\b).*$/i;
  const rowInfo = (el, text) => {
    const row = rowOf(el, text);
    const full = row ? norm(norm(row.innerText || row.textContent).replace(text, ' ')) : '';
    if (!full) return null;
    const raw = String(row.innerText || '');
    const lines = (raw ? raw.split(/[\t\n\r]+/) : []).map(norm).filter(Boolean);
    let nameHint = '';
    for (const line of lines.length ? lines : [full]) { const m = NAME_RE.exec(line.replace(text, ' ').trim()); if (m) { nameHint = m[1]; break; } }
    const cells = [];
    for (const line of lines.length ? lines : [norm(row.textContent)]) {
      const cell = norm(line.split(text).join(' '));
      if (!cell || VOLATILE_CELL.test(cell)) continue;
      const stable = norm(cell.replace(VOLATILE_CUT, ''));
      if (stable) cells.push(clip(stable, 80));
    }
    const nameCell = cells.find((c) => /[A-Za-z]/.test(c) && c.length > 3) || cells[0] || '';
    return { label: clip(full, 160), nameHint, parts: nameCell ? [nameCell] : [] };
  };
  const keyOf = (el) => { const id = el.getAttribute('id'); if (id) return 'id:' + clip(id, 80); const t = el.getAttribute('data-testid'); return t ? 'testid:' + clip(t, 80) : ''; };
  const withoutControls = (node) => { const c = node.cloneNode(true); c.querySelectorAll('input,select,textarea,button').forEach((n) => n.remove()); return norm(c.textContent); };
  /* the accessible name: aria-labelledby, aria-label, a <label>, the element's own text, a title; with `deep`, when that is empty: the
     enclosing <label>, aria-describedby, the text beside it (previous or next sibling) and the short text of its parent */
  const labelOf = (el, deep) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const root = el.getRootNode(); const t = norm(lb.split(/\s+/).map((id) => { const n = root.getElementById ? root.getElementById(id) : null; return n ? n.textContent : ''; }).join(' ')); if (t) return t; }
    if (norm(el.getAttribute('aria-label'))) return norm(el.getAttribute('aria-label'));
    if (el.labels && el.labels.length) { const t = withoutControls(el.labels[0]); if (t) return t; }
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') { const t = norm(el.textContent); if (t) return t; }
    if (norm(el.title)) return norm(el.title);
    if (!deep) return '';
    const wrap = el.closest ? el.closest('label') : null;
    if (wrap) { const t = withoutControls(wrap); if (t) return t; }
    const db = el.getAttribute('aria-describedby');
    if (db) { const root = el.getRootNode(); const t = norm(db.split(/\s+/).map((id) => { const n = root.getElementById ? root.getElementById(id) : null; return n ? n.textContent : ''; }).join(' ')); if (t) return t; }
    /* only a plain caption counts: not a list, a heading, a link or another control (content the switch reveals sits next to it) */
    const BLOCKS = 'a,h1,h2,h3,h4,h5,h6,ul,ol,table,button,input,select,textarea';
    for (const sib of [el.previousElementSibling, el.nextElementSibling]) { const t = sib && !sib.querySelector(BLOCKS + ',[role]') && !sib.getAttribute('role') ? norm(sib.textContent) : ''; if (t && t.length <= 60) return t; }
    const parent = el.parentElement;
    const own = norm(el.textContent);
    const around = parent && !parent.querySelector(BLOCKS) ? norm(parent.textContent) : '';
    return around && around.length <= 80 && around !== own ? around : '';
  };
  /* every name an element has, in the order a screen reader takes them: aria-labelledby, aria-label, the text (or value), the title, the alt of an image */
  const nameSources = (el) => {
    const out = [];
    const add = (s) => { const t = clip(norm(s), 160); if (t && !out.includes(t)) out.push(t); };
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const root = el.getRootNode(); add(lb.split(/\s+/).map((id) => { const n = root.getElementById ? root.getElementById(id) : null; return n ? n.textContent : ''; }).join(' ')); }
    add(el.getAttribute('aria-label'));
    add(el.tagName === 'INPUT' ? el.value : el.textContent);
    add(el.getAttribute('title'));
    const img = el.querySelector ? el.querySelector('img') : null;
    if (img) add(img.alt);
    return out;
  };

  const out = { url: location.href, title: norm(document.title), readyState: document.readyState };
  const signals = { hasPasswordField: false, hasOtpField: false, hasCaptcha: false };
  /* a name is secret-looking when a secret word is a whole word in it: password, token, csrf ... but not passage, scorecard, author_notes */
  const secretish = (s) => /-(password|passwd|pwd|secret|token|csrf|xsrf|otp|cvv|ssn)-/i.test('-' + String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-') + '-');
  const secretControl = (el) => secretish(el.name) || secretish(el.id) || /(current-password|new-password|one-time-code|^cc-)/i.test(el.autocomplete || '');
  const SKIP_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio']);
  const WEB_EXT = /^(html?|xhtml|shtml|php\d?|aspx?|jsp|cfm|cgi|pl|do|action|js|mjs|css|map|com|org|net|io)$/i;
  const controlText = (c) => clip(norm(c.tagName === 'INPUT' ? c.value : c.textContent) || norm(c.getAttribute('aria-label')) || norm(c.getAttribute('title')), 160);
  /* The row of a control: its table row, list item or row-role ancestor; else the nearest ancestor whose text is more than the control's
     own (a wrapper that holds only the control does not count) and that does not hold a second control with the same text (that would
     be a container of several rows). null when there is none. */
  function rowOf(el, text) {
    const hard = el.closest ? el.closest('tr,li,[role=row]') : null;
    if (hard) return hard;
    for (let n = el.parentElement, depth = 0; n && depth < 8 && n.tagName !== 'BODY' && n.tagName !== 'HTML'; n = n.parentElement, depth += 1) {
      if (norm(n.innerText || n.textContent) === text) continue;
      let same = 0;
      for (const c of n.querySelectorAll('button,a,[role=button],input')) { if (controlText(c) === text) same += 1; if (same > 1) return null; }
      return n;
    }
    return null;
  }
  const dispositionName = (u) => { const d = u.searchParams.get('response-content-disposition') || u.searchParams.get('filename') || ''; const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(d); if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } } return d && !/=/.test(d) ? d : ''; };

  out.headings = []; out.links = []; out.buttons = []; out.toggles = []; out.hidden = [];
  let controlCount = 0; let linkCount = 0; let group = '';
  const addToggle = (t) => { if (out.toggles.length < L.togglesMax) out.toggles.push({ disabled: false, key: '', group, ...t }); else trunc.toggles = true; };
  const addHidden = (h) => { if (out.hidden.length < L.hiddenMax) out.hidden.push(h); };
  for (const el of all) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      group = clip(norm(el.textContent), 120);
      if (out.headings.length < L.headingsMax && group) out.headings.push({ level: Number(tag[1]), text: clip(group, 160) });
      continue;
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if ((tag === 'INPUT' && el.type === 'checkbox') || role === 'switch' || role === 'checkbox') {
      addToggle({ label: clip(labelOf(el, true), 120), checked: tag === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true', kind: role || 'checkbox', disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), path: cssPath(el), key: keyOf(el) });
      continue;
    }
    if ((tag === 'INPUT' && el.type === 'radio') || role === 'radio') {
      addToggle({ label: clip(labelOf(el, true), 120), checked: tag === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true', kind: 'radio', disabled: Boolean(el.disabled), path: cssPath(el), key: keyOf(el) });
      continue;
    }
    if (role === 'tab') {
      addToggle({ label: clip(labelOf(el, false), 120), checked: el.getAttribute('aria-selected') === 'true', kind: 'tab', disabled: Boolean(el.disabled), path: cssPath(el), key: keyOf(el) });
      continue;
    }
    if (tag === 'SELECT') {
      controlCount += 1;
      const path = cssPath(el); const key = keyOf(el);
      Array.from(el.options || []).slice(0, L.selectOptions).forEach((o, i) => addToggle({ label: clip(norm(o.textContent), 120), checked: Boolean(o.selected), kind: 'option', disabled: Boolean(el.disabled || o.disabled), path, option: i, key }));
      continue;
    }
    const rawHref = tag === 'A' ? el.getAttribute('href') : null;
    /* an anchor without a real address ("#", "#top", "", javascript:void(0)) is a button in disguise (below); javascript: code is never a file */
    if (tag === 'A' && rawHref !== null && !/^\s*(#.*)?$|^\s*javascript:\s*(void\s*\(\s*0?\s*\)|undefined|;)?\s*;?\s*$/i.test(rawHref)) {
      linkCount += 1;
      if (out.links.length >= L.linksMax) { trunc.links = true; continue; }
      const raw = rawHref;
      let u = null; try { u = new URL(el.href); } catch (e) { /* javascript: and friends */ }
      const download = el.hasAttribute('download') ? el.getAttribute('download') : null;
      let lastSeg = ''; try { lastSeg = u ? decodeURIComponent(u.pathname.split('/').pop() || '') : ''; } catch (e) { lastSeg = ''; }
      const nameHint = download || dispositionName(u || { searchParams: new URLSearchParams() }) || lastSeg;
      const ext = extOf(nameHint) || extOf(lastSeg);
      const names = nameSources(el);
      const why = [];
      if (download !== null) why.push('download-attribute');
      const textExt = extOf(norm(el.textContent));
      if (ext && FILE_EXT.test(ext)) why.push('extension');
      else if (textExt && FILE_EXT.test(textExt)) why.push('text-extension');   /* the link is called Budget_2025.xlsx; its address says nothing. Only a hint that it is a file */
      else if (ext && /[a-z]/i.test(ext) && /^[a-z0-9]{2,5}$/i.test(ext) && !WEB_EXT.test(ext)) why.push('extension-guess');   /* an unknown extension that is not a web page */
      if (names.length && downloadRe.test(names[0])) why.push('download-name');
      if (u && (/(^|\/)(download|downloads|attachments?|files?|blob|export|assets)\/[^/]/i.test(u.pathname) || /\/downloads?\/?$/i.test(u.pathname))) why.push('path');   /* /files/12 and /x/12/download yes; /files and /assets, the pages themselves, no */
      if (u && /(^|[?&])(x-amz-signature|signature|x-goog-signature|sig|se|sp)=/i.test(u.search)) why.push('signed-url');
      const fileLike = why.length > 0 && Boolean(u) && /^(https?|blob|data):$/.test(u.protocol);
      if (!fileLike) continue;
      const text = clip(norm(el.textContent) || norm(el.getAttribute('aria-label')) || norm(el.title) || (el.querySelector('img') ? norm(el.querySelector('img').alt) : ''), 160);
      if (!visible(el)) { addHidden({ href: clip(el.href, 500), rawHref: clip(raw, 300), scheme: u.protocol, download, text, names, why }); continue; }
      /* a link that only says "Download": the row says which file it is */
      let label = text; let parts = []; let hint = nameHint;
      if ((downloadRe.test(names[0] || '') || /^download\b/i.test(text)) && !(extOf(text) && FILE_EXT.test(extOf(text)))) { const info = rowInfo(el, text); if (info) { label = info.label; parts = info.parts; if (info.nameHint && !extOf(hint)) hint = info.nameHint; } }
      out.links.push({ text, names, label, rowParts: parts, href: el.href, rawHref: clip(raw, 300), scheme: u.protocol, download, ext, nameHint: clip(hint, 160), fileLike, why, sameOrigin: u.origin === location.origin, path: cssPath(el), group });
      continue;
    }
    if (tag === 'BUTTON' || tag === 'A' || role === 'button' || (tag === 'INPUT' && /^(button|submit)$/.test(el.type))) {
      const pressed = el.getAttribute('aria-pressed');
      if (pressed === 'true' || pressed === 'false') {   /* a toggle button */
        addToggle({ label: clip(labelOf(el, true), 120), checked: pressed === 'true', kind: 'pressed', disabled: Boolean(el.disabled), path: cssPath(el), key: keyOf(el) });
        continue;
      }
      const text = clip(norm(tag === 'INPUT' ? el.value : el.textContent) || norm(el.getAttribute('aria-label')) || norm(el.getAttribute('title')) || (el.querySelector && el.querySelector('img') ? norm(el.querySelector('img').alt) : ''), 160);
      if (!text) continue;
      if (toggleRe.test(text) && !toggleNever.test(text) && !el.disabled && visible(el)) {   /* a plain "Show all files" button */
        addToggle({ label: text, checked: false, kind: 'button', path: cssPath(el), key: keyOf(el) });
        continue;
      }
      const dataUrl = el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-download-url') || el.getAttribute('data-file') || null;
      const ext = extOf(text);
      const names = nameSources(el);
      const exportish = /^export\b.*\b(csv|xlsx?|pdf|zip|files?|reports?|data|excel)\b/i.test(text);
      const fileLike = Boolean((ext && FILE_EXT.test(ext)) || downloadRe.test(names[0] || '') || /^download\b/i.test(text) || exportish || (dataUrl && FILE_EXT.test(extOf(dataUrl.split('?')[0]) || '')));
      if (!fileLike) continue;
      if (!visible(el)) { addHidden({ button: true, href: '', text, names }); continue; }
      if (out.buttons.length >= L.buttonsMax) { trunc.buttons = true; continue; }
      /* inForm: the control sits in a form (or belongs to one), or has a formaction: pressing it may SUBMIT. scripted: its onclick attribute
         mentions a form or a request. Neither is pressed. */
      const inForm = el.hasAttribute('formaction') || Boolean(el.form) || Boolean(el.closest && el.closest('form'));
      const scripted = scriptedRe.test(el.getAttribute('onclick') || '');
      let label = text; let nameHint = text; let parts = [];
      if (!ext) {   /* "Download" says nothing: the text of its row says which file */
        const info = rowInfo(el, text);
        if (info) { label = info.label; parts = info.parts; if (info.nameHint) nameHint = info.nameHint; }
      }
      out.buttons.push({ text, names, label, rowParts: parts, nameHint: clip(nameHint, 160), fileLike, ext, dataUrl: dataUrl ? clip(dataUrl, 500) : null, disabled: Boolean(el.disabled), inForm, scripted, path: cssPath(el), group });
      continue;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const type = (el.type || tag).toLowerCase();
      if (type === 'password') signals.hasPasswordField = true;
      if (/one-time-code/.test(el.autocomplete || '') || (type === 'text' && /otp|verification|2fa|mfa/i.test((el.name || '') + ' ' + (el.id || '')))) signals.hasOtpField = true;
      if (!SKIP_TYPES.has(type)) controlCount += 1;
    }
  }
  out.linkCount = linkCount;
  out.controlCount = controlCount;
  out.frames = { blocked: blockedFrames };
  if (all.some((e) => e.tagName === 'IFRAME' && /recaptcha|hcaptcha|turnstile|captcha|challenge/i.test(e.src || '')) || document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]')) signals.hasCaptcha = true;

  /* the text, cut at every heading */
  const sections = [];
  let cur = null; let total = 0;
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join('').replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text || cur.heading) { if (sections.length < L.sections) sections.push({ heading: cur.heading, text: clip(text, L.sectionChars) }); else trunc.sections = true; }
    total += text.length;
    cur = null;
  };
  const begin = (heading) => { flush(); cur = { heading, parts: [], chars: 0 }; };
  const add = (s) => { if (!cur) begin(''); if (cur.chars <= L.sectionChars) { cur.parts.push(s); cur.chars += s.length; } else trunc.text = true; };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'CANVAS', 'OPTION']);
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TR', 'UL']);
  const addControl = (el) => {
    const type = (el.type || el.tagName).toLowerCase();
    if (SKIP_TYPES.has(type) || secretControl(el)) return;
    const value = el.tagName === 'SELECT' ? Array.from(el.selectedOptions || []).map((o) => norm(o.textContent)).join(', ') : el.value;
    if (value) add('\n' + (labelOf(el, false) || el.name || 'field') + ': ' + clip(String(value).replace(STRIP, ''), el.tagName === 'TEXTAREA' ? L.sectionChars : L.valueChars) + '\n');
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (over()) { trunc.time = true; return; }
      if (child.nodeType === 3) { add(String(child.nodeValue).replace(STRIP, '')); continue; }
      if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName) || !visible(child)) continue;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) { begin(clip(norm(child.textContent), 160)); continue; }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { addControl(child); continue; }
      if (tag === 'IFRAME') {
        let inner = null;
        try { inner = child.contentDocument; } catch (e) { inner = null; }
        if (inner && inner.body) walk(inner.body);
        continue;
      }
      const block = BLOCK.has(tag);
      if (block) add('\n');
      walk(child);
      if (child.shadowRoot) walk(child.shadowRoot);
      if (tag === 'BR') add('\n');
      if (tag === 'TD' || tag === 'TH') add(' | ');
      if (block) add('\n');
    }
  };
  walk(document.body || document.documentElement);
  flush();
  out.sections = sections;
  out.signals = { ...signals, bodyTextChars: total };
  out.truncated = trunc;
  return out;
}

/* Page side, constant, self-contained. Every op looks at the document, at its open shadow roots and at its same-origin iframes. opts.op:
     expand    open every closed <details>, click expanders (aria-expanded=false, no popup menu, no navigation link, nothing that would
               submit a form) one at a time and look again after each click (a tree that draws itself anew), the row of a tree item rather
               than the item; { opened, expanded, popups: [label], blocked, cut }
     controls  list tabs, "Load more" buttons and the pager: { tabs: [{ label, path, selected }], more: [{ label, path }], pager, popups, cut,
               blocked }; pager: { found, hinted, next, prev, nums: [{ n, label, path, href, current, disabled }], current }
     scroll    scroll the windows and every scrollable box by 90 percent of its height; { moved, atBottom, height }; opts.reset puts them
               back at the top, opts.probe only measures
     where     { href } of the page
     activate  { path, kind, ... } press ONE element, or choose option number `option` of a <select>, after checking the live element
               against the rule of its kind: download (a button named as a download, not in a form), link (an anchor with a download
               attribute or a download name, the address unchanged), tab, expander, more, pager, toggle (tkind: switch checkbox radio tab
               pressed option button). Any other kind, and any kind whose rule fails, is refused.
   A path is one CSS path per document, joined with " >>> " (see extractPage). */
function pageOps(opts) {
  const R = opts.rules || {};
  const HIDDEN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'g');
  const norm = (s) => String(s == null ? '' : s).replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const never = new RegExp(R.never || '(?!)', 'i');
  const downloadRe = new RegExp(R.download || '(?!)', 'i');
  const moreRe = new RegExp(R.more || '(?!)', 'i');
  const nextRe = new RegExp(R.next || '(?!)', 'i');
  const toggleRe = new RegExp(R.toggle || '(?!)', 'i');
  const toggleNever = new RegExp(R.toggleNever || '(?!)', 'i');
  const scriptedRe = new RegExp(R.scripted || '(?!)', 'i');
  const actionSet = new Set(Array.isArray(R.actions) ? R.actions : []);
  const caps = opts.caps || {};
  const visible = (el) => { try { return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true; } catch (e) { return true; } };
  const segmentOf = (n, rootNode) => {
    const parts = [];
    for (let m = n; m && m.nodeType === 1 && parts.length < 40; m = m.parentElement) {
      const t = m.tagName.toLowerCase();
      if (m.id && rootNode.querySelectorAll('#' + CSS.escape(m.id)).length === 1) { parts.unshift(t + '#' + CSS.escape(m.id)); break; }
      let idx = 1; for (let s = m.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === m.tagName) idx += 1;
      parts.unshift(t + ':nth-of-type(' + idx + ')');
    }
    return parts.join(' > ');
  };
  const cssPath = (el) => {
    const segs = [];
    let node = el;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const rootNode = node.getRootNode();
      segs.unshift(segmentOf(node, rootNode));
      if (rootNode === document) return segs.join(' >>> ');
      if (rootNode.host) node = rootNode.host;
      else if (rootNode.defaultView && rootNode.defaultView.frameElement) node = rootNode.defaultView.frameElement;
      else return null;
    }
    return null;
  };
  const resolve = (p) => {
    if (typeof p !== 'string' || !p) return null;
    let ctx = document; let el = null;
    for (const seg of p.split(' >>> ')) {
      if (!ctx) return null;
      try { el = ctx.querySelector(seg); } catch (e) { return null; }
      if (!el) return null;
      if (el.tagName === 'IFRAME') { try { ctx = el.contentDocument; } catch (e) { ctx = null; } } else ctx = el.shadowRoot;
    }
    return el;
  };
  /* the document, its open shadow roots and its same-origin iframes */
  const roots = () => {
    const found = [document];
    for (let i = 0; i < found.length && found.length < 40; i += 1) {
      let seen = 0;
      for (const el of found[i].querySelectorAll('*')) {
        seen += 1;
        if (seen > 20000 || found.length >= 40) break;
        if (el.shadowRoot) found.push(el.shadowRoot);
        if (el.tagName === 'IFRAME') { try { if (el.contentDocument && el.contentDocument.documentElement) found.push(el.contentDocument); } catch (e) { /* another origin */ } }
      }
    }
    return found;
  };
  const every = (selector, rs) => (rs || roots()).flatMap((r) => Array.from(r.querySelectorAll(selector)));
  const textOf = (el) => clip(norm(el.tagName === 'INPUT' ? el.value : el.textContent) || norm(el.getAttribute('aria-label')) || norm(el.title) || (el.querySelector && el.querySelector('img') ? norm(el.querySelector('img').alt) : ''), 160);
  const controlText = (c) => clip(norm(c.tagName === 'INPUT' ? c.value : c.textContent) || norm(c.getAttribute('aria-label')) || norm(c.getAttribute('title')), 160);
  const rowOf = (el, text) => {   /* the same rule as extractPage */
    const hard = el.closest ? el.closest('tr,li,[role=row]') : null;
    if (hard) return hard;
    for (let n = el.parentElement, depth = 0; n && depth < 8 && n.tagName !== 'BODY' && n.tagName !== 'HTML'; n = n.parentElement, depth += 1) {
      if (norm(n.innerText || n.textContent) === text) continue;
      let same = 0;
      for (const c of n.querySelectorAll('button,a,[role=button],input')) { if (controlText(c) === text) same += 1; if (same > 1) return null; }
      return n;
    }
    return null;
  };
  /* every name an element has, in the order a screen reader takes them */
  const namesOf = (el) => {
    const out = [];
    const add = (s) => { const t = clip(norm(s), 160); if (t && !out.includes(t)) out.push(t); };
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const root = el.getRootNode(); add(lb.split(/\s+/).map((id) => { const n = root.getElementById ? root.getElementById(id) : null; return n ? n.textContent : ''; }).join(' ')); }
    add(el.getAttribute('aria-label'));
    add(el.tagName === 'INPUT' ? el.value : el.textContent);
    add(el.getAttribute('title'));
    const img = el.querySelector ? el.querySelector('img') : null;
    if (img) add(img.alt);
    return out;
  };
  const tokensOf = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hasAction = (s) => never.test(s) || tokensOf(s).some((t) => actionSet.has(t));
  /* a link that goes somewhere is not a button: pressing it would leave the page */
  const pressable = (el) => el.tagName !== 'A' || !el.hasAttribute('href') || /^\s*(#.*)?$|^\s*javascript:\s*(void\s*\(\s*0?\s*\)|undefined|;)?\s*;?\s*$/i.test(el.getAttribute('href') || '');
  /* pressing it would submit a form: a button that belongs to a form and is not type=button or reset, or one with a formaction */
  const submitsForm = (el) => {
    if (el.hasAttribute('formaction')) return true;
    const t = String(el.getAttribute('type') || '').toLowerCase();
    const form = el.form || (el.closest ? el.closest('form') : null);
    if (!form) return false;
    if (el.tagName === 'BUTTON') return t !== 'button' && t !== 'reset';
    return el.tagName === 'INPUT' && /^(submit|image)$/.test(t);
  };
  const inAForm = (el) => Boolean(el.form) || Boolean(el.closest && el.closest('form'));
  const nameFits = (el) => {
    const names = namesOf(el);
    return names.length > 0 && downloadRe.test(names[0]) && !names.slice(1).some(hasAction);
  };
  const popupOf = (el) => { const p = el.getAttribute('aria-haspopup'); return Boolean(p && p !== 'false'); };

  if (opts.op === 'where') return { href: location.href };

  if (opts.op === 'expand') {
    let opened = 0; let expanded = 0; let blocked = 0; let cut = false;
    const popups = [];
    const rs = roots();
    for (const d of every('details:not([open])', rs)) { if (opened >= 200) { cut = true; break; } d.open = true; opened += 1; }
    const started = performance.now();
    for (let guard = 0; ; guard += 1) {
      if (guard >= 400 || performance.now() - started > 2500) { cut = true; break; }
      let target = null;
      /* looked up again after every click: a tree that draws itself anew has new nodes, and the old list holds dead ones */
      for (const el of every('[aria-expanded="false"]', rs)) {
        if (el.__fstTried) continue;
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (el.disabled || /^(combobox|menuitem|menu|option|listbox)$/.test(role) || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || !pressable(el) || !visible(el)) continue;
        if (popupOf(el)) { el.__fstTried = true; const l = textOf(el); if (/file|attachment|document|download/i.test(l) && popups.length < 10) popups.push(l); continue; }
        if (submitsForm(el)) { el.__fstTried = true; blocked += 1; continue; }
        target = el; break;
      }
      if (!target) break;
      target.__fstTried = true;
      /* a tree item: the handler sits on its row, which a click on the row reaches (and bubbles up to the item as well) */
      let spot = target;
      if ((target.getAttribute('role') || '').toLowerCase() === 'treeitem') {
        for (const child of Array.from(target.children)) {
          const crole = (child.getAttribute('role') || '').toLowerCase();
          if (child.tagName === 'UL' || child.tagName === 'OL' || crole === 'group' || child.tagName === 'A' || child.querySelector('a[href]') || !visible(child)) continue;
          spot = child; break;
        }
      }
      spot.click(); expanded += 1;
    }
    return { opened, expanded, popups, blocked, cut };
  }
  if (opts.op === 'controls') {
    const tabsMax = caps.tabs || 50; const moreMax = caps.more || 50;
    const tabs = []; const more = []; const popups = []; const cut = {}; let blocked = 0;
    const rs = roots();
    for (const el of every('[role=tab]', rs)) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) continue;
      if (tabs.length >= tabsMax) { cut.tabs = (cut.tabs || 0) + 1; continue; }
      tabs.push({ label: textOf(el), path: cssPath(el), selected: el.getAttribute('aria-selected') === 'true' });
    }
    const ctrls = every('button,a,[role=button],[role=link],input[type=button]', rs).filter((el) => visible(el));
    /* the pager: Next / Previous / numbered controls that sit together (a nav, a list, a pagination box) */
    const PREV = /^(?:prev(?:ious)?(?:\s+page)?|newer|first|last|[\u2039\u00ab<\u2190]+)$/i;
    const groups = new Map();
    for (const el of ctrls) {
      const aria = norm(el.getAttribute('aria-label'));
      const label = textOf(el);
      const rel = String(el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      const kind = nextRe.test(aria) || nextRe.test(label) || rel.includes('next') ? 'next' : (PREV.test(aria) || PREV.test(label) ? 'prev' : (/^\d{1,4}$/.test(label) ? 'num' : ''));
      if (!kind) continue;
      const box = (el.closest ? el.closest('nav,[role=navigation],ul,ol,[class*=pag]') : null) || el.parentElement;
      if (!box) continue;
      if (!groups.has(box)) groups.set(box, []);
      groups.get(box).push({ el, kind, label, aria });
    }
    const isCurrent = (el) => {
      const li = el.parentElement;
      const cls = String(el.className || '') + ' ' + String((li && li.className) || '');
      return ['page', 'true'].includes(String(el.getAttribute('aria-current') || (li && li.getAttribute('aria-current')) || '')) || el.getAttribute('aria-selected') === 'true' || Boolean(el.disabled) || /\b(active|current|selected)\b/i.test(cls);
    };
    const hrefOf = (el) => (el.tagName === 'A' && !pressable(el) ? el.href : null);
    let pager = { found: false, hinted: false, next: null, prev: null, nums: [], current: null };
    let bestSize = 0; let bestItems = [];
    for (const [box, items] of groups) {
      const nums = items.filter((i) => i.kind === 'num');
      const next = items.find((i) => i.kind === 'next');
      const prev = items.find((i) => i.kind === 'prev');
      const labelled = /pag/i.test(String(box.getAttribute('aria-label') || '') + ' ' + String(box.className || ''));
      const relNext = Boolean(next) && String(next.el.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes('next');
      const ok = nums.length >= 2 || ((next || prev) && (nums.length >= 1 || labelled || (next && prev) || relNext));
      const wizard = Boolean(box.closest && box.closest('form')) && nums.length < 2 && !labelled;   /* "Next" in a form is a step of the form */
      if (!ok || wizard || items.length <= bestSize) continue;
      bestSize = items.length; bestItems = items;
      const describe = (i) => ({ label: i.label || i.aria, path: cssPath(i.el), href: hrefOf(i.el), disabled: Boolean(i.el.disabled) || i.el.getAttribute('aria-disabled') === 'true' });
      const numbered = nums.map((i) => ({ n: Number(i.label), current: isCurrent(i.el), ...describe(i) })).sort((a, b) => a.n - b.n);
      const cur = numbered.find((x) => x.current);
      pager = { found: true, hinted: true, next: next ? describe(next) : null, prev: prev ? describe(prev) : null, nums: numbered, current: cur ? cur.n : null };
    }
    if (!pager.found) {
      let hinted = false;
      try { hinted = Boolean(document.querySelector('nav[aria-label*="pagin" i],[aria-label*="pagination" i],[class*="pagination" i],[class*="pager" i],a[rel~="next"],link[rel~="next"]')); } catch (e) { hinted = false; }
      if (!hinted) { try { hinted = /\bpage\s+\d+\s+of\s+\d+\b/i.test(String((document.body && document.body.innerText) || '').slice(0, 30000)); } catch (e) { hinted = false; } }
      pager.hinted = hinted;
    }
    const inPager = new Set();
    if (pager.found) for (const i of bestItems) inPager.add(i.el);
    for (const el of ctrls) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (popupOf(el)) { const l = textOf(el); if (/file|attachment|document|download/i.test(l) && popups.length < 10 && !popups.includes(l)) popups.push(l); continue; }
      if (!pressable(el) || inPager.has(el)) continue;
      const l = textOf(el);
      if (!moreRe.test(l) || toggleRe.test(l) || toggleNever.test(l) || (el.getAttribute('role') || '').toLowerCase() === 'tab') continue;
      if (submitsForm(el)) { blocked += 1; continue; }
      if (more.length >= moreMax) { cut.more = (cut.more || 0) + 1; continue; }
      more.push({ label: l, path: cssPath(el) });
    }
    return { tabs, more, pager, popups, cut, blocked };
  }
  if (opts.op === 'scroll') {
    const boxes = [];
    const styleOf = (el) => { const v = el.ownerDocument && el.ownerDocument.defaultView; return (v && v.getComputedStyle ? v : globalThis).getComputedStyle(el); };
    for (const r of roots()) {
      const doc = r.nodeType === 9 ? r : null;
      if (doc) { const base = doc.scrollingElement || doc.documentElement; if (base) boxes.push({ el: base, step: Math.max(40, Math.floor(((doc.defaultView || window).innerHeight || 800) * 0.9)) }); }
      let seen = 0;
      for (const el of r.querySelectorAll('*')) {
        if (seen >= 5000 || boxes.length >= 30) break;
        seen += 1;
        if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 40) { const oy = styleOf(el).overflowY; if (oy === 'auto' || oy === 'scroll') boxes.push({ el, step: Math.max(40, Math.floor(el.clientHeight * 0.9)) }); }
      }
    }
    if (opts.reset) { for (const b of boxes) b.el.scrollTop = 0; return { moved: false, atBottom: false, height: 0 }; }
    let moved = false;
    if (!opts.probe) for (const b of boxes) { const before = b.el.scrollTop; b.el.scrollTop = before + b.step; if (b.el.scrollTop !== before) moved = true; }
    /* at the bottom: no box has room left to scroll (within 2 pixels) */
    const atBottom = boxes.every((b) => b.el.scrollTop + b.el.clientHeight >= b.el.scrollHeight - 2);
    const height = boxes.reduce((sum, b) => sum + b.el.scrollHeight, 0);
    return { moved, atBottom, height };
  }
  if (opts.op === 'activate') {
    const el = resolve(opts.path);
    if (!el) return { ok: false, why: 'the element is gone from the page' };
    const kind = String(opts.kind || '');
    const text = textOf(el);
    const names = namesOf(el);
    const refuse = (why) => ({ ok: false, why });
    if (typeof opts.label === 'string' && opts.label !== '' && kind !== 'toggle' && text !== opts.label) return refuse('the element is no longer the one that was listed');
    const tag = el.tagName;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (kind === 'download') {
      /* a button named as a download; not a link, not in a form, no script that submits or sends */
      if (tag === 'A' && !pressable(el)) return refuse('the element is a link, not a button');
      if (inAForm(el) || el.hasAttribute('formaction')) return refuse('the control is in a form and may submit it');
      if (scriptedRe.test(el.getAttribute('onclick') || '')) return refuse('the control runs a script that submits or sends something');
      if (!nameFits(el)) return refuse('the control is not named as a download');
      if (typeof opts.row === 'string' && opts.row !== '' && opts.row !== text) {   /* a "Download" button: which row is it in? */
        const rowEl = rowOf(el, text);
        const full = rowEl ? norm(norm(rowEl.innerText || rowEl.textContent).replace(text, ' ')) : '';
        const rowText = clip(full, 160);
        const parts = Array.isArray(opts.parts) ? opts.parts.filter((x) => typeof x === 'string' && x !== '') : [];
        const same = rowText === opts.row || (typeof opts.name === 'string' && opts.name !== '' && full.includes(opts.name)) || (parts.length > 0 && parts.every((x) => full.includes(x)));   /* the name cell survives a status that changed */
        if (!rowEl || !same) return refuse('the row of the element is no longer the one that was listed');
      }
    } else if (kind === 'link') {
      /* a link pressed in the page: a blob or data address (it exists only there) or a download link whose address is the one that was listed */
      if (tag !== 'A') return refuse('the element is no longer a link');
      if (typeof opts.href === 'string' && opts.href !== '') { if (el.href !== opts.href) return refuse('the address of the link changed'); }
      else if (!/^(blob|data):/i.test(el.href)) return refuse('the link is not a blob or data link');
      if (scriptedRe.test(el.getAttribute('onclick') || '')) return refuse('the link runs a script that submits or sends something');
      if (!el.hasAttribute('download') && !nameFits(el)) return refuse('the link is not clearly a download');
    } else if (kind === 'tab') {
      if (role !== 'tab') return refuse('the element is no longer a tab');
      if (submitsForm(el)) return refuse('the control would submit a form');
    } else if (kind === 'expander') {
      if (!el.hasAttribute('aria-expanded') && tag !== 'SUMMARY' && role !== 'treeitem') return refuse('the element is no longer an expander');
      if (!pressable(el) || submitsForm(el)) return refuse('the control would leave the page or submit a form');
    } else if (kind === 'more') {
      if (!moreRe.test(text) && !nextRe.test(text)) return refuse('the element is no longer a "Load more" control');
      if (!pressable(el) || submitsForm(el) || toggleNever.test(text)) return refuse('the control would leave the page or submit a form');
    } else if (kind === 'pager') {
      if (!(nextRe.test(text) || nextRe.test(norm(el.getAttribute('aria-label'))) || /^\d{1,4}$/.test(text) || String(el.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes('next'))) return refuse('the element is no longer a page control');
      if (submitsForm(el)) return refuse('the control would submit a form');
    } else if (kind === 'toggle') {
      /* the "show all files" control: a switch, checkbox, radio, tab, pressed button, <select> option or plain button whose label says so */
      const tkind = String(opts.tkind || '');
      const labels = namesOf(el);
      if (el.labels) for (const l of Array.from(el.labels)) labels.push(norm(l.textContent));
      const wrap = el.closest ? el.closest('label') : null;
      if (wrap) labels.push(norm(wrap.textContent));
      const shown = labels.concat(typeof opts.label === 'string' ? [opts.label] : []);
      if (shown.some((l) => toggleNever.test(l))) return refuse('the label of the control names an action');
      if (tkind === 'option') {
        if (tag !== 'SELECT' || typeof opts.option !== 'number' || !el.options || !el.options[opts.option]) return refuse('the element is no longer a choice list');
        const o = norm(el.options[opts.option].textContent);
        if (toggleNever.test(o) || (!opts.learned && !toggleRe.test(o))) return refuse('the choice is not "show all files"');
      } else if (tkind === 'switch' || tkind === 'checkbox' || tkind === 'radio') {
        if (!((tag === 'INPUT' && /^(checkbox|radio)$/.test(el.type)) || /^(switch|checkbox|radio)$/.test(role))) return refuse('the element is no longer a switch');
      } else if (tkind === 'tab') {
        if (role !== 'tab') return refuse('the element is no longer a tab');
      } else if (tkind === 'pressed') {
        if (el.getAttribute('aria-pressed') === null) return refuse('the element is no longer a toggle button');
      } else if (tkind === 'button') {
        if (!(tag === 'BUTTON' || role === 'button' || tag === 'INPUT') || inAForm(el) || !toggleRe.test(text)) return refuse('the element is no longer the "show all files" button');
      } else return refuse('the loader does not press this kind of control');
    } else {
      return refuse('the loader does not press this kind of element');
    }
    if (kind === 'toggle' && typeof opts.option === 'number' && el.tagName === 'SELECT') {
      el.selectedIndex = opts.option;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    el.click();
    return { ok: true };
  }
  return { ok: false, why: 'unknown operation' };
}

async function takePage(tab, limits = {}) {
  return tab.evalFn(extractPage, pageArgs({ limits: { ...LIMITS, ...limits } }), { timeout: 12000 });
}
const pageOp = (tab, op, extra = {}) => tab.evalFn(pageOps, { op, rules: RULES, caps: { tabs: LIMITS.tabsMax, more: LIMITS.moreMax }, ...extra }, { timeout: 8000, userGesture: op === 'activate' });

/* The file-name phrase at the start of a text: everything up to the end of the first extension ("Entity 01 Budget.txt 1 KB" gives
   "Entity 01 Budget.txt"); the whole text when there is no extension. */
const NAME_PHRASE_RE = new RegExp(`^(.*?\\.(?:${EXT_SRC})(?:\\.(?:${EXT_SRC}))*)(?![A-Za-z0-9])`, 'i');
const namePhrase = (text) => { const m = NAME_PHRASE_RE.exec(String(text || '')); return m ? m[1] : String(text || ''); };
const endsInFileExtension = (text) => { const m = FILE_NAME_END.exec(String(text || '')); return Boolean(m && FILE_EXTENSIONS.test(m[1])); };

const decode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
const tokensOf = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const hasActionWord = (s) => tokensOf(s).some((t) => ACTION_SET.has(t));

/* Why an address may not be requested: an action word in a directory of the path, a file name that IS an action word, an action parameter
   with a verb for a value, or an action word in the name or value of a parameter (a signature and a file name are not read for words).
   '' when the address passes. Only http and https addresses have a path and a query to judge. */
function addressProblem(href) {
  let u;
  try { u = new URL(href); } catch (e) { return 'unreadable address'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const segs = u.pathname.split('/').filter(Boolean).map(decode);
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const m = i === segs.length - 1 ? FILE_NAME_END.exec(seg) : null;
    if (m && FILE_EXTENSIONS.test(m[1])) { if (ACTION_SET.has(seg.slice(0, m.index).toLowerCase())) return `the file name is the action word "${seg}"`; continue; }
    if (hasActionWord(seg)) return `the path has the action word "${seg}"`;
  }
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (SIGNATURE_PARAM_RE.test(key)) continue;
    if (ACTION_PARAMS.has(key)) {
      const vt = tokensOf(v);
      if (vt.length && !vt.every((t) => DOWNLOAD_VALUES.has(t))) return `the parameter ${k} names an action`;
      continue;
    }
    if (hasActionWord(k)) return `the parameter ${k} names an action`;
    if (VALUE_FREE_PARAMS.has(key)) continue;
    if (hasActionWord(v)) return `the parameter ${k} holds an action word`;
  }
  return '';
}

/* names: every name the element has, in screen reader order. A download name: the first one is a download phrase and none of the
   others names an action. */
function nameIsDownload(names) {
  const list = (Array.isArray(names) ? names : [names]).map((n) => String(n || '')).filter(Boolean);
  if (!list.length || !DOWNLOAD_NAME_RE.test(list[0])) return false;
  return !list.slice(1).some((n) => NEVER_TEXT_RE.test(n) || hasActionWord(n));
}
const startsWithAction = (name) => { const first = tokensOf(name)[0]; return NEVER_TEXT_RE.test(String(name || '')) || Boolean(first && ACTION_SET.has(first)); };

/* Whether the loader may request or press a link, and why not. { allow: 'extension' | 'download-attribute' | 'download-path' | 'download-name' }
   or { allow: null, why: 'action' | 'unclear' }. */
function linkVerdict(l) {
  const names = l.names && l.names.length ? l.names : [l.text];
  let u = null;
  try { u = new URL(l.href || ''); } catch (e) { u = null; }
  const hasDownloadAttr = l.download !== null && l.download !== undefined;
  if (u && /^https?:$/.test(u.protocol)) {
    if (addressProblem(l.href) || NEVER_HREF_RE.test(l.rawHref || '')) return { allow: null, why: 'action' };
    let last = '';
    try { last = decode(u.pathname.split('/').filter(Boolean).pop() || ''); } catch (e) { last = ''; }
    if (endsInFileExtension(last)) return { allow: 'extension' };
    if (hasDownloadAttr) return { allow: 'download-attribute' };
    if (/^downloads?$/i.test(last)) return { allow: 'download-path' };
    if (nameIsDownload(names)) return { allow: 'download-name' };
    return { allow: null, why: 'unclear' };
  }
  if (u && /^(blob|data):$/.test(u.protocol)) {
    if (hasDownloadAttr) return { allow: 'download-attribute' };
    if (nameIsDownload(names)) return { allow: 'download-name' };
    return { allow: null, why: 'unclear' };
  }
  return { allow: null, why: 'unclear' };
}

/* The address of a file link without what changes each time it is issued (a signature, an expiry): two copies of the same file that were
   signed twice have the same key. When something was removed the label (and the scope, say the tab) is part of the key, so two files that
   differ only in a token ("/download?token=a" and "/download?token=b") stay two files as long as their names differ, and the same name and
   the same token-less address in two tabs are two files. */
function navigateKey(href, label = '', scope = '') {
  let u = null;
  try { u = new URL(href); } catch (e) { return `n|${href}`; }
  const kept = []; let removed = false;
  for (const [k, v] of u.searchParams) { if (SIGNATURE_PARAM_RE.test(k)) removed = true; else kept.push(`${k}=${v}`); }
  kept.sort();
  return `n|${u.origin}${u.pathname}${kept.length ? `?${kept.join('&')}` : ''}${removed ? `|${label}${scope ? `|${scope}` : ''}` : ''}`;
}

/* The ordered list of things worth downloading, from links and buttons, and the ones that were left out although they look like files.
   Pure; the page URL only resolves data-url values. Every candidate carries the heading above it (group), a label (the link's text; for
   a plain "Download" button the text of its row), its kind (link or button), the rule that allowed it (allow) and the view of the page it
   was seen in (snap.view, see discover.cjs). mode 'navigate' opens the address in a tab of its own; mode 'click' clicks the element in the
   task page (a button, or a blob: or data: link, which only exist inside the page). A "Download all" button is dropped when individual
   files are listed (the files themselves are the list). dropped: [{ label, group, reason }] for a file-looking control the loader will
   not use: an action address ("looks like an action"), a name that is not clearly a download, a button that would submit a form, a
   disabled button. An icon link that only names an action ("Move to trash") is not a file and is not reported. */
function classify(snap) {
  const seen = new Set();
  const candidates = [];
  const dropped = [];
  const view = snap.view || null;
  const drop = (label, group, reason) => dropped.push({ label: String(label || ''), group: String(group || ''), reason });
  for (const l of snap.links || []) {
    if (!l.fileLike || !/^(https?|blob|data):$/.test(l.scheme)) continue;
    const verdict = linkVerdict(l);
    const names = l.names && l.names.length ? l.names : [l.text];
    const label = l.label || l.text || names[0] || '';
    if (!verdict.allow) {
      /* an action address is reported when something on the link names a file; an icon that only says "Move to trash" is not a file */
      if (verdict.why === 'action') { if (String(l.text || '').trim().length > 2 && (names.some(endsInFileExtension) || !names.some(startsWithAction))) drop(label, l.group, 'looks like an action'); }
      else drop(label, l.group, NOT_CLEAR);
      continue;
    }
    const download = l.download !== null && l.download !== undefined;
    if (/^(blob|data):$/.test(l.scheme)) {
      const k = `click|${l.path}|${l.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      candidates.push({ mode: 'click', kind: 'link', allow: verdict.allow, download, text: l.text, href: null, nameHint: l.nameHint || l.text, ext: l.ext, group: l.group || '', label: l.label || l.text || '', rowParts: l.rowParts || [], path: l.path, view });
      continue;
    }
    if (!/^https?:$/.test(l.scheme)) continue;
    /* the same address listed twice on one page is one file; two addresses that differ in a token are two (CandidateSet pairs them across looks) */
    const k = `n|${l.href}`;
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push({ mode: 'navigate', kind: 'link', allow: verdict.allow, download, text: l.text, href: l.href, nameHint: l.nameHint || l.text, ext: l.ext, group: l.group || '', label: l.label || l.text || '', rowParts: l.rowParts || [], path: l.path, view });
  }
  const buttons = [];
  for (const b of snap.buttons || []) {
    if (!b.fileLike) continue;
    const names = b.names && b.names.length ? b.names : [b.text];
    const all = ALL_BUTTON_RE.test(b.text);
    /* a bare "Download" is called by the text of its row; any other text is its own name ("Download app") */
    const shown = /^[^a-z0-9]*download[^a-z0-9]*$/i.test(b.text) ? (b.label || b.text) : b.text;
    if (b.disabled) { if (!all) drop(shown, b.group, 'the button is disabled'); continue; }
    if (!nameIsDownload(names)) { if (!all) drop(shown, b.group, names.some(startsWithAction) ? 'looks like an action' : NOT_CLEAR); continue; }
    if (b.inForm) { if (!all) drop(shown, b.group, 'would submit a form'); continue; }
    if (b.scripted) { if (!all) drop(shown, b.group, 'looks like an action'); continue; }
    let href = null;
    if (b.dataUrl) { try { href = new URL(b.dataUrl, snap.url).href; } catch (e) { href = null; } }
    if (href && seen.has(`n|${href}`)) continue;
    if (href) seen.add(`n|${href}`);
    /* A button is clicked in the page (it may build a blob: URL), because its data-url, if any, is only a hint. */
    buttons.push({ mode: 'click', kind: 'button', allow: 'download-name', download: false, text: b.text, href, nameHint: b.nameHint || b.text, ext: b.ext, group: b.group || '', label: b.label || b.text, rowParts: b.rowParts || [], path: b.path, view });
  }
  const single = buttons.filter((b) => !ALL_BUTTON_RE.test(b.text));
  return { candidates: candidates.concat(candidates.length + single.length ? single : buttons), dropped };
}
const fileCandidates = (snap) => classify(snap).candidates;
const droppedCandidates = (snap) => classify(snap).dropped;

/* The controls of a pager in the order they should be pressed: the Next control (when it is enabled), else the numbered controls after the
   current one, in order. pager: as pageOps 'controls' lists it. */
function pagerSteps(pager) {
  if (!pager || !pager.found) return [];
  const steps = [];
  if (pager.next && !pager.next.disabled) steps.push({ ...pager.next, how: 'next' });
  if (pager.current !== null && pager.current !== undefined) for (const x of pager.nums || []) if (x.n > pager.current && !x.disabled) steps.push({ ...x, how: 'number' });
  return steps;
}

/* A pager link the loader may follow: the same site and path as the page, and no difference but a page-type parameter. */
const PAGE_PARAM_RE = /^(page|p|pg|pagenum|page_num|page_number|pageindex|page_index|paged|offset|start|skip|from|cursor|after)$/i;
function pageLinkOk(target, current) {
  let a; let b;
  try { a = new URL(target); b = new URL(current); } catch (e) { return false; }
  if (!/^https?:$/.test(a.protocol) || a.origin !== b.origin || a.pathname !== b.pathname) return false;
  const rest = (u) => { const m = new Map(); for (const [k, v] of u.searchParams) if (!PAGE_PARAM_RE.test(k)) m.set(k, v); return [...m].sort().map(([k, v]) => `${k}=${v}`).join('&'); };
  return rest(a) === rest(b);
}

/* toggles: [{ label, checked, disabled, path, key, kind }] as extractPage lists them. learned: what was taught for this host: a label
   (text), or { label, key }. Returns the control to switch ON (an UNCHECKED, enabled one) or null. A control is considered only when it
   is a switch, checkbox, radio, tab, pressed button, choice or plain button, and its label names none of clear, delete, remove, reset,
   archive, move, apply, bulk, select all and the like. Then: the learned key (an id or data-testid), the learned label, then the first
   label that matches TOGGLE_LABEL_RE. */
const usableToggle = (t) => Boolean(t && typeof t.label === 'string' && !t.disabled && TOGGLE_KINDS.has(t.kind || 'switch') && !TOGGLE_NEVER_RE.test(t.label));
function findAllFilesToggle(toggles, learned) {
  const usable = (Array.isArray(toggles) ? toggles : []).filter((t) => usableToggle(t) && !t.checked);
  const taught = typeof learned === 'string' ? { label: learned, key: '' } : (learned && typeof learned === 'object' ? learned : {});
  if (typeof taught.key === 'string' && taught.key) { const hit = usable.find((t) => t.key === taught.key); if (hit) return hit; }
  if (typeof taught.label === 'string' && taught.label.trim()) {
    const key = taught.label.trim().toLowerCase();
    const hit = usable.find((t) => t.label.trim().toLowerCase() === key);
    if (hit) return hit;
  }
  return usable.find((t) => TOGGLE_LABEL_RE.test(t.label)) || null;
}

/* Like findAllFilesToggle, but a control that is already ON counts: { toggle, on } or null. A switch that is already on is found and
   flipped (nothing to click). */
function findAllFilesState(toggles, learned) {
  const off = findAllFilesToggle(toggles, learned);
  if (off) return { toggle: off, on: false };
  const taught = typeof learned === 'string' ? { label: learned, key: '' } : (learned && typeof learned === 'object' ? learned : {});
  const on = (Array.isArray(toggles) ? toggles : []).filter((t) => usableToggle(t) && t.checked);
  const hit = (taught.key && on.find((t) => t.key === taught.key))
    || (typeof taught.label === 'string' && taught.label.trim() && on.find((t) => t.label.trim().toLowerCase() === taught.label.trim().toLowerCase()))
    || on.find((t) => TOGGLE_LABEL_RE.test(t.label));
  return hit ? { toggle: hit, on: true } : null;
}

module.exports = {
  extractPage, pageOps, pageOp, takePage, pageArgs, RULES, fileCandidates, droppedCandidates, classify, linkVerdict, addressProblem, nameIsDownload, pagerSteps, pageLinkOk,
  navigateKey, namePhrase, findAllFilesToggle, findAllFilesState, TOGGLE_LABEL_RE, TOGGLE_NEVER_RE, LIMITS, NOT_CLEAR, NEVER_TEXT_RE, NEVER_HREF_RE, NEVER_ACTION_PARAM_RE, ACTION_WORDS,
  ALL_BUTTON_RE, FILE_EXTENSIONS, EXT_SRC,
};
