"""Extract the user-provided GIF without altering its timing or transparency.
Run with the bundled Python/Pillow: python prepare.py /path/to/original.gif
"""
from pathlib import Path
from PIL import Image
import hashlib
import json
import sys

source = Path(sys.argv[1]).resolve()
target = Path(__file__).resolve().parents[4] / 'assets' / 'avatar'
target.mkdir(parents=True, exist_ok=True)
raw = source.read_bytes()
with Image.open(source) as image:
    if image.format != 'GIF' or image.n_frames < 2:
        raise ValueError('Expected the original animated GIF')
    frames, durations = [], []
    for index in range(image.n_frames):
        image.seek(index)
        frames.append(image.convert('RGBA').copy())
        durations.append(image.info.get('duration', 0))
    if durations[-1] < 2000 or any(t <= 0 or t > 500 for t in durations[:-1]):
        raise ValueError('Unexpected timing; review the animation before extraction')
    entries = []
    for index, frame in enumerate(frames):
        name = f'blink-{index:02d}.webp'
        frame.save(target / name, 'WEBP', lossless=True, method=6)
        entries.append({'file': name, 'durationMs': durations[index]})
    (target / 'original.gif').write_bytes(raw)
    manifest = {
        'source': 'original.gif', 'sha256': hashlib.sha256(raw).hexdigest(),
        'width': image.width, 'height': image.height,
        'idleFrame': len(frames) - 1, 'waitMinMs': 2000, 'waitMaxMs': 5000,
        'frames': entries,
    }
    (target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(manifest, ensure_ascii=False))
