# 디자인 시스템

대시보드의 색·재질·공용 컴포넌트를 클라이언트(`frontend/`)와 따로 관리한다. **규칙은 [GUIDELINES.md](GUIDELINES.md) — 모든 변경과 새 컴포넌트가 반드시 따른다.** 검사: `python3 scripts/check-ds.py`. 빌드 단계 없이 파일 그대로 쓰며, 페이지에는 `ds/` 경로로 붙는다 (개발 서버는 `/ds/` 로 내주고, 배포 스크립트는 번들의 `ds/` 로 복사한다).

미리보기: 개발 서버를 띄우고 `http://127.0.0.1:5500/ds/` 를 연다. 모든 토큰과 컴포넌트를 실제 파일로 그리고, 테마와 재질을 바꿔 볼 수 있다.

## 구조

```
design-system/
  GUIDELINES.md           반드시 지킬 규칙
  ds.css                  스타일 진입점: foundations → materials → 컴포넌트 순서로 @import (순서가 곧 캐스케이드 순서)
  ds.js                   커스텀 엘리먼트 진입점 (ES 모듈)
  index.html              미리보기
  foundations/
    tokens.css            팔레트(라이트·다크), 모양(반경), 레이아웃(브레이크포인트·--gutter·--tap), 독 크기
    base.css              요소 기본값, 터치 기본값(입력란 16px 등), .st, 깜빡임·맥박 애니메이션
    theme.js              테마·재질 전환, 사용자 색, 팔레트 예시 (<head> 부트 스크립트)
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
| 플로팅 바 | `<ds-dock>` 안에 `<a>` 탭(`.on` = 현재), `<button class="dock-btn">`, `<label class="dock-btn"><input type="checkbox">…</label>` 토글, `<i class="dock-sep">`. `data-tip` 은 호버 이름, `<b class="dn">` 은 개수 배지. 마지막에 ⋯ 바 설정(위치·크기)을 스스로 붙인다 | `dock/` |
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
- 컴포넌트가 스스로 하는 것: 휴대폰에서 위·아래 바는 버튼 폭을 28px 까지 줄이고 그래도 넘치면 가로 스크롤, 호버 없는 기기에서 바 이름표 끔, `.seg`·`.tscroll` 가로 스크롤, 손가락 기기에서 `.act`·`.tgl`·`.field` 누르는 영역 확대와 입력란 16px.
- 미리보기 위쪽에 지금 폭 단계가 보인다. 창 폭을 바꾸거나 개발자 도구 기기 모드로 확인한다.

## 페이지에 붙이기

```html
<script src="ds/foundations/theme.js"></script>          <!-- 첫 페인트 전에 테마 -->
<script src="ds/components/dock/dock-boot.js"></script>  <!-- 첫 페인트 전에 바 위치·크기 -->
<script type="module" src="ds/ds.js"></script>
<link rel="stylesheet" href="ds/ds.css">
<link rel="stylesheet" href="app.css">                   <!-- 페이지 CSS 는 디자인 시스템 뒤에 -->
```

- 페이지가 정하는 값: `--dock-inset-top` (위쪽 바를 끈적한 헤더 아래로 내릴 거리), 바가 가리지 않도록 본문에 두는 여백. 본문 좌우 여백은 `--gutter` 를 쓴다.
- 기기별 저장값: `adash.theme`, `adash.theme.custom`, `adash.material` (theme.js), `adash.dock`, `adash.dock.size` (dock-boot.js · ds-dock.js).

## 고칠 때

규칙과 완료 기준은 [GUIDELINES.md](GUIDELINES.md) 에 있다. 자주 하는 일만 요약하면:

- 색: `tokens.css` 팔레트(단색 hex)에만 둔다. 사용자가 바꿀 수 있는 색은 `theme.js` 의 `THEME_VARS`·`PALETTES` 에도 넣는다.
- 새 시각 효과: 재질 계약에 토큰을 추가하고 **모든 재질**에 값을 넣은 뒤 컴포넌트에서 쓴다.
- 새 컴포넌트: `components/<이름>/` 에 `<이름>.html`(마크업 계약)과 `<이름>.css` (+ 구조·동작이 있으면 `ds-<이름>.js`). `ds.css`·`ds.js`·`frontend/sw.js`·위 표에 등록한다. 미리보기는 저절로 생긴다.
- 아이콘: `components/icon/icons.svg` 에 `<symbol id="…" viewBox="0 0 24 24">` (선만, 색 속성 없음).
- 끝나면 `python3 scripts/check-ds.py`, 그리고 미리보기에서 라이트·다크 × 유리·매트를 확인한다.
