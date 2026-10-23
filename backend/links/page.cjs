'use strict';
/* Reading a task page: ONE evaluation in the isolated world that turns the DOM into plain data, then pure functions on that data.
   Deterministic, no model, nothing is clicked or submitted here.

   extractPage walks the document in order, open shadow roots included, and returns
     sections   the page text cut at every heading: [{ heading, text }] (text capped per section, section count capped)
     links, buttons   the ones that look like FILES (with the heading above them, as their group), only those a person can see
     toggles    every switch, checkbox and pressed-button, with its accessible label and state (the "show all files" candidates)
     signals    what the sign-in classifier needs (a password field, a one-time-code field, a CAPTCHA, how much text there is)
   It never reads password, hidden and file inputs, nor any control whose name looks like a secret or a code, and never cookies or storage.
   The values hold full URLs and a signed link carries its signature in the query string: the result stays in memory and is never
   logged. Exports: extractPage, takePage, fileCandidates, findAllFilesToggle, TOGGLE_LABEL_RE, LIMITS, NEVER_TEXT_RE, NEVER_HREF_RE. */

const LIMITS = {
  maxMs: 2500, maxElements: 40000, maxRoots: 40, sections: 200, sectionChars: 20000, valueChars: 400,
  linksMax: 2000, buttonsMax: 300, togglesMax: 40, headingsMax: 80,
};

/* Page side. Must be self-contained: it is serialised with toString() and run in the page's isolated world. */
function extractPage(opts) {
  const T0 = performance.now();
  const L = opts.limits;
  const trunc = {};
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const over = () => performance.now() - T0 > L.maxMs;
  const visible = (el) => { try { return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true; } catch (e) { return true; } };

  /* every element of the document and of its open shadow roots, in document order */
  const all = [];
  let roots = 1;
  const collect = (root) => {
    const found = root.querySelectorAll('*');
    for (let j = 0; j < found.length; j += 1) {
      if (all.length >= L.maxElements) { trunc.elements = true; return; }
      all.push(found[j]);
      if (found[j].shadowRoot && roots < L.maxRoots) { roots += 1; collect(found[j].shadowRoot); }
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
  /* the accessible name: aria-labelledby, aria-label, a <label>, the element's own text, a title */
  const labelOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const root = el.getRootNode(); const t = norm(lb.split(/\s+/).map((id) => { const n = root.getElementById ? root.getElementById(id) : null; return n ? n.textContent : ''; }).join(' ')); if (t) return t; }
    if (norm(el.getAttribute('aria-label'))) return norm(el.getAttribute('aria-label'));
    if (el.labels && el.labels.length) { const c = el.labels[0].cloneNode(true); c.querySelectorAll('input,select,textarea,button').forEach((n) => n.remove()); const t = norm(c.textContent); if (t) return t; }
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') { const t = norm(el.textContent); if (t) return t; }
    return norm(el.title);
  };

  const out = { url: location.href, title: document.title, readyState: document.readyState };
  const signals = { hasPasswordField: false, hasOtpField: false, hasCaptcha: false };
  const SECRETISH = /pass|pwd|secret|token|csrf|xsrf|otp|one-time|ssn|card|cvv|auth|session/i;
  const SKIP_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio']);
  const FILE_EXT = /^(pdf|docx?|xlsx?|xlsm|xlsb|csv|tsv|txt|md|json|zip|7z|tar|gz|tgz|rar|rtf|pptx?|odt|ods|odp|png|jpe?g|gif|svg|eml|msg|xml|parquet)$/i;
  const WEB_EXT = /^(html?|xhtml|shtml|php\d?|aspx?|jsp|cfm|cgi|pl|do|action|js|mjs|css|map|com|org|net|io)$/i;
  const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || ''); return m ? m[1].toLowerCase() : null; };
  const dispositionName = (u) => { const d = u.searchParams.get('response-content-disposition') || u.searchParams.get('filename') || ''; const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(d); if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } } return d && !/=/.test(d) ? d : ''; };

  out.headings = []; out.links = []; out.buttons = []; out.toggles = [];
  let controlCount = 0; let linkCount = 0; let group = '';
  for (const el of all) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      group = clip(norm(el.textContent), 120);
      if (out.headings.length < L.headingsMax && group) out.headings.push({ level: Number(tag[1]), text: clip(group, 160) });
      continue;
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if ((tag === 'INPUT' && el.type === 'checkbox') || role === 'switch' || role === 'checkbox') {
      if (out.toggles.length < L.togglesMax) out.toggles.push({ label: clip(labelOf(el), 120), checked: tag === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true', kind: role || 'checkbox', disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), path: cssPath(el), group });
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
      if (u && /(^|\/)(download|downloads|attachments?|files?|blob|export|assets)(\/|$)/i.test(u.pathname)) why.push('path');
      if (u && /(^|[?&])(x-amz-signature|signature|x-goog-signature|sig|se|sp)=/i.test(u.search)) why.push('signed-url');
      const fileLike = why.length > 0 && Boolean(u) && /^(https?|blob|data):$/.test(u.protocol);
      if (!fileLike || !visible(el)) continue;
      const text = clip(norm(el.textContent) || norm(el.getAttribute('aria-label')) || norm(el.title) || (el.querySelector('img') ? norm(el.querySelector('img').alt) : ''), 160);
      out.links.push({ text, href: el.href, rawHref: clip(raw, 300), scheme: u.protocol, download, ext, nameHint: clip(nameHint, 160), fileLike, why, sameOrigin: u.origin === location.origin, path: cssPath(el), group });
      continue;
    }
    if (tag === 'BUTTON' || el.getAttribute('role') === 'button' || (tag === 'INPUT' && /^(button|submit)$/.test(el.type))) {
      const pressed = el.getAttribute('aria-pressed');
      if (pressed === 'true' || pressed === 'false') {   /* a toggle button */
        if (out.toggles.length < L.togglesMax) out.toggles.push({ label: clip(labelOf(el), 120), checked: pressed === 'true', kind: 'pressed', disabled: Boolean(el.disabled), path: cssPath(el), group });
        continue;
      }
      if (out.buttons.length >= L.buttonsMax || !visible(el)) continue;
      const text = clip(norm(tag === 'INPUT' ? el.value : el.textContent) || norm(el.getAttribute('aria-label')), 160);
      if (!text) continue;
      const dataUrl = el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-download-url') || el.getAttribute('data-file') || el.getAttribute('formaction') || null;
      const ext = extOf(text);
      const fileLike = Boolean((ext && FILE_EXT.test(ext)) || /^(download|export)\b/i.test(text) || (dataUrl && FILE_EXT.test(extOf(dataUrl.split('?')[0]) || '')));
      if (fileLike) out.buttons.push({ text, fileLike, ext, dataUrl: dataUrl ? clip(dataUrl, 500) : null, disabled: Boolean(el.disabled), inForm: Boolean(el.form), path: cssPath(el), group });
      continue;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
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
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'CANVAS', 'IFRAME', 'OPTION']);
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TR', 'UL']);
  const addControl = (el) => {
    const type = (el.type || el.tagName).toLowerCase();
    if (SKIP_TYPES.has(type) || SECRETISH.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.autocomplete || ''))) return;
    const value = el.tagName === 'SELECT' ? Array.from(el.selectedOptions).map((o) => norm(o.textContent)).join(', ') : el.value;
    if (value) add('\n' + (labelOf(el) || el.name || 'field') + ': ' + clip(value, el.tagName === 'TEXTAREA' ? L.sectionChars : L.valueChars) + '\n');
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (over()) { trunc.time = true; return; }
      if (child.nodeType === 3) { add(child.nodeValue); continue; }
      if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName) || !visible(child)) continue;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) { begin(clip(norm(child.textContent), 160)); continue; }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { addControl(child); continue; }
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

async function takePage(tab, limits = {}) {
  return tab.evalFn(extractPage, { limits: { ...LIMITS, ...limits } }, { timeout: 12000 });
}

/* Things we will never fetch even if they look like files: they change state on the platform or end the person's session. The text rule
   is anchored at the start ("Delete file", "Sign out") so a file called Archive_2026.zip or Approved_Budget.xlsx still qualifies; the
   address rule looks for the verb as a whole path segment or as an action parameter. */
const NEVER_TEXT_RE = /^(delete|remove|log ?out|sign ?out|cancel|revoke|reset|unsubscribe|submit|approve|reject|publish|archive)\b/i;
const NEVER_HREF_RE = /(^|\/)(delete|remove|logout|log-out|signout|sign-out|revoke|unsubscribe|reset|approve|reject|publish)(\/|$|\?|#)|[?&](action|op|do|cmd)=(delete|remove|logout|revoke|approve|reject|publish)/i;

/* The ordered list of things worth downloading, from links and buttons. Pure; the page URL only resolves data-url values.
   Every candidate carries the heading above it (group) and its visible text (label). */
function fileCandidates(snap) {
  const seen = new Set();
  const out = [];
  for (const l of snap.links || []) {
    if (!l.fileLike || !/^https?:$/.test(l.scheme)) continue;
    if (NEVER_TEXT_RE.test(l.text) || NEVER_HREF_RE.test(l.rawHref)) continue;
    if (seen.has(l.href)) continue;
    seen.add(l.href);
    out.push({ mode: 'navigate', text: l.text, href: l.href, nameHint: l.nameHint || l.text, ext: l.ext, group: l.group || '', label: l.text || '', path: l.path });
  }
  for (const b of snap.buttons || []) {
    if (!b.fileLike || b.disabled || b.inForm || NEVER_TEXT_RE.test(b.text)) continue;
    let href = null;
    if (b.dataUrl) { try { href = new URL(b.dataUrl, snap.url).href; } catch (e) { href = null; } }
    if (href && seen.has(href)) continue;
    if (href) seen.add(href);
    /* A button is clicked in the page (it may build a blob: URL), because its data-url, if any, is only a hint. */
    out.push({ mode: 'click', text: b.text, href, nameHint: b.text, ext: b.ext, group: b.group || '', label: b.text, path: b.path });
  }
  return out;
}

/* The accessible label of the "show all files" switch: a word pair that says all or world files, "show all", "include all|world", or
   "all attachments|downloads". Bounded and anchored on whole words. */
const TOGGLE_LABEL_RE = /\b(all|world)\s+files\b|\bshow all\b|\binclude (all|world)\b|\ball (attachments|downloads)\b/i;

/* toggles: [{ label, checked, disabled, path }] as extractPage lists them. learned: the label the person taught us for this host, or
   null. Returns the toggle to switch ON (an UNCHECKED, enabled one: the learned label first, then the first label that matches
   TOGGLE_LABEL_RE) or null. */
function findAllFilesToggle(toggles, learned) {
  const usable = (Array.isArray(toggles) ? toggles : []).filter((t) => t && typeof t.label === 'string' && !t.checked && !t.disabled);
  if (typeof learned === 'string' && learned.trim()) {
    const key = learned.trim().toLowerCase();
    const hit = usable.find((t) => t.label.trim().toLowerCase() === key);
    if (hit) return hit;
  }
  return usable.find((t) => TOGGLE_LABEL_RE.test(t.label)) || null;
}

module.exports = { extractPage, takePage, fileCandidates, findAllFilesToggle, TOGGLE_LABEL_RE, LIMITS, NEVER_TEXT_RE, NEVER_HREF_RE };
