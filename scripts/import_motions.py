"""AnimeVRM の collect_picks.py で集めた FBX と、motion-create の確認用の絵をサイトに取り込む。

使い方（絵の切り抜きに Pillow と numpy を使うので、motion-create の venv で動かす）:
  ~/git/practice/motion-create/.venv/bin/python scripts/import_motions.py <集めた FBX のフォルダ（index.json がある所）> <motion-create の変換の出力フォルダ>
書き出すもの:
  public/motions/<id>.fbx   モーション（呼吸の強さ 0.8 で混ぜたもの）
  public/thumbs/<id>.avif   一覧の絵（motion-create が描いたアオイの姿勢。ポーズ集の線画は再配布できないので使わない）
  src/motions.json          一覧
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent
picked = Path(sys.argv[1]).resolve()
converted = Path(sys.argv[2]).resolve()
motions_dir = root / 'public/motions'
thumbs_dir = root / 'public/thumbs'
motions_dir.mkdir(parents=True, exist_ok=True)
thumbs_dir.mkdir(parents=True, exist_ok=True)

THUMB = (320, 400)


def crop_figure(src: Path, dst: Path):
    """床と背景（明るい灰色）を除いた人物の範囲を、4:5 で余白を付けて切り抜く"""
    image = Image.open(src).convert('RGB')
    rgb = np.asarray(image).astype(np.int16)
    saturation = rgb.max(axis=2) - rgb.min(axis=2)
    mask = (saturation > 24) | (rgb.max(axis=2) < 120)
    ys, xs = np.nonzero(mask)
    left, right, top, bottom = xs.min(), xs.max(), ys.min(), ys.max()
    cx, cy = (left + right) / 2, (top + bottom) / 2
    height = max(bottom - top, (right - left) * THUMB[1] / THUMB[0]) * 1.15
    width = height * THUMB[0] / THUMB[1]
    box = (round(cx - width / 2), round(cy - height / 2), round(cx + width / 2), round(cy + height / 2))
    background = Image.new('RGB', image.size, tuple(int(v) for v in np.median(rgb[:8].reshape(-1, 3), axis=0)))
    canvas = Image.new('RGB', (box[2] - box[0], box[3] - box[1]), background.getpixel((0, 0)))
    canvas.paste(image, (-box[0], -box[1]))
    canvas.resize(THUMB, Image.LANCZOS).save(dst)


entries = []
with tempfile.TemporaryDirectory() as tmp:
    for item in json.loads((picked / 'index.json').read_text()):
        motion_id = Path(item['file']).stem.removeprefix('gallery_')
        shutil.copy2(picked / item['file'], motions_dir / f'{motion_id}.fbx')
        png = Path(tmp) / f'{motion_id}.png'
        crop_figure(converted / item['pose_id'] / 'avatar_preview.png', png)
        subprocess.run(['avifenc', '-s', '6', '-q', '85', png, thumbs_dir / f'{motion_id}.avif'],
                       check=True, capture_output=True)
        line, number = motion_id.split('_')
        entries.append({'id': motion_id, 'number': number, 'line': line,
                        'name': item['name'], 'category': item.get('category') or '上半身'})

(root / 'src/motions.json').write_text(json.dumps(entries, ensure_ascii=False, indent=1) + '\n')
print(f'{len(entries)} 本')
