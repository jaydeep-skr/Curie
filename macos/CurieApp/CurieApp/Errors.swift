import Foundation

// MARK: - CurieError

/// Typed errors used across the app for clear diagnostics.
enum CurieError: LocalizedError {
    case missingResource(String)
    case serverStartFailed(String)
    case ollamaNotFound
    case ollamaTimeout

    var errorDescription: String? {
        switch self {
        case .missingResource(let detail):
            return "Missing resource: \(detail)"
        case .serverStartFailed(let detail):
            return "Server failed to start: \(detail)"
        case .ollamaNotFound:
            return "Ollama binary not found. Install from https://ollama.com/download"
        case .ollamaTimeout:
            return "Timed out waiting for Ollama server to start."
        }
    }
}
