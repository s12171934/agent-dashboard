import AppIntents
import Foundation
import WidgetKit

// The metric server's /api/glance (server/adash/http/snapshot.py): the few KB the widgets show.
struct Glance: Decodable {
    struct Decision: Decodable, Identifiable {
        let id: String, title: String, header: String?, question: String, more: Int, options: [String], path: String?
    }
    struct Agent: Decodable {
        let title: String?, state: String, model: String?, last_ts: String?, path: String?
        var last: Date? { last_ts.flatMap(parseDate) }
    }
    struct Agents: Decodable { let counts: [String: Int]; let busy: [Agent] }
    struct Test: Decodable {
        let label: String?, kind: String?, phase: String?, total: Int?, done: Int?, passed: Int?, failed: Int?, eta_s: Double?
        let started_at: String?, updated_at: String?
        var verdict: String? = nil  // warn|red|error: not a failing test (the server's judge.py)
        var updated: Date? { updated_at.flatMap(parseDate) }
        var running: Bool { phase == "running" }
        var fraction: Double? { total.flatMap { $0 > 0 ? Double(done ?? 0) / Double($0) : nil } }
    }
    // 사용량: one subscription account's limits (the 플랜 사용량 page)
    struct Account: Decodable {
        struct Limit: Decodable {
            let kind: String?, name: String, percent: Double?, resets_at: Double?
            var resets: Date? { resets_at.map { Date(timeIntervalSince1970: $0) } }
        }
        let provider: String?, email: String?, plan: String?, stale: Bool, limits: [Limit]
    }
    // 작업 계획: a live agent's aplan steps (done|run|todo|skip|fail each)
    struct Plan: Decodable {
        let title: String?, state: String, path: String?, steps: [String], done: Int, total: Int, cur: String
    }
    // 프로젝트: a project folder's progress.json, as the 프로젝트 screen lists it
    struct Project: Decodable {
        let name: String?, error: String?, ratio: Double, total: Int, done: Int, stage: String?, stage_no: Int?, stages: Int?, end: String?
        var finished: Bool { ratio >= 1 }
    }
    // 흐름 점검: the flow check's deviations, bad first
    struct Flow: Decodable {
        struct Item: Decodable { let rule: String?, severity: String?, reason: String, title: String?, path: String? }
        let bad: Int, warn: Int, items: [Item]
    }
    // QA 워크트리 리뷰: a running QA set, its tickets per driver stage, the blocked and the ones waiting for 반출 승인
    struct QASet: Decodable {
        struct Ticket: Decodable { let key: String?, summary: String, stage: String?, reason: String? }
        // counts: blocked, approve, working, waiting, delivered (the page's 워크트리 리뷰 tile groups)
        let epic: String?, summary: String, open: Int, counts: [String: Int], blocked: [Ticket], approve: [Ticket]
    }
    // 홈's 내 차례: dec (결정), ask (보고 확인), blocked (QA 막힘), approve (반출 승인)
    struct Mine: Decodable {
        struct Item: Decodable { let kind: String, title: String?, detail: String?, path: String? }
        let total: Int, counts: [String: Int], items: [Item]
    }
    struct TestCounts: Decodable { let live: Int, finished: Int, failed: Int }
    // 상호작용: a message between agents
    struct Message: Decodable {
        let type: String?, from: String, to: String, subject: String, body: String, at: String?
        var date: Date? { at.flatMap(parseDate) }
    }
    // 설계문서
    struct Designs: Decodable {
        struct Doc: Decodable { let key: String, title: String, kind: String?, mtime: Double?, sessions: Int }
        let docs: Int, sources: Int, recent: [Doc], read: [Doc]
    }
    // 워크트리
    struct Trees: Decodable {
        struct Repo: Decodable { let name: String?, worktrees: Int, dirty: Int }
        struct Dirty: Decodable { let repo: String?, name: String?, branch: String?, dirty: Int, committed: Double? }
        let repos: [Repo], dirty: [Dirty]
    }
    // 비교: today's cost, by hour and by agent
    struct Cost: Decodable {
        struct Top: Decodable { let title: String?, model: String?, cost: Double, path: String? }
        let total: Double, hours: [Double], now_hour: Int, top: [Top]
    }
    let decisions: [Decision]
    let agents: Agents
    let tests: [Test]
    // optional: a server older than these widgets leaves them out
    var usage: [Account]? = nil
    var plans: [Plan]? = nil
    var projects: [Project]? = nil
    var flow: Flow? = nil
    var cost: Cost? = nil
    var test_counts: TestCounts? = nil
    var mine: Mine? = nil
    var qa: [QASet]? = nil
    var talk: [Message]? = nil
    var designs: Designs? = nil
    var trees: Trees? = nil

    // `failed`: the last failure this extension saw, sent along so the server's log shows what the phone met
    static func fetch(failed: GlanceFailure? = nil) async throws -> Data {
        var url = AppGroup.serverURL.appending(path: "api/glance")
        if let failed {
            url.append(queryItems: [URLQueryItem(name: "failed_at", value: String(Int(failed.at.timeIntervalSince1970))),
                                    URLQueryItem(name: "reason", value: failed.reason)])
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        let (data, res) = try await URLSession.shared.data(for: req)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw GlanceFailure.Status(code: status) }
        return data
    }

    static let sample = Glance(
        decisions: [Decision(id: "q1", title: "PSQ-1103 화면 실측", header: "로그인",
                             question: "실측에는 로컬 DB 안에 있는 교사의 로그인이 필요합니다. 어떻게 로그인할까요?", more: 0,
                             options: ["직접 로그인함", "비밀번호 재설정", "계정 알려줌"], path: nil)],
        agents: Agents(counts: ["run": 3, "stalled": 1, "wait": 5, "bg": 2],
                       busy: [Agent(title: "PSQ-1100 화면 실측", state: "run", model: "claude-opus-5-5", last_ts: nil, path: nil),
                              Agent(title: "PL-PIN 통합 리뷰", state: "run", model: "claude-opus-5-5", last_ts: nil, path: nil),
                              Agent(title: "QA 드라이버", state: "wait", model: "claude-sonnet-5-5", last_ts: nil, path: nil)]),
        tests: [Test(label: "PSD-1007 재연결 복구 jest", kind: "jest", phase: "running", total: 171, done: 120, passed: 118, failed: 2,
                     eta_s: 40, started_at: nil, updated_at: nil)],
        usage: [Account(provider: "claude", email: "me@example.com", plan: "Team", stale: false,
                        limits: [.init(kind: "session", name: "5시간 세션", percent: 71, resets_at: Date.now.timeIntervalSince1970 + 7200),
                                 .init(kind: "weekly_all", name: "주간 전체", percent: 87, resets_at: Date.now.timeIntervalSince1970 + 200_000)]),
                Account(provider: "codex", email: "me@example.com", plan: "Business", stale: false,
                        limits: [.init(kind: "primary_window", name: "주간", percent: 17, resets_at: nil)])],
        plans: [Plan(title: "다양한 위젯", state: "run", path: nil, steps: ["done", "done", "run", "todo", "todo"], done: 2, total: 5,
                     cur: "iOS 위젯 4종 추가"),
                Plan(title: "QA 필터 탭 개선", state: "wait", path: nil, steps: ["done", "done", "done", "run"], done: 3, total: 4,
                     cur: "PR 머지·포인터 갱신")],
        projects: [Project(name: "PRD-19 리스닝·리딩 모바일 사용성", error: nil, ratio: 0.775, total: 40, done: 31, stage: "구현", stage_no: 5, stages: 9, end: "2026-10-30"),
                   Project(name: "PRD-60 회원가입 마케팅 수신동의", error: nil, ratio: 0.69, total: 29, done: 20, stage: "구현", stage_no: 5, stages: 9, end: nil)],
        flow: Flow(bad: 1, warn: 3, items: [.init(rule: "정체", severity: "bad", reason: "응답 없음 — 턴이 열린 채 기록 없음", title: "PSD-1030 e2e", path: nil),
                                            .init(rule: "계획 미이행", severity: "warn", reason: "세션이 끝났는데 계획 1단계가 남음", title: "PSQ-1109", path: nil)]),
        cost: Cost(total: 305.02, hours: [15, 25, 19, 5, 0, 0, 0, 0, 0, 42, 63, 81, 55] + Array(repeating: 0, count: 11), now_hour: 12,
                   top: [.init(title: "ego-lite 모바일 화면 실측", model: "claude-opus-5-5", cost: 15.49, path: nil),
                         .init(title: "Orca 워커 브리프 검증", model: "claude-opus-5-5", cost: 14.74, path: nil)]),
        test_counts: TestCounts(live: 1, finished: 12, failed: 2),
        mine: Mine(total: 2, counts: ["dec": 1, "ask": 0, "blocked": 1, "approve": 0],
                   items: [.init(kind: "dec", title: "PSQ-1103 화면 실측", detail: "로그인", path: nil),
                           .init(kind: "blocked", title: "PSQ-1098", detail: "시트의 확정 문구가 아직 없어 멈춤", path: nil)]),
        qa: [QASet(epic: "PSQ-1096", summary: "[PRD49,50] S/W iBT TOEFL QA", open: 3,
                   counts: ["blocked": 1, "approve": 1, "working": 1, "waiting": 0, "delivered": 0],
                   blocked: [.init(key: "PSQ-1098", summary: "Speaking 활동 만들기 '텍스트 가리기' 설명 문구", stage: "analysis",
                                   reason: "시트의 확정 문구가 아직 없어 사용자 결정에 따라 구현을 멈춤")],
                   approve: [.init(key: "PSQ-1101", summary: "리딩 결과 화면 점수 표기", stage: "committed", reason: nil)])],
        talk: [Message(type: "question", from: "rebase 워커", to: "코디네이터", subject: "Question", body: "fc 재베이스 충돌 판단: 필수와 선택 중 어느 쪽으로 갈까요?", at: nil),
               Message(type: "status", from: "코디네이터", to: "rebase 워커", subject: "Re: Question", body: "B 로 간다. main 의 의도를 살린다.", at: nil)],
        designs: Designs(docs: 659, sources: 10,
                         recent: [.init(key: "a", title: "[PRD-19] 리스닝·리딩 모바일 사용성 개선 설계", kind: "md", mtime: Date.now.timeIntervalSince1970 - 3600, sessions: 421),
                                  .init(key: "b", title: "TA 대화형 학습 — 설계 문서", kind: "md", mtime: Date.now.timeIntervalSince1970 - 40000, sessions: 4)],
                         read: []),
        trees: Trees(repos: [.init(name: "plang-front-common", worktrees: 16, dirty: 1), .init(name: "plang_projects", worktrees: 10, dirty: 7)],
                     dirty: [.init(repo: "plang_projects", name: "PSQ-1098", branch: "PSQ-1098", dirty: 3, committed: nil)]))
}

private let isoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let iso = ISO8601DateFormatter()
func parseDate(_ s: String) -> Date? { isoFrac.date(from: s) ?? iso.date(from: s) }

// The page's names and colours for an agent's state (frontend/app.js ST_LABEL).
enum AgentState: String, CaseIterable {
    case run, stalled, wait, bg
    var label: String { ["run": "실행 중", "stalled": "응답 없음", "wait": "입력 대기", "bg": "백그라운드"][rawValue]! }
    var short: String { ["run": "실행", "stalled": "멈춤", "wait": "대기", "bg": "백그"][rawValue]! }
}

struct GlanceEntry: TimelineEntry {
    let date: Date
    let glance: Glance?
    let error: String?
    // set when the glance shown is the last one read before a failed fetch: when it was read
    var stale: Date? = nil
}

// Why a fetch failed, in the widget's words; also what the next fetch reports to the server.
struct GlanceFailure: Codable {
    struct Status: Error { let code: Int }
    let at: Date
    let reason: String

    init(_ error: Error) {
        at = .now
        switch error {
        case let e as Status: reason = "HTTP \(e.code)"
        case is DecodingError: reason = "decode: \(error)".prefix(200).description
        case let e as URLError: reason = "URLError \(e.code.rawValue)"
        default: reason = String(describing: error).prefix(200).description
        }
    }

    // what the widget says when it has nothing to show
    static func message(_ error: Error) -> String {
        switch error {
        case let e as Status: return "대시보드 서버 오류 (HTTP \(e.code))"
        case is DecodingError: return "서버 응답을 읽지 못함 — 앱과 서버 버전 확인"
        case let e as URLError:
            switch e.code {
            case .timedOut: return "대시보드 서버 응답 없음 (10초)"
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
                return "iPhone 네트워크 연결 없음"
            default: return "대시보드 서버에 연결할 수 없음"
            }
        default: return "대시보드 서버에 연결할 수 없음"
        }
    }
}

// One glance for every widget: WidgetKit asks each widget for its timeline on its own, so a fetch each would show
// numbers from different moments side by side. The extension keeps the last fetch for a short while and every widget
// takes it; when a fetch brings something new, every widget is asked to redraw from it.
// A failed fetch (the phone just woke, the VPN is reconnecting, Wi-Fi handing over to cellular) is tried once more;
// still failing, the widgets keep showing the last glance read, marked with its age, rather than an error. The last
// glance is kept on disk too: WidgetKit ends the extension's process between refreshes.
actor GlanceCache {
    static let shared = GlanceCache()
    static let fresh: TimeInterval = 45
    static let keep: TimeInterval = 6 * 3600  // an older glance is no longer worth showing
    private var data: Data?, glance: Glance?, at = Date.distantPast
    private var restored = false
    private var failed: GlanceFailure?
    private var running: Task<Data, Error>?

    private static let file = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appending(path: "glance.json")

    // -> the glance, and when it was read if it is an old one shown after a failure
    func load() async throws -> (Glance, Date?) {
        restore()
        if let glance, Date.now.timeIntervalSince(at) < Self.fresh { return (glance, nil) }
        do {
            // widgets asking together wait on one request
            let report = failed
            let task = running ?? Task {
                // a network blip, not the server: once more after a moment (not after a timeout: WidgetKit gives the
                // extension only so long)
                do { return try await Glance.fetch(failed: report) } catch let e as URLError where e.code != .timedOut {
                    try await Task.sleep(for: .seconds(2))
                    return try await Glance.fetch(failed: report)
                }
            }
            running = task
            defer { running = nil }
            let new = try await task.value
            let g = try JSONDecoder().decode(Glance.self, from: new)
            let changed = data != nil && data != new
            (data, glance, at, failed) = (new, g, .now, nil)
            try? new.write(to: Self.file, options: .atomic)
            if changed { Task { @MainActor in WidgetCenter.shared.reloadAllTimelines() } }  // the others take it from here
            return (g, nil)
        } catch {
            failed = GlanceFailure(error)
            if let glance, Date.now.timeIntervalSince(at) < Self.keep { return (glance, at) }
            throw error
        }
    }

    // the glance the last process read, if this one has none yet
    private func restore() {
        guard !restored else { return }
        restored = true
        guard glance == nil, let d = try? Data(contentsOf: Self.file), let g = try? JSONDecoder().decode(Glance.self, from: d),
              let mtime = (try? FileManager.default.attributesOfItem(atPath: Self.file.path()))?[.modificationDate] as? Date
        else { return }
        (data, glance, at) = (d, g, mtime)
    }

    // after an answer from a widget: the next read fetches
    func drop() { at = min(at, .now.addingTimeInterval(-Self.fresh)) }
}

// Every widget refreshes at the same five-minute marks (two when the server is not reachable), so they fetch together.
private func nextMark(every: TimeInterval) -> Date {
    Date(timeIntervalSince1970: (Date.now.timeIntervalSince1970 / every).rounded(.down) * every + every)
}

// Every widget reads the same glance (GlanceCache); WidgetKit asks again at the next mark, and the app asks it to
// whenever the 결정 대기 list changes while it runs or it comes to the front.
struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry { GlanceEntry(date: .now, glance: .sample, error: nil) }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        if context.isPreview { return completion(placeholder(in: context)) }
        Task { completion(await entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        Task {
            let e = await entry()
            let ok = e.glance != nil && e.stale == nil
            completion(Timeline(entries: [e], policy: .after(nextMark(every: ok ? 300 : 120))))
        }
    }

    private func entry() async -> GlanceEntry {
        do {
            let (g, stale) = try await GlanceCache.shared.load()
            return GlanceEntry(date: .now, glance: g, error: nil, stale: stale)
        } catch {
            return GlanceEntry(date: .now, glance: nil, error: GlanceFailure.message(error))
        }
    }
}

// A choice pressed on the widget: one answer into the session's terminal, as a notification's button does.
struct AnswerIntent: AppIntent {
    static let title: LocalizedStringResource = "결정에 답하기"
    static let isDiscoverable = false

    @Parameter(title: "질문") var id: String
    @Parameter(title: "답") var answer: String

    init() {}
    init(id: String, answer: String) { self.id = id; self.answer = answer }

    func perform() async throws -> some IntentResult {
        var req = URLRequest(url: AppGroup.serverURL.appending(path: "api/decision/answer"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["id": id, "answers": [answer]])
        req.timeoutInterval = 10
        _ = try await URLSession.shared.data(for: req)
        await GlanceCache.shared.drop()
        return .result()  // WidgetKit reloads the widget after an intent
    }
}

// Where a tap opens the app (agentdash://, DashboardController.openLink).
enum Deep {
    static func screen(_ hash: String) -> URL { URL(string: "agentdash://\(hash)")! }
    static func session(_ path: String?) -> URL {
        guard let path else { return screen("decide") }
        var c = URLComponents(string: "agentdash://session")!
        c.queryItems = [URLQueryItem(name: "path", value: path)]
        return c.url!
    }
}
