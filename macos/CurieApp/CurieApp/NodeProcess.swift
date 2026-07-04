import Foundation
import Combine
import OSLog

private let log = Logger(subsystem: "com.curie.app", category: "NodeProcess")

// MARK: - NodeProcess

/// Manages the embedded Node.js + Express server child process.
///
/// Flow:
///   1. Locate the `node` binary and `app/dist/server/index.js` inside Resources.
///   2. Set up environment variables (port, data dir, node_modules path).
///   3. Launch the process and parse stdout for the "listening on port" marker.
///   4. Expose `isReady` and `lastError` as @Published properties.
final class NodeProcess: ObservableObject {

    // ── Public state ──────────────────────────────────────────────────────────
    @Published var isReady    = false
    @Published var lastError: String?
    @Published var logLines: [String] = []

    // ── Private ───────────────────────────────────────────────────────────────
    private var process: Process?
    private var outputPipe = Pipe()
    private var retryCount = 0
    private let maxRetries = 3

    // ── Constants ─────────────────────────────────────────────────────────────
    static let serverPort: UInt16 = 8787
    static let serverURL  = URL(string: "http://127.0.0.1:\(serverPort)")!

    // MARK: - Start

    func start() {
        do {
            try _start()
        } catch {
            let msg = error.localizedDescription
            log.error("NodeProcess failed to start: \(msg)")
            DispatchQueue.main.async {
                self.lastError = msg
            }
        }
    }

    private func _start() throws {
        let bundle = Bundle.main.resourceURL!

        // Locate node binary
        let nodeBin = bundle.appendingPathComponent("node")
        guard FileManager.default.isExecutableFile(atPath: nodeBin.path) else {
            throw CurieError.missingResource("node binary at \(nodeBin.path)")
        }

        // Locate server entry point
        let entryPoint = bundle.appendingPathComponent("app/dist/server/index.js")
        guard FileManager.default.fileExists(atPath: entryPoint.path) else {
            throw CurieError.missingResource("server entry point at \(entryPoint.path)")
        }

        // Data directory: ~/Library/Application Support/Curie
        let dataDir = dataDirectory()
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)

        // Build environment
        var env = ProcessInfo.processInfo.environment
        env["SERVER_PORT"]    = "\(NodeProcess.serverPort)"
        env["CURIE_DATA_DIR"] = dataDir.path
        env["NODE_PATH"]      = bundle.appendingPathComponent("app/node_modules").path
        // Do NOT set VAULT_PATH here — the user sets it inside the app Settings panel.

        let p = Process()
        p.executableURL = nodeBin
        p.arguments     = [entryPoint.path]
        p.environment   = env
        p.currentDirectoryURL = bundle.appendingPathComponent("app")

        // Capture output
        outputPipe = Pipe()
        p.standardOutput = outputPipe
        p.standardError  = outputPipe

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self else { return }
            let text = String(data: data, encoding: .utf8) ?? ""
            for raw in text.components(separatedBy: "\n") {
                let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !line.isEmpty else { continue }
                log.debug("[node] \(line)")
                DispatchQueue.main.async {
                    self.logLines.append(line)
                    if self.logLines.count > 200 { self.logLines.removeFirst() }
                }
                if line.lowercased().contains("listening on port") {
                    DispatchQueue.main.async { self.isReady = true }
                }
            }
        }

        p.terminationHandler = { [weak self] proc in
            guard let self else { return }
            log.warning("Node process exited with code \(proc.terminationStatus)")
            DispatchQueue.main.async {
                self.isReady = false
                if proc.terminationStatus != 0 && self.retryCount < self.maxRetries {
                    self.retryCount += 1
                    log.info("Retrying node process (attempt \(self.retryCount)/\(self.maxRetries))…")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.start() }
                }
            }
        }

        try p.run()
        process = p
        retryCount = 0
        log.info("Node process started (pid \(p.processIdentifier))")
    }

    // MARK: - Stop

    func stop() {
        outputPipe.fileHandleForReading.readabilityHandler = nil
        process?.terminate()
        process = nil
        isReady = false
    }

    // MARK: - Helpers

    private func dataDirectory() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory,
                                                  in: .userDomainMask).first!
        return appSupport.appendingPathComponent("Curie", isDirectory: true)
    }
}
