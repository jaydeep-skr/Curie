# Curie — macOS App: Complete Setup Guide

Everything in this `macos/` folder is self-contained.  
It does **not** modify the JS/TypeScript codebase in any way.

---

## Table of Contents

1. [Folder structure](#folder-structure)
2. [Prerequisites](#prerequisites)
3. [One-time setup — Sparkle keys](#one-time-setup--sparkle-keys)
4. [One-time setup — Apple certificates](#one-time-setup--apple-certificates)
5. [Create the Xcode project (manual steps)](#create-the-xcode-project)
6. [Add Sparkle via Swift Package Manager](#add-sparkle-via-swift-package-manager)
7. [Build the JS bundle](#build-the-js-bundle)
8. [Run in development](#run-in-development)
9. [Creating a release](#creating-a-release)
10. [GitHub Actions CI/CD](#github-actions-cicd)
11. [GitHub Secrets reference](#github-secrets-reference)
12. [Customising models / settings](#customising-models--settings)
13. [Troubleshooting](#troubleshooting)

---

## Folder structure

```
macos/
├── CurieApp/
│   ├── CurieApp/                   ← Swift source files (add to Xcode)
│   │   ├── CurieApp.swift          ← @main entry point + AppDelegate
│   │   ├── NodeProcess.swift       ← launches bundled Node.js server
│   │   ├── OllamaManager.swift     ← detects/starts Ollama, pulls models
│   │   ├── Views.swift             ← all SwiftUI screens + button styles
│   │   ├── WebView.swift           ← WKWebView wrapper
│   │   ├── Errors.swift            ← typed error enum
│   │   ├── Info.plist              ← bundle metadata + Sparkle feed URL
│   │   ├── Curie.entitlements      ← no sandbox (required for child procs)
│   │   └── Resources/              ← populated by build_bundle.sh
│   │       ├── node                ← universal Node.js binary (downloaded)
│   │       └── app/                ← JS build output
│   │           ├── dist/           ← tsc + vite output
│   │           ├── node_modules/   ← production-only deps
│   │           └── package.json
│   ├── CurieApp.xcodeproj/
│   │   └── project.pbxproj        ← reference project file
│   └── ExportOptions.plist         ← Developer ID export config
├── scripts/
│   ├── build_bundle.sh             ← builds JS + downloads node binary
│   ├── release.sh                  ← local release helper
│   └── update_appcast.py           ← inserts new item into appcast.xml
├── github-actions/
│   └── release.yml                 ← copy to .github/workflows/
└── appcast.xml                     ← Sparkle update feed
```

---

## Prerequisites

Install these before starting:

```bash
# Xcode 15+ (from the Mac App Store)
# Command Line Tools
xcode-select --install

# Homebrew (if not already)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# GitHub CLI (for creating releases from the command line)
brew install gh
gh auth login

# xcpretty (nicer xcodebuild output, used in CI)
gem install xcpretty

# Python 3 (ships with macOS, or via brew)
python3 --version    # must be 3.8+
```

You also need:
- **An Apple Developer account** (paid, $99/yr) for code signing and notarization
- **Ollama** installed locally for development testing: https://ollama.com/download

---

## One-time setup — Sparkle keys

Sparkle uses Ed25519 asymmetric signatures to verify update packages.  
You generate a key pair **once** and never need to do it again.

### Step 1 — Download Sparkle and extract `generate_keys`

```bash
# Download the latest Sparkle release
SPARKLE_VER=2.6.4
curl -LO "https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VER}/Sparkle-${SPARKLE_VER}.tar.xz"
tar xf "Sparkle-${SPARKLE_VER}.tar.xz"

# The tools live inside the archive
ls Sparkle.framework/Versions/B/Resources/
# → generate_keys   sign_update   …
```

### Step 2 — Generate the key pair

```bash
./Sparkle.framework/Versions/B/Resources/generate_keys
```

Output:
```
A private key has been generated and saved to your macOS Keychain.
It has been stored under the name "Sparkle Key" for the application:
  Curie

Your public key (SUPublicEDKey) for inserting into Info.plist:
  <BASE64_STRING_HERE>
```

### Step 3 — Put the public key in `Info.plist`

Open [`macos/CurieApp/CurieApp/Info.plist`](CurieApp/CurieApp/Info.plist) and replace:

```xml
<key>SUPublicEDKey</key>
<string>REPLACE_WITH_YOUR_SPARKLE_ED25519_PUBLIC_KEY</string>
```

with the base64 string printed above.

### Step 4 — Export the private key for GitHub Actions

```bash
# Export from Keychain as a base64 string for use in GitHub Secrets
./Sparkle.framework/Versions/B/Resources/generate_keys -x > sparkle_private_key.txt
```

Store the contents of `sparkle_private_key.txt` as the GitHub secret `SPARKLE_PRIVATE_KEY`  
(see [GitHub Secrets reference](#github-secrets-reference)).  
**Never commit this file.**

---

## One-time setup — Apple certificates

You need a **Developer ID Application** certificate (not App Store).

### Step 1 — Create the certificate

1. Open **Xcode → Settings → Accounts**
2. Select your Apple ID → **Manage Certificates**
3. Click **+** → **Developer ID Application**
4. Xcode creates and installs it in your Keychain automatically

### Step 2 — Export as .p12 for GitHub Actions

1. Open **Keychain Access**
2. Find "Developer ID Application: Your Name (TEAMID)"
3. Right-click → **Export** → save as `certificate.p12` with a strong password
4. Base64-encode it:
   ```bash
   base64 -i certificate.p12 | pbcopy    # copies to clipboard
   ```
5. Save that base64 string as GitHub secret `MACOS_CERTIFICATE`
6. Save the .p12 password as `MACOS_CERTIFICATE_PWD`
7. **Delete** `certificate.p12` from disk

### Step 3 — Create an App-specific password

1. Go to https://appleid.apple.com → Sign In → App-Specific Passwords
2. Generate a password named "Curie Notarization"
3. Save it as GitHub secret `APP_SPECIFIC_PWD`

---

## Create the Xcode project

The `project.pbxproj` in this repo is a **reference template** — it cannot be
opened directly because Xcode requires the `.xcodeproj` wrapper to have been
created by Xcode itself to properly resolve SPM packages.

**The recommended approach** is to create a fresh project in Xcode and add the
source files by reference.  This takes about 5 minutes.

### Step 1 — New project

1. Open Xcode → **File → New → Project**
2. Select **macOS → App**
3. Product name: `Curie`  
   Bundle Identifier: `com.curie.app`  
   Interface: **SwiftUI**  
   Language: **Swift**  
4. Save into: `macos/CurieApp/` (so it creates `macos/CurieApp/CurieApp.xcodeproj`)

### Step 2 — Replace generated files with the ones in this folder

Xcode will have created `ContentView.swift` and `CurieApp.swift` (or similar).  
**Delete them** (Move to Trash when Xcode asks).

Then drag these files from `macos/CurieApp/CurieApp/` into the Xcode project navigator:
- `CurieApp.swift`
- `NodeProcess.swift`
- `OllamaManager.swift`
- `Views.swift`
- `WebView.swift`
- `Errors.swift`

When dragging, choose **"Create groups"** (not folder references) and make sure
**"Add to target: Curie"** is checked.

### Step 3 — Add the Resources folder

Drag the `macos/CurieApp/CurieApp/Resources/` folder into the project navigator.

When the dialog appears:
- Choose **"Create folder reference"** (blue folder icon, NOT yellow)  
- Check **"Add to target: Curie" → "Copy items if needed"** must be **unchecked**  
  (we want a reference, not a copy — the build script populates it in-place)

This causes Xcode to copy the entire `Resources/` folder into the `.app` bundle
as-is during the build.

### Step 4 — Configure the target

Select the **Curie** target in the project navigator:

**General tab:**
| Field | Value |
|---|---|
| Bundle Identifier | `com.curie.app` |
| Version | `1.0.0` |
| Build | `1` |
| Deployment Target | macOS 13.0 |

**Signing & Capabilities tab:**
1. Check **Automatically manage signing**
2. Select your Team
3. Click **+Capability** → **Hardened Runtime** (add it)
4. **Do NOT add App Sandbox** — the app will not work with it

**Info tab** (or edit `Info.plist` directly):  
- Make sure all keys from `CurieApp/Info.plist` are present  
  (especially `NSAppTransportSecurity → NSAllowsLocalNetworking = YES`)

**Build Settings tab:**
- Search `INFOPLIST_FILE` → set to `CurieApp/Info.plist`
- Search `CODE_SIGN_ENTITLEMENTS` → set to `CurieApp/Curie.entitlements`

### Step 5 — Set the entitlements file

1. Drag `Curie.entitlements` into the project (Create groups, add to target)
2. In **Build Settings** → `CODE_SIGN_ENTITLEMENTS` → `CurieApp/Curie.entitlements`

---

## Add Sparkle via Swift Package Manager

1. In Xcode: **File → Add Package Dependencies…**
2. Enter: `https://github.com/sparkle-project/Sparkle`
3. Version rule: **Up to Next Major**, starting at `2.0.0`
4. Click **Add Package**
5. In the "Choose package products" sheet:
   - Check **Sparkle** → Add to target **Curie**

This adds `Sparkle.framework` and `SPUStandardUpdaterController` to the build.

> `CurieApp.swift` imports `Sparkle` and instantiates `SPUStandardUpdaterController`
> — this is what checks for updates on launch and every 24 hours.

---

## Build the JS bundle

Run this script **from the repo root** (the directory that contains `package.json`):

```bash
bash macos/scripts/build_bundle.sh
```

What it does:
1. Runs `npm ci` and `npm run build` (TypeScript + Vite)
2. Installs production-only `node_modules` into a temp dir
3. Copies `dist/` and `node_modules/` into `macos/CurieApp/CurieApp/Resources/app/`
4. Downloads Node.js v22.14.0 for both x64 and arm64
5. Uses `lipo` to merge them into a single universal binary
6. Writes the binary to `macos/CurieApp/CurieApp/Resources/node`

You must re-run this script any time you change the JS codebase before archiving.

---

## Run in development

```bash
# 1. Build the JS bundle (first time or after JS changes)
bash macos/scripts/build_bundle.sh

# 2. Make sure Ollama is running
ollama serve &
ollama pull llama3.1:8b
ollama pull nomic-embed-text

# 3. In Xcode: Product → Run  (⌘R)
#    The app opens, OllamaManager checks the server,
#    NodeProcess starts the Express backend,
#    WebView loads http://127.0.0.1:8787
```

---

## Creating a release

### Local release (semi-automated)

```bash
# Step 1: Bump version in Info.plist CFBundleShortVersionString and CFBundleVersion
# Step 2: Rebuild JS bundle
bash macos/scripts/build_bundle.sh

# Step 3: Archive in Xcode
#   Product → Archive → Distribute App → Developer ID → Export

# Step 4: Run the release script
export SPARKLE_PRIVATE_KEY_PATH=/path/to/sparkle_private_key.txt
bash macos/scripts/release.sh --version 1.2.0

# This:
#  - Zips Curie.app
#  - Signs the zip with sign_update
#  - Updates macos/appcast.xml
#  - Commits and pushes appcast.xml to main
#  - Creates a GitHub Release with the zip attached
```

### Fully automated via GitHub Actions

```bash
# Just push a version tag — Actions does everything
git tag v1.2.0
git push origin v1.2.0
```

See [GitHub Actions CI/CD](#github-actions-cicd) for the full workflow.

---

## GitHub Actions CI/CD

The workflow file is at [`macos/github-actions/release.yml`](github-actions/release.yml).

To activate it:
```bash
# Copy to the standard GitHub Actions location in your repo
mkdir -p .github/workflows
cp macos/github-actions/release.yml .github/workflows/release-macos.yml
git add .github/workflows/release-macos.yml
git commit -m "ci: add macOS release workflow"
git push
```

The workflow:
1. Installs Node.js and builds the JS bundle
2. Downloads and lipo-merges the Node.js universal binary
3. Imports your Developer ID certificate into a temp keychain
4. Runs `xcodebuild archive` + `xcodebuild -exportArchive`
5. Notarizes with `xcrun notarytool`
6. Staples the notarization ticket (`xcrun stapler`)
7. Zips the `.app` and signs it with Sparkle's `sign_update`
8. Updates `macos/appcast.xml` and pushes to `main`
9. Creates a GitHub Release with the zip as an asset

---

## GitHub Secrets reference

Add these under **Settings → Secrets and Variables → Actions** in your GitHub repo:

| Secret | How to get it |
|---|---|
| `MACOS_CERTIFICATE` | Base64-encoded Developer ID .p12 (`base64 -i cert.p12`) |
| `MACOS_CERTIFICATE_PWD` | Password chosen when exporting the .p12 |
| `KEYCHAIN_PWD` | Any strong random password (used for the CI temp keychain) |
| `APPLE_ID` | Your Apple ID email address |
| `APPLE_TEAM_ID` | 10-char team ID from developer.apple.com (e.g. `ABCDE12345`) |
| `APP_SPECIFIC_PWD` | App-specific password from appleid.apple.com |
| `SPARKLE_PRIVATE_KEY` | Contents of the file exported by `generate_keys -x` |

---

## Customising models / settings

The default required models are `llama3.1:8b` and `nomic-embed-text`.  
To change them, edit the `requiredModels` array in
[`OllamaManager.swift`](CurieApp/CurieApp/OllamaManager.swift):

```swift
let requiredModels = ["llama3.1:8b", "nomic-embed-text"]
// → e.g. ["mistral:7b", "nomic-embed-text"]
```

The user can always change the active model in the Curie web UI Settings panel
after installation.

---

## Troubleshooting

### "node binary not found" at launch

Run `bash macos/scripts/build_bundle.sh` from the repo root.  
Check that `macos/CurieApp/CurieApp/Resources/node` exists and is executable:
```bash
file macos/CurieApp/CurieApp/Resources/node
# → Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable] [arm64]
```

### "server entry point not found"

The `dist/server/index.js` is missing.  Run the build script.

### App opens but WebView stays black

The Node.js server may not have started in time.  Check the Xcode console for
`[node]` log lines.  `WebView.swift` retries the load every 0.5 s for 15 s, so
usually it self-resolves.  If not, check:
- Port 8787 is not already in use: `lsof -i :8787`
- Node.js binary executes on your Mac: `macos/CurieApp/CurieApp/Resources/node -e 'console.log("ok")'`

### Sparkle "update signature invalid"

The `sparkle:edSignature` in `appcast.xml` was generated with a different key than
what is in `Info.plist SUPublicEDKey`.  Regenerate the keys or re-sign:
```bash
sign_update Curie-1.2.0.zip /path/to/sparkle_private_key.txt
# paste the output back into appcast.xml
```

### Notarization fails with "Invalid entitlements"

Make sure **App Sandbox is NOT enabled** in `Curie.entitlements`.  Hardened
Runtime must be enabled.  Verify:
```bash
codesign -d --entitlements - Curie.app
```

### Ollama not found even though it is installed

The search paths in `OllamaManager.findOllamaBinary()` cover:
- `/usr/local/bin/ollama`
- `/opt/homebrew/bin/ollama`
- `/usr/bin/ollama`
- `~/bin/ollama`

If yours is elsewhere, add the path to the `candidates` array in
[`OllamaManager.swift`](CurieApp/CurieApp/OllamaManager.swift).

```swift
private func findOllamaBinary() -> String? {
    let candidates = [
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/usr/bin/ollama",
        "\(NSHomeDirectory())/bin/ollama",
        "/your/custom/path/ollama",   // ← add here
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}
```

---

## Version bump checklist

When shipping a new version:

- [ ] Update `CFBundleShortVersionString` in `Info.plist` (e.g. `1.2.0`)
- [ ] Update `CFBundleVersion` in `Info.plist` (integer, monotonically increasing)
- [ ] Run `bash macos/scripts/build_bundle.sh` if JS changed
- [ ] `git tag v1.2.0 && git push origin v1.2.0`
- [ ] GitHub Actions runs automatically
- [ ] Verify the release appears at `github.com/YOUR_ORG/curie/releases`
- [ ] Verify `macos/appcast.xml` on `main` has the new entry
- [ ] Test in a fresh VM: download zip, unzip, open Curie.app, check for update prompt
