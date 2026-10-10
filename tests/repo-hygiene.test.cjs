'use strict';
/* Checks on what git will and will not offer, using the repository's own .gitignore. Nothing here reads private/. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const hasGit = git(['rev-parse', '--is-inside-work-tree']).status === 0;
const ignored = name => git(['check-ignore', '-q', '--', name]).status === 0;

test('files the app downloads with private material are ignored wherever they land', { skip: hasGit ? false : 'not a git work tree' }, () => {
  const agents = fs.readFileSync(path.join(root, 'agents.js'), 'utf8');
  assert.ok(/'Finance_Agent_Round_'\+S\.round\.id\+'_PRIVATE\.json'/.test(agents), 'the name agents.js gives the round download');
  for (const name of [
    'Finance_Agent_Round_rnd-0123456789ab_PRIVATE.json',
    'Finance_Task_Analysis_PRIVATE.json',
    'Finance_Task_Analysis_Results_PRIVATE.txt',
    'Downloads/Finance_Agent_Round_rnd-0123456789ab_PRIVATE.json',
    'qa/agents/Finance_Agent_Round_rnd-0123456789ab_PRIVATE.json',
  ]) assert.ok(ignored(name), name + ' must be ignored');
  for (const name of ['private/agent-rounds/rnd-0123456789ab/round.json', 'LOCAL_SERVER.json', 'private/privacy-terms.txt']) assert.ok(ignored(name), name + ' must stay ignored');
  for (const name of ['README.md', 'agents.js', 'scripts/pre-push.cjs', 'tests/repo-hygiene.test.cjs']) assert.ok(!ignored(name), name + ' must not be ignored');
});

test('no tracked file carries the private download suffix', { skip: hasGit ? false : 'not a git work tree' }, () => {
  const tracked = git(['ls-files', '-z']).stdout.split('\0').filter(Boolean);
  assert.deepEqual(tracked.filter(name => /_PRIVATE\./.test(name)), []);
});
