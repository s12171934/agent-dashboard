import AVFoundation
import AVKit
import UIKit

// 녹화 영상 into Picture in Picture by itself when the app is put away (home, another app, the phone locked).
// Prepare a paused native player for PiP, following the page's position and speed (frontend/app.js mdPip).
// Playing even a muted AVPlayer beside WKWebView can interrupt the page's video on iPhone. Only start native
// playback when PiP takes over as the app leaves, and stop it before handing playback back to the page.
@MainActor
final class PipController: NSObject, AVPictureInPictureControllerDelegate {
    private let player = AVPlayer()
    private let host = PlayerHost()
    private var pip: AVPictureInPictureController?
    private var src: URL?
    private var inPip = false
    private var starting = false
    private var wantsPip = false
    private var playing = false
    private var rate: Float = 1
    private var position: Double = 0
    private var possible: NSKeyValueObservation?
    private var lifecycle: [NSObjectProtocol] = []
    /// runs a script in the page: the page's video handed back (`window.adashPip(...)`)
    var page: ((String) -> Void)?

    // the layer goes behind everything in `view` (the web view covers it): PiP needs it in the window, not seen
    func install(in view: UIView) {
        guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
        player.automaticallyWaitsToMinimizeStalling = false
        host.playerLayer.player = player
        host.playerLayer.videoGravity = .resizeAspect
        host.isUserInteractionEnabled = false
        host.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
        view.insertSubview(host, at: 0)
        let c = AVPictureInPictureController(playerLayer: host.playerLayer)
        // The prepared player stays paused. Request PiP on leaving instead of keeping a second player running
        // solely to qualify for AVKit's automatic transition.
        c?.canStartPictureInPictureAutomaticallyFromInline = false
        c?.delegate = self
        pip = c
        possible = c?.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.startIfPossible() }
        }
        let center = NotificationCenter.default
        lifecycle.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.wantsPip = self.playing
                self.startIfPossible()
            }
        })
        lifecycle.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.wantsPip = false
                if self.inPip || self.starting { self.pip?.stopPictureInPicture() }
                if !self.inPip { self.starting = false }
            }
        })
    }

    deinit { lifecycle.forEach(NotificationCenter.default.removeObserver) }

    private func startIfPossible() {
        guard wantsPip, playing, !inPip, !starting, let pip, pip.isPictureInPicturePossible else { return }
        starting = true
        pip.startPictureInPicture()
    }

    // {src, t, playing, rate, rect: [x, y, w, h] in the web view's points} — the page's player as it is now
    func update(_ m: [String: Any], in web: UIView) {
        guard pip != nil else { return }
        guard let s = m["src"] as? String, let url = URL(string: s), url.scheme?.hasPrefix("http") == true else { return stop() }
        guard !inPip, !starting else { return }  // a background pause must not cancel a handoff already in flight
        if url != src {
            src = url
            player.replaceCurrentItem(with: AVPlayerItem(url: url))
        }
        if let r = m["rect"] as? [Double], r.count == 4, let sup = host.superview {
            host.frame = web.convert(CGRect(x: r[0], y: r[1], width: max(r[2], 2), height: max(r[3], 2)), to: sup)
        }
        let t = m["t"] as? Double ?? 0
        position = t.isFinite ? max(0, t) : 0
        playing = m["playing"] as? Bool ?? false
        let speed = m["rate"] as? Double ?? 1
        rate = speed.isFinite && speed > 0 ? Float(speed) : 1
        // Never mirror play/pause as native playback in the foreground: it steals playback from WebKit.
        player.pause()
        if abs(player.currentTime().seconds - t) > 1.5 || !playing {
            player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        startIfPossible()
    }

    // the page has no video any more
    private func stop() {
        src = nil
        playing = false
        wantsPip = false
        inPip = false
        starting = false
        pip?.stopPictureInPicture()
        player.pause()
        player.replaceCurrentItem(with: nil)
    }

    nonisolated func pictureInPictureControllerWillStartPictureInPicture(_ c: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            // A delayed transition may arrive after the app has already become active again.
            guard wantsPip else { c.stopPictureInPicture(); return }
            inPip = true
            starting = false
            player.isMuted = false
            page?("window.adashPip?.('start')")
            player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            player.rate = playing ? rate : 0
        }
    }

    nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ c: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            if !wantsPip { c.stopPictureInPicture() }
        }
    }

    // back in the app, or PiP closed: the page's video at PiP's position, playing if PiP was
    nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ c: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            returnToPage()
        }
    }

    nonisolated func pictureInPictureController(_ c: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler done: @escaping (Bool) -> Void) {
        done(true)
    }

    nonisolated func pictureInPictureController(_ c: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        MainActor.assumeIsolated {
            if inPip { returnToPage() }
            else { starting = false; wantsPip = false; player.pause(); player.isMuted = true }
        }
    }

    private func returnToPage() {
        let handedOff = inPip
        let t = player.currentTime().seconds, resume = player.rate > 0
        // Pause before the asynchronous WebKit play request, including a failed PiP transition.
        player.pause()
        player.isMuted = true
        inPip = false
        starting = false
        wantsPip = false
        playing = resume
        if t.isFinite { position = t }
        if handedOff { page?("window.adashPip?.('stop', \(t.isFinite ? t : position), \(resume))") }
    }
}

private final class PlayerHost: UIView {
    override static var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
