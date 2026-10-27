#!/usr/bin/env python3
"""Put a character online without a deploy: uploads its four strips to the R2 bucket agent-dashboard-chars and lists it
in chars/chars.json there, which the page reads through functions/chars (open tabs pick it up on their next load).

    scripts/char-publish.py <who> --name 미오 --look '빨간 단발 · 노란 우비' [--boss] [--dir <folder>]
    scripts/char-publish.py <who> --remove
    scripts/char-publish.py <who> --restore
    scripts/char-publish.py --list

<who> is the file name (a-z, 0-9, -); its strips hold 8 frames or 32 (four sets of the 8 poses), all four alike. --dir holds <who>-full.webp, <who>-bust.webp, <who>-sd.png and <who>-sd-bust.png
as scripts/char-gen.sh leaves them (default: the current folder). The frame sizes and head tops (CH_ART) are measured
from the strips the way char-sprites.py does. --boss puts them with the coordinators (headset), otherwise with the
workers. A built-in name (aoi …) replaces that person's pictures. --dry-run prints chars.json instead of uploading.
--remove on a built-in person (they live in the deploy) lists them under hidden in chars.json, so every page leaves them
out; --restore (or putting them up again) takes them off it. Neither list may be emptied: one coordinator and one
worker always stay.
Each entry carries v (when it was put up), which the page adds to the picture URLs so a redrawn person shows at once,
and the folder gets a .published stamp (the 「캐릭터」 tab's job list reads it).
Needs `npx wrangler login` once, and Pillow with numpy (run it with "$(scripts/char-python.sh)").
"""
import argparse, glob, json, os, re, shutil, subprocess, sys, tempfile, time
import numpy as np
from PIL import Image

BUCKET = 'agent-dashboard-chars'
if not shutil.which('npx'):  # started by launchd (the metric server's 「삭제」), nvm's node is not on PATH: take the newest
    nvm = sorted(glob.glob(os.path.expanduser('~/.nvm/versions/node/v*/bin')),
                 key=lambda d: [int(x) for x in re.findall(r'\d+', d.split('/node/')[1])])
    if nvm:
        os.environ['PATH'] = nvm[-1] + os.pathsep + os.environ.get('PATH', '')
WRANGLER = ['npx', '--yes', 'wrangler@' + os.environ.get('WRANGLER_VERSION', '4.151.3')]
BUILTIN = {'kaede': True, 'yuki': True, 'aoi': False, 'ren': False, 'hina': False, 'sora': False}  # who: boss
FILES = {'full': '{}-full.webp', 'bust': '{}-bust.webp', 'sd': '{}-sd.png', 'sdb': '{}-sd-bust.png'}


def r2(*args, **kw):
    return subprocess.run(WRANGLER + ['r2', 'object', *args, '--remote'], check=True, **kw)


def measure(path, pixel):
    """{w, h} (or {pw, ph} for an SD pixel strip) per frame and each frame's head top as a share of h."""
    a = np.asarray(Image.open(path).convert('RGBA'))[:, :, 3]
    H, W = a.shape
    n = 32 if W / 8 / H > 1.6 else 8  # 4 sets of 8 poses, or one: a person's frame is never that much wider than high
    if W % n:
        sys.exit(f'{path}: 너비 {W} 가 프레임 {n}개로 나뉘지 않습니다')
    fw, top = W // n, []
    for i in range(n):
        b = (a[:, i * fw:(i + 1) * fw] > (0 if pixel else 128))[:, int(fw * .38):int(fw * .62)]  # the head, not a raised hand
        ys = np.where(b.sum(axis=1) > b.shape[1] * .3)[0]
        top.append(round(int(ys[0]) / H, 3) if len(ys) else 0)
    return {'pw': fw, 'ph': H, 'top': top} if pixel else {'w': fw, 'h': H, 'top': top}


def manifest():
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, 'chars.json')
        try:
            r2('get', f'{BUCKET}/chars/chars.json', '--file', f, capture_output=True, text=True)
        except subprocess.CalledProcessError as e:
            if 'key does not exist' in e.stdout + e.stderr:
                return {'chars': {}}  # nothing published yet
            sys.exit('chars.json 을 읽지 못했습니다 (npx wrangler login?)\n' + e.stdout + e.stderr)
        with open(f) as fh:
            return json.load(fh)


def put_manifest(m):
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
        json.dump(m, fh, ensure_ascii=False, indent=1)
    try:
        r2('put', f'{BUCKET}/chars/chars.json', '--file', fh.name, '--content-type', 'application/json; charset=utf-8')
    finally:
        os.unlink(fh.name)


ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
ap.add_argument('who', nargs='?')
ap.add_argument('--name'); ap.add_argument('--look', default='')
ap.add_argument('--boss', action='store_true')
ap.add_argument('--dir', default='.')
ap.add_argument('--remove', action='store_true'); ap.add_argument('--restore', action='store_true')
ap.add_argument('--list', action='store_true')
ap.add_argument('--dry-run', action='store_true')
o = ap.parse_args()

if o.list:
    m = manifest()
    for who, c in m['chars'].items():
        print(f"{who}\t{c.get('name', '')}\t{'코디네이터' if c.get('boss') else '워커'}\t{c.get('look', '')}")
    for who in m.get('hidden', []):
        print(f"{who}\t(기본 캐릭터, 삭제됨)")
    sys.exit()
if not o.who or not re.fullmatch(r'[a-z0-9-]+', o.who):
    ap.error('<who> 는 영문 소문자·숫자·- 로 된 이름이어야 합니다')
m = manifest()
hidden = m.setdefault('hidden', [])
if o.restore:
    if o.who not in hidden:
        sys.exit(f'{o.who}: 삭제한 기본 캐릭터가 아닙니다')
    hidden.remove(o.who)
    put_manifest(m)
    print(f'{o.who} 를 되살렸습니다')
    sys.exit()
if o.remove:
    builtin = o.who in BUILTIN and o.who not in hidden
    c = m['chars'].pop(o.who, None)
    if c is None and not builtin:
        sys.exit(f'{o.who}: chars.json 에 없습니다')
    left = {w: b for w, b in BUILTIN.items() if w not in hidden and w != o.who}
    left.update({w: bool(x.get('boss')) for w, x in m['chars'].items()})
    boss = c.get('boss') if c and o.who not in BUILTIN else BUILTIN.get(o.who)
    if boss not in left.values():
        sys.exit(f"{o.who}: 마지막 {'코디네이터' if boss else '워커'}는 삭제할 수 없습니다")
    if builtin:
        hidden.append(o.who)
    put_manifest(m)
    if c is not None:
        for f in FILES.values():
            r2('delete', f'{BUCKET}/chars/' + f.format(o.who))
    print(f'{o.who} 를 내렸습니다')
    sys.exit()

paths = {k: os.path.join(o.dir, f.format(o.who)) for k, f in FILES.items()}
missing = [p for p in paths.values() if not os.path.exists(p)]
if missing:
    sys.exit('없는 파일: ' + ', '.join(missing))
art = {k: measure(p, k in ('sd', 'sdb')) for k, p in paths.items()}
if len({len(a['top']) for a in art.values()}) > 1:
    sys.exit('네 스트립의 프레임 수가 다릅니다: ' + ', '.join(f"{k} {len(a['top'])}" for k, a in art.items()))
if o.who in hidden:
    hidden.remove(o.who)
m['chars'][o.who] = {'name': o.name or o.who, 'look': o.look, 'boss': o.boss, 'v': int(time.time()), 'art': art}
if o.dry_run:
    print(json.dumps(m, ensure_ascii=False, indent=1))
    sys.exit()
for k, p in paths.items():
    r2('put', f'{BUCKET}/chars/' + FILES[k].format(o.who), '--file', p,
       '--content-type', 'image/webp' if p.endswith('.webp') else 'image/png')
put_manifest(m)  # last, so the page never lists someone whose pictures are not there yet
with open(os.path.join(o.dir, '.published'), 'w') as fh:
    json.dump({'who': o.who, 'at': m['chars'][o.who]['v']}, fh)
print(f'{o.who} 를 올렸습니다 — 열린 탭은 다음에 열 때 보입니다')
