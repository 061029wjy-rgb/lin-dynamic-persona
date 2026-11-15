"""Deterministic install ZIP. Run from the repository root with npm run package."""
from pathlib import Path
import json, zipfile, hashlib
root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'manifest.json').read_text())['version']
out = root.parent / f'lin-dynamic-persona-{version}.zip'
paths = [p for p in root.rglob('*') if p.is_file() and not any(x in p.relative_to(root).parts for x in ('node_modules', '.git', 'coverage')) and p.suffix != '.zip' and p.name != '.DS_Store']
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in sorted(paths):
        info = zipfile.ZipInfo('lin-dynamic-persona/' + p.relative_to(root).as_posix(), date_time=(2026, 11, 15, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, p.read_bytes())
print(f'{out.name}: {len(paths)} files, {out.stat().st_size} bytes')
print('SHA256', hashlib.sha256(out.read_bytes()).hexdigest())
