import AVFoundation
import AVKit
import UIKit

// 녹화 영상 into Picture in Picture by itself when the app is put away (home, another app, the phone locked).
// WebKit gives an inline <video> no automatic PiP, so the app keeps its own player beside the page's: a muted AVPlayer
// on the same file that follows the page's (play, pause, position, speed — web-ui/src/runtime.js videoBridge tells it), its layer behind the
// web view where the page's video is. AVKit starts PiP from it as the app leaves while it plays
// (canStartPictureInPictureAutomaticallyFromInline). Then it takes over: the page's video pauses and this one plays
// with sound; back in the app (or PiP closed) the page's video goes on from where PiP got to.
// The cost: while a video plays in the page, the app streams the file a second time (muted, from the same server).
@MainActor
final class PipController: NSObject, AVPictureInPictureControllerDelegate {
    private let player = AVPlayer()
    private let host = PlayerHost()
    private var pip: AVPictureInPictureController?
    private var src: URL?
    private var inPip = false
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
        c?.canStartPictureInPictureAutomaticallyFromInline = true
        c?.delegate = self
        pip = c
    }

    // {src, t, playing, rate, rect: [x, y, w, h] in the web view's points} — the page's player as it is now
    func update(_ m: [String: Any], in web: UIView) {
        guard pip != nil, !inPip else { return }  // in PiP the page's video is paused by us: its word does not count
        guard let s = m["src"] as? String, let url = URL(string: s), url.scheme?.hasPrefix("http") == true else { return stop() }
        if url != src {
            src = url
            player.replaceCurrentItem(with: AVPlayerItem(url: url))
        }
        if let r = m["rect"] as? [Double], r.count == 4, let sup = host.superview {
            host.frame = web.convert(CGRect(x: r[0], y: r[1], width: max(r[2], 2), height: max(r[3], 2)), to: sup)
        }
        let t = m["t"] as? Double ?? 0, playing = m["playing"] as? Bool ?? false
        if abs(player.currentTime().seconds - t) > 1.5 || !playing {
            player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        player.rate = playing ? Float(m["rate"] as? Double ?? 1) : 0
    }

    // the page has no video any more
    private func stop() {
        src = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
    }

    nonisolated func pictureInPictureControllerWillStartPictureInPicture(_ c: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            inPip = true
            player.isMuted = false
            page?("window.adashPip?.('start')")
        }
    }

    // back in the app, or PiP closed: the page's video at PiP's position, playing if PiP was
    nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ c: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            inPip = false
            let t = player.currentTime().seconds, playing = player.rate > 0
            player.isMuted = true
            page?("window.adashPip?.('stop', \(t.isFinite ? t : 0), \(playing))")
        }
    }

    nonisolated func pictureInPictureController(_ c: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler done: @escaping (Bool) -> Void) {
        done(true)
    }

    nonisolated func pictureInPictureController(_ c: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        MainActor.assumeIsolated { inPip = false; player.isMuted = true }
    }
}

private final class PlayerHost: UIView {
    override static var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
