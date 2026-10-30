import SwiftUI
import WidgetKit

// 사용량 (the subscription limits), 작업 계획 (the live agents' aplan steps), 프로젝트 (the drivers' ticket progress) and
// 흐름 점검 (the flow check's deviations): the rest of /api/glance, beside the widgets in Widgets.swift.

// A limit's colour by how much is used, as the 플랜 사용량 page bars go.
private func usageTint(_ p: Double) -> Color { p >= 90 ? .red : p >= 70 ? .orange : .teal }

private struct Unsupported: View {
    var body: some View {
        Text("서버를 최신으로 올리면 보입니다").font(.caption).foregroundStyle(.secondary)
            .multilineTextAlignment(.center).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct Empty: View {
    let text: String
    var body: some View {
        Text(text).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: 사용량

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "usage", provider: GlanceProvider()) { e in
            UsageView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("사용량")
        .description("구독 계정별 5시간·주간 한도를 얼마나 썼는지와 언제 풀리는지.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct UsageView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var accounts: [Glance.Account]? { entry.glance?.usage }
    // the first fresh account is the one in use (the server lists the active one first)
    private var main: Glance.Account? { accounts?.first { !$0.stale } ?? accounts?.first }
    // the limit nearest its end: the one that stops work first
    private var tightest: Glance.Account.Limit? { main?.limits.max { ($0.percent ?? 0) < ($1.percent ?? 0) } }

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                if let l = tightest, let p = l.percent {
                    Gauge(value: p, in: 0...100) { Image(systemName: "gauge.with.dots.needle.67percent") } currentValueLabel: {
                        Text("\(Int(p))").monospacedDigit()
                    }
                    .gaugeStyle(.accessoryCircular)
                } else {
                    ZStack { AccessoryWidgetBackground(); Text("–") }
                }
            case .accessoryInline:
                Text(main.map { a in a.limits.prefix(2).map { "\(short($0.name)) \(Int($0.percent ?? 0))%" }.joined(separator: " · ") } ?? "사용량 –")
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 2) {
                    Label("사용량", systemImage: "gauge.with.dots.needle.67percent").font(.headline)
                    if let a = main {
                        ForEach(Array(a.limits.prefix(2).enumerated()), id: \.offset) { _, l in
                            HStack(spacing: 4) {
                                Text(short(l.name)).font(.caption2).frame(width: 30, alignment: .leading)
                                ProgressView(value: min(l.percent ?? 0, 100), total: 100)
                                Text("\(Int(l.percent ?? 0))%").font(.caption2).monospacedDigit()
                            }
                        }
                    } else { Text("–").font(.caption) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            default:
                VStack(alignment: .leading, spacing: 8) {
                    Header(title: "사용량", symbol: "gauge.with.dots.needle.67percent", tint: .teal,
                           trailing: family == .systemSmall ? nil : main?.plan)
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if let accounts {
                        if accounts.isEmpty { Empty(text: "읽은 계정 없음") }
                        else if family == .systemSmall, let a = main { AccountLimits(a: a, compact: true) ; Spacer(minLength: 0) }
                        else {
                            ForEach(Array(accounts.prefix(family == .systemLarge ? 4 : 2).enumerated()), id: \.offset) { i, a in
                                if i > 0 { Divider() }
                                AccountLimits(a: a, compact: family == .systemMedium)
                            }
                            Spacer(minLength: 0)
                        }
                    } else { Unsupported() }
                }
            }
        }
        .widgetURL(Deep.screen("usage"))
    }

    // "5시간 세션" → "세션", "주간 전체" → "주간": room on the lock screen
    private func short(_ name: String) -> String {
        name.hasPrefix("5시간") ? "세션" : name.hasPrefix("주간 ·") ? String(name.dropFirst(5)) : name.hasPrefix("주간") ? "주간" : name
    }
}

private struct AccountLimits: View {
    let a: Glance.Account
    let compact: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 4 : 5) {
            HStack(spacing: 4) {
                Text(a.provider == "codex" ? "Codex" : "Claude").font(.caption.weight(.semibold))
                if let e = a.email { Text(e.split(separator: "@").first.map(String.init) ?? e).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                if a.stale { Image(systemName: "clock.badge.exclamationmark").font(.caption2).foregroundStyle(.secondary) }
            }
            ForEach(Array(a.limits.prefix(compact ? 2 : 3).enumerated()), id: \.offset) { _, l in
                let p = l.percent ?? 0
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(l.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 2)
                        Text("\(Int(p))%").font(.caption2.weight(.semibold)).foregroundStyle(usageTint(p)).monospacedDigit()
                        if !compact, let r = l.resets, r > .now {
                            Text(r, style: .relative).font(.caption2).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                        }
                    }
                    ProgressView(value: min(p, 100), total: 100).tint(usageTint(p))
                }
            }
        }
        .opacity(a.stale ? 0.6 : 1)
    }
}

// MARK: 작업 계획

struct PlansWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "plans", provider: GlanceProvider()) { e in
            PlansView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("작업 계획")
        .description("살아 있는 에이전트가 적어 둔 단계와 지금 하는 단계.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}

struct PlansView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var plans: [Glance.Plan]? { entry.glance?.plans }

    var body: some View {
        switch family {
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                if let p = plans?.first {
                    Text(p.title ?? "에이전트").font(.headline).lineLimit(1)
                    Gauge(value: Double(p.done), in: 0...Double(max(p.total, 1))) { EmptyView() }.gaugeStyle(.accessoryLinearCapacity)
                    Text("\(p.done)/\(p.total) · \(p.cur)").font(.caption2).lineLimit(1)
                } else {
                    Label("작업 계획", systemImage: "list.bullet.clipboard").font(.headline)
                    Text(entry.glance == nil ? "–" : "진행 중인 계획 없음").font(.caption)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(Deep.session(plans?.first?.path))
        default:
            VStack(alignment: .leading, spacing: 8) {
                Header(title: "작업 계획", symbol: "list.bullet.clipboard.fill", tint: .indigo,
                       trailing: plans.map { $0.isEmpty ? nil : "\($0.count)개" } ?? nil)
                if entry.glance == nil { Offline(error: entry.error) }
                else if let plans {
                    if plans.isEmpty { Empty(text: "진행 중인 계획 없음") }
                    else {
                        let shown = Array(plans.prefix(family == .systemLarge ? 5 : family == .systemMedium ? 2 : 1))
                        ForEach(Array(shown.enumerated()), id: \.offset) { i, p in
                            if i > 0 { Divider() }
                            Link(destination: Deep.session(p.path)) { PlanRow(p: p, lines: family == .systemSmall ? 3 : 1) }
                        }
                        Spacer(minLength: 0)
                    }
                } else { Unsupported() }
            }
            .widgetURL(Deep.screen("agents"))
        }
    }
}

private struct PlanRow: View {
    let p: Glance.Plan
    let lines: Int
    private func color(_ s: String) -> Color {
        ["done": .green, "run": .indigo, "fail": .red, "skip": .gray][s] ?? .secondary.opacity(0.35)
    }
    var body: some View {
        let st = AgentState(rawValue: p.state) ?? .wait
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Circle().fill(st.color).frame(width: 7, height: 7)
                Text(p.title ?? "에이전트").font(.caption.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Text("\(p.done)/\(p.total)").font(.caption2.weight(.semibold)).foregroundStyle(.indigo).monospacedDigit()
            }
            // one segment per step, as the page's plan strip
            HStack(spacing: 2) {
                ForEach(Array(p.steps.enumerated()), id: \.offset) { _, s in
                    Capsule().fill(color(s)).frame(height: 4)
                }
            }
            if !p.cur.isEmpty {
                Text(p.cur).font(.caption2).foregroundStyle(.secondary).lineLimit(lines)
            }
        }
    }
}

// MARK: 프로젝트

struct ProjectsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "projects", provider: GlanceProvider()) { e in
            ProjectsView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("프로젝트")
        .description("드라이버 프로젝트마다 검증을 마친 티켓과 체크박스 진행.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular])
    }
}

struct ProjectsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var projects: [Glance.Project]? { entry.glance?.projects }
    // the projects still moving first: a finished one is worth less space
    private var ordered: [Glance.Project] {
        (projects ?? []).enumerated().sorted { a, b in
            let fa = a.element.fraction >= 1, fb = b.element.fraction >= 1
            return fa != fb ? !fa : a.offset < b.offset
        }.map(\.element)
    }

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                if let p = ordered.first {
                    Gauge(value: p.fraction) { Text(p.project ?? "") } currentValueLabel: { Text("\(p.done)").monospacedDigit() }
                        .gaugeStyle(.accessoryCircularCapacity)
                } else { ZStack { AccessoryWidgetBackground(); Text("–") } }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 2) {
                    Label("프로젝트", systemImage: "point.3.connected.trianglepath.dotted").font(.headline)
                    if ordered.isEmpty { Text(entry.glance == nil ? "–" : "프로젝트 없음").font(.caption) }
                    ForEach(Array(ordered.prefix(2).enumerated()), id: \.offset) { _, p in
                        Text("\(p.project ?? "–") \(p.done)/\(p.tickets) · \(Int(p.fraction * 100))%").font(.caption).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .systemSmall:
                VStack(alignment: .leading, spacing: 6) {
                    Header(title: "프로젝트", symbol: "point.3.connected.trianglepath.dotted", tint: .blue)
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if projects == nil { Unsupported() }
                    else if let p = ordered.first {
                        Text(p.project ?? "–").font(.caption.weight(.semibold)).lineLimit(1)
                        Text("\(Int(p.fraction * 100))%").font(.system(size: 30, weight: .bold, design: .rounded)).foregroundStyle(.blue)
                        ProgressView(value: p.fraction).tint(.blue)
                        Text("티켓 \(p.done)/\(p.tickets) 검증").font(.caption2).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    } else { Empty(text: "프로젝트 없음") }
                }
            default:
                VStack(alignment: .leading, spacing: 8) {
                    Header(title: "프로젝트", symbol: "point.3.connected.trianglepath.dotted", tint: .blue)
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if projects == nil { Unsupported() }
                    else if ordered.isEmpty { Empty(text: "프로젝트 없음") }
                    else {
                        ForEach(Array(ordered.prefix(family == .systemLarge ? 5 : 3).enumerated()), id: \.offset) { _, p in
                            ProjectRow(p: p, tickets: family == .systemLarge)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .widgetURL(Deep.screen("projects"))
    }
}

private struct ProjectRow: View {
    let p: Glance.Project
    let tickets: Bool
    var body: some View {
        let finished = p.fraction >= 1
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(p.project ?? "–").font(.caption.weight(.semibold)).lineLimit(1)
                if p.error != nil { Image(systemName: "exclamationmark.triangle.fill").font(.caption2).foregroundStyle(.orange) }
                Spacer(minLength: 4)
                Text("티켓 \(p.done)/\(p.tickets)").font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                Text("\(Int(p.fraction * 100))%").font(.caption2.weight(.semibold)).foregroundStyle(finished ? .green : .blue).monospacedDigit()
            }
            ProgressView(value: p.fraction).tint(finished ? .green : .blue)
            if tickets, !p.open.isEmpty {
                Text(p.open.prefix(3).map { "\($0.jira ?? $0.package ?? "–") \($0.done)/\($0.total)" }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

// MARK: 흐름 점검

struct FlowWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "flow", provider: GlanceProvider()) { e in
            FlowView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("흐름 점검")
        .description("정체·계획 미이행·순서 어긋남처럼 흐름 점검이 찾은 어긋남.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryInline])
    }
}

struct FlowView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var flow: Glance.Flow? { entry.glance?.flow }

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    VStack(spacing: 0) {
                        Image(systemName: "stethoscope").font(.caption)
                        Text(flow.map { "\($0.bad + $0.warn)" } ?? "–").font(.title2.weight(.bold)).minimumScaleFactor(0.5)
                    }
                }
            case .accessoryInline:
                Label(flow.map { $0.bad + $0.warn == 0 ? "흐름 이상 없음" : "흐름 경고 \($0.bad) · 주의 \($0.warn)" } ?? "흐름 점검 –",
                      systemImage: "stethoscope")
            default:
                VStack(alignment: .leading, spacing: 8) {
                    Header(title: "흐름 점검", symbol: "stethoscope", tint: (flow?.bad ?? 0) > 0 ? .red : .orange,
                           trailing: family == .systemSmall ? nil : flow.map { "경고 \($0.bad) · 주의 \($0.warn)" })
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if let flow {
                        if flow.items.isEmpty {
                            VStack(spacing: 6) {
                                Image(systemName: "checkmark.circle.fill").font(.title).foregroundStyle(.green)
                                Text("어긋난 흐름 없음").font(.caption).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else if family == .systemSmall {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                count(flow.bad, "경고", .red)
                                count(flow.warn, "주의", .orange)
                            }
                            if let i = flow.items.first {
                                Text(i.title ?? i.rule ?? "").font(.caption.weight(.semibold)).lineLimit(1)
                                Text(i.reason).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                            }
                            Spacer(minLength: 0)
                        } else {
                            ForEach(Array(flow.items.prefix(family == .systemLarge ? 5 : 2).enumerated()), id: \.offset) { n, i in
                                if n > 0 { Divider() }
                                FlowRow(i: i)
                            }
                            Spacer(minLength: 0)
                        }
                    } else { Unsupported() }
                }
            }
        }
        .widgetURL(Deep.screen("home"))
    }

    private func count(_ n: Int, _ label: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(n)").font(.system(size: 28, weight: .bold, design: .rounded)).foregroundStyle(n > 0 ? tint : .secondary)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

private struct FlowRow: View {
    let i: Glance.Flow.Item
    var body: some View {
        let tint: Color = i.severity == "bad" ? .red : .orange
        Link(destination: i.path.map(Deep.session) ?? Deep.screen("home")) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(i.rule ?? "점검").font(.caption2.weight(.semibold)).foregroundStyle(tint)
                        .padding(.horizontal, 5).padding(.vertical, 1).background(tint.opacity(0.15), in: Capsule())
                    Text(i.title ?? "–").font(.caption.weight(.medium)).lineLimit(1)
                }
                Text(i.reason).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

#Preview(as: .systemMedium) { UsageWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
#Preview(as: .systemMedium) { PlansWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
#Preview(as: .systemLarge) { ProjectsWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
#Preview(as: .systemSmall) { FlowWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
