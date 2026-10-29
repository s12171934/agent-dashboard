import Foundation
import Network

// Serves the deployed page on http://127.0.0.1:<port>, passing each request through to the site. WebKit treats an
// https page's calls to http://127.0.0.1 as mixed content and refuses them, but a loopback page may call loopback
// servers, and the metric server already admits http://127.0.0.1:* as an origin. The page stays the live
// deployment: nothing is bundled, so a deploy shows without rebuilding the app. The port is fixed because the
// page keeps its server list in localStorage, which belongs to the origin.
// /vscode/… (the metric server's web VS Code relay) is passed through raw, websockets included, to the loopback
// metric server: the page shows that VS Code in an iframe, and WebKit holds a cross-origin iframe to 30 frames a second
// or fewer until it is clicked (scrolling does not count), so it has to be this page's origin (PageBridge tells the
// page, which then points the iframe here).
final class LocalPage {
    static var port: UInt16 { UInt16(UserDefaults.standard.integer(forKey: "pagePort")).nonzero ?? 8790 }
    static var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    private let site: URL
    private var listener: NWListener?
    private let session = URLSession(configuration: .ephemeral)  // the page's service worker does the caching
    static let vscodePrefix = "/vscode/"
    // the loopback metric server whose /vscode/ this page passes through
    static var vscodePort: UInt16 {
        let u = DecisionWatcher.serverURL
        return ["127.0.0.1", "localhost"].contains(u.host() ?? "") ? UInt16(u.port ?? 8787) : 8787
    }

    init(site: URL) { self.site = site }

    func start() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] c in self?.serve(c) }
        l.start(queue: .global())
        listener = l
    }

    // One request per connection: read the head, fetch the same path from the site, write it back, close.
    private func serve(_ c: NWConnection) {
        c.start(queue: .global())
        read(c, Data())
    }

    private func read(_ c: NWConnection, _ got: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            guard let self else { return c.cancel() }
            let buf = got + (data ?? Data())
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
                if head.split(separator: " ", maxSplits: 2).dropFirst().first?.hasPrefix(Self.vscodePrefix) == true {
                    Pipe(c, to: Self.vscodePort, first: buf)
                } else {
                    self.answer(c, head)
                }
            } else if done || err != nil || buf.count > 65536 {
                c.cancel()
            } else {
                self.read(c, buf)
            }
        }
    }

    private func answer(_ c: NWConnection, _ head: String) {
        let parts = head.split(separator: "\r\n", maxSplits: 1).first?.split(separator: " ") ?? []
        guard parts.count >= 2, ["GET", "HEAD"].contains(parts[0]), parts[1].hasPrefix("/"),
              let url = URL(string: "." + parts[1], relativeTo: site)?.absoluteURL else {
            return send(c, status: 405, headers: [:], body: Data())
        }
        var req = URLRequest(url: url)
        req.httpMethod = String(parts[0])
        session.dataTask(with: req) { [weak self] data, res, _ in
            guard let self, let res = res as? HTTPURLResponse else {
                self?.send(c, status: 502, headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data("사이트에 닿지 못했습니다".utf8))
                return
            }
            var headers: [String: String] = [:]
            for case let (k as String, v as String) in res.allHeaderFields
            where !["content-encoding", "content-length", "transfer-encoding", "connection"].contains(k.lowercased()) {
                headers[k] = v
            }
            self.send(c, status: res.statusCode, headers: headers, body: parts[0] == "HEAD" ? Data() : data ?? Data())
        }.resume()
    }

    private func send(_ c: NWConnection, status: Int, headers: [String: String], body: Data) {
        var head = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status))\r\n"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
    }
}

// Bytes both ways between the page's connection and the metric server, as they come (a websocket stays open); each
// side's end is passed on, and both close once both have ended.
private final class Pipe {
    private let a: NWConnection, b: NWConnection
    private var ended = 0
    private let q = DispatchQueue(label: "LocalPage.pipe")
    private var keep: Pipe?  // alive until both directions end

    @discardableResult init(_ a: NWConnection, to port: UInt16, first: Data) {
        self.a = a
        b = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        keep = self
        b.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            switch st {
            case .ready:
                b.send(content: first, completion: .contentProcessed { _ in })
                pump(a, b)
                pump(b, a)
            case .failed, .waiting:
                a.cancel(); b.cancel(); keep = nil
            default: break
            }
        }
        b.start(queue: q)
    }

    private func pump(_ from: NWConnection, _ to: NWConnection) {
        from.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, done, err in
            if let data, !data.isEmpty {
                to.send(content: data, completion: .contentProcessed { _ in })
            }
            if done || err != nil {
                to.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in })
                q.async { [self] in
                    ended += 1
                    if ended == 2 { a.cancel(); b.cancel(); keep = nil }
                }
            } else {
                pump(from, to)
            }
        }
    }
}

private extension UInt16 {
    var nonzero: UInt16? { self == 0 ? nil : self }
}
