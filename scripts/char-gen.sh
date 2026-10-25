#!/bin/zsh
# Generate a character mode sheet with Codex's built-in image generation (an original anime-style character, 4×2 poses
# on white), then cut it into frontend/chars/<name>-<kind>.webp with char-sprites.py.
#   scripts/char-gen.sh <name> <full|bust|sd> [work dir]
# bust and sd (the chibi pixel sheet) take the full sheet as their reference, so make full first. Each call takes about 10 minutes; several run
# side by side. The frame sizes char-sprites.py prints go into CH_ART in frontend/app.js.
# Needs `codex` logged in, and Python with Pillow, numpy and scipy for the cut (PYTHON, default python3).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
name=$1; kind=$2; work=${3:-$PWD}
typeset -A CHARS
CHARS=(
  aoi   'young woman office engineer, short teal bob hair with side bangs, amber eyes, oversized cream hoodie over white t-shirt, dark navy pleated skirt, black tights, white sneakers, small gold hair clip'
  ren   'young man programmer, messy black hair, round thin glasses, gray eyes, navy blue cardigan over white collared shirt, gray slacks, brown loafers'
  hina  'young woman designer, long pinkish-brown hair in a high ponytail with a red ribbon, green eyes, white blouse with beige knit vest, red plaid skirt, white socks, brown loafers'
  sora  'cheerful young man, spiky orange hair, blue eyes, olive green bomber jacket over black t-shirt, beige cargo pants, red sneakers'
  kaede 'team leader woman, long straight black hair, violet eyes, black wireless gaming headset with a small boom microphone worn on her head, dark charcoal blazer over white shirt, black slacks, low black heels'
  yuki  'team leader young man, neat silver hair, light blue eyes, black wireless gaming headset with a small boom microphone worn on his head, light blue shirt with sleeves rolled up and loosened navy tie, black trousers, black shoes'
)
desc=${CHARS[$name]}
cd "$work"
style='modern Japanese anime style (clean cel shading, crisp dark lineart, TV-anime look)'
if [ "$kind" = full ]; then
  frame='FULL BODY from head to shoes, standing, facing the viewer, same scale, centered, feet on the same baseline, nothing cropped'; ref=()
elif [ "$kind" = sd ]; then
  # 「AI 생성」: a super-deformed (chibi) pixel art version of the full sheet
  style='SD (super deformed) chibi pixel art: a 16-bit game sprite look with big clearly visible square pixels, a limited palette, a 1-pixel dark outline, no anti-aliasing, no gradients'
  # every SD character is drawn to one body: aoi's sheet is the proportion template for the others
  frame="FULL BODY SD chibi exactly 2 heads tall (the head is 50% of the total height, big expressive eyes, short round body and short legs), standing, facing the viewer, same scale, centered, feet on the same baseline, nothing cropped, each character about 48 pixel-art pixels tall (chunky pixels); the attached image is the reference for the character's exact design (hair, eyes, clothes, colours)"
  ref=(-i "${name}_full.png")
  if [ "$name" != aoi ]; then
    frame="FULL BODY SD chibi, standing, facing the viewer, centered, feet on the same baseline, nothing cropped, chunky pixels as big as the template's. TWO attached images: the FIRST is the proportion template — copy its body exactly: the same head size, the same total height in pixels, the same 2-heads-tall proportions, the same width of shoulders and length of arms and legs, the same placement in each cell and the same pose for each of the 8 cells. The SECOND is the reference for this character's design (hair, eyes, clothes, colours, accessories) — use it only for the design, never for proportions. Long hair or a ponytail may extend beyond the template's outline, but the head, body and legs must match the template"
    ref=(-i aoi_sd.png -i "${name}_full.png")
  fi
else
  frame="UPPER BODY portrait from the top of the head down to the waist (bust shot), facing the viewer, same scale, head at the same height in every cell, centered, nothing cropped at the top or sides; the attached image is the reference for the character's exact design"
  ref=(-i "${name}_full.png")
fi
cat > "p_${name}_${kind}.txt" <<P
Use your built-in image generation tool to create ONE image and save it as PNG at ./${name}_${kind}.png (in the current directory). Do nothing else; do not write code.

Image: a character sprite sheet in ${style}, original character (not an existing IP).
Character: ${desc}.
Layout: 1536x1024 landscape, a 4 columns x 2 rows grid of equal cells, plain flat pure white background (#FFFFFF) everywhere, no grid lines, no text, no floor shadows. In every cell the SAME character, ${frame}.
Cells (left to right, top row then bottom row):
1. calm neutral standing, arms relaxed, slight smile, eyes open
2. holding an open laptop on one forearm and typing on it with the other hand, focused eyes looking down at it
3. holding a coffee mug with both hands, relaxed content smile
4. worried: both hands on head, big sweat drop, troubled eyebrows, wavy mouth
5. sleepy dozing while standing, eyes closed, head tilted, drooping shoulders
6. very happy, eyes closed in a smile, making a peace sign
7. raising one hand high like asking a question, surprised round mouth, eyes wide
8. exactly the same pose and framing as cell 1 but with eyes closed (blink)
P
# the prompt goes in on stdin: --image takes every argument after it
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C . $ref < "p_${name}_${kind}.txt" > "log_${name}_${kind}.txt" 2>&1
"${PYTHON:-python3}" "$ROOT/scripts/char-sprites.py" "${name}_${kind}.png" "$kind" "$ROOT/frontend/chars/${name}-${kind}.$([ "$kind" = sd ] && echo png || echo webp)"
