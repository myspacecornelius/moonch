// Popup logic + the page-injected fill function.
// Data model: the JSON produced by `python3 jobsearch/tools/jobsearch.py export`.

let DATA = null;

const $ = (id) => document.getElementById(id);

async function loadState() {
  const st = await chrome.storage.local.get(["data", "activeJobId"]);
  DATA = st.data || null;
  renderStatus();
  renderJobs(st.activeJobId);
  renderChips();
}

function renderStatus() {
  if (!DATA) {
    $("status").textContent = "No data loaded — import autofill.json below.";
    return;
  }
  $("status").innerHTML = `Loaded: <b>${esc(DATA.basics.name)}</b> · generated ${esc(DATA.generated)} · ${DATA.jobs.length} application(s)`;
}

function esc(s) {
  const d = document.createElement("span");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function renderJobs(activeId) {
  const sel = $("job");
  sel.innerHTML = "";
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "— generic (no cover letter) —";
  sel.appendChild(optNone);
  (DATA?.jobs || []).forEach((j) => {
    const o = document.createElement("option");
    o.value = String(j.id);
    o.textContent = `#${j.id} ${j.company} — ${j.role}`;
    if (String(activeId) === String(j.id)) o.selected = true;
    sel.appendChild(o);
  });
  const hasData = !!DATA;
  $("fill").disabled = !hasData;
  syncCopyButtons();
}

function activeJob() {
  const id = $("job").value;
  if (!id || !DATA) return null;
  return DATA.jobs.find((j) => String(j.id) === id) || null;
}

function syncCopyButtons() {
  const j = activeJob();
  $("copy-cover").disabled = !(j && j.cover);
  $("copy-resume").disabled = !(j && j.resume_txt);
}

function renderChips() {
  const box = $("chips");
  box.innerHTML = "";
  if (!DATA) return;
  const L = DATA.logistics || {};
  const entries = [
    ["Email", DATA.basics.email],
    ["Phone", DATA.basics.phone],
    ["Location", DATA.basics.location],
    ...Object.entries(DATA.links || {}).map(([k, v]) => [k, v]),
    ["Salary", L.salary_expectation],
    ["Work auth", L.work_authorization],
    ["Start date", L.earliest_start],
    ["Notice", L.notice_period],
    ["How heard", L.how_heard],
  ].filter(([, v]) => v);
  entries.forEach(([label, value]) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.title = `Copy: ${value}`;
    c.textContent = label;
    c.addEventListener("click", async () => {
      await navigator.clipboard.writeText(String(value));
      c.textContent = `${label} ✓`;
      setTimeout(() => (c.textContent = label), 900);
    });
    box.appendChild(c);
  });
}

$("import").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.basics || !parsed.basics.name) throw new Error("missing basics.name");
      await chrome.storage.local.set({ data: parsed });
      DATA = parsed;
      renderStatus();
      renderJobs(null);
      renderChips();
      $("result").innerHTML = `<span class="ok">Imported ${esc(file.name)}.</span>`;
    } catch (e) {
      $("result").innerHTML = `<span class="err">Could not import: ${esc(e.message)}</span>`;
    }
  };
  reader.readAsText(file);
});

$("job").addEventListener("change", async () => {
  await chrome.storage.local.set({ activeJobId: $("job").value || null });
  syncCopyButtons();
});

$("copy-cover").addEventListener("click", async () => {
  const j = activeJob();
  if (j?.cover) await navigator.clipboard.writeText(j.cover);
  $("result").innerHTML = `<span class="ok">Cover letter for ${esc(j.company)} copied.</span>`;
});

$("copy-resume").addEventListener("click", async () => {
  const j = activeJob();
  if (j?.resume_txt) await navigator.clipboard.writeText(j.resume_txt);
  $("result").innerHTML = `<span class="ok">Plain-text resume for ${esc(j.company)} copied.</span>`;
});

$("fill").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  $("result").textContent = "Filling…";
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageFill,
      args: [DATA, activeJob()],
    });
    const filled = [], attention = [];
    for (const f of frames) {
      if (!f?.result) continue;
      filled.push(...f.result.filled);
      attention.push(...f.result.attention);
    }
    renderResult(filled, attention);
  } catch (e) {
    $("result").innerHTML = `<span class="err">Couldn't run on this page (${esc(e.message)}). ` +
      `If the form is embedded, try opening the ATS posting directly (greenhouse/lever/ashby link).</span>`;
  }
});

function renderResult(filled, attention) {
  if (!filled.length && !attention.length) {
    $("result").innerHTML = `<span class="warn">No fillable form fields recognized on this page.</span>`;
    return;
  }
  let html = `<div class="ok"><b>Filled ${filled.length}</b></div><ul>`;
  html += filled.map((f) => `<li class="ok">${esc(f.label)} ← ${esc(f.preview)}</li>`).join("");
  html += "</ul>";
  if (attention.length) {
    html += `<div class="warn" style="margin-top:6px"><b>Needs you (${attention.length})</b></div><ul>`;
    html += attention.map((a) => `<li class="warn">${esc(a)}</li>`).join("");
    html += "</ul>";
  }
  html += `<div class="muted" style="margin-top:6px">Review every field, attach the resume PDF, then submit yourself.</div>`;
  $("result").innerHTML = html;
}

// ---------------------------------------------------------------------------
// Injected into the page. Must be fully self-contained (no outer references).
// Fills inputs/textareas/selects/radios it can confidently match, highlights
// them, reports the rest. Never overwrites user-entered values and never
// touches submit buttons.
// ---------------------------------------------------------------------------
function pageFill(d, job) {
  const filled = [];
  const attention = [];
  if (!d) return { filled, attention };

  const norm = (s) =>
    (s == null ? "" : String(s)).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

  const visible = (el) => {
    if (el.type === "hidden" || el.disabled || el.readOnly) return false;
    const r = el.getClientRects();
    return r.length > 0 || el.offsetParent !== null;
  };

  function labelText(el) {
    const bits = [];
    try {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) bits.push(lab.textContent);
      }
      const anc = el.closest("label");
      if (anc) bits.push(anc.textContent);
      bits.push(el.getAttribute("aria-label"));
      const byIds = el.getAttribute("aria-labelledby");
      if (byIds)
        byIds.split(/\s+/).forEach((id) => {
          const n = document.getElementById(id);
          if (n) bits.push(n.textContent);
        });
      bits.push(el.placeholder, el.name, el.id, el.getAttribute("autocomplete"));
      const wrap = el.closest("div,fieldset,li,tr,section");
      if (wrap) {
        const lab2 = wrap.querySelector("label, legend, [class*='label' i]");
        if (lab2) bits.push(lab2.textContent);
      }
    } catch (e) { /* keep going with what we have */ }
    return norm(bits.filter(Boolean).join(" "));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function mark(el, color) {
    try { el.style.outline = `2px solid ${color}`; el.style.outlineOffset = "1px"; } catch (e) {}
  }

  function record(el, label, value) {
    mark(el, "#22a06b");
    const preview = String(value).length > 60 ? String(value).slice(0, 57) + "…" : String(value);
    filled.push({ label: label || el.name || el.id || el.tagName.toLowerCase(), preview });
  }

  // --- derive answers from data -------------------------------------------
  const B = d.basics || {}, L = d.logistics || {}, links = d.links || {};
  const edu = (d.education || [])[0] || {};
  const exp = (d.experience || [])[0] || {};
  const nameParts = d.name_parts || {};
  const yesNoFromBool = (b) => (b === true ? "yes" : b === false ? "no" : null);

  // Each rule: pattern on the field's aggregated label; value or yes/no intent.
  // First matching rule wins per field. `attentionIfEmpty` reports a gap
  // instead of silently skipping.
  const rules = [
    { re: /\b(first|given)\s*name\b/, value: nameParts.first },
    { re: /\b(last|family)\s*name\b|\bsurname\b/, value: nameParts.last },
    { re: /\bmiddle\s*(name|initial)\b/, value: nameParts.middle },
    { re: /\bfull\s*name\b|\byour\s*name\b|^name$/, value: B.name },
    { re: /e\s?mail/, value: B.email },
    { re: /phone|mobile|\btel\b/, value: B.phone },
    { re: /linke?d\s?in/, value: links.LinkedIn || links.Linkedin || links.linkedin },
    { re: /github/, value: links.GitHub || links.github },
    { re: /portfolio|personal\s*(web)?site|\burl\b.*(website|portfolio)/, value: links.Website || links.Portfolio },
    { re: /cover\s*letter/, value: job && job.cover, textareaOnly: true,
      attentionIfEmpty: "Cover letter box found — pick an application in the popup first" },
    { re: /additional\s*information|anything\s*else|comments/, value: job && job.cover, textareaOnly: true },
    { re: /salary|compensation|pay\s*(expectation|range|requirement)/, value: L.salary_expectation,
      attentionIfEmpty: "Salary question — set salary_expectation in answers.yaml" },
    { re: /sponsor/, yes: yesNoFromBool(L.sponsorship_needed === true),
      attentionIfEmpty: "Sponsorship question — set visa_sponsorship_needed" },
    { re: /authoriz|legally\s*(able|eligible)?\s*to\s*work|right\s*to\s*work|work\s*eligib/,
      yes: yesNoFromBool(L.authorized_us === true),
      attentionIfEmpty: "Work-authorization question — set work_authorization" },
    { re: /relocat/, value: L.willing_to_relocate,
      attentionIfEmpty: "Relocation question — set willing_to_relocate" },
    { re: /notice\s*period/, value: L.notice_period,
      attentionIfEmpty: "Notice-period question — set notice_period" },
    { re: /start\s*date|date\s*available|availab(le|ility)\s*(to\s*start|date)|earliest/,
      value: L.earliest_start, attentionIfEmpty: "Start-date question — set earliest_start" },
    { re: /hear(d)?\s*about|referr?al\s*source|how\s*did\s*you\s*(find|learn)/, value: L.how_heard,
      attentionIfEmpty: "'How did you hear about us' — set how_heard" },
    { re: /\bgpa\b/, value: edu.gpa },
    { re: /school|university|college|institution/, value: edu.school },
    { re: /degree|qualification|major|field\s*of\s*study/, value: edu.degree },
    { re: /(current|most\s*recent|present).*(employer|company|organi[sz]ation)|^(company|employer)$/,
      value: exp.company },
    { re: /(current|most\s*recent|present).*(title|role|position)|^(job\s*)?title$/, value: exp.title },
    { re: /city|location|address/, value: B.location },
    { re: /pronoun/, value: null, attentionIfEmpty: "Pronouns — your call" },
  ];

  function matchRule(label, el) {
    for (const r of rules) {
      if (!r.re.test(label)) continue;
      if (r.textareaOnly && !(el instanceof HTMLTextAreaElement)) continue;
      return r;
    }
    return null;
  }

  function fillSelect(el, rule, label) {
    const want = rule.yes != null ? rule.yes : rule.value != null ? norm(rule.value) : null;
    if (want == null) return false;
    const opts = Array.from(el.options).filter((o) => norm(o.textContent) && o.value !== "");
    let target = null;
    if (rule.yes != null) {
      target = opts.find((o) => norm(o.textContent).split(" ")[0] === rule.yes);
    } else {
      target = opts.find((o) => norm(o.textContent) === want) ||
               opts.find((o) => norm(o.textContent).includes(want) || want.includes(norm(o.textContent)));
    }
    if (!target) return false;
    setNativeValue(el, target.value);
    record(el, label, target.textContent.trim());
    return true;
  }

  function fillRadioGroup(radios, rule, label) {
    if (rule.yes == null) return false;
    const target = radios.find((r) => {
      const t = labelText(r);
      return rule.yes === "yes" ? /\byes\b/.test(t) && !/\bno\b(?!w)/.test(t.replace(/\byes\b/, ""))
                                : /\bno\b/.test(t);
    });
    if (!target) return false;
    target.click();
    record(target, label, rule.yes);
    return true;
  }

  // --- walk the form controls ---------------------------------------------
  const controls = Array.from(document.querySelectorAll("input, textarea, select"));
  const doneRadioGroups = new Set();

  for (const el of controls) {
    try {
      if (!visible(el)) continue;
      const type = (el.getAttribute("type") || (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : "text")).toLowerCase();
      if (["submit", "button", "image", "reset", "password", "search"].includes(type)) continue;

      if (type === "file") {
        attention.push("File upload found — attach the resume PDF manually");
        mark(el, "#d97706");
        continue;
      }

      const label = labelText(el);
      if (!label) continue;

      if (type === "radio" || type === "checkbox") {
        const key = el.name || label;
        if (doneRadioGroups.has(key)) continue;
        const group = controls.filter((c) => c.type === el.type && (c.name || labelText(c)) === key && visible(c));
        const groupLabel = label;
        const rule = matchRule(groupLabel, el);
        if (rule) {
          doneRadioGroups.add(key);
          if (!fillRadioGroup(group, rule, groupLabel) && rule.attentionIfEmpty) {
            attention.push(rule.attentionIfEmpty);
            group.forEach((g) => mark(g, "#d97706"));
          }
        }
        continue;
      }

      if (el.value && String(el.value).trim() !== "") continue; // never overwrite

      const rule = matchRule(label, el);
      if (!rule) continue;

      if (el instanceof HTMLSelectElement) {
        if (!fillSelect(el, rule, label) && rule.attentionIfEmpty) {
          attention.push(rule.attentionIfEmpty);
          mark(el, "#d97706");
        }
        continue;
      }

      const value = rule.yes != null ? null : rule.value;
      if (value == null || String(value).trim() === "") {
        if (rule.attentionIfEmpty) { attention.push(rule.attentionIfEmpty); mark(el, "#d97706"); }
        continue;
      }
      setNativeValue(el, String(value));
      record(el, label, value);
    } catch (e) { /* one bad field shouldn't stop the rest */ }
  }

  // required fields still empty → flag
  for (const el of controls) {
    try {
      if (!visible(el)) continue;
      const req = el.required || el.getAttribute("aria-required") === "true";
      if (req && !el.value && el.type !== "file" && el.type !== "radio" && el.type !== "checkbox") {
        mark(el, "#d97706");
        attention.push(`Required and still empty: ${labelText(el).slice(0, 60) || el.name || el.id}`);
      }
    } catch (e) {}
  }

  return { filled, attention };
}

loadState();
