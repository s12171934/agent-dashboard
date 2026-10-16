# agent-dashboard

Claude Code·Codex 에이전트 세션, Orca Run, `aplan` 작업 계획을 한 화면에서 실시간으로 보여 주는 로컬 웹 대시보드다.

- 세션 로그를 증분으로 읽어 상태 변화를 SSE 로 브라우저에 밀어 준다.
- 세션별 토큰·비용, 진행 중인 단계, 에이전트 사이 상호작용, 테스트 실행, 결정 대기 질문을 보여 준다.
- 서버는 Python 표준 라이브러리만 쓴다. 설치할 의존성이 없다.

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
| 결정 대기 (선택) | 로컬 결정 버튼 서버 (`127.0.0.1:8799`) |

## 실행

```sh
python3 server.py                       # http://127.0.0.1:8787
python3 server.py --port 8787 --hours 24 --host 127.0.0.1 --host <tailscale ip>
```

| 옵션 | 기본값 | 뜻 |
| --- | --- | --- |
| `--port` | `8787` | 수신 포트 |
| `--hours` | `24` | 이 시간 안에 갱신된 세션만 추적 |
| `--runs` | `8` | 추적할 최근 Orca Run 의 최소 개수 |
| `--host` | `127.0.0.1` | 바인드 주소. 여러 번 줄 수 있다 |

## 상시 실행 (launchd)

`launchd/install.sh` 가 템플릿(`launchd/agent-dashboard.plist.in`)을 채워 `~/Library/LaunchAgents/` 에 설치하고 시작한다.

```sh
DASH_HOSTS="127.0.0.1 <tailscale ip>" launchd/install.sh   # 설치·재설치
launchd/install.sh uninstall                               # 중지·제거
```

| 환경 변수 | 기본값 |
| --- | --- |
| `DASH_LABEL` | `local.agent-dashboard` |
| `DASH_HOSTS` | `127.0.0.1` (공백으로 구분) |
| `DASH_PYTHON` | `PATH` 의 `python3` |

- 같은 포트로 손으로 띄운 서버가 있으면 먼저 내려야 한다.
- 로그는 저장소 폴더의 `server.log` 에 쌓인다.

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

저장소 폴더의 `prefs.json` 은 화면 설정(숨김·유휴 표시 등)과 아래 경로 설정을 담는다. git 추적 대상이 아니다.

| 키 | 뜻 |
| --- | --- |
| `external_plans` | 드라이버가 쓰는 외부 계획 파일 경로 목록 (`~` 사용 가능) |
| `run_tc_progress` | run-tc 진행 파일 경로 목록 |

## 보안

- **인증이 없다.** 바인드한 주소(루프백, tailnet 등)에 닿는 클라이언트는 모두 신뢰한다. 공용 네트워크 주소에 바인드하지 않는다.
- `Host` 헤더가 바인드 주소가 아닌 요청은 거부한다 (DNS rebinding 방지).
- 세션 로그 내용이 화면에 그대로 보인다. 화면 공유·원격 접근 시 주의한다.

## 공개 면

다른 도구·자동화가 의존해도 되는 것은 아래뿐이다. 나머지(웹 UI 가 쓰는 `/api/*` HTTP 엔드포인트 등)는 내부용이라 예고 없이 바뀔 수 있다.

- `aplan` CLI 와 그 기록 형식 (`~/.agent-plans/*.jsonl`)
- `server.py` 실행 옵션과 `launchd/install.sh` 환경 변수
- 테스트 진행 파일 형식 — `/private/tmp/agent-test-progress/` 에 실행 하나당 JSON 하나를 원자적으로(임시 파일에 쓴 뒤 rename) 갱신한다. 필드: `label` `kind` `phase` `detail` `total` `done` `passed` `failed` `pending` `started_at` `updated_at` `eta_s` `log` `owner` `terminal` `session_id`

## 로컬 상태 파일 (git 무시)

`prefs.json` · `settled.json` · `plan-history.json` · `test-history.json` · `history-cache.json` · `server.log` · `.token`
