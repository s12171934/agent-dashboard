#!/usr/bin/env python3
"""Cut a character mode sheet (4×2 poses on white, from char-gen.sh) into one WebP strip of 8 frames.

Drops the white backdrop (a flood from the cell edges, plus flat white gaps between the legs and inside the hair),
lines the frames up (a bust by its head), crops all 8 with one shared box so a pose keeps its place, and scales them
to 320 px (full) or 240 px (bust) high (the Live2D pictures). Prints {w, h, frames: [{top}]} — w × h per frame, top = where the head
starts as a share of h — which goes into CH_ART in frontend/app.js. An sd sheet (SD chibi pixel art, 「AI 생성」) is
snapped to a pixel grid (standing pose 80 rows high) and written as <out> itself (a .png), with {pw, ph} instead of {w, h},
and its bust (head to waist, on a finer grid) as <out>-bust.png ({bust: {pw, ph, frames}}).
  scripts/char-sprites.py <sheet.png> <full|bust|sd> <out.webp|out.png>
Needs Pillow, numpy and scipy.
"""
import sys, json
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

src, kind, out = sys.argv[1:4]
SD_BODY = 80  # an SD sprite's standing height (frame 0, head to feet) in pixels, about the generator's own grid
SD_MERGE = 30  # colours of a sheet closer than this (summed over R, G, B) become one
SD_CUT, SD_BUST = .75, 80  # an SD bust: the top 75 % of the standing height, that part 80 rows high
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
                    low = {'full': cy > .45 or cy < .14, 'sd': cy < .1}.get(kind, cy < .4)  # an SD's short legs leave no gap, but white socks
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
if kind == 'sd':
    # the rows of an SD sheet sit at different heights too: stand every frame on frame 0's feet
    f0 = cells[0].getbbox()[3]
    for i, c in enumerate(cells):
        dy = f0 - c.getbbox()[3]
        if dy:
            m = Image.new('RGBA', c.size, (0, 0, 0, 0)); m.paste(c, (0, dy)); cells[i] = m
boxes = [c.getbbox() for c in cells]
x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes); x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
pad = 4; x0 = max(0, x0 - pad); y0 = max(0, y0 - pad); x1 = min(cw, x1 + pad); y1 = min(ch, y1 + pad)
if kind == 'sd':
    # SD pixel art: the generator draws on a rough grid of ~4-7 px blocks that is not exact, and not the same for every
    # character. Size the grid so the standing pose (frame 0, head to feet) is SD_BODY rows — every character the same
    # height, whatever a raised hand or a ponytail adds to the box; SD_BODY is about the generator's own resolution, so
    # a 1-block highlight or stripe still gets a pixel — then give each block its most common colour (a mode over
    # coarse colour bins, not an average, so a 1-block eye or highlight survives), drawn as the median of its pixels in
    # that bin: no shared palette, which would give its colours to the big hair and jacket and lose a small hair clip or
    # the eyes' own colour. The mode is taken over the block's core: an edge of the block may already be the
    # neighbour's colour, the grids not lining up exactly. Near colours are merged across the sheet afterwards.
    full = Image.new('RGBA', (cw * 8, ch)); [full.paste(c, (i * cw, 0)) for i, c in enumerate(cells)]
    b0 = cells[0].getbbox(); bs = (b0[3] - b0[1]) / SD_BODY
    rgb = np.asarray(full)[:, :, :3]; al = np.asarray(full)[:, :, 3] > 128
    qi = (rgb[..., 0] >> 5).astype(np.int32) << 6 | (rgb[..., 1] >> 5).astype(np.int32) << 3 | rgb[..., 2] >> 5  # 8 levels a channel
    dark = (np.stack([np.arange(512) >> 6, np.arange(512) >> 3 & 7, np.arange(512) & 7], 1) * 32 + 16).mean(axis=1) < 70

    def pixel(bs, yb, path, cut):
        """the box from y0 down to yb in bs-px blocks, written to path; cut: the bottom edge is a cut (a bust), not an outline"""
        PH = int((yb - y0) / bs + .5); PW = int((x1 - x0) / bs + .5)
        core = lambda o, n: slice(o + int((n + .2) * bs), o + max(int((n + .8) * bs), int((n + .2) * bs) + 1))
        px = np.zeros((PH, PW * 8, 4), np.uint8)
        for i in range(8):
            for j in range(PH):
                ys = slice(y0 + int(j * bs), y0 + max(int((j + 1) * bs), int(j * bs) + 1))
                for k in range(PW):
                    xs = slice(i * cw + x0 + int(k * bs), i * cw + x0 + max(int((k + 1) * bs), int(k * bs) + 1))
                    m = al[ys, xs]
                    if not m.size or m.mean() < .5: continue
                    cy, cx = core(y0, j), core(i * cw + x0, k)
                    m = al[cy, cx]
                    if not m.any(): cy, cx, m = ys, xs, al[ys, xs]
                    q = qi[cy, cx][m]; cnt = np.bincount(q, minlength=512)
                    # a dark colour (lineart, an eye) that covers a good part of the block wins over the mode
                    dk = np.where(dark, cnt, 0)
                    v = dk.argmax() if dk.max() >= .35 * m.sum() else cnt.argmax()
                    px[j, i * PW + k] = (*np.median(rgb[cy, cx][m][q == v], axis=0).astype(np.uint8), 255)
        # merge near colours, the commonest first, so one shade of the hair stays one colour in every frame
        o = px[:, :, 3] > 0
        u, inv, n = np.unique(px[o][:, :3], axis=0, return_inverse=True, return_counts=True)
        u = u.astype(int); to = np.arange(len(u)); keep = []
        for c in np.argsort(-n):
            d = np.abs(u[keep] - u[c]).sum(axis=1) if keep else np.array([SD_MERGE])
            if d.min() < SD_MERGE: to[c] = keep[d.argmin()]
            else: keep.append(c)
        px[o, :3] = u[to[inv.ravel()]]
        # drop stray pixels: an opaque pixel with at most one opaque neighbour is noise from the backdrop's edge
        for _ in range(2):
            o = px[:, :, 3] > 0
            nb = sum(np.roll(o, sh, ax) for sh, ax in ((1, 0), (-1, 0), (1, 1), (-1, 1)))
            px[o & (nb <= 1)] = 0
        # a clean 1 px outline: every pixel on the silhouette's edge becomes a dark shade of its own colour (this also
        # hides the backdrop's whitish fringe)
        o = px[:, :, 3] > 0
        inner = o & np.roll(o, 1, 0) & np.roll(o, -1, 0) & np.roll(o, 1, 1) & np.roll(o, -1, 1)
        rim = o & ~inner & (px[:, :, :3].mean(axis=2) >= 70)  # already dark: the generator's own outline
        if cut: rim[-1] = o[-1] & ~(np.roll(o[-1], 1) & np.roll(o[-1], -1))
        px[rim, :3] = (px[rim, :3] * .3).astype(np.uint8)
        Image.fromarray(px).save(path, optimize=True)
        meta = {'pw': PW, 'ph': PH, 'frames': []}
        for i in range(8):
            a = px[:, i * PW:(i + 1) * PW, 3] > 0
            b = a[:, int(PW * .38):int(PW * .62)]
            meta['frames'].append({'top': round(int(np.where(b.sum(axis=1) > b.shape[1] * .3)[0][0]) / PH, 3)})
        return meta

    meta = pixel(bs, y1, out, False)
    # the bust: from the head down to just below the waist (SD_CUT of the standing height), on a finer grid so the
    # face gets more pixels — written next to it as <out>-bust.png
    yb = b0[1] + SD_CUT * (b0[3] - b0[1])
    meta['bust'] = pixel((yb - b0[1]) / SD_BUST, yb, out.rsplit('.', 1)[0] + '-bust.png', True)
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
