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
    // 프로젝트: a driver plan's tickets, the open ones under way first
    struct Project: Decodable {
        struct Ticket: Decodable { let jira: String?, package: String?, status: String?, done: Int, total: Int }
        let project: String?, error: String?, tickets: Int, done: Int, boxes_done: Int, boxes_total: Int, open: [Ticket]
        var fraction: Double { boxes_total > 0 ? Double(boxes_done) / Double(boxes_total) : tickets > 0 ? Double(done) / Double(tickets) : 0 }
    }
    // 흐름 점검: the flow check's deviations, bad first
    struct Flow: Decodable {
        struct Item: Decodable { let rule: String?, severity: String?, reason: String, title: String?, path: String? }
        let bad: Int, warn: Int, items: [Item]
    }
    let decisions: [Decision]
    let agents: Agents
    let tests: [Test]
    // optional: a server older than these widgets leaves them out
    var usage: [Account]? = nil
    var plans: [Plan]? = nil
    var projects: [Project]? = nil
    var flow: Flow? = nil

    static func load() async throws -> Glance {
        var req = URLRequest(url: AppGroup.serverURL.appending(path: "api/glance"))
        req.timeoutInterval = 10
        let (data, res) = try await URLSession.shared.data(for: req)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(Glance.self, from: data)
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
        projects: [Project(project: "PRD-51", error: nil, tickets: 3, done: 2, boxes_done: 13, boxes_total: 16,
                           open: [.init(jira: "PSD-1007", package: "S3", status: "planned", done: 0, total: 3)]),
                   Project(project: "PRD-60", error: nil, tickets: 12, done: 10, boxes_done: 68, boxes_total: 68, open: [])],
        flow: Flow(bad: 1, warn: 3, items: [.init(rule: "정체", severity: "bad", reason: "기대 시간의 5.3배 경과", title: "PSD-1030 e2e", path: nil),
                                            .init(rule: "계획 미이행", severity: "warn", reason: "세션이 끝났는데 계획 1단계가 남음", title: "PSQ-1109", path: nil)]))
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
}

// Every widget reads the same glance; WidgetKit asks again after a few minutes, and the app asks it to whenever the
// 결정 대기 list changes while it runs.
struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry { GlanceEntry(date: .now, glance: .sample, error: nil) }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        if context.isPreview { return completion(placeholder(in: context)) }
        Task { completion(await entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        Task {
            let e = await entry()
            completion(Timeline(entries: [e], policy: .after(.now.addingTimeInterval(e.glance == nil ? 120 : 300))))
        }
    }

    private func entry() async -> GlanceEntry {
        do { return GlanceEntry(date: .now, glance: try await Glance.load(), error: nil) }
        catch { return GlanceEntry(date: .now, glance: nil, error: "대시보드 서버에 연결할 수 없음") }
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
