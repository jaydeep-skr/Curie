import Foundation
import AppKit
import OSLog

private let log = Logger(subsystem: "com.curie.app", category: "OllamaManager")

// MARK: - OllamaState

enum OllamaState: Equatable {
    case checking
    case notInstalled
    case notRunning                 // installed but server not up after retry
    case starting                   // launching `ollama serve`
    case modelMissing([String])     // running, but pull needed
    case ready                      // fully operational
    case error(String)

    static func == (lhs: OllamaState, rhs: OllamaState) -> Bool {
        switch (lhs, rhs) {
        case (.checking, .checking),
             (.notInstalled, .notInstalled),
             (.notRunning, .notRunning),
             (.starting, .starting),
             (.ready, .ready): return true
        case (.modelMissing(let a), .modelMissing(let b)): return a == b
        case (.error(let a), .error(let b)): return a == b
        default: return false
        }
    }
}

// MARK: - OllamaManager

/// Detects Ollama, starts the server daemon, and pulls any required models.
///
/// Required models are `llama3.1:8b` (chat) and `nomic-embed-text` (embeddings).
/// You can extend `requiredModels` without changing anything else.
@MainActor
final class OllamaManager: ObservableObject {

    @Published var state: OllamaState = .checking
    @Published var pullProgress: [String: Double] = [:]   // model → 0…1
    @Published var pullLog = ""

    // Models that must be present for Curie to function
    let requiredModels = ["llama3.1:8b", "nomic-embed-text"]

    private var serveProcess: Process?
    private let ollamaAPIBase = URL(string: "http://localhost:11434")!

    // MARK: - Entry point

    /// Call once at app launch.  Safe to call again to re-check.
    func check() async {
        state = .checking
        log.info("Checking Ollama…")

        guard let ollamaPath = findOllamaBinary() else {
            log.warning("Ollama binary not found")
            state = .notInstalled
            return
        }

        log.info("Found Ollama at \(ollamaPath)")

        // Is the server already up?
        if await pingServer() {
            await checkAndPullModels(ollamaPath: ollamaPath)
            return
        }

        // Try to start it
        state = .starting
        await startServe(ollamaPath: ollamaPath)

        // Poll up to 12 seconds
        for attempt in 1...24 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if await pingServer() {
                log.info("Ollama server came up (attempt \(attempt))")
                await checkAndPullModels(ollamaPath: ollamaPath)
                return
            }
        }

        log.error("Ollama server did not come up after 12 s")
        state = .notRunning
    }

    // MARK: - Model pull

    /// Pull all missing models, streaming progress via `pullLog` and `pullProgress`.
    func pullMissingModels() async {
        guard let ollamaPath = findOllamaBinary() else { return }
        guard case .modelMissing(let missing) = state else { return }

        for model in missing {
            pullLog += "⬇  Pulling \(model)…\n"
            pullProgress[model] = 0

            await withCheckedContinuation { cont in
                let p = Process()
                let pipe = Pipe()
                p.executableURL = URL(fileURLWithPath: ollamaPath)
                p.arguments     = ["pull", model]
                p.standardOutput = pipe
                p.standardError  = pipe

                pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
                    guard let self else { return }
                    let txt = String(data: h.availableData, encoding: .utf8) ?? ""
                    for line in txt.components(separatedBy: "\n") {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { continue }
                        Task { @MainActor in
                            self.pullLog += trimmed + "\n"
                            // Parse percentage from lines like "pulling manifest ▕████░░░░░▏  42%"
                            if let pct = Self.extractPercent(from: trimmed) {
                                self.pullProgress[model] = pct
                            }
                        }
                    }
                }

                p.terminationHandler = { proc in
                    Task { @MainActor in
                        self.pullProgress[model] = proc.terminationStatus == 0 ? 1.0 : -1
                        self.pullLog += proc.terminationStatus == 0
                            ? "✓ \(model) ready.\n"
                            : "✗ Pull failed (exit \(proc.terminationStatus)).\n"
                    }
                    cont.resume()
                }

                try? p.run()
            }
        }

        await check()
    }

    // MARK: - Ollama install

    func openInstallPage() {
        NSWorkspace.shared.open(URL(string: "https://ollama.com/download/mac")!)
    }

    /// Open Terminal with the recommended setup command so the user can see progress
    func openTerminalWithSetup() {
        let cmd = requiredModels.map { "ollama pull \($0)" }.joined(separator: " && ")
        let script = """
        tell application "Terminal"
            activate
            do script "\(cmd)"
        end tell
        """
        var err: NSDictionary?
        NSAppleScript(source: script)?.executeAndReturnError(&err)
    }

    // MARK: - Stop

    func stopServe() {
        serveProcess?.terminate()
        serveProcess = nil
    }

    // MARK: - Private helpers

    private func findOllamaBinary() -> String? {
        let candidates = [
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
            "/usr/bin/ollama",
            "\(NSHomeDirectory())/bin/ollama",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func pingServer() async -> Bool {
        let url = ollamaAPIBase.appendingPathComponent("api/tags")
        guard let (_, response) = try? await URLSession.shared.data(from: url),
              let http = response as? HTTPURLResponse else { return false }
        return http.statusCode == 200
    }

    private func startServe(ollamaPath: String) async {
        await withCheckedContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: ollamaPath)
            p.arguments = ["serve"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError  = FileHandle.nullDevice
            try? p.run()
            serveProcess = p
            log.info("Started `ollama serve` (pid \(p.processIdentifier))")
            cont.resume()
        }
    }

    private func checkAndPullModels(ollamaPath: String) async {
        // List installed models via `ollama list`
        let p = Process(); let pipe = Pipe()
        p.executableURL = URL(fileURLWithPath: ollamaPath)
        p.arguments = ["list"]
        p.standardOutput = pipe
        p.standardError  = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let installedNames = output
            .components(separatedBy: "\n")
            .dropFirst()                  // skip header line
            .compactMap { $0.components(separatedBy: /\s+/).first }
            .filter { !$0.isEmpty }

        let missing = requiredModels.filter { required in
            !installedNames.contains { $0.hasPrefix(required.components(separatedBy: ":").first ?? required) }
        }

        log.info("Installed models: \(installedNames.joined(separator: ", "))")
        log.info("Missing models: \(missing.joined(separator: ", "))")

        if missing.isEmpty {
            state = .ready
        } else {
            state = .modelMissing(missing)
        }
    }

    private static func extractPercent(from line: String) -> Double? {
        // Match "  42%" or "42 MB / 100 MB"
        if let match = line.firstMatch(of: /(\d+)%/) {
            return Double(match.1)! / 100.0
        }
        return nil
    }
}
