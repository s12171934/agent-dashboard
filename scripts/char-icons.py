#!/usr/bin/env python3
"""Make a character's app icon for the 「앱 아이콘」 panel: their drawn icon art (<who>-icon-art.webp, 1024px, from
scripts/char-icon-art.sh) when they have one, else their SD face (the standing frame of <who>-sd-bust.png, from the top
of the head down to the chin) as crisp pixel art on a field in their own colour.

    scripts/char-icons.py <who> [<who> …] [--dir <folder>] [--out <folder>]

Writes, next to the strips, <who>-icon-192.png, <who>-icon-512.png, <who>-icon-maskable-512.png (the face inside the
central 80% circle that maskable icons keep), <who>-icon-180.png (apple-touch-icon) and <who>-icon.json, the manifest
icon-boot.js points at when that face is picked. Built-in people keep theirs in frontend/chars (the default for both
folders); scripts/char-publish.py makes and uploads them for people put up without a deploy.
Needs Pillow with numpy (run it with "$(scripts/char-python.sh)").
"""
import argparse, colorsys, json, pathlib, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHARS = ROOT / 'frontend' / 'chars'
SIZES = {'192': (192, .84), '512': (512, .84), 'maskable-512': (512, .64), '180': (180, .84)}  # name: (px, face share)
FILES = [f'icon-{k}.png' for k in SIZES] + ['icon.json']


def face(strip):
    """The standing frame's head as an RGBA crop (square, the face centred), and the frame's own pixels."""
    im = Image.open(strip).convert('RGBA')
    a = np.asarray(im)
    H, W = a.shape[:2]
    n = 32 if W / 8 / H > 1.6 else 8
    fw = W // n
    fr = a[:, :fw]
    on = fr[:, :, 3] > 0
    rows = np.where(on.any(axis=1))[0]
    top = int(rows[0])
    # the head: from its top, as high as the head is wide at its widest within the upper 55% of the bust
    side = 0
    for y in range(top, top + int((H - top) * .55)):
        xs = np.where(on[y])[0]
        if len(xs):
            side = max(side, int(xs[-1] - xs[0] + 1))
    side = min(max(side, 8), H - top)
    cols = np.where(on[top:top + side].any(axis=0))[0]
    cx = (int(cols[0]) + int(cols[-1]) + 1) / 2
    x0 = int(round(cx - side / 2))
    box = np.zeros((side, side, 4), np.uint8)
    sx0, sx1 = max(x0, 0), min(x0 + side, fw)
    box[:, sx0 - x0:sx1 - x0] = fr[top:top + side, sx0:sx1]
    return Image.fromarray(box), fr


def tint(fr):
    """The character's own colour: the most common saturated hue among their pixels, skin left out (hair or clothes,
    mostly), as hue and saturation 0–1."""
    px = fr[fr[:, :, 3] > 0][:, :3] / 255
    hsv = np.array([colorsys.rgb_to_hsv(*p) for p in px])
    skin = (hsv[:, 0] > .02) & (hsv[:, 0] < .12) & (hsv[:, 1] < .55) & (hsv[:, 2] > .65)
    sat = hsv[(hsv[:, 1] > .25) & (hsv[:, 2] > .2) & ~skin]
    if len(sat) < 20:  # grey, white or black people (nova): a cool slate
        return .58, .25
    hist, edges = np.histogram(sat[:, 0], bins=24, range=(0, 1))
    i = int(hist.argmax())
    return (edges[i] + edges[i + 1]) / 2, float(np.median(sat[(sat[:, 0] >= edges[i]) & (sat[:, 0] < edges[i + 1]), 1]))


def field(size, hue, sat):
    """A soft diagonal gradient in the character's hue, deep enough that a light face reads on it, with a glow behind."""
    s = min(max(sat, .3), .75)
    c0 = np.array(colorsys.hsv_to_rgb(hue, s, .32)) * 255
    c1 = np.array(colorsys.hsv_to_rgb((hue + .06) % 1, s * .85, .62)) * 255
    t = (np.add.outer(np.arange(size), np.arange(size)) / (2 * size - 2))[:, :, None]
    bg = Image.fromarray(np.uint8(c0 * (1 - t) + c1 * t)).convert('RGBA')
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    r = size * .36
    ImageDraw.Draw(glow).ellipse([size / 2 - r, size * .52 - r, size / 2 + r, size * .52 + r], fill=(255, 255, 255, 70))
    return Image.alpha_composite(bg, glow.filter(ImageFilter.GaussianBlur(size * .1)))


def icon(head, size, share, hue, sat):
    k = max(1, int(size * share / head.width))  # a whole multiple: every sprite pixel a crisp block
    big = head.resize((head.width * k, head.height * k), Image.NEAREST)
    out = field(size, hue, sat)
    shadow = Image.new('RGBA', big.size, (0, 0, 0, 0))
    shadow.putalpha(big.getchannel('A').point(lambda v: 90 if v else 0))
    x, y = (size - big.width) // 2, (size - big.height) // 2 + int(size * .03)
    out.alpha_composite(shadow, (x + k, y + k))
    out.alpha_composite(big, (x, y))
    return out.convert('RGB')


def manifest(who):
    icons = [(f'{who}-icon-192.png', '192x192', 'any'), (f'{who}-icon-512.png', '512x512', 'any'),
             (f'{who}-icon-maskable-512.png', '512x512', 'maskable')]
    return {
        'id': '../', 'name': 'Agent Dashboard', 'short_name': 'Agents',
        'description': 'Claude Code·Codex 에이전트 세션과 Orca Run 을 실시간으로 보는 대시보드',
        'lang': 'ko', 'start_url': '../', 'scope': '../', 'display': 'standalone',
        'background_color': '#0f1215', 'theme_color': '#0f1215',
        'icons': [dict(src=s, sizes=z, type='image/png', purpose=p) for s, z, p in icons],
    }


def make(who, src, out):
    art = src / f'{who}-icon-art.webp'
    if art.exists():
        # drawn full-bleed with the head inside the central circle, so the maskable one is the same picture
        im = Image.open(art).convert('RGB')
        out.mkdir(parents=True, exist_ok=True)
        for name, (size, _) in SIZES.items():
            im.resize((size, size), Image.LANCZOS).save(out / f'{who}-icon-{name}.png', optimize=True)
        (out / f'{who}-icon.json').write_text(json.dumps(manifest(who), ensure_ascii=False, indent=2) + '\n')
        return [out / f'{who}-{f}' for f in FILES]
    strip = src / f'{who}-sd-bust.png'
    if not strip.exists():
        sys.exit(f'{strip} 이 없습니다')
    head, fr = face(strip)
    hue, sat = tint(fr)
    out.mkdir(parents=True, exist_ok=True)
    for name, (size, share) in SIZES.items():
        icon(head, size, share, hue, sat).save(out / f'{who}-icon-{name}.png', optimize=True)
    (out / f'{who}-icon.json').write_text(json.dumps(manifest(who), ensure_ascii=False, indent=2) + '\n')
    return [out / f'{who}-{f}' for f in FILES]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('who', nargs='+')
    ap.add_argument('--dir', type=pathlib.Path, default=CHARS, help='where <who>-sd-bust.png is')
    ap.add_argument('--out', type=pathlib.Path, help='where the icons go (default: --dir)')
    a = ap.parse_args()
    for who in a.who:
        make(who, a.dir, a.out or a.dir)
        print(who)


if __name__ == '__main__':
    main()
