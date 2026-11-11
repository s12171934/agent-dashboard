import AVFoundation
import SwiftUI
import UserNotifications
import UIKit
import WidgetKit

// The iPhone app: the dashboard page full screen, the 결정 대기 watcher and its notifications (while the app runs or
// was just put away: iOS stops the stream soon after), and the widgets (../Widgets), which it refreshes when the
// questions change and opens at the screen a tap asks for.
@main
struct AgentDashboardApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            DashboardView().ignoresSafeArea()
                .onOpenURL { AppDelegate.dashboard.openLink($0) }  // a widget tap
        }
        // Coming to the front: the widgets read again, so one left at an old glance or an error after the phone was
        // offline catches up without waiting for WidgetKit's next turn.
        .onChange(of: phase) { _, now in
            if now == .active { WidgetCenter.shared.reloadAllTimelines() }
        }
    }
}

struct DashboardView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> DashboardController { AppDelegate.dashboard }
    func updateUIViewController(_ c: DashboardController, context: Context) {}
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    static let dashboard = DashboardController()
    private let watcher = DecisionWatcher()
    private var notifier: DecisionNotifier!
    private var shown: [String] = []  // the questions the widgets last showed

    func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let dash = Self.dashboard
        notifier = DecisionNotifier(watcher: watcher)
        notifier.onOpen = { dash.open(sessionPath: $0) }
        watcher.onNew = { [weak self] in self?.notifier.notify($0) }
        watcher.onGone = { [weak self] in self?.notifier.gone($0) }
        watcher.onChange = { [weak self] in
            guard let self else { return }
            UNUserNotificationCenter.current().setBadgeCount(watcher.pending.count)
            let now = watcher.pending.map(\.id)
            if now != shown { shown = now; WidgetCenter.shared.reloadAllTimelines() }
        }
        dash.onServer = { [weak self] in self?.watcher.use($0) }
        watcher.start()
        // 녹화 영상 plays on with the app put away or the phone locked (UIBackgroundModes audio): the page's video
        // sound is playback, not ambient, so the silent switch and leaving the app do not stop it.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        return true
    }}
