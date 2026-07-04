import SwiftUI

// MARK: - RootView

/// Top-level routing view.  Switches between onboarding screens and the main
/// WKWebView once everything (Ollama + Node.js) is ready.
struct RootView: View {
    @EnvironmentObject var node:   NodeProcess
    @EnvironmentObject var ollama: OllamaManager

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch ollama.state {

            case .checking, .starting:
                StartupView(message: ollama.state == .checking
                    ? "Checking Ollama…"
                    : "Starting Ollama server…")

            case .notInstalled:
                OllamaInstallView()
                    .environmentObject(ollama)

            case .notRunning:
                OllamaNotRunningView()
                    .environmentObject(ollama)

            case .modelMissing(let models):
                ModelPullView(missingModels: models)
                    .environmentObject(ollama)

            case .ready, .error:
                if node.isReady {
                    WebView(url: NodeProcess.serverURL)
                        .ignoresSafeArea()
                        .overlay(alignment: .topLeading) {
                            if let err = node.lastError {
                                ErrorBanner(message: err)
                            }
                        }
                } else {
                    StartupView(message: "Starting Curie backend…")
                }
            }
        }
        .onAppear {
            node.start()
            Task { await ollama.check() }
        }
        .frame(minWidth: 900, minHeight: 640)
    }
}

// MARK: - StartupView

struct StartupView: View {
    let message: String

    var body: some View {
        VStack(spacing: 22) {
            ZStack {
                RoundedRectangle(cornerRadius: 20)
                    .fill(LinearGradient(
                        colors: [Color(hex: "#5b8af7"), Color(hex: "#7c5cd8")],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ))
                    .frame(width: 72, height: 72)
                Text("⚛").font(.system(size: 34))
            }
            .shadow(color: Color(hex: "#5b8af7").opacity(0.4), radius: 20)

            Text("Curie")
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundColor(.white)

            Text(message)
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.55))

            ProgressView()
                .progressViewStyle(.linear)
                .frame(width: 200)
                .tint(Color(hex: "#5b8af7"))
        }
        .padding(60)
    }
}

// MARK: - OllamaInstallView

struct OllamaInstallView: View {
    @EnvironmentObject var ollama: OllamaManager

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "externaldrive.badge.exclamationmark")
                .font(.system(size: 56))
                .foregroundColor(.orange)
                .symbolRenderingMode(.hierarchical)

            Text("Ollama Not Installed")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.white)

            Text("Curie needs **Ollama** to run AI models on your Mac.\nDownload and install it, then relaunch Curie.")
                .multilineTextAlignment(.center)
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.65))
                .frame(maxWidth: 360)

            VStack(spacing: 10) {
                Button {
                    ollama.openInstallPage()
                } label: {
                    Label("Download Ollama", systemImage: "arrow.down.circle.fill")
                        .frame(width: 220, height: 38)
                }
                .buttonStyle(PrimaryButtonStyle())

                Button {
                    Task { await ollama.check() }
                } label: {
                    Text("I've installed it — check again")
                        .frame(width: 220, height: 36)
                }
                .buttonStyle(GhostButtonStyle())
            }

            Divider().frame(width: 260).overlay(Color.white.opacity(0.1))

            Text("Or install via Homebrew:")
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.4))
            CodeBlock("brew install ollama")
        }
        .padding(56)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - OllamaNotRunningView

struct OllamaNotRunningView: View {
    @EnvironmentObject var ollama: OllamaManager

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "network.slash")
                .font(.system(size: 52))
                .foregroundColor(Color(hex: "#f87171"))
                .symbolRenderingMode(.hierarchical)

            Text("Ollama Server Not Responding")
                .font(.system(size: 20, weight: .bold))
                .foregroundColor(.white)

            Text("Curie tried to start the Ollama server but it didn't respond.\nMake sure Ollama is installed and not blocked by a firewall.")
                .multilineTextAlignment(.center)
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.6))
                .frame(maxWidth: 360)

            Button {
                Task { await ollama.check() }
            } label: {
                Label("Try Again", systemImage: "arrow.clockwise")
                    .frame(width: 180, height: 38)
            }
            .buttonStyle(PrimaryButtonStyle())

            CodeBlock("ollama serve")
        }
        .padding(56)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - ModelPullView

struct ModelPullView: View {
    let missingModels: [String]
    @EnvironmentObject var ollama: OllamaManager
    @State private var pulling = false

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "arrow.down.circle.fill")
                .font(.system(size: 52))
                .foregroundColor(Color(hex: "#5b8af7"))
                .symbolRenderingMode(.hierarchical)

            Text("Download AI Models")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.white)

            Text("Curie needs these models on your Mac before it can start:")
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.6))

            VStack(alignment: .leading, spacing: 8) {
                ForEach(missingModels, id: \.self) { model in
                    HStack(spacing: 10) {
                        Circle()
                            .fill(Color(hex: "#5b8af7").opacity(0.3))
                            .frame(width: 8, height: 8)
                        Text(model)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundColor(.white.opacity(0.85))

                        if let p = ollama.pullProgress[model] {
                            ProgressView(value: max(0, p))
                                .progressViewStyle(.linear)
                                .tint(p >= 1 ? Color(hex: "#34d399") : Color(hex: "#5b8af7"))
                                .frame(width: 80)
                            if p >= 1 {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(Color(hex: "#34d399"))
                            }
                        }
                    }
                }
            }
            .padding(14)
            .background(Color.white.opacity(0.04))
            .cornerRadius(12)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.08)))

            if pulling && !ollama.pullLog.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(ollama.pullLog)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.white.opacity(0.55))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id("bottom")
                    }
                    .frame(height: 110)
                    .padding(10)
                    .background(Color.black.opacity(0.35))
                    .cornerRadius(10)
                    .onChange(of: ollama.pullLog) { _ in
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
                .frame(maxWidth: 420)
            }

            HStack(spacing: 10) {
                Button {
                    pulling = true
                    Task { await ollama.pullMissingModels() }
                } label: {
                    Label(
                        pulling ? "Downloading…" : "Download Models",
                        systemImage: pulling ? "hourglass" : "arrow.down.circle"
                    )
                    .frame(width: 200, height: 38)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(pulling)

                if !pulling {
                    Button {
                        ollama.openTerminalWithSetup()
                    } label: {
                        Text("Open Terminal")
                            .frame(height: 38)
                            .padding(.horizontal, 16)
                    }
                    .buttonStyle(GhostButtonStyle())
                }
            }

            Text("Each model download is ~4–8 GB.\nAn internet connection is required.")
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.35))
                .multilineTextAlignment(.center)
        }
        .padding(52)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - ErrorBanner

struct ErrorBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(Color(hex: "#f87171"))
            Text(message)
                .font(.system(size: 12))
                .foregroundColor(Color(hex: "#f87171"))
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Color(hex: "#1e0606").opacity(0.9))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(hex: "#f87171").opacity(0.25)))
        .padding(10)
    }
}

// MARK: - CodeBlock

struct CodeBlock: View {
    let code: String
    init(_ code: String) { self.code = code }

    var body: some View {
        HStack {
            Text(code)
                .font(.system(size: 12.5, design: .monospaced))
                .foregroundColor(Color(hex: "#34d399"))
                .textSelection(.enabled)
            Spacer()
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
            } label: {
                Image(systemName: "doc.on.doc")
                    .font(.system(size: 11))
                    .foregroundColor(.white.opacity(0.35))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Color.white.opacity(0.04))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.07)))
        .frame(maxWidth: 340)
    }
}

// MARK: - Button styles

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13.5, weight: .semibold))
            .foregroundColor(.white)
            .background(
                LinearGradient(
                    colors: [Color(hex: "#5b8af7"), Color(hex: "#6e98fa")],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
                .cornerRadius(10)
                .opacity(configuration.isPressed ? 0.8 : 1)
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.15), value: configuration.isPressed)
    }
}

struct GhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13.5, weight: .medium))
            .foregroundColor(.white.opacity(0.65))
            .background(
                Color.white.opacity(configuration.isPressed ? 0.06 : 0.03)
                    .cornerRadius(10)
            )
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.1)))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.15), value: configuration.isPressed)
    }
}

// MARK: - Color helper

extension Color {
    init(hex: String) {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var rgb: UInt64 = 0
        Scanner(string: h).scanHexInt64(&rgb)
        let r = Double((rgb >> 16) & 0xFF) / 255.0
        let g = Double((rgb >>  8) & 0xFF) / 255.0
        let b = Double( rgb        & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}
