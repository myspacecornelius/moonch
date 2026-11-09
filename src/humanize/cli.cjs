#!/usr/bin/env node
'use strict';
/* The humanize network on its own, without the Studio or its companion (docs/humanize.md).

     npm run humanize -- run --in draft.txt [--out final.txt] [--report report.json]
                            [--rewriter verva|stub] [--detector gptzero|stub] [--passes 3] [--rounds 3] [--workers 1]
                            [--verva-url https://...] [--headless] [--yes] [--quiet]
     npm run humanize -- brief --in draft.txt          the secretary's brief only: no network, no browser
     npm run humanize -- sign-in [--verva-url URL]     the Verva sign-in window; press Enter here when you are signed in
     npm run humanize -- config --verva-url URL [--input SEL] [--button SEL] [--output SEL] [--min-words N] [--headless|--windowed]

   --in - (or no --in) reads the text from standard input. The final text goes to --out, or to standard output. Progress goes to standard
   error. A run with Verva or GPTZero needs --yes: text leaves this computer (masked to Verva, unmasked chunks to GPTZero).
   The report (--report) holds the text, the brief, every pass and the log; it is written with mode 0600.
   Exit codes: 0 the aggregate reached its bar, 1 it did not (below-bar, stalled, budget), 2 a usage or setup error,
   3 Verva asks for a sign-in, 130 stopped with Ctrl-C. */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { runHumanize } = require('./orchestrator.cjs');
const { brief } = require('./secretary.cjs');
const { pickProviders } = require('./providers/index.cjs');
const { createVervaWeb, writeConfig, readConfig } = require('./providers/verva-web.cjs');
const { createKeyStore } = require('./keys.cjs');
const { THIRD_PARTY_TEXT } = require('./constants.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const USAGE = [
  'Usage:',
  '  npm run humanize -- run --in draft.txt [--out final.txt] [--report report.json]',
  '                         [--rewriter verva|stub] [--detector gptzero|stub] [--passes 3] [--rounds 3] [--workers 1]',
  '                         [--verva-url https://...] [--headless] [--yes] [--quiet]',
  '  npm run humanize -- brief --in draft.txt        the secretary\'s brief only (no network, no browser)',
  '  npm run humanize -- sign-in [--verva-url URL]   the Verva sign-in window',
  '  npm run humanize -- config --verva-url URL [--input SEL] [--button SEL] [--output SEL] [--min-words N] [--headless|--windowed]',
  '',
  'A run with Verva or GPTZero needs --yes. GPTZero\'s key: GPTZERO_API_KEY, or the macOS Keychain item finance-studio-gptzero-key.',
].join('\n');

const FLAGS = new Set(['yes', 'quiet', 'headless', 'windowed', 'help']);
function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    if (FLAGS.has(name)) { out[name] = true; continue; }
    if (i + 1 >= argv.length) throw usage(`--${name} needs a value`);
    out[name] = argv[++i];
  }
  return out;
}

function usage(message) {
  return Object.assign(new Error(message ? `${message}\n\n${USAGE}` : USAGE), { exit: 2 });
}

function int(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw usage(`--${name} must be a whole number`);
  return n;
}

async function readInput(file) {
  if (file && file !== '-') return fs.readFileSync(path.resolve(file), 'utf8');
  if (process.stdin.isTTY) throw usage('Give the text with --in <file>, or pipe it in');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const pct = x => (Number.isFinite(x) ? `${Math.round(x * 1000) / 10}%` : '-');

async function cmdRun(args, io) {
  const text = await readInput(args.in);
  const rewriterId = args.rewriter || 'verva';
  const detectorId = args.detector || 'gptzero';
  const verva = rewriterId === 'verva' ? createVervaWeb({ root: ROOT, env: io.env, headless: args.headless ? true : undefined, config: args['verva-url'] ? { ...readConfig(ROOT, io.env), url: args['verva-url'] } : undefined }) : null;
  const providers = pickProviders({ rewriter: rewriterId, detector: detectorId }, { verva, keys: createKeyStore({ env: io.env }) });
  if (providers.external && !args.yes) throw usage(`Add --yes to confirm: ${THIRD_PARTY_TEXT}`);
  const controller = new AbortController();
  const onSigint = () => { io.err('\nStopping (the best version so far is kept)...'); controller.abort(); };
  process.once('SIGINT', onSigint);
  let seen = 0;
  let stage = '';
  const result = await runHumanize(text, {
    rewriter: providers.rewriter,
    detector: providers.detector,
    signal: controller.signal,
    options: { maxPasses: int(args.passes, 'passes'), maxRounds: int(args.rounds, 'rounds'), workers: int(args.workers, 'workers') },
    onUpdate: view => {
      if (args.quiet) return;
      const at = `${view.stage} r${view.round} p${view.pass}`;
      if (at !== stage) { stage = at; io.err(`[${view.stage}] round ${view.round}, pass ${view.pass}`); }
      for (const line of view.log.slice(seen)) io.err(`  ${line.text}`);
      seen = view.log.length;
    },
  }).finally(async () => {
    process.removeListener('SIGINT', onSigint);
    if (verva) await verva.close().catch(() => {});
  });
  if (args.out) fs.writeFileSync(path.resolve(args.out), result.final);
  else io.out(result.final);
  if (args.report) fs.writeFileSync(path.resolve(args.report), JSON.stringify(result, null, 2), { mode: 0o600 });
  io.err('');
  io.err(`Status: ${result.status}${result.error ? ` (${result.error})` : ''}`);
  io.err(`Aggregate: ${pct(result.aggregate.human)} human (bar ${pct(result.aggregate.bar)})${result.providers.detector && result.providers.detector.estimate ? ' - OFFLINE ESTIMATE, not a GPTZero reading; not signed off' : result.signedOff ? ' - signed off by GPTZero' : ''}`);
  for (const c of result.chunks) io.err(`  ${c.id.padEnd(6)} ${c.kind.padEnd(5)} ${c.status.padEnd(9)} best ${pct(c.best.human)} / bar ${pct(c.bar)}  passes: ${c.passes.map(p => `${p.kind === 'baseline' ? 'b' : `r${p.round}.${p.pass}`}:${p.gate === 'rejected' ? 'rejected' : pct(p.human)}`).join(' ')}${c.notes.length ? `  read: ${c.notes.join(', ')}` : ''}`);
  io.err(`Calls: ${result.calls.rewrite} rewrite, ${result.calls.scan} scan.`);
  if (result.status === 'passed') return 0;
  if (result.status === 'cancelled') return 130;
  if (result.status === 'needs-sign-in') return 3;
  if (result.status === 'failed') return 2;
  return 1;
}

async function cmdBrief(args, io) {
  const b = brief(await readInput(args.in));
  io.out(JSON.stringify({ facts: b.facts, terms: b.terms, bindings: b.bindings }, null, 2));
  return 0;
}

async function cmdSignIn(args, io) {
  const verva = createVervaWeb({ root: ROOT, env: io.env, config: args['verva-url'] ? { url: args['verva-url'] } : undefined });
  const opened = await verva.signIn();
  io.err('A Chrome window is open on Verva. Sign in there (the Studio cannot see that window), then press Enter here.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await Promise.race([new Promise(resolve => rl.once('line', resolve)), opened.exited]);
  rl.close();
  await verva.finishSignIn();
  io.err('Done. The sign-in is kept in private/humanize/verva-profile.');
  return 0;
}

function cmdConfig(args, io) {
  const patch = {};
  if (args['verva-url']) patch.url = args['verva-url'];
  for (const key of ['input', 'button', 'output']) if (args[key] !== undefined) patch[key] = args[key];
  if (args['min-words'] !== undefined) patch.minWords = int(args['min-words'], 'min-words');
  if (args.headless) patch.headless = true;
  if (args.windowed) patch.headless = false;
  const saved = writeConfig(ROOT, patch);
  io.out(JSON.stringify({ ...saved, url: saved.url || null }, null, 2));
  return 0;
}

async function main(argv = process.argv.slice(2), io = { out: t => process.stdout.write(`${t}\n`), err: t => process.stderr.write(`${t}\n`), env: process.env }) {
  try {
    const args = parse(argv);
    const command = args._[0];
    if (!command || args.help) { io.err(USAGE); return command ? 0 : 2; }
    if (command === 'run') return await cmdRun(args, io);
    if (command === 'brief') return await cmdBrief(args, io);
    if (command === 'sign-in') return await cmdSignIn(args, io);
    if (command === 'config') return cmdConfig(args, io);
    throw usage(`Unknown command "${command}"`);
  } catch (error) {
    io.err(String(error && error.message ? error.message : error));
    return error && Number.isInteger(error.exit) ? error.exit : 2;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { main, parse };
