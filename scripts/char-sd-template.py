#!/usr/bin/env python3
"""Rebuild aoi's SD sheet, the proportion template every other SD character copies (char-gen.sh sd), from the strip
in frontend/chars: the 8 frames blown up with square pixels into a 1536×1024 4×2 grid on white, as the sheet was drawn.

    scripts/char-sd-template.py <out.png>
"""
import os
import sys
from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
strip = Image.open(os.path.join(ROOT, 'frontend/chars/aoi-sd.png')).convert('RGBA')
fw, fh = strip.width // 8, strip.height
CW, CH, S = 384, 512, 5  # cell size, and how many sheet pixels one sprite pixel takes (about the generator's own grid)
sheet = Image.new('RGBA', (CW * 4, CH * 2), (255, 255, 255, 255))
for i in range(8):
    f = strip.crop((i * fw, 0, (i + 1) * fw, fh)).resize((fw * S, fh * S), Image.NEAREST)
    x, y = (i % 4) * CW + (CW - f.width) // 2, (i // 4) * CH + CH - f.height - 40  # feet on one baseline
    sheet.alpha_composite(f, (x, y))
sheet.convert('RGB').save(sys.argv[1])
