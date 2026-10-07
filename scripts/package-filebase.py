"""Build a clean, reproducible source distribution and its manifest.

Private evidence modules (private/), model-run receipts, runtime payloads, and QA downloads are never
included. Usage:
    python3 scripts/package-filebase.py                 # write FILEBASE_MANIFEST.json and two ZIPs next to the repo
    python3 scripts/package-filebase.py --manifest-only # write FILEBASE_MANIFEST.json only
"""
from pathlib import Path
import hashlib, json, sys, zipfile, stat

VERSION = '2.1.0'
root = Path(__file__).resolve().parent.parent
explicit = ['Finance_Task_Studio.html', 'index.html', 'styles.css', 'core.js', 'app.js', 'dashboard.js', 'package-engine.js',
            'candidate-engine.js', 'catalog.js', 'examples.js', 'playbook.js', 'research-gates.js', 'research-catalog.json',
            'README.md', 'VERIFICATION.md', 'package.json', '.gitignore', 'Start Finance Task Studio.command']
files = [root / f for f in explicit]
for directory in ['backend', 'scripts', 'tests', 'research']:
    files += [f for f in (root / directory).rglob('*') if f.is_file() and '__pycache__' not in f.parts and '.DS_Store' not in f.parts]
files += [f for f in (root / 'qa').rglob('*') if f.is_file() and 'downloads' not in f.parts and f.name != 'invalid-project.json']
forbidden = ['private', 'model-runs', 'downloads', 'evidence-module.js', 'model-run.js', 'LOCAL_SERVER.json']
for f in files:
    if not f.is_file():
        raise RuntimeError('Required deliverable missing: ' + str(f))
    if any(x in f.parts for x in forbidden):
        raise RuntimeError('Private or runtime payload in package: ' + str(f))
files = sorted(set(files))
manifest = {
    'format': 'finance-studio-filebase-manifest-v1',
    'version': VERSION,
    'files': [{'file': str(f.relative_to(root)), 'bytes': f.stat().st_size, 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()} for f in files],
    'excluded': ['private/ (locally kept evidence modules and model-run receipts)', 'model-runs/ (raw requests, events, SDK storage, stderr)',
                 'qa/**/downloads/', 'LOCAL_SERVER.json', 'credentials and environment/configuration secrets'],
    'private_evidence': 'No private task evidence is distributed. A bundled task audit is loaded locally through the app as a private evidence module.',
}
manifest_path = root / 'FILEBASE_MANIFEST.json'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'manifest': str(manifest_path), 'files': len(files)}))
if '--manifest-only' in sys.argv:
    sys.exit(0)
files.append(manifest_path)
for name in ['Finance_Task_Studio.zip', 'Finance_Task_Studio_Filebase.zip']:
    target = root.parent / name
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(set(files)):
            arc = 'finance-trap-studio/' + str(f.relative_to(root))
            info = zipfile.ZipInfo(arc, date_time=(2026, 10, 7, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | (0o755 if f.suffix == '.command' else 0o644)) << 16
            z.writestr(info, f.read_bytes())
    with zipfile.ZipFile(target) as z:
        assert z.testzip() is None
        assert not any('/private/' in f or '/model-runs/' in f or f.endswith('LOCAL_SERVER.json') for f in z.namelist())
    print(json.dumps({'path': str(target), 'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'files': len(files)}))
