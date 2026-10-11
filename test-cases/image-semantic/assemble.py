"""Download 100 reviewed real-world images unchanged into a private directory.

Usage: python3 assemble.py OUTPUT_DIRECTORY
Sources and expectations are frozen in public-sources.json. No image synthesis.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output_directory', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent
destination = args.output_directory.resolve()
if destination == root or root in destination.parents:
    raise SystemExit('Choose a private output directory outside the repository')
repository = root.parent.parent
if destination == repository or repository in destination.parents:
    raise SystemExit('Choose a private output directory outside the repository')
destination.mkdir(parents=True, exist_ok=True, mode=0o700)
sources = json.loads((root / 'public-sources.json').read_text(encoding='utf-8'))['cases']
if len(sources) != 100 or len({s['sha256'] for s in sources}) != 100:
    raise SystemExit('Expected 100 distinct reviewed original images')
cases, cards = [], []
for source in sources:
    name = source['file']
    if Path(name).name != name:
        raise SystemExit('Invalid source filename')
    path = destination / name
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
    cases.append(dict(id=source['id'], group=source['kind'], message='',
                      image='/image-cases/' + name, expected=source['expected']))
    e = source['expected']
    details = html.escape(json.dumps(e, ensure_ascii=False))
    cards.append(f'<article data-action="{e["action"]}"><h2>{source["id"]} · {html.escape(source["scenario"])}</h2>'
                 f'<a href="{html.escape(name)}"><img loading="lazy" src="{html.escape(name)}"></a>'
                 f'<p>{html.escape(source["reason"])}</p><pre>{details}</pre>'
                 f'<a href="{html.escape(source["sourcePage"], quote=True)}" rel="noreferrer">Source page</a></article>')
path = destination / 'cases.json'
path.write_text(json.dumps({'cases': cases}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
path.chmod(0o600)
record_count = sum(s['expected']['action'] == 'record' for s in sources)
page = '''<!doctype html><meta charset="utf-8"><title>100 real-world payment images</title>
<style>body{font:16px system-ui;background:#eef1f5;margin:24px;color:#182237}h1{font-size:28px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:20px}article{background:white;padding:18px;border-radius:12px}img{width:100%;height:420px;object-fit:contain}h2{font-size:17px}pre{white-space:pre-wrap;word-break:break-word;font-size:13px}button{padding:10px;margin:6px}a{color:#1759a8}</style>
<h1>100 real-world payment images / 100 张真实世界支付图片</h1>
<p>80 web originals + 20 SROIE receipt scans. No synthetic images. Expected results are human labels, not model results.</p>
<p>Click an image for the unchanged original. Missing purpose → comment 无; missing date → ask; missing currency → SGD.</p>
<button onclick="filter('all')">All 100</button><button onclick="filter('record')">Expected record RECORD_COUNT</button><button onclick="filter('reject')">Expected no write REJECT_COUNT</button>
<main>''' + ''.join(cards) + '''</main><script>function filter(a){document.querySelectorAll('article').forEach(x=>x.hidden=a!=='all'&&x.dataset.action!==a)}</script>'''
page = page.replace('RECORD_COUNT', str(record_count)).replace('REJECT_COUNT', str(len(sources) - record_count))
(destination / 'index.html').write_text(page, encoding='utf-8')
print(f'Assembled {len(cases)} unchanged real images; browse index.html. No synthetic images generated.')
