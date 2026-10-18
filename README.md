---
title: agent-dashboard
created: 2026-10-16
updated: 2026-10-18
tags: [domain/인공지능, area/ai에이전트, agent/claude-1b219bef-b3db-4ef6-8088-81f7f0d19120]
source: ai
---

# agent-dashboard

Claude Code·Codex 에이전트 세션, Orca Run, `aplan` 작업 계획을 한 화면에서 실시간으로 보여 주는 웹 대시보드다.

- 세션 로그를 증분으로 읽어 상태 변화를 SSE 로 브라우저에 밀어 준다.
- 세션별 토큰·비용, 진행 중인 단계, 에이전트 사이 상호작용, 테스트 실행, 결정 대기 질문을 보여 준다.
- 서버는 Python 표준 라이브러리만 쓴다. 설치할 의존성이 없다.

## 구성

| 폴더 | 무엇 | 어디서 도는가 |
| --- | --- | --- |
| `frontend/` | 정적 페이지 (빌드 단계 없음) | Cloudflare Pages — `https://dashboard.s-dante.com` (= `agent-dashboard-2at.pages.dev`) |
| `design-system/` | 토큰·유리 질감·공용 컴포넌트(웹 컴포넌트·클래스). 페이지에는 `ds/` 로 붙는다 — [design-system/README.md](design-system/README.md) | 페이지와 함께 배포 |
| `server/` | 메트릭 서버 (`server.py`, REST `/api/*` + SSE `/events`), `decision-hook`, `aplan`, `launchd/` | 로컬 Mac |
| `scripts/` | `deploy-frontend.sh` — `frontend/`(+ `design-system/` → `ds/`)를 Pages 에 배포, `dev-frontend.py` — 로컬 개발 서버 | |
| `exports/` | 공개 스키마 | |

```
브라우저 ── https://dashboard.s-dante.com (페이지)
   └─ fetch / EventSource ──► http://127.0.0.1:8787          (이 Mac)
                          └─► https://<mac>.<tailnet>.ts.net  (tailnet 기기, tailscale serve 경유)
```

- 페이지는 메트릭 서버 목록을 기기마다 따로 기억한다(기본값 `http://127.0.0.1:8787` 하나). 연결 표시(오른쪽 위 「실시간」)를 누르면 「메트릭 서버」 패널이 열리고, 켜진 서버가 하나도 연결되지 않으면 저절로 열린다. `?server=<url>` 로 열면 그 서버를 목록에 넣고 켠다.
- 서버를 여러 개 등록할 수 있다(기기마다 서버 하나씩 띄운 여러 Mac 등). 체크한 서버만 화면에 들어가고, 패널의 「보기」로 고른다.
  - **합쳐 보기:** 모든 서버의 세션·Run·테스트·결정 대기를 한 목록으로. 카드에 서버 배지가 붙는다.
  - **서버별 보기:** 에이전트 탭을 서버마다 구획으로 나눈다.
  - 비교 탭에는 「서버별」 묶음이 생긴다. 상단 합계는 켜진 서버 전체다.
  - 상세·숨김·결정 응답·Orca 열기·닫기는 그 세션을 보낸 서버로 간다. 연결 안 되는 서버는 빼고 그리며, 오른쪽 위 「⚠ 오류」에 이름이 뜬다.
- https 페이지는 http 주소를 부를 수 없다(혼합 콘텐츠). 예외는 루프백뿐이라, 다른 기기에서는 `tailscale serve --bg 8787` 이 주는 https 주소를 쓴다.
- Chrome 은 공개 사이트가 로컬 주소를 부를 때 「로컬 네트워크 접근」 권한을 한 번 묻는다. 허용해야 붙는다.

## 요구 사항

- macOS (상시 실행에 `launchd` 를 쓴다. 서버 자체는 Python 3 만 있으면 된다)
- Python 3
- 선택: Orca CLI(`orca`)가 `PATH` 에 있으면 Run·터미널 정보를 함께 보여 준다

## 읽는 데이터

| 출처 | 경로 |
| --- | --- |
| Claude Code 세션 | `~/.claude/projects/**/*.jsonl` |
| Codex 세션 | `~/.codex/sessions/**/rollout-*.jsonl`, Orca 의 Codex 계정 세션 |
| Orca Run·터미널 | `orca` CLI 호출 |
| 작업 계획 | `~/.agent-plans/<session>.jsonl` (`aplan` 이 기록) |
| 테스트 진행 | `/private/tmp/agent-test-progress/*.json` |
| 결정 대기 | `server/decision-hook` 이 등록한 AskUserQuestion 질문. 터미널 선택기와 같은 질문이다 (아래 「결정 버튼」) |
| 프로젝트 진행 | `--projects-dir` 로 준 폴더마다 `<프로젝트 폴더>/progress.json` (아래 「프로젝트 진행 API」, 지정하지 않으면 읽지 않음) |

## 실행

```sh
python3 server/server.py --origin https://dashboard.s-dante.com --origin https://agent-dashboard-2at.pages.dev
tailscale serve --bg 8787                                                  # 다른 기기용 https 주소 (선택)
```

로컬에서 페이지를 고칠 때는 `python3 scripts/dev-frontend.py` 로 띄우고 `http://127.0.0.1:5500` 을 연다(`--port` 로 바꿀 수 있다). `frontend/` 의 파일을 저장하면 열린 탭이 저절로 따라온다: CSS 는 새로 고치지 않고 그 자리에서 바뀌고, 나머지는 페이지를 새로 고친다. `http://localhost:*`·`http://127.0.0.1:*` 출처는 `--origin` 없이 허용된다.

| 옵션 | 기본값 | 뜻 |
| --- | --- | --- |
| `--port` | `8787` | 수신 포트 |
| `--hours` | `24` | 이 시간 안에 갱신된 세션만 추적 |
| `--runs` | `8` | 추적할 최근 Orca Run 의 최소 개수 |
| `--host` | `127.0.0.1` | 바인드 주소. 여러 번 줄 수 있다 |
| `--origin` | 없음 | CORS 를 허용할 페이지 출처. 하위 도메인(Pages 프리뷰 배포)도 포함하므로, 다른 서비스가 사는 도메인이면 그 하위 도메인들도 허용된다. 여러 번 줄 수 있다 |
| `--projects-dir` | 없음 (기능 꺼짐) | 프로젝트 폴더들을 담은 폴더. 바로 아래 하위 폴더 중 `progress.json` 이 있는 것을 프로젝트로 본다. 여러 번 줄 수 있다 |

## 상시 실행 (launchd)

`server/launchd/install.sh` 가 템플릿(`server/launchd/agent-dashboard.plist.in`)을 채워 `~/Library/LaunchAgents/` 에 설치하고 시작한다.

```sh
DASH_ORIGINS="https://dashboard.s-dante.com https://agent-dashboard-2at.pages.dev" server/launchd/install.sh   # 설치·재설치
server/launchd/install.sh uninstall                                                                           # 중지·제거
```

| 환경 변수 | 기본값 |
| --- | --- |
| `DASH_LABEL` | `local.agent-dashboard` |
| `DASH_HOSTS` | `127.0.0.1` (공백으로 구분) |
| `DASH_ORIGINS` | 없음 (공백으로 구분, `--origin` 으로 넘김) |
| `DASH_PYTHON` | `PATH` 의 `python3` |
| `DASH_PROJECTS_DIRS` | 없음 (`:` 로 구분 — 경로에 공백이 있을 수 있어서. 각각 `--projects-dir` 로 넘김) |

예: `DASH_PROJECTS_DIRS="$HOME/notes/projects" DASH_ORIGINS="…" server/launchd/install.sh`

- 같은 포트로 손으로 띄운 서버가 있으면 먼저 내려야 한다.
- 로그는 `server/server.log` 에 쌓인다.

## 프론트 배포 (Cloudflare Pages)

main 에 `frontend/`·`design-system/`·`scripts/deploy-frontend.sh` 변경이 들어오면 GitHub Actions(`.github/workflows/deploy-frontend.yml`)가 `scripts/deploy-frontend.sh` 로 프로덕션에 배포한다. Actions 탭에서 손으로 돌릴 수도 있다(workflow_dispatch).

- 저장소 시크릿 두 개가 있어야 돈다: `CLOUDFLARE_API_TOKEN`(권한 Account · Cloudflare Pages · Edit), `CLOUDFLARE_ACCOUNT_ID`.
- Pages 프로젝트가 직접 업로드 방식이라 Cloudflare 의 Git 연동은 쓰지 않는다(직접 업로드 프로젝트는 나중에 Git 을 붙일 수 없다).

손으로 배포할 때:

```sh
npx wrangler login              # 한 번
scripts/deploy-frontend.sh      # frontend/ 를 프로덕션에 배포 (프로젝트가 없으면 만든다)
PAGES_BRANCH=dev scripts/deploy-frontend.sh   # 프리뷰 배포 (<hash>.agent-dashboard-2at.pages.dev)
```

- `dashboard.s-dante.com` 은 Pages 프로젝트 `agent-dashboard` 의 커스텀 도메인이다 (`dashboard` CNAME → `agent-dashboard-2at.pages.dev`, 프록시).
- PWA 로 설치할 수 있다 (`manifest.webmanifest`, `sw.js`, `icons/`). Chrome·Edge 는 주소창의 설치 버튼, iOS Safari 는 공유 → 홈 화면에 추가. 서비스 워커는 이 출처의 페이지 파일만 네트워크 우선으로 캐시해 오프라인에서도 열리게 하고, 메트릭 서버 요청과 `build.json` 은 건드리지 않는다.
- 앱 아이콘은 바의 「앱 아이콘」에서 고른다: 컨셉 5종(그리드·펄스·봇·터미널·노드) × 색 4종(블루·에메랄드·선셋·그래파이트) = 20개, 이 기기에만 저장(`adash.icon`). `icon-boot.js` 가 고른 아이콘의 manifest·파비콘·apple-touch-icon 으로 링크를 바꾼다. 탭 아이콘은 바로 바뀌고, 설치한 앱은 브라우저가 다음에 manifest 를 확인할 때 바뀐다(Chrome 은 바꿀지 물을 수 있음). iOS 는 추가할 때의 아이콘을 유지하므로 홈 화면에 다시 추가해야 한다.
- 아이콘은 `scripts/make-icons.py` 가 만든다(SVG 템플릿 → headless Chrome 으로 PNG). 기본(그리드·블루)은 `icons/` 와 `manifest.webmanifest`, 나머지는 `icons/app/<컨셉>-<색>/` 에 manifest 와 함께 있다. 아이콘을 바꾸거나 더할 때는 스크립트를 고쳐 다시 돌리고, 목록은 `icon-boot.js` 에도 맞춘다.
- 배포본에는 `build.json` 이 붙는다. 열려 있는 탭은 1분마다, 그리고 화면에 다시 나타나거나 포커스·네트워크를 되찾을 때마다(10초에 한 번까지) 이것을 확인해 새 배포면 서비스 워커를 갱신하고 새로 고친다. 설치한 PWA 는 다시 열기보다 백그라운드에서 돌아오는 일이 많아서다.
- 서버와 페이지는 따로 배포되므로, `/api/*` 모양을 깨는 변경은 `server.py` 의 `API_VERSION` 과 `frontend/api.js` 의 `API_VERSION` 을 함께 올린다. 다르면 페이지가 그리지 않고 알린다.

## 결정 버튼 — AskUserQuestion 을 터미널과 대시보드 양쪽에서 답하기

`server/decision-hook` 은 AskUserQuestion 에 거는 Claude Code PreToolUse 훅이다. 질문을 메트릭 서버에 등록하고 아무것도 출력하지 않은 채 바로 끝난다. 그래서 터미널에는 평소처럼 선택기가 뜨고, 대시보드에는 같은 질문이 카드로 뜬다. 어느 쪽에서 답해도 된다.

```json
{"hooks": {"PreToolUse": [{"matcher": "AskUserQuestion",
  "hooks": [{"type": "command", "command": "<저장소>/server/decision-hook", "timeout": 10}]}]}}
```

- 터미널에서 답하면 트랜스크립트에 그 호출의 결과가 생기고, 서버가 카드를 치운다. 터미널에서 Esc 로 취소하거나 세션이 끝나도 마찬가지다.
- 대시보드에서 답하면 서버가 그 세션의 Orca 터미널에 키 입력(`orca terminal send`)으로 같은 답을 넣는다. 터미널은 훅이 넘긴 `ORCA_TERMINAL_HANDLE` 로 찾고, 없으면 대시보드가 세션에 연결해 둔 터미널을 쓴다.
- 키를 보내기 전과 매 단계 뒤에 터미널 화면(`orca terminal read --screen`)을 읽는다. 이 질문의 선택기가 처음 상태로 떠 있을 때만 시작하고, 화면이 예상과 다르면 그 자리에서 멈춘다. 선택기에 Esc 는 보내지 않으므로 질문은 터미널에 남는다.
- 대시보드에서 넣을 수 있는 답: 단일 선택, 여러 질문, 여러 개 고르기, 단일 선택의 「직접 입력」. 서버는 여러 개 고르기의 직접 입력(하나)도 받지만, 카드에는 아직 그 입력 칸이 없다.
- 카드가 「— 터미널에서 답하세요」라고 알리는 경우: Orca 밖 세션이라 터미널을 못 찾을 때, 선택기가 화면에 없거나 터미널에서 이미 답하기 시작했을 때, 키 입력이 예상대로 반영되지 않았을 때. 줄바꿈이 든 직접 입력처럼 키로 넣을 수 없는 답도 거절한다.
- 키 입력 흉내라서 Claude Code 선택기의 화면 모양·키 조작이 바뀌면 깨질 수 있다(v2.1 에서 확인). 그때도 터미널 선택기는 그대로 쓸 수 있다.
- 메트릭 서버에 닿지 않으면 훅은 바로 비켜선다. 터미널 선택기만 뜬다.
- 환경 변수: `DASH_URL` (기본 `http://127.0.0.1:8787`).

## aplan — 작업 계획 기록

에이전트가 여러 단계 작업을 시작할 때 단계를 기록하면, 대시보드가 세션 카드에 단계 차트로 그린다.

```sh
aplan set "단계 1" "단계 2" ...   # 계획 기록 (1단계 시작)
aplan add "단계" [...]            # 단계 추가
aplan done [N] [메모]             # N단계 완료 (기본: 진행 중인 단계), 다음 단계 시작
aplan start N                     # N단계를 명시적으로 시작
aplan skip N [메모] / aplan fail N [메모]
```

- 호출한 세션은 `CLAUDE_CODE_SESSION_ID` · `CODEX_THREAD_ID` · Orca 터미널 핸들 순으로 식별한다.
- 기록은 출력만 하는 명령이다. 실패해도 에이전트의 본 작업을 멈추지 않는다.

## 프로젝트 진행 API

`--projects-dir` 를 주면 그 폴더 바로 아래 하위 폴더 중 `progress.json` 이 있는 것을 프로젝트로 읽는다(조회 전용, 파일을 쓰지 않는다). 파일 형식은 `exports/project-progress.schema.json` 이고, 파일에는 원천 사실만 있으므로 아래 파생값은 모두 서버가 계산한다. 2초마다 mtime 을 보고 바뀐 파일만 다시 읽는다.

| 엔드포인트 | 응답 |
| --- | --- |
| `GET /api/projects` | `{"enabled", "version", "dirs": [{"dir", "error"}], "projects": [...]}` — 프로젝트마다 아래 필드, 단계(`stages`)에는 `steps` 를 빼고 |
| `GET /api/project?name=<폴더 이름>[&dir=<--projects-dir>]` | 프로젝트 하나, 단계마다 `steps` 포함. 같은 이름이 두 `--projects-dir` 에 있으면 `dir` 로 고르고, 없으면 먼저 준 폴더의 것. 없으면 404 |
| `GET /api/project/note?name=<폴더 이름>&path=<노트 경로>[&dir=]` | 프로젝트 폴더 안 노트 하나: `{"project", "path", "abs", "mtime", "content", "links": [{"target", "path"}]}`. `path` 는 프로젝트 폴더 기준(step 의 `path` 그대로). 스텝 노트가 아니어도 그 폴더 안 `.md` 면 준다 — 노트의 `[[링크]]` 를 따라갈 수 있게. `links` 는 본문의 위키링크를 같은 폴더 안 노트로 푼 것(볼트 경로면 뒤쪽이 가장 길게 맞는 것, 이름만이면 파일 이름으로; 폴더 밖이면 `null`). 실제 경로(symlink·`..` 해석 후)가 폴더 밖이거나 `.md` 가 아니면 404, 1MB 초과는 413 |
| `GET /events` | 기존 `data: <version>` 메시지와 별도로, 프로젝트가 바뀌면 이름 붙은 이벤트 `event: projects` / `data: <version>` 을 보낸다. 연결 직후 한 번 보낸다. `onmessage` 만 듣는 페이지는 깨우지 않는다 |

대시보드의 「프로젝트」 탭(바의 흐름 아이콘)이 이 API 를 그린다. 켜진 메트릭 서버 중 `--projects-dir` 로 띄운 서버의 프로젝트를 모두 모은다.

- **프로젝트별:** 프로젝트마다 단계를 단계 순서대로 한 줄로 잇는다. 프로젝트를 누르면 그 자리에서 펼쳐져(아코디언, 한 번에 하나) 단계와 스텝이 나온다. 단계 노드를 누르면 그 단계로 간다.
- **전체 시계열:** 굵은 줄기 하나에서 프로젝트마다 가지가 갈라진다. 날짜가 있는 사건마다 같은 간격의 칸을 주고(실제 날짜 간격에 비례하지 않음), 같은 날 끝난 단계는 나란히, 진행 중인 단계는 시작일부터 오늘까지 막대로 그린다. 모든 단계가 끝난 프로젝트는 줄기로 합류하고, 그 자리는 뒤에 갈라지는 가지가 다시 쓴다. 가로(시간 좌→우)·세로(위→아래)·자동(창 비율)으로 바꿀 수 있다. 프로젝트를 누르면 그 가지가 강조되고 상세가 그래프 아래(가로) 또는 옆(세로)에 나온다.
- **스텝을 누르면** 상세가 둘로 나뉘어 한쪽에 스텝 목록, 다른 쪽에 그 스텝의 Obsidian 노트(속성, 본문)가 나온다. 문서 자체는 Obsidian 에서 열린다: 스텝 줄의 「Obsidian」, 노트 제목, 「Obsidian 에서 열기」, 본문의 `[[링크]]`(프로젝트 폴더 안 노트는 `obsidian://open?path=<절대 경로>`, 폴더 밖은 Obsidian 검색).
- 가로로만 넘치는 영역(가로 그래프, 단계 줄)은 세로 휠로 가로 스크롤한다. 양 끝에서는 페이지가 스크롤된다.
- 기기별 저장값: `adash.proj` (보기, 방향).

`--projects-dir` 를 주지 않으면 `/api/projects` 는 `{"enabled": false, ...}`, `/api/project` 는 404, `projects` 이벤트는 나가지 않는다.

프로젝트 필드 (예: 폴더 `Sample App`)

```json
{"name": "Sample App", "dir": "/…/projects", "path": "/…/projects/Sample App/progress.json", "mtime": 1760000000.0,
 "error": null, "template": "basic", "generated_at": "2026-10-18T09:00:00+09:00",
 "status": "active", "total": 6, "counts": {"scheduling": 1, "pending": 1, "active": 1, "done": 2, "failed": 1},
 "ratio": 0.3333, "start": "2026-10-01", "end": "2026-10-20", "stage_count": 4,
 "current": {"no": 2, "name": "Build", "status": "active"},
 "stages": [{"no": 1, "name": "Design", "status": "failed", "total": 2, "counts": {…}, "ratio": 0.5,
             "start": "2026-10-01", "end": "2026-10-04",
             "steps": [{"path": "1 Design/spec.md", "title": "spec", "date": "2026-10-01", "endDate": "2026-10-03", "status": "done"}, …]}, …]}
```

- 파일을 읽지 못하거나 스키마에 맞지 않으면 그 프로젝트만 `error`(요약)와 `problems`(위반 목록)를 갖고 파생값 필드가 없다. 서버와 다른 프로젝트는 그대로 돈다. 열지 못한 `--projects-dir` 는 `dirs[].error` 에 뜬다.
- 검사하는 것: 스키마의 필수 키·알 수 없는 키·타입·`schemaVersion` 1·빈 문자열·`no` ≥ 1·`status` 값·`date`(YYYY-MM-DD)·`generatedAt`(RFC 3339)·`scheduling` 이면 날짜 없음, 아니면 `date` 있음. 설명에 적힌 것도 검사한다 — `no` 중복, 파일 안 `path` 중복, `project` 가 폴더 이름과 같음.

파생 규칙

- **단계 순서:** `no` 오름차순 (파일 안 순서가 아니라). 단계 안의 `steps` 는 순서가 의미 없다는 스키마에 따라 `date` 순(날짜 없는 것은 뒤), 같으면 `path` 순으로 준다.
- **step `title`:** `path` 의 파일 이름에서 확장자를 뺀 것 (스키마: 「Its title is the step name」).
- **개수·진행률:** `total` 은 단계의 step 수, `counts` 는 상태별 수, `ratio` = `done` / `total` (step 이 없으면 `null`). 프로젝트 값은 모든 단계의 step 을 합쳐 같은 식으로 낸다(단계 평균이 아니다).
- **기간 `start`/`end`:** 날짜가 있는 step 중 가장 이른 `date` 와 가장 늦은 `endDate`(없으면 그 `date` — 하루짜리). `pending` 의 계획 날짜와 `active` 의 「지금까지 일한 마지막 날」도 그대로 포함한다. 날짜 있는 step 이 없으면 `null`.
- **단계 상태** (step 상태들로, 위에서부터 처음 맞는 것. 프로젝트 `status` 도 모든 step 에 같은 규칙):
  1. `empty` — step 이 없다
  2. `done` — 모두 `done`
  3. `failed` — 모두 끝났는데(`done`/`failed`) 하나 이상 `failed`
  4. `active` — `active` 가 있거나, 끝난 step 과 남은 step(`pending`/`scheduling`)이 섞여 있다
  5. `pending` — 시작한 것은 없고 `pending` 이 있다
  6. `scheduling` — 모두 `scheduling`
- **현재 단계 `current`:** `active` 인 단계 중 `no` 가 가장 작은 것. 없으면 끝난 step 이 있는 마지막 단계 다음에서 처음 나오는 `pending`/`scheduling` 단계(끝난 step 이 하나도 없으면 처음부터). 그것도 없으면 `null`.

스키마에 근거가 없어 서버가 정한 것: 단계 상태 6가지와 그 우선순위(`empty` 추가, `done`·`failed` 가 섞인 채 끝난 단계는 `failed`, 일부만 끝나고 진행 중인 step 이 없는 단계도 `active`), `failed` step 을 진행률 분자에 넣지 않음, 계획 날짜를 기간에 포함, 현재 단계 고르는 법(앞 단계가 `scheduling` 으로 남아 있어도 뒤 단계가 진행 중이면 그쪽 — 단계가 순서대로만 진행되지 않는 실제 파일이 있어서), `endDate` < `date` 는 검사하지 않음.

## 설정 (`prefs.json`)

`server/prefs.json` 은 화면 설정(숨김·유휴 표시 등)과 아래 경로 설정을 담는다. git 추적 대상이 아니다.

| 키 | 뜻 |
| --- | --- |
| `external_plans` | 드라이버가 쓰는 외부 계획 파일 경로 목록 (`~` 사용 가능) |
| `run_tc_progress` | run-tc 진행 파일 경로 목록 |

## 보안

- **인증이 없다.** 바인드한 주소(루프백, tailnet 등)에 닿는 클라이언트는 모두 신뢰한다. 공용 네트워크 주소에 바인드하지 않는다.
- `Host` 헤더가 바인드 주소가 아닌 요청은 거부한다 (DNS rebinding 방지).
- 브라우저 요청은 `Origin` 이 `--origin`(과 로컬 출처) 밖이면 거부한다. 그래야 사용자가 연 다른 웹페이지가 세션 로그를 읽거나 터미널을 닫지 못한다. 페이지 자체는 공개라 누구나 열 수 있지만, 그 사람 브라우저는 그 사람 자신의 로컬 주소를 부를 뿐이다.
- 세션 로그 내용이 화면에 그대로 보인다. 화면 공유·원격 접근 시 주의한다.

## 공개 면

다른 도구·자동화가 의존해도 되는 것은 아래뿐이다. 나머지(웹 UI 가 쓰는 `/api/*` HTTP 엔드포인트 등)는 내부용이라 예고 없이 바뀔 수 있다.

- `aplan` CLI 와 그 기록 형식 (`~/.agent-plans/*.jsonl`)
- `server/server.py` 실행 옵션과 `server/launchd/install.sh` 환경 변수
- 테스트 진행 파일 형식 — `/private/tmp/agent-test-progress/` 에 실행 하나당 JSON 하나를 원자적으로(임시 파일에 쓴 뒤 rename) 갱신한다. 필드: `label` `kind` `phase` `detail` `total` `done` `passed` `failed` `pending` `started_at` `updated_at` `eta_s` `log` `owner` `terminal` `session_id`

- 프로젝트 진행 파일 형식 — `exports/project-progress.schema.json` (JSON Schema). 서버는 `--projects-dir` 아래에서 읽어 위 「프로젝트 진행 API」로 준다. 프로젝트마다 `progress.json` 하나에 흐름 단계(stage)와 단계마다 그 안의 작업(step — 날짜·상태 scheduling·pending·active·done·failed)만 담고, 단계 상태·기간·작업 수·진행률 같은 파생값은 대시보드가 계산한다.

## 로컬 상태 파일 (git 무시)

`server/` 아래에 쌓인다. 저장소 루트에 있던 것(구조 분리 전)은 `server/` 로 옮기면 그대로 이어진다.

`prefs.json` · `settled.json` · `plan-history.json` · `test-history.json` · `history-cache.json` · `server.log` · `.token`
