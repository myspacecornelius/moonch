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

   Exports: extractPage, pageOps, takePage, fileCandidates, findAllFilesToggle, findAllFilesState, TOGGLE_LABEL_RE, LIMITS, NEVER_TEXT_RE, NEVER_HREF_RE. */

const LIMITS = {
  maxMs: 2500, maxElements: 40000, maxRoots: 40, sections: 200, sectionChars: 20000, valueChars: 400,
  linksMax: 2000, buttonsMax: 300, togglesMax: 60, headingsMax: 80, selectOptions: 20,
};

/* Things we will never fetch or click even if they look like files: they change state on the platform or end the person's session. The
   text rule is anchored at the start ("Delete file", "Sign out") so a file called Archive_2026.zip or Approved_Budget.xlsx still
   qualifies; the address rule looks for the verb as a whole path segment or as an action parameter. */
const NEVER_TEXT_RE = /^(delete|remove|log ?out|sign ?out|cancel|revoke|reset|unsubscribe|submit|approve|reject|publish|archive)\b/i;
const NEVER_HREF_RE = /(^|\/)(delete|remove|logout|log-out|signout|sign-out|revoke|unsubscribe|reset|approve|reject|publish)(\/|$|\?|#)|[?&](action|op|do|cmd)=(delete|remove|logout|revoke|approve|reject|publish)/i;

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

  const cssPath = (el) => {
    if (el.getRootNode() !== document) return null;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 7; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift(t + '#' + CSS.escape(n.id)); break; }
      let idx = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) idx += 1;
      parts.unshift(t + ':nth-of-type(' + idx + ')');
    }
    return parts.join(' > ');
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
    if (tag === 'A') {
      if (!el.hasAttribute('href')) continue;
      linkCount += 1;
      if (out.links.length >= L.linksMax) { trunc.links = true; continue; }
      const raw = el.getAttribute('href');
      let u = null; try { u = new URL(el.href); } catch (e) { /* javascript: and friends */ }
      const download = el.hasAttribute('download') ? el.getAttribute('download') : null;
      let lastSeg = ''; try { lastSeg = u ? decodeURIComponent(u.pathname.split('/').pop() || '') : ''; } catch (e) { lastSeg = ''; }
      const nameHint = download || dispositionName(u || { searchParams: new URLSearchParams() }) || lastSeg;
      const ext = extOf(nameHint) || extOf(lastSeg);
      const why = [];
      if (download !== null) why.push('download-attribute');
      if (ext && FILE_EXT.test(ext)) why.push('extension');
      else if (ext && /[a-z]/i.test(ext) && /^[a-z0-9]{2,5}$/i.test(ext) && !WEB_EXT.test(ext)) why.push('extension-guess');   /* an unknown extension that is not a web page: probably a file (.bin, .dat) */
      if (u && /(^|\/)(download|downloads|attachments?|files?|blob|export|assets)\/[^/]/i.test(u.pathname)) why.push('path');   /* /files/12 yes; /files and /assets, the pages themselves, no */
      if (u && /(^|[?&])(x-amz-signature|signature|x-goog-signature|sig|se|sp)=/i.test(u.search)) why.push('signed-url');
      const fileLike = why.length > 0 && Boolean(u) && /^(https?|blob|data):$/.test(u.protocol);
      if (!fileLike || !visible(el)) continue;
      const text = clip(norm(el.textContent) || norm(el.getAttribute('aria-label')) || norm(el.title) || (el.querySelector('img') ? norm(el.querySelector('img').alt) : ''), 160);
      out.links.push({ text, href: el.href, rawHref: clip(raw, 300), scheme: u.protocol, download, ext, nameHint: clip(nameHint, 160), fileLike, why, sameOrigin: u.origin === location.origin, path: cssPath(el), group });
      continue;
    }
    if (tag === 'BUTTON' || role === 'button' || (tag === 'INPUT' && /^(button|submit)$/.test(el.type))) {
      const pressed = el.getAttribute('aria-pressed');
      if (pressed === 'true' || pressed === 'false') {   /* a toggle button */
        addToggle({ label: clip(labelOf(el, true), 120), checked: pressed === 'true', kind: 'pressed', disabled: Boolean(el.disabled), path: cssPath(el), key: keyOf(el) });
        continue;
      }
      const text = clip(norm(tag === 'INPUT' ? el.value : el.textContent) || norm(el.getAttribute('aria-label')), 160);
      if (!text) continue;
      if (toggleRe.test(text) && !/^(download|export|delete|remove|archive|cancel)\b/i.test(text) && !el.disabled && visible(el)) {   /* a plain "Show all files" button */
        addToggle({ label: text, checked: false, kind: 'button', path: cssPath(el), key: keyOf(el) });
        continue;
      }
      if (out.buttons.length >= L.buttonsMax || !visible(el)) continue;
      const dataUrl = el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-download-url') || el.getAttribute('data-file') || el.getAttribute('formaction') || null;
      const ext = extOf(text);
      const fileLike = Boolean((ext && FILE_EXT.test(ext)) || /^(download|export)\b/i.test(text) || (dataUrl && FILE_EXT.test(extOf(dataUrl.split('?')[0]) || '')));
      if (!fileLike) continue;
      let label = text; let nameHint = text;
      if (!ext) {   /* "Download" says nothing: the text of its table row or list item says which file */
        const row = el.closest ? el.closest('tr,li,[role=row]') : null;
        const rowText = row ? norm(norm(row.innerText || row.textContent).replace(text, ' ')) : '';   /* innerText puts a space between table cells */
        if (rowText) { label = clip(rowText, 160); const m = /[^\s"'<>:|?*\\/]+\.([A-Za-z0-9]{1,8})\b/.exec(rowText); if (m && FILE_EXT.test(m[1])) nameHint = m[0]; }
      }
      out.buttons.push({ text, label, nameHint: clip(nameHint, 160), fileLike, ext, dataUrl: dataUrl ? clip(dataUrl, 500) : null, disabled: Boolean(el.disabled), inForm: Boolean(el.form), path: cssPath(el), group });
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

/* Page side, constant, self-contained. opts.op:
     expand    open every closed <details>, click expanders (aria-expanded=false with aria-controls, no popup menu, not destructive)
     controls  list tabs and "Load more" / "Show more" buttons: { tabs: [{ label, path, selected }], more: [{ label, path }] }
     scroll    scroll the window and every scrollable box by 90 percent of its height; { moved }; opts.reset puts them back at the top
     activate  { path, option?, label?, never } click one element, or choose option number `option` of a <select>; refused when the
               element is gone, when its text is no longer `label` (when a label is given), or when its text is a destructive verb */
function pageOps(opts) {
  const HIDDEN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'g');
  const norm = (s) => String(s == null ? '' : s).replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const never = new RegExp(opts.never || '(?!)', 'i');
  const visible = (el) => { try { return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true; } catch (e) { return true; } };
  const cssPath = (el) => {
    if (el.getRootNode() !== document) return null;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 7; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift(t + '#' + CSS.escape(n.id)); break; }
      let idx = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) idx += 1;
      parts.unshift(t + ':nth-of-type(' + idx + ')');
    }
    return parts.join(' > ');
  };
  const textOf = (el) => clip(norm(el.tagName === 'INPUT' ? el.value : el.textContent) || norm(el.getAttribute('aria-label')) || norm(el.title) || (el.querySelector && el.querySelector('img') ? norm(el.querySelector('img').alt) : ''), 160);
  if (opts.op === 'expand') {
    let opened = 0; let expanded = 0;
    for (const d of document.querySelectorAll('details:not([open])')) { if (opened >= 50) break; d.open = true; opened += 1; }
    for (const el of document.querySelectorAll('[aria-expanded="false"][aria-controls]')) {
      if (expanded >= 30) break;
      const popup = el.getAttribute('aria-haspopup');
      if ((popup && popup !== 'false') || el.disabled || never.test(textOf(el)) || !visible(el)) continue;
      el.click(); expanded += 1;
    }
    return { opened, expanded };
  }
  if (opts.op === 'controls') {
    const tabs = []; const more = [];
    for (const el of document.querySelectorAll('[role=tab]')) { if (tabs.length >= 8) break; if (!el.disabled && visible(el)) tabs.push({ label: textOf(el), path: cssPath(el), selected: el.getAttribute('aria-selected') === 'true' }); }
    for (const el of document.querySelectorAll('button,a,[role=button]')) { if (more.length >= 3) break; if (!el.disabled && /^(load|show) more$/i.test(textOf(el)) && visible(el)) more.push({ label: textOf(el), path: cssPath(el) }); }
    return { tabs, more };
  }
  if (opts.op === 'scroll') {
    const boxes = [];
    const base = document.scrollingElement || document.documentElement;
    boxes.push(base);
    let seen = 0;
    for (const el of document.querySelectorAll('*')) {
      if (seen >= 5000 || boxes.length >= 20) break;
      seen += 1;
      if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 40) { const oy = getComputedStyle(el).overflowY; if (oy === 'auto' || oy === 'scroll') boxes.push(el); }
    }
    if (opts.reset) { for (const el of boxes) el.scrollTop = 0; return { moved: false }; }
    let moved = false;
    for (const el of boxes) { const before = el.scrollTop; el.scrollTop = before + Math.max(40, Math.floor((el === base ? window.innerHeight : el.clientHeight) * 0.9)); if (el.scrollTop !== before) moved = true; }
    return { moved };
  }
  if (opts.op === 'activate') {
    const el = opts.path ? document.querySelector(opts.path) : null;
    if (!el) return { ok: false, why: 'the element is gone from the page' };
    const text = textOf(el);
    if (never.test(text)) return { ok: false, why: 'the element is a destructive action' };
    if (typeof opts.label === 'string' && opts.label !== '' && text !== opts.label) return { ok: false, why: 'the element is no longer the one that was listed' };
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
const pageOp = (tab, op, extra = {}) => tab.evalFn(pageOps, { op, never: NEVER_TEXT_RE.source, ...extra }, { timeout: 8000 });

const ALL_BUTTON_RE = /^(download|export)\s+(all|everything|zip|archive|bundle)\b/i;

/* The ordered list of things worth downloading, from links and buttons. Pure; the page URL only resolves data-url values.
   Every candidate carries the heading above it (group) and a label (the link's text; for a plain "Download" button the text of its row).
   mode 'navigate' opens the address in a tab of its own; mode 'click' clicks the element in the task page (a button, or a blob: or data:
   link, which only exist inside the page). A "Download all" button is dropped when individual files are listed. */
function fileCandidates(snap) {
  const seen = new Set();
  const out = [];
  for (const l of snap.links || []) {
    if (!l.fileLike || NEVER_TEXT_RE.test(l.text) || NEVER_HREF_RE.test(l.rawHref)) continue;
    if (/^(blob|data):$/.test(l.scheme)) {
      if (seen.has(`click|${l.path}|${l.text}`)) continue;
      seen.add(`click|${l.path}|${l.text}`);
      out.push({ mode: 'click', text: l.text, href: null, nameHint: l.nameHint || l.text, ext: l.ext, group: l.group || '', label: l.text || '', path: l.path });
      continue;
    }
    if (!/^https?:$/.test(l.scheme) || seen.has(l.href)) continue;
    seen.add(l.href);
    out.push({ mode: 'navigate', text: l.text, href: l.href, nameHint: l.nameHint || l.text, ext: l.ext, group: l.group || '', label: l.text || '', path: l.path });
  }
  const buttons = [];
  for (const b of snap.buttons || []) {
    if (!b.fileLike || b.disabled || b.inForm || NEVER_TEXT_RE.test(b.text)) continue;
    let href = null;
    if (b.dataUrl) { try { href = new URL(b.dataUrl, snap.url).href; } catch (e) { href = null; } }
    if (href && seen.has(href)) continue;
    if (href) seen.add(href);
    /* A button is clicked in the page (it may build a blob: URL), because its data-url, if any, is only a hint. */
    buttons.push({ mode: 'click', text: b.text, href, nameHint: b.nameHint || b.text, ext: b.ext, group: b.group || '', label: b.label || b.text, path: b.path });
  }
  const single = buttons.filter((b) => !ALL_BUTTON_RE.test(b.text));
  return out.concat(out.length + single.length ? single : buttons);
}

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

module.exports = { extractPage, pageOps, pageOp, takePage, fileCandidates, findAllFilesToggle, findAllFilesState, TOGGLE_LABEL_RE, LIMITS, NEVER_TEXT_RE, NEVER_HREF_RE };
