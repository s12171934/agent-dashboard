import AppKit
import WebKit
import Foundation
@main struct WebUITests {
 @MainActor static func main() async throws {
  NSApplication.shared.setActivationPolicy(.prohibited)
  let cfg=WKWebViewConfiguration();cfg.websiteDataStore = .nonPersistent();cfg.mediaTypesRequiringUserActionForPlayback = []
  cfg.userContentController.addUserScript(WKUserScript(source:PageBridge.resumeScript,injectionTime:.atDocumentEnd,forMainFrameOnly:true))
  if CommandLine.arguments.count>2 {let dock=try String(contentsOfFile:CommandLine.arguments[2],encoding:.utf8);cfg.userContentController.addUserScript(WKUserScript(source:dock,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
  let web=WKWebView(frame:CGRect(x:0,y:0,width:390,height:844),configuration:cfg)
  guard let url=URL(string:CommandLine.arguments.dropFirst().first ?? "http://127.0.0.1:5517/fixture.html")else{fatalError("fixture URL missing")}
  let window=NSWindow(contentRect:web.frame,styleMask:[.borderless],backing:.buffered,defer:false);window.contentView=web;window.orderBack(nil)
  DispatchQueue.main.asyncAfter(deadline:.now()+120){print("WebKit UI test timed out");exit(1)}
  web.load(URLRequest(url:url))
  var ready=false
  for _ in 0..<150 {try await Task.sleep(for:.milliseconds(100));if let v=try? await web.evaluateJavaScript("typeof window.uiChecks==='function' && !!document.querySelector('[data-ui=rust-wasm]')") as? Bool,v{ready=true;break}}
  guard ready else{let error=try? await web.evaluateJavaScript("document.body.innerText");print("UI did not start: \(error ?? "unknown")");exit(1)}
  print("WebKit WASM ready");fflush(stdout)
  let monitor=Task {for _ in 0..<30{try? await Task.sleep(for:.seconds(2));if Task.isCancelled{return};let p=try? await web.evaluateJavaScript("window.uiProgress || document.visibilityState");print("WebKit: \(p ?? "unknown")");fflush(stdout)}}
  let result=try await web.callAsyncJavaScript("return await window.uiChecks()",arguments:[:],in:nil,contentWorld:.page)
  monitor.cancel()
  guard let rows=result as? [[String:Any]]else{print("Invalid UI test result: \(String(describing:result))");exit(1)}
  for row in rows{print("\(row["ok"] as? Bool == true ? "✓" : "✗") \(row["name"] ?? "test") \(row["error"] ?? "")")}
  let failures=rows.filter{$0["ok"] as? Bool != true}
  print("WKWebView: \(rows.count-failures.count)/\(rows.count) checks passed")
  web.stopLoading();window.close();exit(failures.isEmpty ? 0:1)
 }
}
