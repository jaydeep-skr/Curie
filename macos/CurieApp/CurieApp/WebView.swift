import SwiftUI
import WebKit

// MARK: - WebView

/// A full-window WKWebView that loads the Curie Express backend.
///
/// It retries loading every second for up to 15 seconds if the server is not
/// yet ready (handles race between Swift startup and Node.js init time).
struct WebView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // Allow local storage and cookies (settings persistence)
        config.websiteDataStore = .default()

        // Allow all ports on localhost without CORS preflight
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate         = context.coordinator

        // Dark background during load — matches app background
        wv.setValue(false, forKey: "drawsBackground")
        wv.layer?.backgroundColor = NSColor.black.cgColor

        context.coordinator.webView = wv
        context.coordinator.targetURL = url
        context.coordinator.scheduleLoad()

        return wv
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    // MARK: - Coordinator

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        var targetURL: URL?
        private var retries   = 0
        private let maxRetries = 30   // 30 × 0.5 s = 15 s
        private var timer: Timer?

        func scheduleLoad() {
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
                self?.tryLoad()
            }
        }

        private func tryLoad() {
            guard let wv = webView, let url = targetURL else { return }
            wv.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, didFailProvisionalNavigation _: WKNavigation!,
                     withError error: Error) {
            let nsErr = error as NSError
            // NSURLErrorCannotConnectToHost (-1004) → server not up yet
            if nsErr.code == NSURLErrorCannotConnectToHost && retries < maxRetries {
                retries += 1
                scheduleLoad()
            }
        }

        func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) {
            let nsErr = error as NSError
            if nsErr.code == NSURLErrorCannotConnectToHost && retries < maxRetries {
                retries += 1
                scheduleLoad()
            }
        }

        func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
            timer?.invalidate()
            retries = 0
        }

        // MARK: WKUIDelegate — open links that target _blank in the default browser
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
    }
}
