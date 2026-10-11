"""Render synthetic visual regression fixtures; outputs stay outside Git.

Requires Pillow. Usage: python3 render.py OUTPUT_DIRECTORY [FONT_PATH]
The default font search supports the current Mac and Windows font locations.
"""
import json
import os
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('destination', type=Path)
parser.add_argument('font', nargs='?', type=Path)
parser.add_argument('--cases', type=Path, default=Path(__file__).with_name('cases.json'))
args = parser.parse_args()
destination = args.destination.resolve()
destination.mkdir(parents=True, exist_ok=True, mode=0o700)
fonts = ([args.font] if args.font else [
    Path('/System/Library/Fonts/Hiragino Sans GB.ttc'),
    Path('/System/Library/Fonts/STHeiti Light.ttc'),
    Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts/msyh.ttc',
])
font_path = next((p for p in fonts if p.is_file()), None)
if font_path is None:
    raise SystemExit('Supply an installed CJK font path as the second argument.')
font = ImageFont.truetype(str(font_path), 34)
heading = ImageFont.truetype(str(font_path), 43)
corpus = json.loads(args.cases.read_text(encoding='utf-8'))
for case in corpus['cases']:
    lines = []
    scratch = ImageDraw.Draw(Image.new('RGB', (1100, 100)))
    for text in case['lines']:
        current = ''
        for character in text:
            if scratch.textlength(current + character, font=font) > 980:
                lines.append(current)
                current = ''
            current += character
        lines.append(current)
    image = Image.new('RGB', (1100, max(650, 210 + 65 * len(lines))), '#fcfbf7')
    draw = ImageDraw.Draw(image)
    draw.text((55, 45), case['title'], font=heading, fill='#18212b')
    draw.line((55, 120, 1045, 120), fill='#717782', width=2)
    for n, line in enumerate(lines):
        draw.text((55, 155 + n * 65), line, font=font, fill='#18212b')
    path = destination / (case['id'] + '.png')
    image.save(path)
    path.chmod(0o600)
    case.update(group='semantic-image', message='', image='/image-cases/' + path.name)
    del case['title'], case['lines']
path = destination / 'cases.json'
path.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
path.chmod(0o600)
print(f'Rendered {len(corpus["cases"])} synthetic receipt fixtures.')
