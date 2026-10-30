# adash — 메트릭 서버 코드

`server/server.py` 는 진입점만 갖고, 서버 코드는 이 패키지에 있다. 표준 라이브러리만 쓴다.

## 레이어

```
http/       요청을 받는 층: 호스트·출처 검사, CORS, JSON 응답, 경로 → 기능 엔드포인트(routes.py), /api/state 스냅숏과 그 구획·증분(snapshot.py), /events, 아이폰 위젯용 요약 /api/glance, macOS 앱 결정 감시용 /api/decisions
features/   기능별 폴더. 상태(store), 수집 루프(loop), 계산(service 등), 엔드포인트(api.py)
core/       공용 기반: 경로 설정, 큰 lock 과 변경 번호(version), prefs.json, 로그, 파일 캐시와 묵은 값을 주며 뒤에서 다시 읽는 캐시(files.py), Orca CLI, git, Jira
main.py     명령행 인자, 수집 스레드와 HTTP 서버 시작
```

의존은 아래 방향으로만 간다. `scripts/check-server.py` 가 검사한다.

- `core` 는 `core` 만 import 한다.
- `features/<기능>` 은 `core` 와 다른 기능을 import 할 수 있다. `http`·`main` 은 import 하지 않는다. 모듈 사이에 순환 import 를 만들지 않는다.
- 다른 기능의 `api.py` 는 import 하지 않는다. `api.py` 는 `http/routes.py` 만 불러 쓴다.
- `http` 는 `main` 을 import 하지 않는다.

## 기능

| 폴더 | 무엇 | 엔드포인트 (`api.py`) |
| --- | --- | --- |
| `sessions/` | Claude·Codex 대화 기록 수집(scan), 한 세션 파싱(session), 가격·사용량·작업 계획·위치·Orca 훅, 수동 유휴 표시 | `/api/session`, `/api/chat`, `/api/plans`, `POST /api/pref` |
| `history/` | 비교 탭의 일주일 사용량 (5분 칸) | `/api/history` |
| `orca_runs/` | Orca Run·태스크·워커·터미널 수집, 끝난 디스패치 보관 | `/api/run` |
| `terminals/` | 세션이 도는 터미널 찾기, 아래 터미널까지 닫기 작업, 에이전트 띄우기(새 워크트리·기존 워크트리)와 프롬프트 보내기, 대화 기록이 아직 없는 에이전트 터미널(프롬프트 없이 띄움)을 입력 대기 세션으로 보이기(pending) | `/api/orca/job`, `/api/orca/places`, `POST /api/orca/focus·close·launch·send` |
| `chars/` | 「새 캐릭터」: 올린 원본 그림과 브리프로 Orca 에이전트를 띄워 캐릭터를 그리고 R2 에 올리게 함, 작업 폴더의 파일로 진행 판정. 영구 삭제, 이름·생김새·역할 바꾸기, 시트 하나(종류·세트) 다시 그려 올리기(`redraw.py`, 시트 원본은 `~/.cache/agent-dashboard/char-sheets`) | `/api/chars/jobs`(+ `redraws`), `/api/chars/file`, `POST /api/chars/create·remove·unpublish·meta·redraw` |
| `interactions/` | 에이전트 사이 메시지 (Orca 오케스트레이션 수신함) | `/api/interactions` |
| `plans/` | 외부(드라이버) 계획 파일, 계획의 주인 세션, 추가 상자 사유 | (스냅숏에 실림) |
| `tests/` | 긴 테스트 실행 진행과 끝난 기록 | `/api/tests`, `/api/tests/run` |
| `decisions/` | 결정 카드와 메일함: 등록(ask), 터미널 선택기 입력(picker), 답(answer), 세션 붙잡기(guard), 정리(sweep) | `/api/decision/*` |
| `projects/` | 프로젝트 진행 `progress.json` 검사·계산, 스텝 노트 | `/api/projects`, `/api/project`, `/api/project/note` |
| `designs/` | 설계 문서 색인(index·roots·toc), 도구 호출에서 읽은 줄 추적(shell_reads·reads), 섹션별 읽기 기록(refs) | `/api/designs`, `/api/design`, `/api/design/file`, `/api/design/refs` |
| `review/` | QA 묶음 리뷰(Jira·워크트리·PR), QA 드라이버, 반출 | `/api/reviews`, `POST /api/review/*`, `POST /api/qa/*` |
| `plan_usage/` | 구독 계정별 플랜 사용량(「사용량」 탭): Claude 는 호스트 로그인(키체인 → `~/.claude/.credentials.json`)과 Orca 계정(키체인 `Orca Claude Code Managed Credentials`), Codex 는 `~/.codex`·Orca codex-accounts 의 토큰으로 각 사용량 API 를 계정마다 5분에 한 번(재시작해도 유지, 429·401 이면 늘려서) 읽는다. 토큰은 갱신하지 않고 읽기만 한다. 마지막 값은 `server/plan-usage.json` | (스냅숏에 실림) |
| `vault/` | 볼트 노트와 그것을 만든 세션 | `/api/vault/recent` |
| `flow/` | 정상 흐름 계약과 흐름 이탈 판정 | `POST /api/flow/ok` |
| `usage/` | 페이지의 기능 사용 기록(`frontend/usage.js`)을 환경과 함께 `server/usage.jsonl` 에 덧붙임. 분석은 `server/ausage` | `POST /api/usage` |
| `worktrees/` | 「워크트리」 탭: Orca 저장소마다 `git worktree list` 로 모든 워크트리(Orca 가 만들지 않은 것 포함, 각 저장소 .git 아래 서브모듈의 워크트리도 「서브모듈 · 상위 폴더」 저장소로)와 미커밋·마지막 커밋, 데스크톱·웹 VS Code 로 열기(루프백만), 워크트리별 메모(`server/worktree-notes.json`), 삭제(Orca 것은 `orca worktree rm`, 나머지는 `git worktree remove`, 메인 금지·루프백만; 잃는 것 — 미커밋·잠금·안의 서브모듈 워크트리·원격에 없는 서브모듈 커밋 — 이 없으면 서브모듈이 있어도 강제로 한 번에, 있으면 사유를 보이고 다시 물음) | `/api/worktrees`, `POST /api/worktrees/open·web·note·remove` |

## 상태를 다룰 때

- 수집 스레드와 요청 스레드가 같은 dict 를 고친다. 읽기·쓰기는 `core.state.lock` 안에서 한다.
- 화면에 보일 변화가 있으면 `core.state.bump()` 로 변경 번호를 올린다. 서버는 그 번호가 움직이면 스냅숏을 다시 만든다. 내용이 실제로 바뀌었을 때만 `/events` 로 내용 버전을 알리고, 페이지는 `/api/state?base=` 로 바뀐 것만 받는다(`http/snapshot.py` 의 `parts_*`, 저장소 README 「실시간 갱신」). 한 번의 수집에서 여러 곳을 고쳐도 `bump()` 는 끝에 한 번만 부른다.
- 스냅숏에 싣는 값은 화면 목록이 쓰는 것만이다. 펼쳐야 보이는 큰 목록(끝난 테스트의 케이스 등)은 따로 엔드포인트를 두고 펼칠 때 읽게 한다.
- 모듈 전역을 통째로 바꾸는 값(`global x; x = …`)은 다른 모듈에서 `from … import x` 로 받으면 옛 값에 묶인다. 그런 값은 모듈째 import 해서 `모듈.x` 로 읽는다. 예: `core_state.version`, `designs_store.design`, `terminals_targets.focus_handles`. dict·list 를 제자리에서 고치는 값은 그냥 import 해도 된다.
- 새 엔드포인트는 그 기능의 `api.py` 에 `def get_…(h, url)` / `def post_…(h, url)` 로 두고 `http/routes.py` 에 경로를 등록한다. `h` 는 요청 핸들러다(`h.send_json`, `h.send_body`, `h.encode`, `h.rfile`, `h.headers`).
- `/api/*` 응답 모양을 깨는 변경은 `http/snapshot.py` 의 `API_VERSION` 과 `frontend/api.js` 의 것을 함께 올린다.
