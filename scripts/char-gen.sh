#!/bin/zsh
# Generate a character mode set with Codex's built-in image generation (an original anime-style character): four sheets
# of 4×2 poses on white — A, then B, C and D side by side, each drawn from A so the four match — the same 8 poses with
# a different action in each (CELLS below), then cut them into one 32-frame strip frontend/chars/<name>-<kind>.webp with
# char-sprites.py.
#   scripts/char-gen.sh <name> <full|bust|sd> [work dir] [sets]
# sets: which sheets to (re)draw, default abcd; the cut always takes all four (<name>_<kind>.png, _b, _c, _d).
# bust and sd (the chibi pixel sheet) take the full sheets as their reference, so make full first. Each call takes about
# 20 minutes (A, then the other three at once); several run side by side. The frame sizes char-sprites.py prints go
# into CH_ART in frontend/app.js.
# A name not listed below is a new character: describe them in CHAR_DESC (English, like the lines below); the strips go
# to the work dir instead of frontend/chars, and scripts/char-publish.py puts them online without a deploy.
#   CHAR_DESC='young woman ..., short red hair, ...' scripts/char-gen.sh mio full ~/chars-work
# CHAR_REF=<image> gives full a picture to take the look from (the 「캐릭터」 tab's upload): it is redrawn as an original
# character in this style, CHAR_DESC still naming what to keep. sd copies aoi's SD sheets (aoi_sd.png, aoi_sd_b.png …
# in the work dir, rebuilt from frontend/chars by char-sd-template.py when missing), so redraw aoi's first.
# Needs `codex` logged in; the cut uses PYTHON, or the Python char-python.sh finds or makes (Pillow, numpy, scipy).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
name=$1; kind=$2; work=${3:-$PWD}; sets=${4:-abcd}
typeset -A CHARS
CHARS=(
  aoi   'young woman office engineer, short teal bob hair with side bangs, amber eyes, oversized cream hoodie over white t-shirt, dark navy pleated skirt, black tights, white sneakers, small gold hair clip'
  ren   'young man programmer, messy black hair, round thin glasses, gray eyes, navy blue cardigan over white collared shirt, gray slacks, brown loafers'
  hina  'young woman designer, long pinkish-brown hair in a high ponytail with a red ribbon, green eyes, white blouse with beige knit vest, red plaid skirt, white socks, brown loafers'
  sora  'cheerful young man, spiky orange hair, blue eyes, olive green bomber jacket over black t-shirt, beige cargo pants, red sneakers'
  kaede 'team leader woman, long straight black hair, violet eyes, black wireless gaming headset with a small boom microphone worn on her head, dark charcoal blazer over white shirt, black slacks, low black heels'
  yuki  'team leader young man, neat silver hair, light blue eyes, black wireless gaming headset with a small boom microphone worn on his head, light blue shirt with sleeves rolled up and loosened navy tie, black trousers, black shoes'
)
desc=${CHARS[$name]:-${CHAR_DESC:-}}
[ -n "$desc" ] || { echo "새 캐릭터 $name: CHAR_DESC 에 생김새를 적어 주세요" >&2; exit 2; }
[ -z "${CHAR_REF:-}" ] || CHAR_REF=${CHAR_REF:A}  # absolute: the rest runs in the work dir
cd "$work"
PY=${PYTHON:-$("$ROOT/scripts/char-python.sh")}
out="$ROOT/frontend/chars"; (( ${+CHARS[$name]} )) || out=$PWD
# the 8 cells of each sheet, left to right, top row then bottom: 1 입력 대기, 2 실행 중, 3 백그라운드, 4 응답 없음,
# 5 유휴, 6 완료, 7 결정 대기, 8 cell 1 with the eyes shut (the blink Live2D crossfades to)
typeset -A CELLS
CELLS[a]='1. calm neutral standing, arms relaxed, slight smile, eyes open
2. holding an open laptop on one forearm and typing on it with the other hand, focused eyes looking down at it
3. holding a coffee mug with both hands, relaxed content smile
4. worried: both hands on head, big sweat drop, troubled eyebrows, wavy mouth
5. sleepy dozing while standing, eyes closed, head tilted, drooping shoulders
6. very happy, eyes closed in a smile, making a peace sign
7. raising one hand high like asking a question, surprised round mouth, eyes wide'
CELLS[b]='1. a big stretch: both arms raised straight overhead with the fingers laced, relaxed smile, eyes open
2. holding a tablet in one arm and writing on it with a stylus, focused eyes looking down at it
3. holding a steaming cup of tea with both hands near the chest, gentle smile
4. deep in thought: one arm across the chest, the other hand on the chin, frowning, a small sweat drop
5. a big yawn, one hand covering the open mouth, eyes squeezed shut with a tear in the corner
6. a joyful cheer with both arms raised high, big open smile
7. beckoning toward the viewer with one hand as if calling someone over, curious eyebrows, eyes open'
CELLS[c]='1. standing with arms crossed, calm confident expression, eyes open
2. reading a few sheets of paper held in both hands, turning a page, focused eyes looking down at them
3. eating a sandwich held in both hands, happy puffed cheeks
4. on the verge of tears: teary eyes, trembling pouting mouth, both hands clenched at the chest
5. hugging a small pillow to the chest while standing and nodding off, eyes closed, head drooping
6. a thumbs-up with one hand, winking with a grin
7. holding up a small sign with a big question mark on it, puzzled look'
CELLS[d]='1. hands clasped behind the back, glancing to one side with a curious look, eyes open
2. typing fast with both thumbs on a smartphone held in both hands, focused eyes looking down at it
3. leaning back casually, looking at a smartphone in one hand, the other hand in a pocket, relaxed
4. shocked: staring at an open laptop held in one arm, eyes wide, mouth open in alarm, a big sweat drop
5. asleep standing up with a snot bubble from the nose, eyes closed, head drooping forward
6. a victory fist pump, eyes closed in a big grin
7. holding a clipboard out toward the viewer with both hands, expectant look, eyes open'
style='modern Japanese anime style (clean cel shading, crisp dark lineart, TV-anime look)'
[ "$kind" = sd ] && style='SD (super deformed) chibi pixel art: a 16-bit game sprite look with big clearly visible square pixels, a limited palette, a 1-pixel dark outline, no anti-aliasing, no gradients'
sheet() { [ "$1" = a ] && echo "${name}_$2.png" || echo "${name}_$2_$1.png"; }
# One sheet: set $1. A takes its references as before; B–D also get this kind's A, to keep the look, scale and framing.
gen() {
  local set=$1 frame ref=() same
  same="the SAME character at the SAME scale and framing as the first attached image (this character's sheet with other poses): the same head size, the same height in the cell, the same placement in each cell, the same design; only the poses change"
  if [ "$kind" = full ]; then
    frame='FULL BODY from head to shoes, standing, facing the viewer, same scale, centered, feet on the same baseline, nothing cropped'
    if [ $set != a ]; then
      frame="$frame; $same"; ref=(-i "$(sheet a full)")
    elif [ -n "${CHAR_REF:-}" ]; then
      frame="$frame; the attached image is the reference for this character's look (hair, face, eyes, clothes, colours, accessories): redraw that look as an original character in the style above, never copying its art style, background or a real person's likeness"
      ref=(-i "$CHAR_REF")
    fi
  elif [ "$kind" = sd ]; then
    # 「AI 생성」: a super-deformed (chibi) pixel art version of the full sheet
    if [ "$name" = aoi ]; then
      # every SD character is drawn to one body: aoi's sheets are the proportion template for the others
      frame="FULL BODY SD chibi exactly 2 heads tall (the head is 50% of the total height, big expressive eyes, short round body and short legs), standing, facing the viewer, same scale, centered, feet on the same baseline, nothing cropped, each character about 48 pixel-art pixels tall (chunky pixels); the attached image is the reference for the character's exact design (hair, eyes, clothes, colours)"
      ref=(-i "$(sheet $set full)")
      if [ $set != a ]; then
        frame="FULL BODY SD chibi exactly 2 heads tall, standing, facing the viewer, centered, feet on the same baseline, nothing cropped. TWO attached images: the FIRST is this character's SD sheet with other poses — copy its body, pixel size, total height in pixels, palette and placement in each cell exactly; the SECOND is the reference for the poses of the 8 cells and the design — never for proportions"
        ref=(-i "$(sheet a sd)" -i "$(sheet $set full)")
      fi
    else
      local tpl=$([ $set = a ] && echo aoi_sd.png || echo aoi_sd_$set.png)
      frame="FULL BODY SD chibi, standing, facing the viewer, centered, feet on the same baseline, nothing cropped, chunky pixels as big as the template's. TWO attached images: the FIRST is the proportion template — copy its body exactly: the same head size, the same total height in pixels, the same 2-heads-tall proportions, the same width of shoulders and length of arms and legs, the same placement in each cell and the same pose for each of the 8 cells. The SECOND is the reference for this character's design (hair, eyes, clothes, colours, accessories) — use it only for the design, never for proportions. Long hair or a ponytail may extend beyond the template's outline, but the head, body and legs must match the template"
      ref=(-i $tpl -i "$(sheet $set full)")
      [ -f $tpl ] || "$PY" "$ROOT/scripts/char-sd-template.py" $tpl $set
    fi
  else
    frame="UPPER BODY portrait from the top of the head down to the waist (bust shot), facing the viewer, same scale, head at the same height in every cell, centered, nothing cropped at the top or sides; the attached image is the reference for the character's exact design"
    ref=(-i "$(sheet $set full)")
    if [ $set != a ]; then
      frame="UPPER BODY portrait from the top of the head down to the waist (bust shot), facing the viewer, head at the same height in every cell, centered, nothing cropped at the top or sides. TWO attached images: the FIRST is this character's bust sheet with other poses — copy its scale, framing, head size and head height exactly; the SECOND is the full-body reference for the poses of the 8 cells and the design"
      ref=(-i "$(sheet a bust)" -i "$(sheet $set full)")
    fi
  fi
  local p="p_${name}_${kind}_${set}.txt" png=$(sheet $set $kind)
  cat > "$p" <<P
Use your built-in image generation tool to create ONE image and save it as PNG at ./${png} (in the current directory). Do nothing else; do not write code.

Image: a character sprite sheet in ${style}, original character (not an existing IP).
Character: ${desc}.
Layout: 1536x1024 landscape, a 4 columns x 2 rows grid of equal cells, plain flat pure white background (#FFFFFF) everywhere, no grid lines, no text, no floor shadows. In every cell the SAME character, ${frame}.
Cells (left to right, top row then bottom row):
${CELLS[$set]}
8. exactly the same pose and framing as cell 1 but with eyes closed (blink)
P
  # the prompt goes in on stdin: --image takes every argument after it
  rm -f "$png"
  codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C . $ref < "$p" > "log_${name}_${kind}_${set}.txt" 2>&1
  [ -f "$png" ] || { echo "$png: 생성되지 않음 (log_${name}_${kind}_${set}.txt)" >&2; return 1; }
}
if [[ $sets == *a* ]]; then gen a; fi
for s in b c d; do [[ $sets == *$s* ]] && gen $s & done
wait
for s in a b c d; do [ -f "$(sheet $s $kind)" ] || { echo "$(sheet $s $kind) 가 없어 자르지 않습니다" >&2; exit 1; }; done
"$PY" "$ROOT/scripts/char-sprites.py" "$(sheet a $kind)" "$kind" "$out/${name}-${kind}.$([ "$kind" = sd ] && echo png || echo webp)" "$(sheet b $kind)" "$(sheet c $kind)" "$(sheet d $kind)"
