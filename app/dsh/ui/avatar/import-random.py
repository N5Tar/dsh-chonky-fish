"""Copy supplied final PNG frames unchanged; read playback timing from matching GIFs.
Usage: python3 app/dsh/ui/avatar/import-random.py /path/to/Downloads
"""
from pathlib import Path
from PIL import Image
import hashlib
import io
import json
import sys
import zipfile

source = Path(sys.argv[1])
target = Path(__file__).resolve().parents[4] / 'assets/avatar/random'
specs = [('idle', 2, 4, 3), ('running', 2, 3, 2), ('waiting', 2, 3, 2),
         ('review', 2, 3, 2), ('waving', 1, 1, 2), ('jumping', 1, 1, 2), ('failed', 1, 1, 0.5)]
archives = []
for pattern in ['final-and-qa-5-*.zip', 'final-and-qa-6-*.zip']:
    matches = list(source.glob(pattern))
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one {pattern}')
    archives.append(zipfile.ZipFile(matches[0]))

def read(name):
    path = 'outputs/little-blue-whale/' + name
    for archive in archives:
        if path in archive.namelist():
            return archive.read(path)
    raise ValueError('Missing ' + path)

manifest = dict(width=192, height=208, idleFrame=0, playbackRate=0.5, waitMinMs=2000, waitMaxMs=5000, actions=[], frames=[])
for name, minimum, maximum, weight in specs:
    gif = Image.open(io.BytesIO(read(name + '.gif')))
    indices = []
    for i in range(gif.n_frames):
        gif.seek(i)
        duration = gif.info['duration']
        raw = read(f'frames/{name}/{i:02d}.png')
        image = Image.open(io.BytesIO(raw))
        if image.size != (192, 208) or image.mode != 'RGBA' or duration <= 0:
            raise ValueError('Unexpected frame ' + name)
        file = f'{name}/{i:02d}.png'
        indices.append(len(manifest['frames']))
        manifest['frames'].append(dict(file=file, durationMs=duration, sha256=hashlib.sha256(raw).hexdigest()))
        (target / name).mkdir(parents=True, exist_ok=True)
        (target / file).write_bytes(raw)
    manifest['actions'].append(dict(name=name, frames=indices, minLoops=minimum, maxLoops=maximum, weight=weight))
(target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
for archive in archives:
    archive.close()
print(f'Imported {len(manifest["frames"])} unchanged PNG frames, {len(specs)} actions into {target}')
