import SwiftUI

@main
struct CurieApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appDelegate.nodeProcess)
                .environmentObject(appDelegate.ollamaManager)
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}   // hide File > New
        }
    }
}

// MARK: - AppDelegate (lifecycle, menu bar, Sparkle)

class AppDelegate: NSObject, NSApplicationDelegate {
    let nodeProcess   = NodeProcess()
    let ollamaManager = OllamaManager()
    private var updaterController: SPUStandardUpdaterController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Initialise Sparkle updater
        updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )

        // Size the window nicely
        if let window = NSApp.windows.first {
            window.setContentSize(NSSize(width: 1200, height: 800))
            window.center()
            window.title = "Curie"
            window.minSize = NSSize(width: 800, height: 600)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        nodeProcess.stop()
        ollamaManager.stopServe()
    }
}
