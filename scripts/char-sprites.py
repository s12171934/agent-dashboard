#!/usr/bin/env python3
"""Cut a character mode sheet (4×2 poses on white, from char-gen.sh) into one WebP strip of 8 frames.

Drops the white backdrop (a flood from the cell edges, plus flat white gaps between the legs and inside the hair),
lines the frames up (a bust by its head), crops all 8 with one shared box so a pose keeps its place, and scales them
to 320 px (full) or 240 px (bust) high; also writes the pixel version <out>-px.png (66 / 98 px high). Prints {w, h, frames: [{top}]} — w × h per frame, top = where the head
starts as a share of h — which goes into CH_ART in frontend/app.js.
  scripts/char-sprites.py <sheet.png> <full|bust> <out.webp>
Needs Pillow, numpy and scipy.
"""
import sys, json
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

src, kind, out = sys.argv[1:4]
H = 320 if kind == 'full' else 240          # output frame height
im = Image.open(src).convert('RGB')
W0, H0 = im.size
cw, ch = W0 // 4, H0 // 2
cells = []
for r in range(2):
    for c in range(4):
        a = np.asarray(im.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))).astype(np.int16)
        white = (a.min(axis=2) > 232) & (np.ptp(a, axis=2) < 18)
        lab, _ = ndimage.label(white)
        # a bust is cut at the waist, so its shirt runs into the bottom edge: flood from the other three only
        rims = [lab[0], lab[:, 0], lab[:, -1]] + ([lab[-1]] if kind == 'full' else [])
        edge = set(np.unique(np.concatenate(rims))) - {0}
        bg = np.isin(lab, list(edge))
        # small enclosed white holes between arm and body etc. that are big are background too
        lab2, n2 = ndimage.label(white & ~bg)
        if n2:
            sizes = ndimage.sum(np.ones_like(lab2), lab2, range(1, n2 + 1))
            for i, s in enumerate(sizes, 1):
                if s > 300:
                    region = lab2 == i
                    # flat near-white enclosed region (a gap between legs or arm and body) -> background
                    v = a[region].astype(float)
                    cy = np.where(region)[0].mean() / region.shape[0]
                    # gaps between the legs and pockets inside the hair; not the middle, where a flat white shirt is
                    low = (cy > .45 or cy < .14) if kind == 'full' else cy < .4
                    if low and v.mean() > 244 and v.std() < 5: bg |= region
        alpha = (~bg).astype(np.uint8) * 255
        alpha = ndimage.binary_erosion(ndimage.binary_opening(alpha > 0, iterations=1), iterations=1)
        # keep only the biggest blobs (drop specks)
        lab3, n3 = ndimage.label(alpha)
        if n3:
            sizes = ndimage.sum(np.ones_like(lab3), lab3, range(1, n3 + 1))
            keep = [i + 1 for i, s in enumerate(sizes) if s > .03 * sizes.max()]  # drops specks and a neighbour's fingertips
            alpha = np.isin(lab3, keep)
        al = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(.7))
        rgba = Image.fromarray(a.astype(np.uint8)).convert('RGBA'); rgba.putalpha(al)
        cells.append(rgba)
if kind == 'bust':
    # the rows of a bust sheet sit at different heights: line every frame's head up with frame 0's. The head top is
    # the first row filled across the middle band (a raised hand or a peace sign is off to the side).
    def head(c):
        al = np.asarray(c)[:, :, 3] > 128
        b = al[:, int(cw * .4):int(cw * .6)]
        rows = np.where(b.sum(axis=1) > b.shape[1] * .3)[0]
        return rows[0] if len(rows) else 0
    h0 = head(cells[0])
    for i, c in enumerate(cells):
        dy = h0 - head(c)
        if dy:
            m = Image.new('RGBA', c.size, (0, 0, 0, 0)); m.paste(c, (0, dy)); cells[i] = m
boxes = [c.getbbox() for c in cells]
x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes); x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
pad = 4; x0 = max(0, x0 - pad); y0 = max(0, y0 - pad); x1 = min(cw, x1 + pad); y1 = min(ch, y1 + pad)
s = H / (y1 - y0); FW = round((x1 - x0) * s)
sheet = Image.new('RGBA', (FW * 8, H), (0, 0, 0, 0))
meta = {'w': FW, 'h': H, 'frames': []}
for i, c in enumerate(cells):
    f = c.crop((x0, y0, x1, y1)).resize((FW, H), Image.LANCZOS)
    sheet.paste(f, (i * FW, 0))
    al = np.asarray(f)[:, :, 3] > 128
    b = al[:, int(FW * .38):int(FW * .62)]  # the head's top, not a raised hand's
    ys = np.where(b.sum(axis=1) > b.shape[1] * .3)[0]
    meta['frames'].append({'top': round(ys[0] / H, 3)})
sheet.save(out, 'WEBP', quality=88, method=6)

# The pixel version (「AI 생성」 style): every frame shrunk onto a grid PH px high, one shared palette for all 8 frames
# (so a colour never flickers between poses), alpha cut hard, then a 1 px outline in a darkened copy of the colour it
# borders. Written next to the strip as <out>-px.png; the page shows it at 2× with image-rendering: pixelated.
PH = 66 if kind == 'bust' else 98
PW = int(FW * PH / H + .5)
small = Image.new('RGBA', (PW * 8, PH), (0, 0, 0, 0))
for i in range(8):
    f = sheet.crop((i * FW, 0, (i + 1) * FW, H)).filter(ImageFilter.UnsharpMask(2, 120, 2))
    # a plain box average washes out thin dark lines (eyes, lineart): mix in a darkest-of-neighbours copy
    box = f.resize((PW, PH), Image.BOX)
    dark = Image.fromarray(np.dstack([np.asarray(f)[:, :, :3], np.asarray(f)[:, :, 3]]).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).resize((PW, PH), Image.BOX)
    b, d = np.asarray(box).astype(float), np.asarray(dark).astype(float)
    w = np.clip((b[:, :, :3].mean(axis=2) - d[:, :, :3].mean(axis=2)) / 120, 0, 1)[:, :, None] * .3
    m = b.copy(); m[:, :, :3] = b[:, :, :3] * (1 - w) + d[:, :, :3] * w
    small.paste(Image.fromarray(m.astype(np.uint8)), (i * PW, 0))
a = np.asarray(small).copy()
solid = a[:, :, 3] > 110
rgb = Image.fromarray(a[:, :, :3])
pal = rgb.quantize(colors=40, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
q = np.asarray(pal.convert('RGB')).copy()
px = np.zeros_like(a); px[:, :, :3] = q; px[:, :, 3] = solid * 255
edge = ~solid & ndimage.binary_dilation(solid, structure=[[0, 1, 0], [1, 1, 1], [0, 1, 0]])
# frames sit side by side: no outline across a frame border
edge[:, [i * PW for i in range(1, 8)]] &= False
src = np.zeros_like(q)
for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
    sh = np.roll(np.roll(q * solid[:, :, None], dy, 0), dx, 1); m = np.roll(np.roll(solid, dy, 0), dx, 1)
    src = np.where((m & ~src.any(axis=2))[:, :, None], sh, src)
px[edge, :3] = (src[edge] * .3).astype(np.uint8); px[edge, 3] = 255
Image.fromarray(px).save(out.rsplit('.', 1)[0] + '-px.png', optimize=True)
meta['pw'], meta['ph'] = PW, PH
print(json.dumps(meta))
