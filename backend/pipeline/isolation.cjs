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

const fs = require('node:fs');
const path = require('node:path');
const { isObject, within } = require('./util.cjs');

/* Options that would bring information in from somewhere else: a saved session, extra folders, MCP servers or plugins, other settings, a system
   prompt of the project. */
const FORBIDDEN_OPTIONS = ['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id', '--add-dir', '--mcp-config', '--plugin-dir', '--settings', '--agents', '--system-prompt', '--system-prompt-file', '--append-system-prompt', '--append-system-prompt-file', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--teleport'];
/* Options every isolated run carries. */
const REQUIRED_OPTIONS = ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];

/* Does a text name this folder? The folder has to stand in the text as a path: at a boundary on both sides (the text starts there or the character before is not
   one a path name is made of, and the folder is followed by the end, a separator or a character no name is made of), so that <root>/private-notes or
   <root>/private.bak is not <root>/private, and /x<root>/private is not <root>/private either. A text that does not hold the folder as a path, whatever else it
   holds, is not a text that names it. */
const NAME_CHAR = /[A-Za-z0-9_.~+@%-]/;
function namesFolder(text, folder) {
  const value = String(text);
  const target = String(folder).replace(/[\\/]+$/, '');
  if (target.length < 4) return false;
  for (let from = 0; ;) {
    const at = value.indexOf(target, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : value[at - 1];
    const after = value[at + target.length] || '';
    if ((!before || !(NAME_CHAR.test(before) || before === '/' || before === '\\')) && (!after || after === '/' || after === '\\' || !NAME_CHAR.test(after))) return true;
    from = at + 1;
  }
}

/* The names of the environment variables whose value names one of the folders (see namesFolder). */
function environmentProblems(env, forbiddenText = []) {
  const named = forbiddenText.filter(item => typeof item === 'string' && item.length >= 4);
  return Object.entries(isObject(env) ? env : {}).filter(([, value]) => typeof value === 'string' && named.some(item => namesFolder(value, item))).map(([name]) => name);
}

/* args: the argument list (the prompt is not in it when it goes on stdin). env: the environment the process gets. cwd: its working folder.
   tmpRoot / projectRoot / homeDir: absolute paths. forbiddenText: folders that no environment value or argument may name as a path (a reference folder, a
   private folder; see namesFolder: <root>/private-notes is not <root>/private). tools: the tools this run may have (an array; [] for a run with none); when it is given, the run's --tools and --allowedTools must be exactly
   that list. Returns [text] of what does not hold; [] when everything does. */
function isolationProblems({ args, env, cwd, tmpRoot, projectRoot, homeDir = null, forbiddenText = [], tools = undefined }) {
  const problems = [];
  const list = Array.isArray(args) ? args.map(String) : [];
  for (const option of REQUIRED_OPTIONS) if (!list.includes(option)) problems.push(`the run does not carry ${option}`);
  const at = list.indexOf('--setting-sources');
  if (at < 0 || list[at + 1] !== '') problems.push('the run may load settings from the user, the project or a local file (--setting-sources is not empty)');
  for (const option of FORBIDDEN_OPTIONS) {
    if (list.some(item => item === option || item.startsWith(`${option}=`))) problems.push(`the run is given ${option}`);
  }
  if (Array.isArray(tools)) {
    const want = [...tools].sort().join(',');
    /* every place an option stands counts (a second --allowedTools is not ignored), and so does the spelling with a dash */
    const listOf = (...options) => {
      const given = new Set();
      list.forEach((item, index) => {
        const named = options.find(option => item === option || item.startsWith(`${option}=`));
        if (!named) return;
        const value = item === named ? (list[index + 1] === undefined ? '' : list[index + 1]) : item.slice(named.length + 1);
        for (const tool of String(value).split(/[,\s]+/).filter(Boolean)) given.add(tool);
      });
      return [...given].sort().join(',');
    };
    if (listOf('--tools') !== want) problems.push(`the run's tools are not exactly the ones this review may use (${want || 'none'})`);
    if (listOf('--allowedTools', '--allowed-tools') !== want) problems.push('the run allows tools beyond the ones this review may use');
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
  /* where the working folder really is: a link there must not lead into the project or the home folder, or out of the temporary root */
  try {
    const real = fs.realpathSync(cwd);
    if (real !== cwd) {
      if (typeof tmpRoot === 'string' && tmpRoot && !within(real, fs.realpathSync(tmpRoot))) problems.push('the working folder is, through a link, not under the temporary root');
      if (typeof projectRoot === 'string' && projectRoot && within(real, fs.realpathSync(projectRoot))) problems.push('the working folder is, through a link, inside the project');
    }
  } catch { /* a folder that does not exist yet has no real path to compare */ }
  const named = forbiddenText.filter(item => typeof item === 'string' && item.length >= 4);
  for (const item of list) if (named.some(text => namesFolder(item, text))) problems.push('an argument of the run names a private folder');
  for (const name of environmentProblems(variables, named)) problems.push(`the environment variable ${name} names a private folder`);
  return problems;
}

module.exports = { isolationProblems, environmentProblems, namesFolder, FORBIDDEN_OPTIONS, REQUIRED_OPTIONS };
