# adash — 메트릭 서버 코드

`server/server.py` 는 진입점만 갖고, 서버 코드는 이 패키지에 있다. 표준 라이브러리만 쓴다.

## 레이어

```
http/       요청을 받는 층: 호스트·출처 검사, CORS, JSON 응답, 경로 → 기능 엔드포인트(routes.py), /api/state 스냅숏과 /events
features/   기능별 폴더. 상태(store), 수집 루프(loop), 계산(service 등), 엔드포인트(api.py)
core/       공용 기반: 경로 설정, 큰 lock 과 변경 번호(version), prefs.json, 로그, 파일 캐시, Orca CLI, git, Jira
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
| `terminals/` | 세션이 도는 터미널 찾기, 아래 터미널까지 닫기 작업, 에이전트 띄우기(새 워크트리·기존 워크트리)와 프롬프트 보내기 | `/api/orca/job`, `/api/orca/places`, `POST /api/orca/focus·close·launch·send` |
| `chars/` | 「새 캐릭터」: 올린 원본 그림과 브리프로 Orca 에이전트를 띄워 캐릭터를 그리고 R2 에 올리게 함, 작업 폴더의 파일로 진행 판정 | `/api/chars/jobs`, `/api/chars/file`, `POST /api/chars/create·remove·unpublish` |
| `interactions/` | 에이전트 사이 메시지 (Orca 오케스트레이션 수신함) | `/api/interactions` |
| `plans/` | 외부(드라이버) 계획 파일, 계획의 주인 세션, 추가 상자 사유 | (스냅숏에 실림) |
| `tests/` | 긴 테스트 실행 진행과 끝난 기록 | `/api/tests` |
| `decisions/` | 결정 카드와 메일함: 등록(ask), 터미널 선택기 입력(picker), 답(answer), 세션 붙잡기(guard), 정리(sweep) | `/api/decision/*` |
| `projects/` | 프로젝트 진행 `progress.json` 검사·계산, 스텝 노트 | `/api/projects`, `/api/project`, `/api/project/note` |
| `designs/` | 설계 문서 색인(index·roots·toc), 도구 호출에서 읽은 줄 추적(shell_reads·reads), 섹션별 읽기 기록(refs) | `/api/designs`, `/api/design`, `/api/design/file`, `/api/design/refs` |
| `review/` | QA 묶음 리뷰(Jira·워크트리·PR), QA 드라이버, 반출 | `/api/reviews`, `POST /api/review/*`, `POST /api/qa/*` |
| `vault/` | 볼트 노트와 그것을 만든 세션 | `/api/vault/recent` |
| `flow/` | 정상 흐름 계약과 흐름 이탈 판정 | `POST /api/flow/ok` |

## 상태를 다룰 때

- 수집 스레드와 요청 스레드가 같은 dict 를 고친다. 읽기·쓰기는 `core.state.lock` 안에서 한다.
- 화면에 보일 변화가 있으면 `core.state.bump()` 로 변경 번호를 올린다. 페이지는 `/events` 로 이 번호를 받아 `/api/state` 를 다시 읽는다.
- 모듈 전역을 통째로 바꾸는 값(`global x; x = …`)은 다른 모듈에서 `from … import x` 로 받으면 옛 값에 묶인다. 그런 값은 모듈째 import 해서 `모듈.x` 로 읽는다. 예: `core_state.version`, `designs_store.design`, `terminals_targets.focus_handles`. dict·list 를 제자리에서 고치는 값은 그냥 import 해도 된다.
- 새 엔드포인트는 그 기능의 `api.py` 에 `def get_…(h, url)` / `def post_…(h, url)` 로 두고 `http/routes.py` 에 경로를 등록한다. `h` 는 요청 핸들러다(`h.send_json`, `h.send_body`, `h.encode`, `h.rfile`, `h.headers`).
- `/api/*` 응답 모양을 깨는 변경은 `http/snapshot.py` 의 `API_VERSION` 과 `frontend/api.js` 의 것을 함께 올린다.
