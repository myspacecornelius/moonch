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
forbidden = ['private', 'model-runs', 'downloads', 'evidence-module.js', 'model-run.js', 'LOCAL_SERVER.json']


def tracked_files():
    # A git hook sets GIT_DIR and friends; they must not point git at another repository than the one this script belongs to.
    env = {k: v for k, v in os.environ.items() if k not in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE')}
    try:
        listing = subprocess.run(['git', 'ls-files', '-z'], cwd=root, env=env, check=True, capture_output=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError('Cannot list tracked files with git ls-files: ' + str(error))
    names = [name for name in listing.decode('utf-8').split('\0') if name]
    if not names:
        raise RuntimeError('git ls-files listed nothing: run this inside the repository work tree')
    return [root / name for name in names if name != MANIFEST_NAME]


files = tracked_files()
for f in files:
    if not f.is_file():
        raise RuntimeError('Tracked file missing from the work tree: ' + str(f))
    if any(x.lower() in [part.lower() for part in f.parts] for x in forbidden) or 'private' in f.name.lower():
        raise RuntimeError('Private or runtime payload in package: ' + str(f))
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
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'manifest': str(manifest_path), 'files': len(files)}))
if '--manifest-only' in sys.argv:
    sys.exit(0)
files.append(manifest_path)
for name in ['Finance_Task_Studio.zip', 'Finance_Task_Studio_Filebase.zip']:
    target = root.parent / name
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(set(files)):
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
