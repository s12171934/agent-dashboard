#!/usr/bin/env python3
"""Cut a character mode sheet (4×2 poses on white, from char-gen.sh) into one WebP strip of 8 frames.

Drops the white backdrop (a flood from the cell edges, plus flat white gaps between the legs and inside the hair),
lines the frames up (a bust by its head), crops all 8 with one shared box so a pose keeps its place, and scales them
to 320 px (full) or 240 px (bust) high (the Live2D pictures). Prints {w, h, frames: [{top}]} — w × h per frame, top = where the head
starts as a share of h — which goes into CH_ART in frontend/app.js. An sd sheet (SD chibi pixel art, 「AI 생성」) is
snapped to an 80-row pixel grid and written as <out> itself (a .png), with {pw, ph} instead of {w, h}.
  scripts/char-sprites.py <sheet.png> <full|bust|sd> <out.webp|out.png>
Needs Pillow, numpy and scipy.
"""
import sys, json
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

src, kind, out = sys.argv[1:4]
SD_H = 80  # an SD sprite's height in pixels
H = 320 if kind == 'full' else 240  # output frame height
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
        rims = [lab[0], lab[:, 0], lab[:, -1]] + ([lab[-1]] if kind != 'bust' else [])
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
                    low = {'full': cy > .45 or cy < .14, 'sd': cy > .7 or cy < .1}.get(kind, cy < .4)  # an SD body starts lower
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
if kind == 'sd':
    # SD pixel art: the generator draws on a rough grid of ~5-7 px blocks that is not exact, and not the same for every
    # character. Lay one SD_H-row grid over the shared box (so every character stands the same height), then give each
    # block its most common colour (a mode, not an average, so a 1-block eye or highlight survives) from a 64-colour
    # palette of the whole sheet.
    full = Image.new('RGBA', (cw * 8, ch)); [full.paste(c, (i * cw, 0)) for i, c in enumerate(cells)]
    bs = (y1 - y0) / SD_H
    pal = full.convert('RGB').quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    qi = np.asarray(pal); cols = np.asarray(pal.getpalette()[:64 * 3]).reshape(-1, 3)
    al = np.asarray(full)[:, :, 3] > 128
    PH = int((y1 - y0) / bs + .5); PW = int((x1 - x0) / bs + .5)
    px = np.zeros((PH, PW * 8, 4), np.uint8)
    for i in range(8):
        for j in range(PH):
            ys = slice(y0 + int(j * bs), y0 + max(int((j + 1) * bs), int(j * bs) + 1))
            for k in range(PW):
                xs = slice(i * cw + x0 + int(k * bs), i * cw + x0 + max(int((k + 1) * bs), int(k * bs) + 1))
                m = al[ys, xs]
                if m.mean() < .5: continue
                v = np.bincount(qi[ys, xs][m], minlength=64).argmax()
                px[j, i * PW + k] = (*cols[v], 255)
    Image.fromarray(px).save(out, optimize=True)
    meta = {'pw': PW, 'ph': PH, 'frames': []}
    for i in range(8):
        a = px[:, i * PW:(i + 1) * PW, 3] > 0
        b = a[:, int(PW * .38):int(PW * .62)]
        meta['frames'].append({'top': round(int(np.where(b.sum(axis=1) > b.shape[1] * .3)[0][0]) / PH, 3)})
    print(json.dumps(meta))
    sys.exit()
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

print(json.dumps(meta))
