import SwiftUI
import WidgetKit

// One widget per page screen not covered in Widgets.swift and Insights.swift: 홈 (내 차례 and a tile per screen),
// QA (워크트리 리뷰), 상호작용, 설계문서, 워크트리 and 비용 (비교). They read the screens' summaries in /api/glance
// (server/adash/http/glance_screens.py).

private func dollars(_ v: Double) -> String { v >= 100 ? String(format: "$%.0f", v) : String(format: "$%.2f", v) }

// MARK: 홈

struct HomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "home", provider: GlanceProvider()) { e in
            HomeView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("홈")
        .description("내 차례(결정·보고 확인·QA 막힘·반출 승인)와 화면마다 페이지 홈과 같은 숫자 하나.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryInline])
    }
}

// a 내 차례 item's kind, as the page's hmMine names it
private let mineKind: [String: (String, Color)] = ["dec": ("결정", .orange), "ask": ("보고 확인", .indigo), "blocked": ("QA 막힘", .red),
                                                   "approve": ("반출 승인", .orange)]

struct HomeView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var g: Glance? { entry.glance }
    private var mine: Glance.Mine? { g?.mine }
    private var total: Int { mine?.total ?? g?.decisions.count ?? 0 }
    private func count(_ k: String) -> Int { mine?.counts[k] ?? 0 }

    private struct Tile: Identifiable {
        let id: String, label: String, value: String, symbol: String, tint: Color, hot: Bool
    }
    // each the figure the page's 홈 tile shows for that screen
    private var tiles: [Tile] {
        guard let g else { return [] }
        let n = { (s: AgentState) in g.agents.counts[s.rawValue] ?? 0 }
        var out = [
            Tile(id: "decide", label: "결정 대기", value: "\(g.decisions.count)", symbol: "questionmark.bubble.fill", tint: .orange, hot: !g.decisions.isEmpty),
            Tile(id: "agents", label: "실행 · 대기 \(n(.wait))", value: "\(n(.run) + n(.bg))", symbol: "person.2.fill", tint: .green, hot: n(.stalled) > 0),
        ]
        if let t = g.test_counts {
            out.append(t.live > 0 ? Tile(id: "tests", label: "테스트 실행 중", value: "\(t.live)", symbol: "flask.fill", tint: .purple, hot: true)
                                  : Tile(id: "tests", label: "테스트 실패", value: "\(t.failed)", symbol: "flask.fill", tint: .red, hot: t.failed > 0))
        }
        if let qa = g.qa {
            let c = { (k: String) in qa.reduce(0) { $0 + ($1.counts[k] ?? 0) } }
            out.append(c("approve") > 0 ? Tile(id: "worktrees", label: "QA 반출 승인", value: "\(c("approve"))", symbol: "checklist", tint: .orange, hot: true)
                                         : Tile(id: "worktrees", label: "QA 작업 중", value: "\(c("working"))", symbol: "checklist", tint: .pink, hot: c("blocked") > 0))
        }
        if let c = g.cost { out.append(Tile(id: "compare", label: "오늘 비용", value: dollars(c.total), symbol: "chart.bar.fill", tint: .mint, hot: false)) }
        if let top = g.usage?.filter({ !$0.stale }).flatMap(\.limits).compactMap(\.percent).max() {
            out.append(Tile(id: "usage", label: "사용량 최고", value: "\(Int(top))%", symbol: "gauge.with.dots.needle.67percent", tint: top >= 90 ? .red : .teal, hot: top >= 70))
        }
        if let ps = g.projects {
            let open = ps.filter { !$0.finished && $0.error == nil }
            out.append(Tile(id: "projects", label: "프로젝트 진행", value: open.isEmpty ? "없음" : "\(open.count)개", symbol: "point.3.connected.trianglepath.dotted", tint: .blue, hot: false))
        }
        if let f = g.flow { out.append(Tile(id: "home", label: "흐름 점검", value: "\(f.bad + f.warn)", symbol: "stethoscope", tint: .red, hot: f.bad > 0)) }
        if let t = g.trees { out.append(Tile(id: "trees", label: "미커밋 워크트리", value: "\(t.repos.reduce(0) { $0 + $1.dirty })", symbol: "arrow.triangle.branch", tint: .brown, hot: false)) }
        return out
    }

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "hand.raised").font(.caption)
                    Text(g == nil ? "–" : "\(total)").font(.title2.weight(.bold)).minimumScaleFactor(0.5)
                }
            }
            .widgetURL(Deep.screen("home"))
        case .accessoryInline:
            Label(g == nil ? "내 차례 –" : total == 0 ? "내 차례 없음" : "내 차례 \(total)", systemImage: "hand.raised")
                .widgetURL(Deep.screen("home"))
        case .systemSmall:
            VStack(alignment: .leading, spacing: 4) {
                Header(title: "내 차례", symbol: "hand.raised.fill", tint: .orange)
                if g == nil { Offline(error: entry.error) }
                else if total == 0 { allClear }
                else {
                    Text("\(total)").font(.system(size: 38, weight: .bold, design: .rounded)).foregroundStyle(.orange)
                    Text(["dec", "ask", "blocked", "approve"].filter { count($0) > 0 }.map { "\(mineKind[$0]!.0) \(count($0))" }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    Spacer(minLength: 0)
                }
            }
            .widgetURL(Deep.screen("home"))
        default:
            VStack(alignment: .leading, spacing: 8) {
                Header(title: "홈", symbol: "house.fill", tint: .accentColor)
                if g == nil { Offline(error: entry.error) }
                else {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
                        ForEach(Array(tiles.prefix(family == .systemLarge ? 9 : 6))) { t in tile(t) }
                    }
                    if family == .systemLarge { mineList }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private func tile(_ t: Tile) -> some View {
        Link(destination: Deep.screen(t.id)) {
            VStack(alignment: .leading, spacing: 1) {
                Image(systemName: t.symbol).font(.caption2).foregroundStyle(t.tint)
                Text(t.value).font(.system(size: family == .systemLarge ? 20 : 17, weight: .bold, design: .rounded))
                    .foregroundStyle(t.hot ? t.tint : .primary).lineLimit(1).minimumScaleFactor(0.6)
                Text(t.label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
            .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    // 대형: what is the user's to do, or a plain all-clear line when nothing is
    @ViewBuilder private var mineList: some View {
        HStack(spacing: 4) {
            Text("내 차례").font(.caption.weight(.semibold))
            if total > 0 { Text("\(total)").font(.caption.weight(.bold)).foregroundStyle(.orange) }
            Spacer(minLength: 0)
        }
        .padding(.top, 2)
        if total == 0 {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("기다리는 결정도, 막힌 QA도 없습니다").font(.caption).foregroundStyle(.secondary)
            }
        } else {
            ForEach(Array((mine?.items ?? []).prefix(3).enumerated()), id: \.offset) { _, i in
                let k = mineKind[i.kind] ?? ("할 일", .orange)
                Link(destination: i.path.map(Deep.session) ?? Deep.screen(i.kind == "dec" ? "decide" : i.kind == "ask" ? "agents" : "worktrees")) {
                    HStack(spacing: 5) {
                        Text(k.0).font(.caption2.weight(.semibold)).foregroundStyle(k.1)
                            .padding(.horizontal, 5).padding(.vertical, 1).background(k.1.opacity(0.15), in: Capsule())
                        Text(i.title ?? "").font(.caption.weight(.medium)).lineLimit(1)
                        Text(i.detail ?? "").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private var allClear: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill").font(.title).foregroundStyle(.green)
            Text("내 차례 없음").font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: QA

struct QAWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "qa", provider: GlanceProvider()) { e in
            QAView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("QA")
        .description("QA 드라이버가 처리 중인 티켓: 막힘, 반출 승인 대기, 작업 중, 대기.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

// the page's 워크트리 리뷰 tile groups
private let qaGroups: [(String, String, Color)] = [("blocked", "막힘", .red), ("approve", "승인 대기", .orange), ("working", "작업 중", .green),
                                                   ("waiting", "대기", .gray), ("delivered", "반출됨", .blue)]

struct QAView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var sets: [Glance.QASet]? { entry.glance?.qa }
    private func c(_ k: String) -> Int { sets?.reduce(0) { $0 + ($1.counts[k] ?? 0) } ?? 0 }
    private var open: Int { sets?.reduce(0) { $0 + $1.open } ?? 0 }
    private var rows: [(Glance.QASet.Ticket, Bool)] { (sets ?? []).flatMap { $0.blocked.map { ($0, true) } + $0.approve.map { ($0, false) } } }

    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                Text(sets == nil ? "QA –" : "QA 작업 \(c("working")) · 막힘 \(c("blocked")) · 승인 \(c("approve"))")
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Label("QA 진행 \(open)", systemImage: "checklist").font(.headline)
                    Text(sets == nil ? "–" : "작업 \(c("working")) · 막힘 \(c("blocked")) · 승인 \(c("approve"))").font(.caption)
                    if let t = rows.first?.0 { Text("\(t.key ?? "") \(t.summary)").font(.caption2).lineLimit(1) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .systemSmall:
                VStack(alignment: .leading, spacing: 6) {
                    Header(title: "QA", symbol: "checklist", tint: .pink)
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if sets == nil { Unsupported() }
                    else if open == 0 { Empty(text: "진행 중인 QA 없음") }
                    else {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            number(c("working"), "작업 중", .green)
                            number(c("blocked"), "막힘", .red)
                            number(c("approve"), "승인", .orange)
                        }
                        if let (t, b) = rows.first {
                            Text(t.key ?? "").font(.caption.weight(.semibold)).foregroundStyle(b ? .red : .orange)
                            Text(t.reason ?? t.summary).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                }
            default:
                VStack(alignment: .leading, spacing: 8) {
                    Header(title: "QA", symbol: "checklist", tint: .pink, trailing: sets.map { _ in "진행 티켓 \(open)" })
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if let sets {
                        if open == 0 { Empty(text: "진행 중인 QA 없음") }
                        else {
                            HStack(spacing: 10) {
                                ForEach(qaGroups.filter { c($0.0) > 0 }, id: \.0) { g in number(c(g.0), g.1, g.2) }
                                Spacer(minLength: 0)
                            }
                            if family == .systemLarge {
                                ForEach(Array(sets.enumerated()), id: \.offset) { _, s in
                                    Text("\(s.epic ?? "QA") · \(s.summary) · \(s.open)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            ForEach(Array(rows.prefix(family == .systemLarge ? 5 : 2).enumerated()), id: \.offset) { _, r in
                                QATicketRow(t: r.0, blocked: r.1)
                            }
                            Spacer(minLength: 0)
                        }
                    } else { Unsupported() }
                }
            }
        }
        .widgetURL(Deep.screen("worktrees"))
    }

    private func number(_ n: Int, _ label: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(n)").font(.system(size: 22, weight: .bold, design: .rounded)).foregroundStyle(n > 0 ? tint : .secondary)
            Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

private struct QATicketRow: View {
    let t: Glance.QASet.Ticket
    let blocked: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Text(blocked ? "막힘" : "승인 대기").font(.caption2.weight(.semibold)).foregroundStyle(blocked ? .red : .orange)
                Text(t.key ?? "").font(.caption.weight(.semibold))
                Text(t.summary).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            if let r = t.reason, !r.isEmpty { Text(r).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
        }
    }
}

// MARK: 상호작용

struct TalkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "talk", provider: GlanceProvider()) { e in
            TalkView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("상호작용")
        .description("에이전트끼리 주고받은 최근 메시지: 질문, 에스컬레이션, 완료 보고, 지시.")
        .supportedFamilies([.systemMedium, .systemLarge, .accessoryRectangular])
    }
}

struct TalkView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var msgs: [Glance.Message]? { entry.glance?.talk }

    var body: some View {
        Group {
            switch family {
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Label("상호작용", systemImage: "bubble.left.and.bubble.right").font(.headline)
                    if let m = msgs?.first {
                        Text("\(m.from) → \(m.to)").font(.caption).lineLimit(1)
                        Text(m.body).font(.caption2).lineLimit(1)
                    } else { Text(entry.glance == nil ? "–" : "메시지 없음").font(.caption) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            default:
                VStack(alignment: .leading, spacing: 7) {
                    Header(title: "상호작용", symbol: "bubble.left.and.bubble.right.fill", tint: .cyan)
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if let msgs {
                        if msgs.isEmpty { Empty(text: "최근 메시지 없음") }
                        else {
                            ForEach(Array(msgs.prefix(family == .systemLarge ? 5 : 2).enumerated()), id: \.offset) { i, m in
                                if i > 0 { Divider() }
                                MessageRow(m: m)
                            }
                            Spacer(minLength: 0)
                        }
                    } else { Unsupported() }
                }
            }
        }
        .widgetURL(Deep.screen("talk"))
    }
}

private struct MessageRow: View {
    let m: Glance.Message
    // the page's TALK_TYPES names and colours
    private var kind: (String, Color) {
        ["question": ("질문", .orange), "escalation": ("에스컬레이션", .red), "worker_done": ("완료 보고", .green),
         "status": ("상태·답", .cyan), "dispatch": ("지시", .indigo)][m.type ?? ""] ?? ("메시지", .secondary)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(kind.0).font(.caption2.weight(.semibold)).foregroundStyle(kind.1)
                Text("\(m.from) → \(m.to)").font(.caption.weight(.medium)).lineLimit(1)
                Spacer(minLength: 2)
                if let d = m.date { Text(d, style: .relative).font(.caption2).foregroundStyle(.secondary).lineLimit(1).monospacedDigit() }
            }
            Text(m.body.isEmpty ? m.subject : m.body).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        }
    }
}

// MARK: 설계문서

struct DesignsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "designs", provider: GlanceProvider()) { e in
            DesignsView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("설계문서")
        .description("최근에 고친 설계문서와 에이전트가 가장 많이 읽은 문서.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct DesignsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var d: Glance.Designs? { entry.glance?.designs }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Header(title: "설계문서", symbol: "book.fill", tint: .brown, trailing: d.map { "\($0.docs)개" })
            if entry.glance == nil { Offline(error: entry.error) }
            else if let d {
                if family == .systemSmall {
                    Text("\(d.docs)").font(.system(size: 32, weight: .bold, design: .rounded)).foregroundStyle(.brown)
                    if let r = d.recent.first {
                        Text(r.title).font(.caption2.weight(.medium)).lineLimit(2)
                        if let t = r.mtime { Text(Date(timeIntervalSince1970: t), style: .relative).font(.caption2).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 0)
                } else {
                    Text("최근 수정").font(.caption2).foregroundStyle(.secondary)
                    ForEach(Array(d.recent.prefix(family == .systemLarge ? 4 : 2).enumerated()), id: \.offset) { _, doc in DocRow(doc: doc, read: false) }
                    if family == .systemLarge, !d.read.isEmpty {
                        Divider()
                        Text("많이 읽힌 문서").font(.caption2).foregroundStyle(.secondary)
                        ForEach(Array(d.read.prefix(3).enumerated()), id: \.offset) { _, doc in DocRow(doc: doc, read: true) }
                    }
                    Spacer(minLength: 0)
                }
            } else { Empty(text: "설계문서를 보지 않는 서버") }
        }
        .widgetURL(Deep.screen("designs"))
    }
}

private struct DocRow: View {
    let doc: Glance.Designs.Doc
    let read: Bool
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: doc.kind == "pdf" ? "doc.richtext" : doc.kind == "md" ? "doc.text" : "doc").font(.caption2).foregroundStyle(.brown)
            Text(doc.title).font(.caption).lineLimit(1)
            Spacer(minLength: 4)
            if read { Text("\(doc.sessions)세션").font(.caption2).foregroundStyle(.secondary).monospacedDigit() }
            else if let t = doc.mtime { Text(Date(timeIntervalSince1970: t), style: .relative).font(.caption2).foregroundStyle(.secondary).lineLimit(1).monospacedDigit() }
        }
    }
}

// MARK: 워크트리

struct TreesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "trees", provider: GlanceProvider()) { e in
            TreesView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("워크트리")
        .description("저장소마다 워크트리 수와 커밋하지 않은 변경이 남은 워크트리.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct TreesView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var t: Glance.Trees? { entry.glance?.trees }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Header(title: "워크트리", symbol: "arrow.triangle.branch", tint: .brown,
                   trailing: t.map { "\($0.repos.reduce(0) { $0 + $1.worktrees })개" })
            if entry.glance == nil { Offline(error: entry.error) }
            else if let t {
                let dirty = t.repos.reduce(0) { $0 + $1.dirty }
                if family == .systemSmall {
                    Text("\(dirty)").font(.system(size: 32, weight: .bold, design: .rounded)).foregroundStyle(dirty > 0 ? .orange : .secondary)
                    Text("미커밋 워크트리").font(.caption2).foregroundStyle(.secondary)
                    if let w = t.dirty.first { Text("\(w.name ?? "") · \(w.dirty)개").font(.caption2).lineLimit(1) }
                    Spacer(minLength: 0)
                } else {
                    ForEach(Array(t.repos.prefix(family == .systemLarge ? 6 : 3).enumerated()), id: \.offset) { _, r in
                        HStack(spacing: 4) {
                            Text(r.name ?? "–").font(.caption).lineLimit(1)
                            Spacer(minLength: 4)
                            if r.dirty > 0 { Text("미커밋 \(r.dirty)").font(.caption2).foregroundStyle(.orange) }
                            Text("\(r.worktrees)").font(.caption.weight(.semibold)).monospacedDigit()
                        }
                    }
                    if family == .systemLarge, !t.dirty.isEmpty {
                        Divider()
                        ForEach(Array(t.dirty.prefix(4).enumerated()), id: \.offset) { _, w in
                            HStack(spacing: 4) {
                                Circle().fill(.orange).frame(width: 6, height: 6)
                                Text(w.name ?? "–").font(.caption2.weight(.medium)).lineLimit(1)
                                Text(w.repo ?? "").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                Spacer(minLength: 2)
                                Text("\(w.dirty)개").font(.caption2).foregroundStyle(.orange).monospacedDigit()
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
            } else { Unsupported() }
        }
        .widgetURL(Deep.screen("trees"))
    }
}

// MARK: 비용 (비교)

struct CostWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "cost", provider: GlanceProvider()) { e in
            CostView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("오늘 비용")
        .description("오늘 쓴 토큰 비용의 시간대별 막대와 가장 많이 쓴 에이전트.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

struct CostView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var c: Glance.Cost? { entry.glance?.cost }

    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                Text(c.map { "오늘 " + dollars($0.total) } ?? "오늘 비용 –")
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Label(c.map { "오늘 " + dollars($0.total) } ?? "오늘 비용 –", systemImage: "chart.bar").font(.headline)
                    if let c { HourBars(c: c, tint: .primary).frame(height: 22) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            default:
                VStack(alignment: .leading, spacing: 6) {
                    Header(title: "오늘 비용", symbol: "chart.bar.fill", tint: .mint)
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if let c {
                        Text(dollars(c.total)).font(.system(size: family == .systemSmall ? 28 : 24, weight: .bold, design: .rounded))
                            .foregroundStyle(.mint).monospacedDigit()
                        HourBars(c: c, tint: .mint).frame(height: family == .systemLarge ? 70 : 30)
                        if family != .systemSmall {
                            ForEach(Array(c.top.prefix(family == .systemLarge ? 5 : 1).enumerated()), id: \.offset) { _, t in
                                Link(destination: t.path.map(Deep.session) ?? Deep.screen("compare")) {
                                    HStack(spacing: 4) {
                                        Text(t.title ?? "에이전트").font(.caption).lineLimit(1)
                                        Spacer(minLength: 4)
                                        Text(dollars(t.cost)).font(.caption.weight(.semibold)).monospacedDigit()
                                    }
                                }
                            }
                        }
                        Spacer(minLength: 0)
                    } else { Unsupported() }
                }
            }
        }
        .widgetURL(Deep.screen("compare"))
    }
}

// today's 24 hours, one bar each; the hours still to come are faint
private struct HourBars: View {
    let c: Glance.Cost
    let tint: Color
    var body: some View {
        let top = max(c.hours.max() ?? 0, 0.01)
        HStack(alignment: .bottom, spacing: 1.5) {
            ForEach(Array(c.hours.enumerated()), id: \.offset) { h, v in
                RoundedRectangle(cornerRadius: 1)
                    .fill(tint.opacity(h > c.now_hour ? 0.15 : h == c.now_hour ? 1 : 0.6))
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .scaleEffect(y: max(v / top, 0.04), anchor: .bottom)
            }
        }
    }
}

#Preview(as: .systemMedium) { HomeWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
#Preview(as: .systemMedium) { QAWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
#Preview(as: .systemLarge) { TalkWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
#Preview(as: .systemMedium) { CostWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
