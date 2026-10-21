"""Build a clean source distribution and its manifest from the files git tracks.

The file list is `git ls-files`, so an untracked or ignored file (private/, model-run receipts, QA downloads, task packages,
exports, local settings) can never reach the package. The forbidden-name checks below are a second guard, in case such a file
is ever tracked by mistake. FILEBASE_MANIFEST.json is written next to the repository files and is not versioned (it is in
.gitignore), because it records the sizes and hashes of this checkout. Usage:
    python3 scripts/package-filebase.py                 # write FILEBASE_MANIFEST.json and two ZIPs next to the repo
    python3 scripts/package-filebase.py --manifest-only # write FILEBASE_MANIFEST.json only
"""
from pathlib import Path
import hashlib, json, os, subprocess, sys, zipfile, stat

VERSION = '3.0.0'
ARCHIVE_PREFIX = 'finance-task-studio/'
MANIFEST_NAME = 'FILEBASE_MANIFEST.json'
root = Path(__file__).resolve().parent.parent
root_real = root.resolve()
forbidden = ['private', 'model-runs', 'downloads', 'evidence-module.js', 'model-run.js', 'LOCAL_SERVER.json']


def fail(message):
    sys.exit('package-filebase: ' + message)


def git_output(*args):
    # A git hook sets GIT_DIR and friends; they must not point git at another repository than the one this script belongs to.
    env = {k: v for k, v in os.environ.items() if k not in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE')}
    try:
        return subprocess.run(['git'] + list(args), cwd=root, env=env, check=True, capture_output=True).stdout.decode('utf-8')
    except (OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr.decode('utf-8', 'replace').strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        fail('run npm run package from a git checkout: git ' + ' '.join(args) + ' failed (' + (detail or 'no output') + ')')


def tracked_files():
    top = git_output('rev-parse', '--show-toplevel').strip()
    if not top or Path(top).resolve() != root_real:
        fail('run npm run package from a git checkout: ' + str(root) + ' is not the top level of one')
    names = [name for name in git_output('ls-files', '-z').split('\0') if name]
    if not names:
        fail('git ls-files listed nothing: run npm run package from a git checkout with tracked files')
    changed = [line for line in git_output('status', '--porcelain').split('\n') if line]
    if changed:
        sys.stderr.write('package-filebase: warning: git status is not clean (' + str(len(changed)) + ' entries); the package holds the tracked files as they are on disk, not as committed\n')
    return [root / name for name in names if name != MANIFEST_NAME]


def check_file(f):
    # The second guard behind git ls-files: no link of any kind, nothing that leaves the repository, nothing private or runtime.
    if f.is_symlink():
        fail('Symlink in package: ' + str(f))
    if not f.is_file():
        fail('Tracked file missing from the work tree: ' + str(f))
    real = f.resolve()
    try:
        real_relative = real.relative_to(root_real)
    except ValueError:
        fail('Path leaves the repository: ' + str(f))
    if real != root_real / f.relative_to(root):
        fail('Path goes through a symlink: ' + str(f))
    for name, parts in ((f.name, f.relative_to(root).parts), (real.name, real_relative.parts)):
        if any(x.lower() in [part.lower() for part in parts] for x in forbidden) or 'private' in name.lower():
            fail('Private or runtime payload in package: ' + str(f))


files = tracked_files()
for f in files:
    check_file(f)
files = sorted(set(files))
manifest = {
    'format': 'finance-studio-filebase-manifest-v1',
    'version': VERSION,
    'files': [{'file': str(f.relative_to(root)), 'bytes': f.stat().st_size, 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()} for f in files],
    'excluded': ['everything git does not track (private/ evidence modules and model-run receipts, model-runs/, qa/**/downloads/, LOCAL_SERVER.json, task packages, exports)',
                 'credentials and environment/configuration secrets'],
    'private_evidence': 'No private task evidence is distributed. A bundled task audit is loaded locally through the app as a private evidence module.',
}
manifest_path = root / MANIFEST_NAME
if manifest_path.is_symlink():
    fail(MANIFEST_NAME + ' is a symlink; remove it and run again')
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'manifest': str(manifest_path), 'files': len(files)}))
if '--manifest-only' in sys.argv:
    sys.exit(0)
files.append(manifest_path)
for name in ['Finance_Task_Studio.zip', 'Finance_Task_Studio_Filebase.zip']:
    target = root.parent / name
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(set(files)):
            check_file(f)
            arc = ARCHIVE_PREFIX + str(f.relative_to(root))
            info = zipfile.ZipInfo(arc, date_time=(2026, 10, 7, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | (0o755 if f.stat().st_mode & 0o111 else 0o644)) << 16
            z.writestr(info, f.read_bytes())
    with zipfile.ZipFile(target) as z:
        assert z.testzip() is None
        assert not any('/private/' in f or '/model-runs/' in f or f.endswith('LOCAL_SERVER.json') for f in z.namelist())
        assert all(f.startswith(ARCHIVE_PREFIX) for f in z.namelist())
    print(json.dumps({'path': str(target), 'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'files': len(files)}))
