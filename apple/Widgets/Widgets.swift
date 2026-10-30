import AppIntents
import SwiftUI
import WidgetKit

// The iPhone widgets: 결정 대기 (answerable from the widget), 에이전트 (who is running, waiting, stuck), 테스트 (the
// long runs' progress), and in Insights.swift 사용량, 작업 계획, 프로젝트 and 흐름 점검, on the home screen and the lock
// screen. Each reads the metric server's /api/glance.
@main
struct AgentWidgets: WidgetBundle {
    var body: some Widget {
        DecisionsWidget()
        AgentsWidget()
        TestsWidget()
        UsageWidget()
        PlansWidget()
        ProjectsWidget()
        FlowWidget()
    }
}

extension AgentState {
    var color: Color { [.run: .green, .stalled: .red, .wait: .orange, .bg: .blue][self]! }
}

struct Header: View {
    let title: String, symbol: String, tint: Color
    var trailing: String? = nil
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if let trailing { Text(trailing).foregroundStyle(.secondary) }
        }
        .font(.caption.weight(.semibold))
        .lineLimit(1)
    }
}

struct Offline: View {
    let error: String?
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "wifi.exclamationmark").font(.title2).foregroundStyle(.secondary)
            Text(error ?? "불러오는 중").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: 결정 대기

struct DecisionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "decisions", provider: GlanceProvider()) { e in
            DecisionsView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("결정 대기")
        .description("에이전트가 기다리는 결정. 선택지를 눌러 바로 답합니다.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct DecisionsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var list: [Glance.Decision] { entry.glance?.decisions ?? [] }

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "questionmark.bubble").font(.caption)
                    Text(entry.glance == nil ? "–" : "\(list.count)").font(.title2.weight(.bold)).minimumScaleFactor(0.5)
                }
            }
            .widgetURL(Deep.screen("decide"))
        case .accessoryInline:
            Label(entry.glance == nil ? "결정 대기 –" : list.isEmpty ? "결정 대기 없음" : "결정 대기 \(list.count)건", systemImage: "questionmark.bubble")
                .widgetURL(Deep.screen("decide"))
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Label(entry.glance == nil ? "결정 대기 –" : "결정 대기 \(list.count)", systemImage: "questionmark.bubble").font(.headline)
                if let d = list.first {
                    Text(d.title).font(.caption).lineLimit(1)
                    Text(d.question).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                } else if entry.glance != nil {
                    Text("기다리는 결정 없음").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(Deep.session(list.first?.path))
        case .systemSmall:
            small
        default:
            wide(max: family == .systemLarge ? 3 : 1)
        }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 4) {
            Header(title: "결정 대기", symbol: "questionmark.bubble.fill", tint: .orange)
            if entry.glance == nil { Offline(error: entry.error) }
            else if let d = list.first {
                Text("\(list.count)").font(.system(size: 34, weight: .bold, design: .rounded)).foregroundStyle(.orange)
                Text(d.title).font(.caption.weight(.semibold)).lineLimit(1)
                Text(d.question).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
                Spacer(minLength: 0)
            } else { none }
        }
        .widgetURL(Deep.session(list.first?.path))
    }

    private var none: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill").font(.title).foregroundStyle(.green)
            Text("기다리는 결정 없음").font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func wide(max: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Header(title: "결정 대기", symbol: "questionmark.bubble.fill", tint: .orange,
                   trailing: entry.glance == nil ? nil : list.count > max ? "외 \(list.count - max)건" : "\(list.count)건")
            if entry.glance == nil { Offline(error: entry.error) }
            else if list.isEmpty { none }
            else {
                ForEach(list.prefix(max)) { d in
                    Link(destination: Deep.session(d.path)) { DecisionRow(d: d, lines: max == 1 ? 2 : 2) }
                    if d.id != list.prefix(max).last?.id { Divider() }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

private struct DecisionRow: View {
    let d: Glance.Decision
    let lines: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(d.title).font(.caption.weight(.semibold)).lineLimit(1)
                if let h = d.header, !h.isEmpty { Text("· " + h).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Text(d.question).font(.caption).foregroundStyle(.secondary).lineLimit(lines)
            if !d.options.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(d.options.prefix(3).enumerated()), id: \.offset) { _, o in
                        Button(intent: AnswerIntent(id: d.id, answer: o)) {
                            Text(o).font(.caption2.weight(.semibold)).lineLimit(1).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(.orange)
                    }
                }
            } else if d.more > 0 {
                Text("질문 \(d.more + 1)개 · 앱에서 답하기").font(.caption2).foregroundStyle(.orange)
            }
        }
    }
}

// MARK: 에이전트

struct AgentsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "agents", provider: GlanceProvider()) { e in
            AgentsView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("에이전트")
        .description("실행 중·입력 대기·응답 없음인 에이전트 수와 가장 최근의 몇 개.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

struct AgentsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private func n(_ s: AgentState) -> Int { entry.glance?.agents.counts[s.rawValue] ?? 0 }

    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                Text(entry.glance == nil ? "에이전트 –" : "실행 \(n(.run)) · 대기 \(n(.wait))" + (n(.stalled) > 0 ? " · 멈춤 \(n(.stalled))" : ""))
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Label("에이전트", systemImage: "person.2").font(.headline)
                    if entry.glance == nil { Text("–").font(.caption) }
                    else {
                        Text("실행 \(n(.run)) · 대기 \(n(.wait))").font(.caption)
                        Text("백그라운드 \(n(.bg)) · 응답 없음 \(n(.stalled))").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .systemSmall:
                VStack(alignment: .leading, spacing: 8) {
                    Header(title: "에이전트", symbol: "person.2.fill", tint: .green)
                    if entry.glance == nil { Offline(error: entry.error) } else { counts(columns: 2) }
                }
            default:
                VStack(alignment: .leading, spacing: 8) {
                    Header(title: "에이전트", symbol: "person.2.fill", tint: .green)
                    if entry.glance == nil { Offline(error: entry.error) }
                    else {
                        counts(columns: 4)
                        Divider()
                        ForEach(Array((entry.glance?.agents.busy ?? []).prefix(family == .systemLarge ? 6 : 2).enumerated()), id: \.offset) { _, a in
                            AgentRow(a: a)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .widgetURL(Deep.screen("agents"))
    }

    private func counts(columns: Int) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: columns), alignment: .leading, spacing: 8) {
            ForEach(AgentState.allCases, id: \.self) { s in
                VStack(alignment: .leading, spacing: 0) {
                    Text("\(n(s))").font(.system(size: 24, weight: .bold, design: .rounded)).foregroundStyle(n(s) > 0 ? s.color : .secondary)
                    Text(s.label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }
}

private struct AgentRow: View {
    let a: Glance.Agent
    var body: some View {
        let st = AgentState(rawValue: a.state) ?? .wait
        Link(destination: a.path.map(Deep.session) ?? Deep.screen("agents")) {
            HStack(spacing: 6) {
                Circle().fill(st.color).frame(width: 7, height: 7)
                Text(a.title ?? "에이전트").font(.caption.weight(.medium)).lineLimit(1)
                Spacer(minLength: 4)
                if let t = a.last, st != .run {
                    Text(t, style: .relative).font(.caption2).foregroundStyle(.secondary).lineLimit(1).monospacedDigit()
                } else {
                    Text(st.short).font(.caption2).foregroundStyle(st.color)
                }
            }
        }
    }
}

// MARK: 테스트

struct TestsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "tests", provider: GlanceProvider()) { e in
            TestsView(entry: e).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("테스트")
        .description("긴 테스트 실행의 진행과 결과.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

struct TestsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry
    private var runs: [Glance.Test] { entry.glance?.tests ?? [] }

    var body: some View {
        Group {
            switch family {
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 2) {
                    Label("테스트", systemImage: "flask").font(.headline)
                    if let t = runs.first { TestRow(t: t, compact: true) } else { Text("실행 없음").font(.caption) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            default:
                VStack(alignment: .leading, spacing: 8) {
                    Header(title: "테스트", symbol: "flask.fill", tint: .purple,
                           trailing: runs.contains(where: \.running) ? "\(runs.filter(\.running).count)개 실행 중" : nil)
                    if entry.glance == nil { Offline(error: entry.error) }
                    else if runs.isEmpty {
                        Text("최근 실행 없음").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ForEach(Array(runs.prefix(family == .systemSmall ? 1 : 3).enumerated()), id: \.offset) { _, t in
                            TestRow(t: t, compact: false)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .widgetURL(Deep.screen("tests"))
    }
}

private struct TestRow: View {
    let t: Glance.Test
    let compact: Bool
    private var tint: Color {
        t.running ? .purple : t.verdict == "warn" ? .orange : t.verdict == "error" ? .gray : t.verdict == "red" ? .green
            : (t.failed ?? 0) > 0 || t.phase == "failed" ? .red : .green
    }
    private var status: String {
        if t.running { return t.total.map { "\(t.done ?? 0)/\($0)" } ?? "실행 중" }
        if let v = ["warn": "통과 · 확인", "red": "의도한 빨강", "error": "실행 오류"][t.verdict ?? ""] { return v }
        if (t.failed ?? 0) > 0 { return "실패 \(t.failed!)" }
        return t.phase == "failed" ? "실패" : "통과" + (t.passed.map { $0 > 0 ? " \($0)" : "" } ?? "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(t.label ?? t.kind ?? "테스트").font(.caption.weight(.medium)).lineLimit(compact ? 1 : 2)
                Spacer(minLength: 4)
                Text(status).font(.caption2.weight(.semibold)).foregroundStyle(tint).monospacedDigit()
            }
            if t.running {
                if let f = t.fraction { ProgressView(value: f).tint(tint) } else { ProgressView(value: 0.05).tint(tint).opacity(0.5) }
            }
            if !compact, let u = t.updated, !t.running {
                Text(u, style: .relative).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

#Preview(as: .systemMedium) { DecisionsWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
#Preview(as: .systemMedium) { AgentsWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
#Preview(as: .systemSmall) { TestsWidget() } timeline: { GlanceEntry(date: .now, glance: .sample, error: nil) }
