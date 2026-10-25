# 디자인 시스템

대시보드의 색·재질·공용 컴포넌트를 클라이언트(`frontend/`)와 따로 관리한다. **규칙은 [GUIDELINES.md](GUIDELINES.md) — 모든 변경과 새 컴포넌트가 반드시 따른다.** 검사: `python3 scripts/check-ds.py`. 빌드 단계 없이 파일 그대로 쓰며, 페이지에는 `ds/` 경로로 붙는다 (개발 서버는 `/ds/` 로 내주고, 배포 스크립트는 번들의 `ds/` 로 복사한다).

미리보기: 개발 서버를 띄우고 `http://127.0.0.1:5500/ds/` 를 연다. 모든 토큰과 컴포넌트를 실제 파일로 그리고, 테마와 재질을 바꿔 볼 수 있다.

스토리: `http://127.0.0.1:5500/ds/stories.html` 은 스토리북처럼 컴포넌트를 상황별로 하나씩 본다. 상황은 각 `<이름>.html` 의 `<!-- @story 이름 — 설명 -->` 표시로 나뉜다(GUIDELINES H2).
- 왼쪽 목록에서 컴포넌트 → 스토리를 고르면 가운데 캔버스(iframe)에 그 스토리만 그려지고, 아래 패널에 그 스토리의 「점검」 결과·마크업·계약이 나온다. 문제를 누르면 캔버스의 그 요소가 깜빡인다. 주소의 `#<이름>/<번호>` 로 바로 열린다.
- 폭(맞춤 · 390 · 669 · 820 · 1100)은 캔버스 폭이라 브레이크포인트와 넘침이 그 폭 그대로 잰다. 테마·재질은 페이지와 캔버스에 같이 걸린다.
- 「모두 점검」은 지금 테마·재질·폭으로 모든 스토리를, 「네 조합으로 모두」는 라이트·다크 × 유리·매트로 재서 목록의 스토리·컴포넌트마다 「통과」·「문제 n」 배지를 붙인다. 「문제만 보기」는 통과한 것을 숨긴다.
- 열린 대화상자·시트, 떠 있는 토스트처럼 누르거나 띄워야 보이는 상태는 `data-story-play` 로 그린 채 잰다. 한 페이지 미리보기는 이런 상태를 재지 못한다.

점검: 미리보기의 「점검」을 누르면(또는 `/ds/?check`) 컴포넌트마다 지금 화면 그대로 재서 제목 옆에 「통과」나 「문제 n」 배지를 붙인다. 문제는 제목 아래에 규칙 번호와 함께 나오고, 누르면 그 요소로 가서 깜빡인다. 걸린 요소는 빨간 점선으로 둘러진다. 폭을 바꾸거나 돌리거나 접으면 다시 재므로, 실기기(휴대폰, iPhone Duo)에서 열면 그 기기 그대로 확인된다.
- 재는 것: 화면 밖 넘침(B5), 누르는 영역 28px · 손가락 36px(A4·B3, `::before` 로 넓힌 영역 포함), 손가락 기기 입력란 16px(B4), 글자 대비 4.5 : 1(큰 글자 3), 아이콘 버튼의 `aria-label`·`data-tip`(A1).
- 「네 조합 모두」는 라이트·다크 × 유리·매트를 차례로 바꿔 재고 합친다(문제마다 걸린 조합이 붙는다). 「문제만 보기」는 통과한 컴포넌트를 숨긴다.
- 대비는 배경을 겹쳐 계산한다. 유리의 흐림은 페이지 색 위에 겹친 것으로 보고, 그라데이션·이미지 위 글자는 재지 않는다.
- 소스 규칙은 여전히 `check-ds.py` 가 본다. 「점검」은 화면에서만 보이는 규칙을 맡는다(`preview-check.js`, 미리보기 전용이라 대시보드는 불러오지 않는다).

## 구조

```
design-system/
  GUIDELINES.md           반드시 지킬 규칙
  ds.css                  스타일 진입점: foundations → materials → 컴포넌트 순서로 @import (순서가 곧 캐스케이드 순서)
  ds.js                   커스텀 엘리먼트 진입점 (ES 모듈)
  index.html              미리보기 (모든 컴포넌트를 한 페이지에, 스토리를 차례로)
  stories.html            스토리 (상황별로 하나씩 보고 스토리마다 점검)
  story.html              스토리의 캔버스 (stories.html 이 iframe 으로 띄운다)
  stories.js              <이름>.html 을 @story 표시로 나누는 파서 (두 미리보기가 같이 쓴다)
  preview.css             예시가 쓰는 배치 도우미 (.row, .bars, .bg-field, .icons)
  preview-check.js        「점검」 (화면에서 재는 규칙)
  foundations/
    tokens.css            팔레트(라이트·다크), 모양(반경), 레이아웃(브레이크포인트·--gutter·--tap), 독 크기
    base.css              요소 기본값, 터치 기본값(입력란 16px 등), .st, 깜빡임·맥박 애니메이션
    theme.js              테마·재질 전환, 사용자 색, 팔레트 예시 (<head> 부트 스크립트)
    fold.js               펼친 접이식에서 주름이 화면 가운데서 벗어난 거리 --fold-off (<head> 부트 스크립트)
  materials/
    glass.css             리퀴드글래스 (기본) — 재질 계약의 기준
    matte.css             매트: 불투명, 블러·광택 없음
  components/<이름>/
    <이름>.html           마크업 계약: 받는 구조·속성·상태와 예시 (미리보기가 이 파일로 그려진다)
    <이름>.css            그 컴포넌트의 스타일
    ds-<이름>.js          커스텀 엘리먼트 (구조나 동작이 있는 컴포넌트만)
```

## 재질

표면이 어떻게 보이는지(반투명, 블러, 광택, 그림자)는 컴포넌트가 아니라 재질이 정한다. 컴포넌트는 재질 계약 토큰(`--surface-*`, `--control-*`, `--bar-*`, `--chart-*`, `--scrim-blur`)만 쓰고, 각 재질 파일이 그 토큰을 채운다. 토큰 목록은 `materials/glass.css` 머리말에 있다.

| 재질 | `data-material` | 모습 |
| --- | --- | --- |
| 유리 (기본) | `glass` | 반투명 + 배경 블러, 윗면 광택과 밝은 테두리, 막대는 유리관 |
| 매트 | `matte` | 패널 색 그대로 불투명, 얇은 테두리와 부드러운 그림자, 막대·컨트롤은 평면 |

- 페이지 전체: `<html data-material="…">` — `applyMaterial(choice)` (theme.js), 저장 키 `adash.material`. 대시보드에서는 「색 편집」 맨 위 「재질」에서 고른다.
- 일부만: 아무 요소에나 `data-material="matte"` 를 붙이면 그 하위 트리만 그 재질이 된다.

## 컴포넌트

각 컴포넌트의 정확한 마크업은 그 폴더의 `<이름>.html` 이 기준이다. 아래 표는 요약이다. 구조나 동작이 있으면 커스텀 엘리먼트, 겉모습뿐이면 클래스다. 모두 light DOM 이라 페이지 CSS·스크립트가 안쪽 요소를 그대로 선택할 수 있다.

| 컴포넌트 | API | 파일 |
| --- | --- | --- |
| 아이콘 | `<ds-icon name="users">` — `icons.svg` 의 심볼. 자기는 `display: contents`, 크기는 놓는 쪽이 `… svg` 로 정한다 (기본 1em) | `icon/` |
| 상태 필 | `<ds-pill state="run\|wait\|idle\|done\|bg\|stalled">라벨</ds-pill>` — 앞의 점은 엘리먼트가 넣는다 | `pill/` |
| 플로팅 바 | `<ds-dock>` 안에 `<a>` 탭(`.on` = 현재), `<button class="dock-btn">`, `<label class="dock-btn"><input type="checkbox">…</label>` 토글, `<i class="dock-sep">`. `data-tip` 은 호버 이름, `<b class="dn">` 은 개수 배지. 마지막에 ⋯ 바 설정(위치·크기)을 스스로 붙인다. 휴대폰에서는 런처 알약(현재 탭 + `summary`)이 되고, 누르면 같은 버튼들이 이름 붙은 바텀시트(`[open]`, 묶음 제목은 `.dock-sep` 의 `data-label`)로 열린다 | `dock/` |
| 바 팝오버 | `.dock-pop` — 바 쪽에서 열리는 팝오버 자리. `hidden` 으로 열고 닫으며, 하나가 열리면 다른 `.dock-pop` 은 닫힌다. 위치는 바의 최대 크기 기준이라 크기를 바꿔도 움직이지 않는다 | `dock/` |
| 표면 | `.surface`, `.surface.surface-strong` — 현재 재질로 그린 판 | `surface/` |
| 테마 버튼 | `<ds-theme-toggle button-class="…">` — 시스템 → 라이트 → 다크 순환, 아이콘·이름을 스스로 갱신 | `theme-toggle/` |
| 색 편집 | `<ds-theme-editor class="popover dock-pop" hidden>` — 재질·팔레트·색 선택기. `hidden` 으로 열고 닫는다 | `theme-editor/` |
| 툴팁 | `<ds-tooltip id="tip">` — `tip.show(html, event)`, `tip.hide()` | `tooltip/` |
| 토스트 | `<ds-toast id="toast">` — `toast.show(msg, { action, onAction })` | `toast/` |
| 도넛 | `<ds-donut segments="N 색; N 색" value="3/5" caption="완료">` | `donut/` |
| 팝오버 | `.popover` + `.pop-h`(머리줄) — 떠 있는 설정·편집 패널 | `popover/` |
| 대화상자 | `<dialog class="dialog">` + `.dialog-warn`, `.dialog-btns` | `dialog/` |
| 박스 | `.box` (+ `<h3>`), `<details class="box">` | `box/` |
| 카드 | `.card` — 누르는 타일, 호버 때 떠오름 | `card/` |
| 두 칸 | `.panes` > 자식 둘 — 같은 폭 두 칸. 700px 이하에서 쌓이지만 펼친 접이식 화면(B8)에서는 나란히, 칸 사이 틈이 주름 위에 온다 | `panes/` |
| KPI | `.kpis` > `.kpi` (`<span>` 라벨, `<b>` 값, `<small>` 메모) | `kpi/` |
| 표 | `<table>`, 숫자 열 `.n`, 넓은 표는 `<div class="tscroll">` 로 감싼다 | `table/` |
| 범례 | `.legend` > `<span><i style="background:…"></i>이름</span>` | `legend/` |
| 제목 | `.sec-h` > `<h2>` + `<span>` 메모 | `heading/` |
| 입력 | `.field` (`<input>`, `<select>`) | `field/` |
| 점 | `.dot`, `.dot.live` | `dot/` |
| 배지 | `.badge` (색 변형은 페이지가 정한다) | `badge/` |
| 칩 | `<span class="chip" style="--c: 색">라벨 <i>n</i></span>` | `chip/` |
| 버튼 | `.act`, `.act.big`, `.act.accent`, `.act.danger`, `.tgl` | `button/` |
| 세그먼트 | `<span class="seg"><button class="on">…</button>…</span>` — 폭보다 길면 스스로 가로 스크롤 | `segmented/` |
| 막대 | `.track`(누적), `.ctxbar`(채움), `.prog`(얇은 누적), `.tbar`(통과·실패), `.pbar`(단계 `<i class="done\|run\|fail\|skip">`) | `bar/` |

## 반응형

폭 세 단계(`max-width` 900 태블릿 · 700 좁은 화면 · 500 휴대폰)와 입력 방식(`pointer: coarse`, `hover: none`)을 따로 본다. 규칙은 GUIDELINES 10장(B1–B7).

- 토큰: `--gutter` (페이지 가장자리 여백, 700px 이하 12px), `--tap` (누르는 영역, 손가락 기기 36px).
- 컴포넌트가 스스로 하는 것: 휴대폰에서 바는 아래 가운데 런처 알약(48px)이 되고 누르면 버튼마다 이름이 붙은 52px 행의 바텀시트로 열림(위치·크기 설정은 휴대폰에서 쓰지 않음), 호버 없는 기기에서 바 이름표 끔, `.seg`·`.tscroll` 가로 스크롤, 손가락 기기에서 `.act`·`.tgl`·`.field` 누르는 영역 확대와 입력란 16px.
- 미리보기 위쪽에 지금 폭 단계가 보인다. 창 폭을 바꾸거나 개발자 도구 기기 모드로 확인한다.

### 접이식 (펼친 화면)

펼친 책 모양 접이식(iPhone Duo 내부 화면 669 × 951, 옆으로 들면 951 × 669)은 폭 단계와 따로 **펼침 레이아웃**으로 본다. 규칙은 GUIDELINES B8–B10.

- 조건(그대로 복사해 쓴다): `(pointer: coarse) and (width > 500px) and (min-aspect-ratio: 5/8) and (max-aspect-ratio: 8/5) and ((width <= 700px) or (height <= 700px))`, 또는 브라우저가 힌지를 알려 주면 `(horizontal-viewport-segments: 2)`.
- 토큰: `--fold` (펼침이면 1, 스크립트가 읽는다), `--hinge` (가려지는 힌지 폭, 이음매 없는 화면은 0), `--seg-w` (첫 화면 조각의 폭, 기본 `100vw`), `--pane-gap` (두 칸 사이, 힌지 + 양쪽 여백 이상).
- 컴포넌트가 스스로 하는 것: `.panes` 는 펼침에서 두 칸을 유지한다. 힌지가 보고되면 대화상자·팝오버는 `--seg-w` 안에 머물고, 위·아래 바와 그 팝오버는 첫 화면 가운데로 옮긴다.
- 접은 커버 화면(466 × 678)은 휴대폰 단계(500px 이하) 그대로다.

## 페이지에 붙이기

```html
<script src="ds/foundations/theme.js"></script>          <!-- 첫 페인트 전에 테마 -->
<script src="ds/foundations/fold.js"></script>           <!-- 펼친 접이식의 주름 위치 -->
<script src="ds/components/dock/dock-boot.js"></script>  <!-- 첫 페인트 전에 바 위치·크기 -->
<script type="module" src="ds/ds.js"></script>
<link rel="stylesheet" href="ds/ds.css">
<link rel="stylesheet" href="app.css">                   <!-- 페이지 CSS 는 디자인 시스템 뒤에 -->
```

- 페이지가 정하는 값: `--dock-inset-top` (위쪽 바를 끈적한 헤더 아래로 내릴 거리), 바가 가리지 않도록 본문에 두는 여백. 본문 좌우 여백은 `--gutter` 를 쓴다.
- 페이지가 바에 주는 속성(선택): `summary` (휴대폰 런처에 보일 한 줄 요약), `sheet-title` (휴대폰 시트 제목), `.dock-sep` 의 `data-label` (시트의 묶음 제목).
- 기기별 저장값: `adash.theme`, `adash.theme.custom`, `adash.material` (theme.js), `adash.dock`, `adash.dock.size` (dock-boot.js · ds-dock.js).

## 고칠 때

규칙과 완료 기준은 [GUIDELINES.md](GUIDELINES.md) 에 있다. 자주 하는 일만 요약하면:

- 색: `tokens.css` 팔레트(단색 hex)에만 둔다. 사용자가 바꿀 수 있는 색은 `theme.js` 의 `THEME_VARS`·`PALETTES` 에도 넣는다.
- 새 시각 효과: 재질 계약에 토큰을 추가하고 **모든 재질**에 값을 넣은 뒤 컴포넌트에서 쓴다.
- 새 컴포넌트: `components/<이름>/` 에 `<이름>.html`(마크업 계약, 상황마다 `@story`)과 `<이름>.css` (+ 구조·동작이 있으면 `ds-<이름>.js`). `ds.css`·`ds.js`·`frontend/sw.js`·위 표에 등록한다. 미리보기는 저절로 생긴다.
- 아이콘: `components/icon/icons.svg` 에 `<symbol id="…" viewBox="0 0 24 24">` (선만, 색 속성 없음).
- 끝나면 `python3 scripts/check-ds.py`, 그리고 스토리의 「네 조합으로 모두」(폭 맞춤과 390)에서 그 컴포넌트의 스토리가 모두 통과인지 보고, 라이트·다크 × 유리·매트를 눈으로 확인한다.
