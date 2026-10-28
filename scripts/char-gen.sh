#!/bin/zsh
# Generate a character mode set with Codex's built-in image generation (an original anime-style character): four sheets
# of 4×2 poses on white — A, then B, C and D side by side, each drawn from A so the four match — the same 8 poses with
# a different action in each (CELLS below), then cut them into one 32-frame strip frontend/chars/<name>-<kind>.webp with
# char-sprites.py.
#   scripts/char-gen.sh <name> <full|bust|sd|run|done> [work dir] [sets]
# sets: which sheets to (re)draw, default abcd; the cut always takes all four (<name>_<kind>.png, _b, _c, _d).
# run draws, for each set, 8 frames of the 「실행 중」 pose as one looping motion of about 5 seconds (RUN below; the page
# times them, CH_RUN_MS), from that set's sd and full sheets, so make sd first. They are cut together with the sd
# sheets — one pixel grid and box for all 64 frames, so the motion lines up with the poses — into <name>-sd-run.png and
# <name>-sd-bust-run.png beside <name>-sd.png; a later sd cut takes them along again. done draws one sheet (set A: every
# state but 「실행 중」 keeps it) of the 「완료」 pose as a calmer 5-second loop (DONE below), cut the same way into
# <name>-sd-done.png and <name>-sd-bust-done.png.
# bust and sd (the chibi pixel sheet) take the full sheets as their reference, so make full first. Each call takes about
# 20 minutes (A, then the other three at once); several run side by side. The frame sizes char-sprites.py prints go
# into CH_ART in frontend/app.js.
# A name not listed below is a new character: describe them in CHAR_DESC (English, like the lines below); the strips go
# to the work dir instead of frontend/chars, and scripts/char-publish.py puts them online without a deploy.
#   CHAR_DESC='young woman ..., short red hair, ...' scripts/char-gen.sh mio full ~/chars-work
# CHAR_REF=<image> gives full a picture to take the look from (the 「캐릭터」 tab's upload): it is redrawn as an original
# character in this style, CHAR_DESC still naming what to keep. sd copies the template person's SD sheets (SD_TPL,
# default hina: hina_sd.png, hina_sd_b.png … in the work dir, rebuilt from frontend/chars by char-sd-template.py when
# missing), so redraw theirs first.
# Needs `codex` logged in; the cut uses PYTHON, or the Python char-python.sh finds or makes (Pillow, numpy, scipy).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
name=$1; kind=$2; work=${3:-$PWD}; sets=${4:-abcd}; tpl=${SD_TPL:-hina}
typeset -A CHARS
CHARS=(
  ren   'young man programmer, messy black hair, round thin glasses, gray eyes, navy blue cardigan over white collared shirt, gray slacks, brown loafers'
  hina  'young woman designer, long pinkish-brown hair in a high ponytail with a red ribbon, green eyes, white blouse with beige knit vest, red plaid skirt, white socks, brown loafers'
  kaede 'team leader woman, long straight black hair, violet eyes, black wireless gaming headset with a small boom microphone worn on her head, dark charcoal blazer over white shirt, black slacks, low black heels'
  # 운영실 staff (HUB in app.js): one a screen, dressed for the job
  sera   'young woman executive secretary, dark brown hair in a neat low bun with a slim gold hairpin, warm brown eyes, small pearl earrings, fitted navy blazer and navy pencil skirt over a white blouse with a soft bow at the collar, a thin gold wristwatch, navy low heels'
  daichi 'young man office manager, short dark brown undercut hair swept to one side, amber eyes, white dress shirt with the sleeves rolled to the elbows, dark gray waistcoat, a blue ID badge on a lanyard round the neck, a silver wristwatch, charcoal trousers, brown oxford shoes'
  mina   'young woman quality inspector, short teal bob with a side-swept fringe, sharp teal eyes, a white inspector coat over a black turtleneck, a red armband on the left sleeve, a small brass jeweller loupe hanging on a cord round the neck, a green check-mark badge pinned to the chest, black trousers, white sneakers'
  toru   'young man lab tester, messy bright orange hair, light green eyes, clear safety goggles pushed up on the forehead, a white lab coat over a mint-green T-shirt, a glass test tube clipped in the breast pocket, green rubber gloves, khaki cargo trousers, gray sneakers'
  midori 'young woman accountant, auburn hair in a single side braid, hazel eyes, a translucent green eyeshade visor, a white shirt with black sleeve garters on both arms, a dark green waistcoat with a gold pocket-watch chain, a pencil tucked behind one ear, brown skirt, brown shoes'
  gonta  'big friendly young man building caretaker, short spiky black hair under a backwards yellow cap, dark eyes, a stubbly chin, blue work overalls over a gray T-shirt, a brown tool belt with a wrench and a walkie-talkie, a ring of keys on the belt, heavy brown work boots'
  fumi   'young woman archivist, very long straight lavender hair with blunt bangs, calm gray eyes, a long brown duster coat over a cream sweater, a dark red knitted scarf, a fountain pen clipped to the collar, a small leather notebook on a chain at the hip, dark tights, brown ankle boots'
  sho    'young man project manager, neat swept-back dark blue hair, sharp blue eyes, a light gray suit jacket over a black turtleneck, a small red lapel pin, a black smartwatch, slim gray trousers, white leather sneakers'
  aki    'young woman architect, short wavy black hair under a dark red beret, gold eyes, a pencil tucked behind one ear, a black turtleneck under an open olive work jacket, a rolled blueprint tube slung on her back by a strap, a tape measure clipped to the belt, dark jeans, black boots'
  yuki  'team leader young man, neat silver hair, light blue eyes, black wireless gaming headset with a small boom microphone worn on his head, light blue shirt with sleeves rolled up and loosened navy tie, black trousers, black shoes'
)
desc=${CHARS[$name]:-${CHAR_DESC:-}}
[ $name = hina ] && export CHAR_WHITE_SOCKS=1  # her socks are flat white: char-sprites.py must not take them for gaps
[ -n "$desc" ] || { echo "새 캐릭터 $name: CHAR_DESC 에 생김새를 적어 주세요" >&2; exit 2; }
[ -z "${CHAR_REF:-}" ] || CHAR_REF=${CHAR_REF:A}  # absolute: the rest runs in the work dir
cd "$work"
PY=${PYTHON:-$("$ROOT/scripts/char-python.sh")}
out="$ROOT/frontend/chars"; (( ${+CHARS[$name]} )) || out=$PWD
out=${CHAR_OUT:-$out}  # the 「캐릭터」 tab's redraw keeps a built-in person's strips out of the repo (they go up to R2)
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
# run: the 8 frames of each set's 「실행 중」 pose (cell 2 of its sd sheet), one motion that loops back into frame 1 —
# working (1–4), a pause to think (5, 6), back to work (7, 8)
typeset -A RUN
RUN[a]='1. exactly cell 2 of the FIRST attached sheet: holding an open laptop on one forearm and typing on it with the other hand, the typing hand down on the keys, eyes looking down at it
2. the same, the typing hand lifted a little above the keys
3. the typing hand down on the keys again, a little further to the side
4. the typing hand lifted again, mouth slightly open as if muttering to itself
5. pausing: looking up from the laptop toward the viewer, the free hand off the keys with one finger on the chin, thinking
6. an idea: eyes bright, a small smile, that finger raised
7. looking back down at the laptop, the hand coming back to the keys
8. typing again, the hand down on the keys, a satisfied little smile'
RUN[b]='1. exactly cell 2 of the FIRST attached sheet: holding a tablet in one arm and writing on it with a stylus, the stylus tip on the screen, eyes looking down at it
2. the same, the stylus moved a little across the screen in a stroke
3. the stylus lifted a little off the screen
4. the stylus back on the screen at a new spot, writing
5. pausing: looking up from the tablet toward the viewer, the stylus tapping the chin, thinking
6. an idea: eyes bright, a small smile, the stylus raised
7. looking back down at the tablet, the stylus coming back to the screen
8. writing again, the stylus on the screen, a satisfied little smile'
RUN[c]='1. exactly cell 2 of the FIRST attached sheet: reading a few sheets of paper held in both hands, eyes looking down at them
2. the same, the eyes further down the page
3. turning a page: one hand lifting the top sheet halfway over
4. the page turned, both hands holding the papers again, reading the new page
5. pausing: looking up from the papers toward the viewer, thinking, the papers lowered a little
6. understanding: a small nod, eyes closed, a small smile
7. raising the papers again and looking back down at them
8. reading again, a satisfied little smile'
RUN[d]='1. exactly cell 2 of the FIRST attached sheet: typing fast with both thumbs on a smartphone held in both hands, eyes looking down at it
2. the same, the left thumb down and the right thumb lifted
3. the right thumb down and the left thumb lifted
4. both thumbs lifted a little, mouth slightly open as if muttering to itself
5. pausing: looking up from the phone toward the viewer, the phone lowered to the chest in both hands, thinking
6. an idea: eyes bright, a small smile
7. raising the phone again and looking back down at it
8. typing again with both thumbs, a satisfied little smile'
# done: the 8 frames of set A's 「완료」 pose (cell 6 of its sd sheet), a calm loop — the peace sign held, a smile, a blink
DONE='1. exactly cell 6 of the FIRST attached sheet: very happy, eyes closed in a smile, making a peace sign
2. the same pose, eyes open, a warm smile
3. the same, the head tilted a little to one side, the peace sign tilted with it
4. the same as cell 3 but the eyes closed in a smile
5. the peace sign hand lowered a little, a relaxed smile, eyes open
6. a small satisfied sigh: shoulders relaxed, eyes half closed, the hand lowered a little more
7. raising the peace sign again, eyes open, a bright smile
8. the same as cell 1 with a tiny grin'
style='modern Japanese anime style (clean cel shading, crisp dark lineart, TV-anime look)'
[[ $kind == (sd|run|done) ]] && style='SD (super deformed) chibi pixel art: a 16-bit game sprite look with big clearly visible square pixels, a limited palette, a 1-pixel dark outline, no anti-aliasing, no gradients'
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
  elif [[ $kind == (run|done) ]]; then
    frame="FULL BODY SD chibi, facing the viewer, centered, feet on the same baseline, nothing cropped. TWO attached images: the FIRST is this character's SD sheet — copy its body, head size, total height in pixels, pixel size, palette, outline and the placement of the character in each cell EXACTLY, so every cell here lines up with it frame for frame; the SECOND is the full-body reference for the design"
    ref=(-i "$(sheet $set sd)" -i "$(sheet $set full)")
  elif [ "$kind" = sd ]; then
    # 「AI 생성」: a super-deformed (chibi) pixel art version of the full sheet
    if [ "$name" = "$tpl" ]; then
      # every SD character is drawn to one body: the template person's sheets are the proportion template for the others
      frame="FULL BODY SD chibi exactly 2 heads tall (the head is 50% of the total height, big expressive eyes, short round body and short legs), standing, facing the viewer, same scale, centered, feet on the same baseline, nothing cropped, each character about 48 pixel-art pixels tall (chunky pixels); the attached image is the reference for the character's exact design (hair, eyes, clothes, colours)"
      ref=(-i "$(sheet $set full)")
      if [ $set != a ]; then
        frame="FULL BODY SD chibi exactly 2 heads tall, standing, facing the viewer, centered, feet on the same baseline, nothing cropped. TWO attached images: the FIRST is this character's SD sheet with other poses — copy its body, pixel size, total height in pixels, palette and placement in each cell exactly; the SECOND is the reference for the poses of the 8 cells and the design — never for proportions"
        ref=(-i "$(sheet a sd)" -i "$(sheet $set full)")
      fi
    else
      local t=$(sheet $set sd); t=${t/#$name/$tpl}
      frame="FULL BODY SD chibi, standing, facing the viewer, centered, feet on the same baseline, nothing cropped, chunky pixels as big as the template's. TWO attached images: the FIRST is the proportion template — copy its body exactly: the same head size, the same total height in pixels, the same 2-heads-tall proportions, the same width of shoulders and length of arms and legs, the same placement in each cell and the same pose for each of the 8 cells. The SECOND is the reference for this character's design (hair, eyes, clothes, colours, accessories) — use it only for the design, never for proportions. Long hair or a ponytail may extend beyond the template's outline, but the head, body and legs must match the template"
      ref=(-i $t -i "$(sheet $set full)")
      [ -f $t ] || "$PY" "$ROOT/scripts/char-sd-template.py" $t $set $tpl
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
  if [[ $kind == (run|done) ]]; then
    local cells=${RUN[$set]:-} calm='' 
    [ $kind = done ] && cells=$DONE && calm=' — a gentle, calm motion: only small changes'
    cat > "$p" <<P
Use your built-in image generation tool to create ONE image and save it as PNG at ./${png} (in the current directory). Do nothing else; do not write code.

Image: a character animation sprite sheet in ${style}, original character (not an existing IP).
Character: ${desc}.
Layout: 1536x1024 landscape, a 4 columns x 2 rows grid of equal cells, plain flat pure white background (#FFFFFF) everywhere, no grid lines, no text, no floor shadows. In every cell the SAME character, ${frame}.
These 8 cells (left to right, top row then bottom row) are consecutive frames of ONE continuous looping motion of about 5 seconds${calm}, so neighbouring cells differ only by small changes (a hand, an arm, the head, the eyes), cell 8 leads smoothly back into cell 1, the feet stay on the same baseline in every cell and the body never jumps in position or size:
${cells}
P
  else
  cat > "$p" <<P
Use your built-in image generation tool to create ONE image and save it as PNG at ./${png} (in the current directory). Do nothing else; do not write code.

Image: a character sprite sheet in ${style}, original character (not an existing IP).
Character: ${desc}.
Layout: 1536x1024 landscape, a 4 columns x 2 rows grid of equal cells, plain flat pure white background (#FFFFFF) everywhere, no grid lines, no text, no floor shadows. In every cell the SAME character, ${frame}.
Cells (left to right, top row then bottom row):
${CELLS[$set]}
8. exactly the same pose and framing as cell 1 but with eyes closed (blink)
P
  fi
  # the prompt goes in on stdin: --image takes every argument after it
  rm -f "$png"
  codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C . $ref < "$p" > "log_${name}_${kind}_${set}.txt" 2>&1
  [ -f "$png" ] || { echo "$png: 생성되지 않음 (log_${name}_${kind}_${set}.txt)" >&2; return 1; }
}
[ $kind = done ] && sets=a  # one sheet: set A
if [[ $sets == *a* ]]; then
  if [ $kind = run ]; then gen a & else gen a; fi  # run's sheets draw from sd, not from A: all four at once
fi
for s in b c d; do [[ $sets == *$s* ]] && gen $s & done
wait
for s in $([ $kind = done ] && echo a || echo a b c d); do [ -f "$(sheet $s $kind)" ] || { echo "$(sheet $s $kind) 가 없어 자르지 않습니다" >&2; exit 1; }; done
if [[ $kind == (sd|run|done) ]]; then
  # the sd sheets, and the run and done sheets when they are there: cut as one, so their frames share the poses' grid
  cut=() run=() extra=()
  for s in a b c d; do cut+=("$(sheet $s sd)"); run+=("$(sheet $s run)"); done
  [ -f $run[1] ] && [ -f $run[2] ] && [ -f $run[3] ] && [ -f $run[4] ] && cut+=($run) && extra+=(run:4)
  [ -f "$(sheet a done)" ] && cut+=("$(sheet a done)") && extra+=(done:1)
  CHAR_EXTRA=${(j:,:)extra} "$PY" "$ROOT/scripts/char-sprites.py" $cut[1] sd "$out/${name}-sd.png" $cut[2,-1]
else
  "$PY" "$ROOT/scripts/char-sprites.py" "$(sheet a $kind)" "$kind" "$out/${name}-${kind}.webp" "$(sheet b $kind)" "$(sheet c $kind)" "$(sheet d $kind)"
fi
