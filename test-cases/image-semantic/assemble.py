"""Assemble the reviewed image suite outside Git. Requires Pillow for rendering.

Usage: python3 assemble.py OUTPUT_DIRECTORY [--originals-directory PRIVATE_DIR]
Public images are downloaded without alteration and checked against reviewed hashes.
The optional private directory contains cases.json and the CARD-1/CARD-2 originals.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output_directory', type=Path)
parser.add_argument('--originals-directory', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent
destination = args.output_directory.resolve()
subprocess.run([sys.executable, str(root / 'render.py'), str(destination)], check=True)
cases = json.loads((destination / 'cases.json').read_text(encoding='utf-8'))['cases']
sources = json.loads((root / 'public-sources.json').read_text(encoding='utf-8'))['cases']
for source in sources:
    path = destination / source['file']
    if not path.exists():
        request = urllib.request.Request(source['imageUrl'], headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(request, timeout=45) as response:
            content = response.read(10 * 1024 * 1024 + 1)
        if len(content) > 10 * 1024 * 1024:
            raise SystemExit(f'{source["id"]}: image exceeds inbound size limit')
        if hashlib.sha256(content).hexdigest() != source['sha256']:
            raise SystemExit(f'{source["id"]}: source changed; review pixels and expectations before use')
        path.write_bytes(content)
    if hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
        raise SystemExit(f'{source["id"]}: local source hash mismatch')
    path.chmod(0o600)
    cases.append(dict(id=source['id'], group='public-image', message='',
                      image='/image-cases/' + path.name, expected=source['expected']))
if args.originals_directory:
    original_root = args.originals_directory.resolve()
    originals = json.loads((original_root / 'cases.json').read_text(encoding='utf-8'))['cases']
    selected = [c for c in originals if c['id'] in ('CARD-1', 'CARD-2')]
    if {c['id'] for c in selected} != {'CARD-1', 'CARD-2'}:
        raise SystemExit('Private suite must contain exactly CARD-1 and CARD-2 original definitions')
    for case in selected:
        name = Path(case['image']).name
        source = (original_root / name).resolve()
        if source.parent != original_root:
            raise SystemExit('Original must reside in the supplied private directory')
        shutil.copyfile(source, destination / name)
        (destination / name).chmod(0o600)
        cases.append({**case, 'image': '/image-cases/' + name})
if len({case['id'] for case in cases}) != len(cases):
    raise SystemExit('Duplicate case IDs')
path = destination / 'cases.json'
path.write_text(json.dumps({'cases': cases}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
path.chmod(0o600)
print(f'Assembled {len(cases)} image scenarios. Private originals are never bundled with the repository.')
