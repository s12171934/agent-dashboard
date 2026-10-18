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
| 결정 대기 | `server/decision-hook` 이 등록한 AskUserQuestion 질문 (아래 「결정 버튼」) |

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

- 같은 포트로 손으로 띄운 서버가 있으면 먼저 내려야 한다.
- 로그는 `server/server.log` 에 쌓인다.

## 프론트 배포 (Cloudflare Pages)

```sh
npx wrangler login              # 한 번
scripts/deploy-frontend.sh      # frontend/ 를 프로덕션에 배포 (프로젝트가 없으면 만든다)
PAGES_BRANCH=dev scripts/deploy-frontend.sh   # 프리뷰 배포 (<hash>.agent-dashboard-2at.pages.dev)
```

- `dashboard.s-dante.com` 은 Pages 프로젝트 `agent-dashboard` 의 커스텀 도메인이다 (`dashboard` CNAME → `agent-dashboard-2at.pages.dev`, 프록시).
- PWA 로 설치할 수 있다 (`manifest.webmanifest`, `sw.js`, `icons/`). Chrome·Edge 는 주소창의 설치 버튼, iOS Safari 는 공유 → 홈 화면에 추가. 서비스 워커는 이 출처의 페이지 파일만 네트워크 우선으로 캐시해 오프라인에서도 열리게 하고, 메트릭 서버 요청과 `build.json` 은 건드리지 않는다.
- 아이콘 원본은 `icons/icon.svg` 이고 PNG 는 그것을 렌더링한 것이다. 바꾸면 PNG 도 다시 만든다.
- 배포본에는 `build.json` 이 붙는다. 열려 있는 탭은 5분마다 이것을 확인해 새 배포면 새로 고친다.
- 서버와 페이지는 따로 배포되므로, `/api/*` 모양을 깨는 변경은 `server.py` 의 `API_VERSION` 과 `frontend/api.js` 의 `API_VERSION` 을 함께 올린다. 다르면 페이지가 그리지 않고 알린다.

## 결정 버튼 — AskUserQuestion 을 대시보드에서 답하기

`server/decision-hook` 은 AskUserQuestion 에 거는 Claude Code PreToolUse 훅이다. 질문을 메트릭 서버에 등록하고 기다리다가, 대시보드에서 온 답을 `updatedInput.answers` 로 Claude 에 넘긴다. 이 경우 터미널 선택기는 뜨지 않는다.

```json
{"hooks": {"PreToolUse": [{"matcher": "AskUserQuestion",
  "hooks": [{"type": "command", "command": "<저장소>/server/decision-hook", "timeout": 3600}]}]}}
```

- 카드의 「터미널에서 답하기」를 누르거나 `DECISION_WAIT`(기본 1800초)가 지나면 훅은 아무것도 돌려주지 않는다. 그러면 평소처럼 터미널 선택기가 뜬다. 훅의 `timeout` 은 `DECISION_WAIT` 보다 길게 준다.
- 메트릭 서버에 닿지 않으면 훅은 바로 비켜선다. 질문을 잃지 않는다.
- 훅이 기다리는 동안 터미널에는 선택기 대신 「running PreToolUse hooks」가 보인다. 터미널에서 답하려면 대시보드에서 넘긴다.
- 세션이 중단돼 훅이 끝나면 카드도 닫힌다. 트랜스크립트에 그 호출의 결과가 이미 있으면 서버가 카드를 치운다.
- 환경 변수: `DASH_URL` (기본 `http://127.0.0.1:8787`), `DECISION_WAIT`.

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

- 프로젝트 진행 파일 형식 — `exports/project-progress.schema.json` (JSON Schema). 프로젝트마다 `progress.json` 하나에 흐름 단계(stage)와 단계마다 그 안의 작업(step — 날짜·상태 scheduling·pending·active·done·failed)만 담고, 단계 상태·기간·작업 수·진행률 같은 파생값은 대시보드가 계산한다.

## 로컬 상태 파일 (git 무시)

`server/` 아래에 쌓인다. 저장소 루트에 있던 것(구조 분리 전)은 `server/` 로 옮기면 그대로 이어진다.

`prefs.json` · `settled.json` · `plan-history.json` · `test-history.json` · `history-cache.json` · `server.log` · `.token`
