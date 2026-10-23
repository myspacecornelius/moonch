'use strict';
/* Reading a task page: evaluations in the isolated world that turn the DOM into plain data, then pure functions on that data.
   Deterministic, no model. extractPage and pageOps are CONSTANT functions: they are sent to the page as text, they use nothing from
   this module, and their arguments go in as JSON (tab.evalFn), so nothing from the page, the link or the person can become code.

   extractPage reads, nothing clicked, nothing submitted. It walks the document in order, open shadow roots and same-origin iframes
   included, and returns
     sections   the page text cut at every heading: [{ heading, text }] (text capped per section, section count capped)
     links, buttons   the ones that look like FILES (with the heading above them, as their group), only those a person can see; a
                button called just "Download" takes the text of its table row or list item as its label
     toggles    every switch, checkbox, pressed-button, radio, tab, <select> option and "show all files" button, with its label, its state
                and a stable key (id or data-testid) for when it has no label
     signals    what the sign-in classifier needs (a password field, a one-time-code field, a CAPTCHA, how much text there is)
   It never reads password, hidden and file inputs, nor any control whose name looks like a secret or a code, and never cookies or storage.
   The values hold full URLs and a signed link carries its signature in the query string: the result stays in memory and is never logged.

   pageOps does the few things the loader does to a page, one small step per call: open <details> and expanders, list tabs and
   "load more" buttons, scroll the scrollable boxes one step, and activate ONE element (a click, or choosing a <select> option) after
   checking that it is still the element that was listed and is not a destructive one.

   Exports: extractPage, pageOps, pageOp, takePage, fileCandidates, droppedCandidates, classify, navigateKey, namePhrase, findAllFilesToggle,
   findAllFilesState, TOGGLE_LABEL_RE, LIMITS, NEVER_TEXT_RE, NEVER_HREF_RE, NEVER_ACTION_PARAM_RE. */

const LIMITS = {
  maxMs: 2500, maxElements: 40000, maxRoots: 40, sections: 200, sectionChars: 20000, valueChars: 400,
  linksMax: 2000, buttonsMax: 300, togglesMax: 60, headingsMax: 80, selectOptions: 20,
};

/* Things we will never fetch or click even if they look like files: they change state on the platform or end the person's session. The
   text rule is anchored at the start ("Delete file", "Sign out") so a file called Archive_2026.zip or Approved_Budget.xlsx still
   qualifies; the address rule looks for the verb as a whole path segment or as an action parameter. */
const NEVER_TEXT_RE = /^(delete|remove|log ?out|sign ?out|cancel|revoke|reset|unsubscribe|submit|approve|reject|publish|archive)\b/i;
const NEVER_HREF_RE = /(^|\/)(delete|remove|logout|log-out|signout|sign-out|revoke|unsubscribe|reset|approve|reject|publish)(\/|$|\?|#)|[?&](action|op|do|cmd)=(delete|remove|logout|revoke|approve|reject|publish)/i;
/* A link that is plainly a FILE (its name ends in a file extension, or it has a download attribute) is a GET of a document, whatever the
   words in its name or its folder: "Reset policy.pdf", /publish/2025/policy.pdf. Only an action parameter still stops it. */
const NEVER_ACTION_PARAM_RE = /[?&](action|op|do|cmd)=(delete|remove|logout|revoke|approve|reject|publish)/i;
/* Query parameters that sign or time-limit an address and change every time it is issued. */
const SIGNATURE_PARAM_RE = /^(x-amz-.*|x-goog-.*|x-ms-.*|x-sig.*|x-expires|x-token|signature|sig|se|sp|sv|sr|st|spr|skoid|sktid|expires?|token|policy|key-pair-id|awsaccesskeyid|googleaccessid)$/i;

/* The label of the "show all files" control: show, include, display or view (with all, every, the, world or available) before files,
   attachments, documents or downloads; or all, every or world before them. "Show only added files" and "Show details" do not match.
   Bounded: every repetition consumes a word, so it runs in linear time. */
const TOGGLE_LABEL_RE = /\b(?:(?:show|include|display|view)\s+(?:(?:all|every|the|world|available)\s+)*(?:files?|attachments?|documents?|downloads?)|(?:all|every|world)\s+(?:the\s+)?(?:files?|attachments?|documents?|downloads?))\b/i;

/* Page side. Must be self-contained: it is serialised with toString() and run in the page's isolated world. */
function extractPage(opts) {
  const T0 = performance.now();
  const L = opts.limits;
  const toggleRe = new RegExp(opts.toggleRe || '(?!)', 'i');   /* without a pattern nothing counts as a "show all files" button */
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
  const collect = (root) => {
    const found = root.querySelectorAll('*');
    for (let j = 0; j < found.length; j += 1) {
      if (all.length >= L.maxElements) { trunc.elements = true; return; }
      const el = found[j];
      all.push(el);
      if (el.shadowRoot && roots < L.maxRoots) { roots += 1; collect(el.shadowRoot); }
      if (el.tagName === 'IFRAME' && roots < L.maxRoots) {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }   /* another origin: not readable */
        if (inner && inner.documentElement) { roots += 1; collect(inner); }
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
  /* what a row says besides the control: its label (the row text without the control's own text), the file-name phrase it holds, and the
     STABLE parts of it (cells and lines that are not a size, a date, a time or "5 min ago", cut where such a thing starts), which are
     what tells two rows apart when their text changes every minute */
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
    const parts = [];
    for (const line of lines.length ? lines : [norm(row.textContent)]) {
      const cell = norm(line.split(text).join(' '));
      if (!cell || VOLATILE_CELL.test(cell)) continue;
      const stable = norm(cell.replace(VOLATILE_CUT, ''));
      if (stable) parts.push(clip(stable, 80));
    }
    return { label: clip(full, 160), nameHint, parts: parts.slice(0, 4) };
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

  const out = { url: location.href, title: norm(document.title), readyState: document.readyState };
  const signals = { hasPasswordField: false, hasOtpField: false, hasCaptcha: false };
  /* a name is secret-looking when a secret word is a whole word in it: password, token, csrf ... but not passage, scorecard, author_notes */
  const secretish = (s) => /-(password|passwd|pwd|secret|token|csrf|xsrf|otp|cvv|ssn)-/i.test('-' + String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-') + '-');
  const secretControl = (el) => secretish(el.name) || secretish(el.id) || /(current-password|new-password|one-time-code|^cc-)/i.test(el.autocomplete || '');
  const SKIP_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio']);
  const FILE_EXT = /^(pdf|docx?|xlsx?|xlsm|xlsb|csv|tsv|txt|md|json|zip|7z|tar|gz|tgz|rar|rtf|pptx?|odt|ods|odp|png|jpe?g|gif|svg|eml|msg|xml|parquet)$/i;
  const WEB_EXT = /^(html?|xhtml|shtml|php\d?|aspx?|jsp|cfm|cgi|pl|do|action|js|mjs|css|map|com|org|net|io)$/i;
  const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || ''); return m ? m[1].toLowerCase() : null; };
  const EXTS = FILE_EXT.source.slice(2, -2);
  /* the file-name phrase at the start of a line of row text: everything up to the end of the first extension ("Entity 01 Budget.txt", "archive.tar.gz") */
  const NAME_RE = new RegExp('^(.*?\\.(?:' + EXTS + ')(?:\\.(?:' + EXTS + '))*)(?![A-Za-z0-9])', 'i');
  const controlText = (c) => clip(norm(c.tagName === 'INPUT' ? c.value : c.textContent) || norm(c.getAttribute('aria-label')) || norm(c.getAttribute('title')), 160);
  /* The row of a control: its table row, list item or row-role ancestor; else the nearest ancestor whose text is more than the control's
     own (a wrapper that holds only the control does not count) and that does not hold a second control with the same text (that would
     be a container of several rows). null when there is none. */
  const rowOf = (el, text) => {
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
  const dispositionName = (u) => { const d = u.searchParams.get('response-content-disposition') || u.searchParams.get('filename') || ''; const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(d); if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } } return d && !/=/.test(d) ? d : ''; };

  out.headings = []; out.links = []; out.buttons = []; out.toggles = [];
  let controlCount = 0; let linkCount = 0; let group = '';
  const addToggle = (t) => { if (out.toggles.length < L.togglesMax) out.toggles.push({ disabled: false, key: '', group, ...t }); };
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
      const why = [];
      if (download !== null) why.push('download-attribute');
      const textExt = extOf(norm(el.textContent));
      if (ext && FILE_EXT.test(ext)) why.push('extension');
      else if (textExt && FILE_EXT.test(textExt)) why.push('text-extension');   /* the link is called Budget_2025.xlsx; its address says nothing. Only a hint that it is a file: it never waives the rules about addresses */
      else if (ext && /[a-z]/i.test(ext) && /^[a-z0-9]{2,5}$/i.test(ext) && !WEB_EXT.test(ext)) why.push('extension-guess');   /* an unknown extension that is not a web page: probably a file (.bin, .dat) */
      if (u && /(^|\/)(download|downloads|attachments?|files?|blob|export|assets)\/[^/]/i.test(u.pathname)) why.push('path');   /* /files/12 yes; /files and /assets, the pages themselves, no */
      if (u && /(^|[?&])(x-amz-signature|signature|x-goog-signature|sig|se|sp)=/i.test(u.search)) why.push('signed-url');
      const fileLike = why.length > 0 && Boolean(u) && /^(https?|blob|data):$/.test(u.protocol);
      if (!fileLike || !visible(el)) continue;
      const text = clip(norm(el.textContent) || norm(el.getAttribute('aria-label')) || norm(el.title) || (el.querySelector('img') ? norm(el.querySelector('img').alt) : ''), 160);
      /* a link that only says "Download": the row says which file it is */
      let label = text; let parts = [];
      if (/^(download|export)\b/i.test(text) && !(extOf(text) && FILE_EXT.test(extOf(text)))) { const info = rowInfo(el, text); if (info) { label = info.label; parts = info.parts; if (info.nameHint && !extOf(nameHint)) nameHint = info.nameHint; } }
      out.links.push({ text, label, rowParts: parts, href: el.href, rawHref: clip(raw, 300), scheme: u.protocol, download, ext, nameHint: clip(nameHint, 160), fileLike, why, sameOrigin: u.origin === location.origin, path: cssPath(el), group });
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
      if (toggleRe.test(text) && !/^(download|export|delete|remove|archive|cancel)\b/i.test(text) && !el.disabled && visible(el)) {   /* a plain "Show all files" button */
        addToggle({ label: text, checked: false, kind: 'button', path: cssPath(el), key: keyOf(el) });
        continue;
      }
      if (out.buttons.length >= L.buttonsMax || !visible(el)) continue;
      const dataUrl = el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-download-url') || el.getAttribute('data-file') || null;
      const ext = extOf(text);
      const fileLike = Boolean((ext && FILE_EXT.test(ext)) || /^(download|export)\b/i.test(text) || (dataUrl && FILE_EXT.test(extOf(dataUrl.split('?')[0]) || '')));
      if (!fileLike) continue;
      /* inForm: pressing it would SUBMIT a form (a button or input of a form that is not type=button or reset, or one with a formaction) */
      const btype = String(el.getAttribute('type') || '').toLowerCase();
      const submitsForm = el.hasAttribute('formaction') || (Boolean(el.form) && (tag === 'BUTTON' ? btype !== 'button' && btype !== 'reset' : tag === 'INPUT' && /^(submit|image)$/.test(btype)));
      let label = text; let nameHint = text; let parts = [];
      if (!ext) {   /* "Download" says nothing: the text of its row says which file */
        const info = rowInfo(el, text);
        if (info) { label = info.label; parts = info.parts; if (info.nameHint) nameHint = info.nameHint; }
      }
      out.buttons.push({ text, label, rowParts: parts, nameHint: clip(nameHint, 160), fileLike, ext, dataUrl: dataUrl ? clip(dataUrl, 500) : null, disabled: Boolean(el.disabled), inForm: submitsForm, path: cssPath(el), group });
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
     expand    open every closed <details>, click expanders (aria-expanded=false, no popup menu, no navigation link, not destructive)
     controls  list tabs and "Load more" / "Show more" buttons: { tabs: [{ label, path, selected }], more: [{ label, path }] }
     scroll    scroll the windows and every scrollable box by 90 percent of its height; { moved }; opts.reset puts them back at the top
     activate  { path, option?, label?, row?, name?, never } click one element, or choose option number `option` of a <select>; refused
               when the element is gone, when its text is no longer `label` (when a label is given), when the text of its table row or
               list item is no longer `row` (when a row is given; `name`, a file name inside that text, is enough), or when its text is a
               destructive verb (`never`; an empty pattern lets a plain file link through)
   A path is one CSS path per document, joined with " >>> " (see extractPage). */
function pageOps(opts) {
  const HIDDEN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'g');
  const norm = (s) => String(s == null ? '' : s).replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const never = new RegExp(opts.never || '(?!)', 'i');
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
  const every = (selector) => roots().flatMap((r) => Array.from(r.querySelectorAll(selector)));
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
  /* a link that goes somewhere is not a button: pressing it would leave the page */
  const pressable = (el) => el.tagName !== 'A' || !el.hasAttribute('href') || /^\s*(#.*)?$|^\s*javascript:\s*(void\s*\(\s*0?\s*\)|undefined|;)?\s*;?\s*$/i.test(el.getAttribute('href') || '');
  if (opts.op === 'expand') {
    let opened = 0; let expanded = 0;
    for (const d of every('details:not([open])')) { if (opened >= 50) break; d.open = true; opened += 1; }
    for (const el of every('[aria-expanded="false"]')) {
      if (expanded >= 30) break;
      const popup = el.getAttribute('aria-haspopup');
      const role = (el.getAttribute('role') || '').toLowerCase();
      if ((popup && popup !== 'false') || el.disabled || /^(combobox|menuitem|menu|option|listbox)$/.test(role) || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || !pressable(el) || never.test(textOf(el)) || !visible(el)) continue;
      el.click(); expanded += 1;
    }
    return { opened, expanded };
  }
  if (opts.op === 'controls') {
    const tabs = []; const more = [];
    for (const el of every('[role=tab]')) { if (tabs.length >= 12) break; if (!el.disabled && visible(el)) tabs.push({ label: textOf(el), path: cssPath(el), selected: el.getAttribute('aria-selected') === 'true' }); }
    for (const el of every('button,a,[role=button]')) { if (more.length >= 3) break; if (!el.disabled && pressable(el) && /^(load|show|view|see)\s+(\d+\s+)?more\b/i.test(textOf(el)) && visible(el)) more.push({ label: textOf(el), path: cssPath(el) }); }
    return { tabs, more };
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
    if (opts.reset) { for (const b of boxes) b.el.scrollTop = 0; return { moved: false }; }
    let moved = false;
    for (const b of boxes) { const before = b.el.scrollTop; b.el.scrollTop = before + b.step; if (b.el.scrollTop !== before) moved = true; }
    return { moved };
  }
  if (opts.op === 'activate') {
    const el = resolve(opts.path);
    if (!el) return { ok: false, why: 'the element is gone from the page' };
    const text = textOf(el);
    if (never.test(text)) return { ok: false, why: 'the element is a destructive action' };
    if (typeof opts.label === 'string' && opts.label !== '' && text !== opts.label) return { ok: false, why: 'the element is no longer the one that was listed' };
    if (typeof opts.row === 'string' && opts.row !== '' && opts.row !== text) {   /* a "Download" button: which row is it in? */
      const rowEl = rowOf(el, text);
      const full = rowEl ? norm(norm(rowEl.innerText || rowEl.textContent).replace(text, ' ')) : '';
      const rowText = clip(full, 160);
      const parts = Array.isArray(opts.parts) ? opts.parts.filter((x) => typeof x === 'string' && x !== '') : [];
      const same = rowText === opts.row || (typeof opts.name === 'string' && opts.name !== '' && full.includes(opts.name)) || (parts.length > 0 && parts.every((x) => full.includes(x)));   /* the stable parts survive a "5 min ago" that changed */
      if (!rowEl || !same) return { ok: false, why: 'the row of the element is no longer the one that was listed' };
    }
    if (typeof opts.option === 'number' && el.tagName === 'SELECT') {
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
  return tab.evalFn(extractPage, { limits: { ...LIMITS, ...limits }, toggleRe: TOGGLE_LABEL_RE.source }, { timeout: 12000 });
}
const pageOp = (tab, op, extra = {}) => tab.evalFn(pageOps, { op, never: NEVER_TEXT_RE.source, ...extra }, { timeout: 8000, userGesture: op === 'activate' });

const ALL_BUTTON_RE = /^(download|export)\s+(all|everything|zip|archive|bundle)\b/i;
const FILE_NAME_END = /\.([A-Za-z0-9]{1,8})$/;
const FILE_EXTENSIONS = /^(pdf|docx?|xlsx?|xlsm|xlsb|csv|tsv|txt|md|json|zip|7z|tar|gz|tgz|rar|rtf|pptx?|odt|ods|odp|png|jpe?g|gif|svg|eml|msg|xml|parquet)$/i;
/* The file-name phrase at the start of a text: everything up to the end of the first extension ("Entity 01 Budget.txt 1 KB" gives
   "Entity 01 Budget.txt"); the whole text when there is no extension. */
const NAME_PHRASE_RE = new RegExp(`^(.*?\\.(?:${FILE_EXTENSIONS.source.slice(2, -2)})(?:\\.(?:${FILE_EXTENSIONS.source.slice(2, -2)}))*)(?![A-Za-z0-9])`, 'i');
const namePhrase = (text) => { const m = NAME_PHRASE_RE.exec(String(text || '')); return m ? m[1] : String(text || ''); };
const endsInFileExtension = (text) => { const m = FILE_NAME_END.exec(String(text || '')); return Boolean(m && FILE_EXTENSIONS.test(m[1])); };

/* The address of a file link without what changes each time it is issued (a signature, an expiry): two copies of the same file that were
   signed twice have the same key. When something was removed the label is part of the key, so two files that differ only in a token
   ("/download?token=a" and "/download?token=b") stay two files as long as their names differ. */
function navigateKey(href, label = '') {
  let u = null;
  try { u = new URL(href); } catch (e) { return `n|${href}`; }
  const kept = []; let removed = false;
  for (const [k, v] of u.searchParams) { if (SIGNATURE_PARAM_RE.test(k)) removed = true; else kept.push(`${k}=${v}`); }
  kept.sort();
  return `n|${u.origin}${u.pathname}${kept.length ? `?${kept.join('&')}` : ''}${removed ? `|${label}` : ''}`;
}

/* The ordered list of things worth downloading, from links and buttons, and the ones that were left out although they look like files.
   Pure; the page URL only resolves data-url values. Every candidate carries the heading above it (group), a label (the link's text; for
   a plain "Download" button the text of its row), its kind (link or button) and the view of the page it was seen in (snap.view, see
   discover.cjs). mode 'navigate' opens the address in a tab of its own; mode 'click' clicks the element in the task page (a button, or
   a blob: or data: link, which only exist inside the page). A "Download all" button is dropped when individual files are listed (the
   files themselves are the list). dropped: [{ label, group, reason }] for a file-looking control the loader will not press: a name that
   starts with a destructive verb (unless it is plainly a file), a button that would submit a form, a disabled button. A control with no
   file name at all ("Delete file" next to an address that is not a document) is an action, not a file, and is not reported. */
function classify(snap) {
  const seen = new Set();
  const candidates = [];
  const dropped = [];
  const view = snap.view || null;
  const drop = (label, group, reason) => dropped.push({ label: String(label || ''), group: String(group || ''), reason });
  for (const l of snap.links || []) {
    if (!l.fileLike) continue;
    /* real: the ADDRESS says it is a file (an extension in its path) or the link has a download attribute. The link's own words do not count:
       "Remove Q4.pdf" next to /api/files/13/remove is still an action. */
    const real = (l.why || []).some((w) => w === 'extension' || w === 'download-attribute');
    const blocked = real ? NEVER_ACTION_PARAM_RE.test(l.rawHref) : (NEVER_TEXT_RE.test(l.text) || NEVER_HREF_RE.test(l.rawHref));
    if (blocked) {
      if (real || endsInFileExtension(l.text) || FILE_EXTENSIONS.test(l.ext || '')) drop(l.text, l.group, 'looks like an action');
      continue;
    }
    const download = l.download !== null && l.download !== undefined;
    if (/^(blob|data):$/.test(l.scheme)) {
      const k = `click|${l.path}|${l.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      candidates.push({ mode: 'click', kind: 'link', download, text: l.text, href: null, nameHint: l.nameHint || l.text, ext: l.ext, group: l.group || '', label: l.label || l.text || '', rowParts: l.rowParts || [], path: l.path, view });
      continue;
    }
    if (!/^https?:$/.test(l.scheme)) continue;
    /* the same address listed twice on one page is one file; two addresses that differ in a token are two (CandidateSet pairs them across looks) */
    const k = `n|${l.href}`;
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push({ mode: 'navigate', kind: 'link', download, text: l.text, href: l.href, nameHint: l.nameHint || l.text, ext: l.ext, group: l.group || '', label: l.label || l.text || '', rowParts: l.rowParts || [], path: l.path, view });
  }
  const buttons = [];
  for (const b of snap.buttons || []) {
    if (!b.fileLike) continue;
    const all = ALL_BUTTON_RE.test(b.text);
    if (b.disabled) { if (!all) drop(b.label || b.text, b.group, 'the button is disabled'); continue; }
    if (NEVER_TEXT_RE.test(b.text)) { if (endsInFileExtension(b.text) || FILE_EXTENSIONS.test(b.ext || '')) drop(b.label || b.text, b.group, 'looks like an action'); continue; }
    if (b.inForm) { if (!all) drop(b.label || b.text, b.group, 'would submit a form'); continue; }
    let href = null;
    if (b.dataUrl) { try { href = new URL(b.dataUrl, snap.url).href; } catch (e) { href = null; } }
    if (href && seen.has(`n|${href}`)) continue;
    if (href) seen.add(`n|${href}`);
    /* A button is clicked in the page (it may build a blob: URL), because its data-url, if any, is only a hint. */
    buttons.push({ mode: 'click', kind: 'button', download: false, text: b.text, href, nameHint: b.nameHint || b.text, ext: b.ext, group: b.group || '', label: b.label || b.text, rowParts: b.rowParts || [], path: b.path, view });
  }
  const single = buttons.filter((b) => !ALL_BUTTON_RE.test(b.text));
  return { candidates: candidates.concat(candidates.length + single.length ? single : buttons), dropped };
}
const fileCandidates = (snap) => classify(snap).candidates;
const droppedCandidates = (snap) => classify(snap).dropped;

/* toggles: [{ label, checked, disabled, path, key }] as extractPage lists them. learned: what was taught for this host: a label (text),
   or { label, key }. Returns the control to switch ON (an UNCHECKED, enabled one) or null: first the learned key (an id or data-testid),
   then the learned label, then the first label that matches TOGGLE_LABEL_RE. */
function findAllFilesToggle(toggles, learned) {
  const usable = (Array.isArray(toggles) ? toggles : []).filter((t) => t && typeof t.label === 'string' && !t.checked && !t.disabled);
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
  const on = (Array.isArray(toggles) ? toggles : []).filter((t) => t && typeof t.label === 'string' && t.checked && !t.disabled);
  const hit = (taught.key && on.find((t) => t.key === taught.key))
    || (typeof taught.label === 'string' && taught.label.trim() && on.find((t) => t.label.trim().toLowerCase() === taught.label.trim().toLowerCase()))
    || on.find((t) => TOGGLE_LABEL_RE.test(t.label));
  return hit ? { toggle: hit, on: true } : null;
}

module.exports = { extractPage, pageOps, pageOp, takePage, fileCandidates, droppedCandidates, classify, navigateKey, namePhrase, findAllFilesToggle, findAllFilesState, TOGGLE_LABEL_RE, LIMITS, NEVER_TEXT_RE, NEVER_HREF_RE, NEVER_ACTION_PARAM_RE };
