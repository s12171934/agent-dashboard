#!/usr/bin/env python3
"""Rebuild one of the template person's SD sheets (default hina), the proportion template every other SD character
copies (char-gen.sh sd, SD_TPL), from the strip in frontend/chars: set a–d's 8 frames (a 32-frame strip holds the four
in order) blown up with square pixels into a 1536×1024 4×2 grid on white, as the sheet was drawn.

    scripts/char-sd-template.py <out.png> [a|b|c|d] [who]
"""
import os
import sys
from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
who = sys.argv[3] if len(sys.argv) > 3 else 'hina'
strip = Image.open(os.path.join(ROOT, f'frontend/chars/{who}-sd.png')).convert('RGBA')
n = 32 if strip.width / 8 / strip.height > 1.6 else 8  # a person's frame is never that much wider than high
fw, fh = strip.width // n, strip.height
k = 'abcd'.index(sys.argv[2] if len(sys.argv) > 2 else 'a') * 8
if k >= n:
    sys.exit(f'{who}-sd.png 은 세트 A 8장뿐입니다 — {who} 의 SD 를 먼저 4세트로 다시 그리세요')
CW, CH, S = 384, 512, 5  # cell size, and how many sheet pixels one sprite pixel takes (about the generator's own grid)
sheet = Image.new('RGBA', (CW * 4, CH * 2), (255, 255, 255, 255))
for i in range(8):
    f = strip.crop(((k + i) * fw, 0, (k + i + 1) * fw, fh)).resize((fw * S, fh * S), Image.NEAREST)
    x, y = (i % 4) * CW + (CW - f.width) // 2, (i // 4) * CH + CH - f.height - 40  # feet on one baseline
    sheet.alpha_composite(f, (x, y))
sheet.convert('RGB').save(sys.argv[1])
