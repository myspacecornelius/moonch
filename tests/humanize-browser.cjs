'use strict';
/* The Verva worker (src/humanize/providers/verva-web.cjs) in a real Chromium, against fake Verva pages served on 127.0.0.1. No network
   beyond this machine, no account, no model. Run: npm run test:humanize (node tests/humanize-browser.cjs).

   Checks: the editor, the button and the result are found without selectors on a textarea page whose result streams in, and on a
   contenteditable page; pinned selectors win on a page where guessing would pick the wrong box; a sign-in wall stops the run with
   needs-sign-in before anything is typed; a page's own "out of credits" message is reported; the whole orchestrator runs through the
   worker; Chrome runs on the pipe only (no debugging port), from a 0700 profile, and its environment holds no GPTZero key.

   Environment: CHROME_BIN (default: the Playwright Chromium under /opt/pw-browsers when it exists). As root, --no-sandbox is added
   through spawnFn only, as tests/links-browser.cjs does. KEEP=1 keeps the temporary folder. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createVervaWeb } = require('../src/humanize/providers/verva-web.cjs');
const { runHumanize } = require('../src/humanize/orchestrator.cjs');
const { findFacts } = require('../src/humanize/secretary.cjs');

function defaultChrome() {
  const base = '/opt/pw-browsers';
  try {
    for (const dir of fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const file = path.join(base, dir, sub, 'chrome');
        if (fs.existsSync(file)) return file;
      }
    }
  } catch { /* not this machine */ }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const chromePath = process.env.CHROME_BIN || defaultChrome();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let lastChrome = null;
const spawnFn = (binary, args, options) => {
  const child = spawn(binary, isRoot ? [...args.slice(0, -1), '--no-sandbox', args[args.length - 1]] : args, options);
  lastChrome = { child, args };
  return child;
};

/* ------------------------------------------------------------------ fake Verva pages */

const SCRIPT_TEXTAREA = `document.getElementById('go').addEventListener('click',()=>{const t=document.getElementById('in').value;const out=document.getElementById('out');out.textContent='';const w=t.replace(/went well/g,'went fine').replace(/\\bvery\\b/g,'really').split(' ');let i=0;const tm=setInterval(()=>{i+=2;out.textContent=w.slice(0,i).join(' ');if(i>=w.length)clearInterval(tm);},60);});`;
const SCRIPT_EDITABLE = `const ed=document.getElementById('ed'),btn=document.getElementById('run');let value='';ed.addEventListener('input',()=>{value=ed.innerText;btn.disabled=!value.trim();});btn.addEventListener('click',()=>{const box=document.querySelector('[data-testid="humanized-output"]');box.setAttribute('aria-busy','true');setTimeout(()=>{box.textContent=value.replace(/went well/g,'went fine');box.setAttribute('aria-busy','false');},400);});`;
const SCRIPT_TWO = `document.getElementById('go').addEventListener('click',()=>{document.getElementById('res').value=document.getElementById('mine').value.replace(/went well/g,'went fine');});`;
const SCRIPT_CREDITS = `document.getElementById('go').addEventListener('click',()=>{const a=document.getElementById('alert');a.textContent='You do not have enough credits. Upgrade your plan to continue.';a.hidden=false;});`;

const PAGES = {
  '/textarea': `<h1>Verva</h1><textarea id="in" rows="8" cols="70"></textarea><p><button id="go">Humanize</button></p><div class="result-box" id="out"></div><script src="/textarea.js"></script>`,
  '/editable': `<h1>Verva</h1><div id="ed" contenteditable="true" style="min-height:80px;border:1px solid #888"></div><p><button id="run" disabled>Humanize text</button></p><div data-testid="humanized-output" aria-busy="false"></div><script src="/editable.js"></script>`,
  '/two': `<textarea id="notes" rows="3">scratch notes the worker must not touch</textarea><textarea id="mine" rows="6" cols="70"></textarea><textarea id="res" rows="6" cols="70"></textarea><button id="go">Go</button><script src="/two.js"></script>`,
  '/login': `<h1>Sign in</h1><form><input type="email"><input type="password"><button>Sign in</button></form>`,
  '/credits': `<textarea id="in" rows="6" cols="60"></textarea><button id="go">Humanize</button><div role="alert" id="alert" hidden></div><div class="output"></div><script src="/credits.js"></script>`,
};
const SCRIPTS = { '/textarea.js': SCRIPT_TEXTAREA, '/editable.js': SCRIPT_EDITABLE, '/two.js': SCRIPT_TWO, '/credits.js': SCRIPT_CREDITS };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (SCRIPTS[url.pathname]) { res.setHeader('content-type', 'text/javascript'); return res.end(SCRIPTS[url.pathname]); }
    if (url.pathname === '/app') { res.writeHead(302, { location: '/login' }); return res.end(); }
    if (!PAGES[url.pathname]) { res.writeHead(404); return res.end('no'); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Verva test</title></head><body>${PAGES[url.pathname]}</body></html>`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------ the checks */

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok - ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`not ok - ${name}\n  ${String(error && error.stack || error).split('\n').slice(0, 6).join('\n  ')}`);
  }
}

async function main() {
  if (!fs.existsSync(chromePath)) {
    console.log(`skip - no Chrome at ${chromePath} (set CHROME_BIN)`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'humanize-browser-'));
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const worker = (page, extra = {}) => createVervaWeb({ root: tmp, chromePath, spawnFn, headless: true, allowLoopback: true, config: { url: `${base}${page}`, stableMs: 500, pollMs: 100, resultTimeoutMs: 15000, ...extra } });
  const MASKED = 'The quarter went well for the very patient team, and K01 rose K02 to K03 while K04 did not breach the K05 covenant.';

  await check('a textarea page whose result streams in: found without selectors, read once it stops changing, placeholders intact', async () => {
    process.env.GPTZERO_API_KEY = 'gptzero-test-key-should-not-leak';
    const v = worker('/textarea');
    try {
      await v.preflight();
      const out = await v.rewrite(MASKED);
      assert.equal(out, MASKED.replace('went well', 'went fine').replace(/\bvery\b/g, 'really'));
      const second = await v.rewrite('A second segment went well for K06 and the K07 team.');
      assert.equal(second, 'A second segment went fine for K06 and the K07 team.', 'the tab is reused and the old result is not read again');
      assert.ok(lastChrome.args.includes('--remote-debugging-pipe'), 'CDP over the pipe');
      assert.ok(!lastChrome.args.some(a => a.startsWith('--remote-debugging-port')), 'no debugging port');
      if (process.platform === 'linux') {
        const environ = fs.readFileSync(`/proc/${lastChrome.child.pid}/environ`, 'utf8');
        assert.ok(!environ.includes('GPTZERO_API_KEY') && !environ.includes('gptzero-test-key'), 'Chrome gets an allow list of variables: no API key');
      }
      const mode = fs.statSync(path.join(tmp, 'private', 'humanize', 'verva-profile')).mode & 0o777;
      assert.equal(mode, 0o700, 'the profile is private');
    } finally {
      delete process.env.GPTZERO_API_KEY;
      await v.close();
    }
  });

  await check('a contenteditable page with a button that waits for input and a busy result box', async () => {
    const v = worker('/editable');
    try {
      assert.equal(await v.rewrite(MASKED), MASKED.replace('went well', 'went fine'));
    } finally {
      await v.close();
    }
  });

  await check('pinned selectors win where guessing would pick the wrong box', async () => {
    const v = worker('/two', { input: '#mine', button: '#go', output: '#res' });
    try {
      assert.equal(await v.rewrite(MASKED), MASKED.replace('went well', 'went fine'));
      assert.equal(v.status().pinned.input, true);
    } finally {
      await v.close();
    }
  });

  await check('a sign-in wall (a redirect to a password form) stops with needs-sign-in before anything is typed', async () => {
    const v = worker('/app');
    try {
      await assert.rejects(v.preflight(), e => e.code === 'needs-sign-in' && /sign in/i.test(e.message));
    } finally {
      await v.close();
    }
  });

  await check('the page\'s own "not enough credits" message is reported, not waited out', async () => {
    const v = worker('/credits');
    try {
      const started = Date.now();
      await assert.rejects(v.rewrite(MASKED), e => e.code === 'rewriter' && /Verva said: You do not have enough credits/.test(e.message));
      assert.ok(Date.now() - started < 10000, 'reported at once');
    } finally {
      await v.close();
    }
  });

  await check('the whole network runs through the Verva worker: secretary, Verva, repair, sign-off', async () => {
    const v = worker('/textarea');
    const text = 'The quarter went well and revenue rose 12% to $4.1m as pricing held. Margin fell 150 bps to 21.4%, but leverage did not breach the 3.5x covenant. The team plans to keep costs flat next year.';
    const detector = { id: 'fake', label: 'Fake detector', async scan(t) { return { human: t.includes('went fine') ? 0.95 : 0.3, sentences: [] }; } };
    try {
      const r = await runHumanize(text, { rewriter: v, detector });
      assert.equal(r.status, 'passed');
      assert.equal(r.final, text.replace('went well', 'went fine'));
      assert.deepEqual(findFacts(r.final).map(f => f.text), findFacts(text).map(f => f.text));
      assert.equal(r.calls.rewrite, 1);
    } finally {
      await v.close();
    }
  });

  server.close();
  if (process.env.KEEP !== '1') fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
