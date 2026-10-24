'use strict';
/* The isolation audit of designer v2. "Isolated" means that a run is given none of the designer's information: not the designer's
   conversation or logs, not the reference documents, not the brief, the guideline, the golden answer or any grading guidance, and no
   inherited project or user memory. It does not mean "no instructions": a pilot gets the fixed pilot text and the packet.

   isolationProblems looks at what a run was started with (its argument list, its environment and its working folder) and says, in plain
   sentences, which exclusion does not hold. Nothing is started here. The pipeline runs it before each isolated run of its own, and the tests
   run it over what the stub recorded for pilots, reviewers and the rest.

   What the installed CLI cannot enforce is not claimed. The options below are what the CLI documents (and what the pre-flight checks in
   `claude --help`); the account's sign-in is shared with the run through CLAUDE_SECURESTORAGE_CONFIG_DIR, a run is held to its folder by the
   audit of its tool calls after the fact and not by a sandbox, and a process of the same account can read another process's open files under
   /proc: that last case is found by the audit when the run does it, not prevented. */

const path = require('node:path');
const { isObject, within } = require('./util.cjs');

/* Options that would bring information in from somewhere else: a saved session, extra folders, MCP servers or plugins, other settings, a system
   prompt of the project. */
const FORBIDDEN_OPTIONS = ['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id', '--add-dir', '--mcp-config', '--plugin-dir', '--settings', '--agents', '--system-prompt', '--system-prompt-file', '--append-system-prompt', '--append-system-prompt-file', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--teleport'];
/* Options every isolated run carries. */
const REQUIRED_OPTIONS = ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];

/* args: the argument list (the prompt is not in it when it goes on stdin). env: the environment the process gets. cwd: its working folder.
   tmpRoot / projectRoot / homeDir: absolute paths. forbiddenText: strings that must not occur in any environment value (a reference folder, a
   private folder). Returns [text] of what does not hold; [] when everything does. */
function isolationProblems({ args, env, cwd, tmpRoot, projectRoot, homeDir = null, forbiddenText = [] }) {
  const problems = [];
  const list = Array.isArray(args) ? args.map(String) : [];
  for (const option of REQUIRED_OPTIONS) if (!list.includes(option)) problems.push(`the run does not carry ${option}`);
  const at = list.indexOf('--setting-sources');
  if (at < 0 || list[at + 1] !== '') problems.push('the run may load settings from the user, the project or a local file (--setting-sources is not empty)');
  for (const option of FORBIDDEN_OPTIONS) {
    if (list.some(item => item === option || item.startsWith(`${option}=`))) problems.push(`the run is given ${option}`);
  }
  const variables = isObject(env) ? env : {};
  if (variables.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') problems.push('auto-memory is not turned off');
  if (variables.CLAUDE_CODE_DISABLE_CLAUDE_MDS !== '1') problems.push('project instruction files are not turned off');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    problems.push('the working folder is not an absolute path');
    return problems;
  }
  const config = variables.CLAUDE_CONFIG_DIR;
  if (typeof config !== 'string' || !config || !within(path.resolve(config), cwd)) problems.push('the runtime\'s configuration folder is not inside the working folder');
  for (const name of ['TMPDIR', 'CLAUDE_CODE_TMPDIR']) {
    if (typeof variables[name] !== 'string' || !variables[name] || !within(path.resolve(variables[name]), cwd)) problems.push(`${name} is not inside the working folder`);
  }
  if (typeof tmpRoot === 'string' && tmpRoot && !within(cwd, path.resolve(tmpRoot))) problems.push('the working folder is not under the temporary root');
  if (typeof projectRoot === 'string' && projectRoot && within(cwd, path.resolve(projectRoot))) problems.push('the working folder is inside the project');
  if (typeof homeDir === 'string' && homeDir && within(cwd, path.resolve(homeDir)) && !(typeof tmpRoot === 'string' && within(path.resolve(tmpRoot), path.resolve(homeDir)))) problems.push('the working folder is inside the home folder');
  if (variables.FINANCE_STUDIO_PILOT_TOKEN) problems.push('the companion\'s own pilot token source is in the environment');
  const named = forbiddenText.filter(item => typeof item === 'string' && item.length >= 4);
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value !== 'string') continue;
    if (named.some(item => value.includes(item))) problems.push(`the environment variable ${name} names a private folder`);
  }
  return problems;
}

module.exports = { isolationProblems, FORBIDDEN_OPTIONS, REQUIRED_OPTIONS };
