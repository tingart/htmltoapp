# Web OS Multi-Platform Build System

A reusable Tauri v2-based build factory for packaging large HTML/CSS/JavaScript applications as native applications across Android, Windows, Linux, and macOS.

## Overview

This repository is **not** a permanent Tauri project. Instead, it's a **build factory** that:

1. Accepts a Web OS project as a ZIP archive
2. Validates and extracts the project
3. Injects it into a reusable Tauri v2 shell
4. Builds native applications for requested platforms
5. Provides a GitHub Pages dashboard for build management

## Quick Start

### For Web OS Developers

1. **Prepare your Web OS ZIP**
   - Your project should be a standard HTML/CSS/JavaScript application
   - Optionally include `app.json` for metadata
   - Optionally include `icon.png` (1024x1024 or larger)
   - Index file should be `index.html`

2. **Upload via GitHub Pages Dashboard**
   - Visit: `https://yourusername.github.io/htmltoapp/`
   - Upload your ZIP file
   - Specify app name, package ID, version
   - Select target platforms
   - Click "Build"

3. **Download Artifacts**
   - After the build completes, download native apps
   - Android: APK and/or AAB
   - Windows: MSI and/or portable
   - Linux: AppImage and/or DEB
   - macOS: DMG

### For Repository Maintainers

1. **Initial Setup**
   ```bash
   # Clone the repository
   git clone https://github.com/tingart/htmltoapp
   cd htmltoapp
   
   # Configure GitHub Actions secrets
   # - ANDROID_KEYSTORE (optional, for signing)
   # - ANDROID_KEYSTORE_PASS (optional)
   # - ANDROID_KEY_ALIAS (optional)
   # - ANDROID_KEY_PASS (optional)
   
   # Enable GitHub Pages
   # - Settings → Pages → Source: GitHub Actions
   ```

2. **Enable GitHub Pages Deployment**
   - The dashboard workflow automatically deploys to GitHub Pages on push to main

## Architecture

```
Web OS ZIP
    ↓
[GitHub Pages Dashboard]
    ↓
[GitHub Actions Workflow]
    ↓
[Tauri v2 Build Factory]
    ├── [Web OS Runtime - Common API]
    │   ├── webOS.fs (Sandboxed filesystem)
    │   ├── webOS.terminal (Process execution)
    │   ├── webOS.process (Process management)
    │   ├── webOS.network (Network access)
    │   ├── webOS.storage (Local storage)
    │   ├── webOS.permissions (Permission system)
    │   └── webOS.device (Platform/device info)
    │
    ├── [Platform Adapters]
    │   ├── Android (Java/Kotlin bridge)
    │   ├── Windows (Win32/WinRT)
    │   ├── Linux (GTK/native syscalls)
    │   └── macOS (Cocoa)
    │
    └── [Sandboxed Runtime]
        └── Virtual filesystem, controlled process execution
```

## Key Features

- **Reusable Shell**: One Tauri project, infinite Web OS applications
- **Platform Abstraction**: Single JavaScript API, platform-specific implementations
- **Sandboxed**: Virtual filesystem, controlled process execution, permission system
- **Large Project Support**: Efficient ZIP handling, preserves directory structure and file types
- **Secure Dashboard**: No exposed credentials, uses GitHub Actions workflow_dispatch
- **Metadata Support**: Optional `app.json` and `icon.png` for customization
- **Web Fallback**: Same frontend runs in browser without Tauri
- **Multi-platform Builds**: Android (APK/AAB), Windows, Linux (AppImage/DEB), macOS (DMG)

## Web OS API Reference

### Filesystem
```javascript
webOS.fs.readFile(path) → Promise<string>
webOS.fs.writeFile(path, content) → Promise<void>
webOS.fs.readdir(path) → Promise<string[]>
webOS.fs.mkdir(path) → Promise<void>
webOS.fs.remove(path) → Promise<void>
webOS.fs.stat(path) → Promise<FileStats>
```

### Terminal/Process
```javascript
webOS.terminal.exec(command) → Promise<ExecResult>
webOS.terminal.spawn(command, args) → Promise<ProcessId>
webOS.process.list() → Promise<Process[]>
webOS.process.kill(pid) → Promise<void>
```

### Permissions
```javascript
webOS.permissions.request(permission) → Promise<boolean>
webOS.permissions.check(permission) → Promise<boolean>
webOS.permissions.list() → Promise<PermissionStatus[]>
```

### Other APIs
```javascript
webOS.network.fetch(url, options) → Promise<Response>
webOS.storage.setItem(key, value) → Promise<void>
webOS.storage.getItem(key) → Promise<string|null>
webOS.device.getInfo() → Promise<DeviceInfo>
webOS.device.getPlatform() → "android" | "windows" | "linux" | "macos" | "web"
```

## Platform-Specific Limitations

### Android
- Terminal/shell execution is sandboxed; full Linux userspace not provided
- Process execution limited to Java/Kotlin interop
- Filesystem sandboxed to app-specific directory
- Network access available
- Camera/microphone via Android permissions system

### Windows
- Full process execution in sandboxed environment
- Filesystem access respects sandbox boundaries
- All APIs fully supported

### Linux
- Full process execution available
- Filesystem access respects sandbox boundaries
- All APIs fully supported

### macOS
- Full process execution available
- Filesystem access respects sandbox boundaries
- Notarization required for distribution

## File Structure

```
├── README.md                      # This file
├── ARCHITECTURE.md                # Detailed architecture
├── SECURITY.md                    # Security model and threat analysis
├── CONTRIBUTING.md                # Contribution guidelines
├── LICENSE                        # License (MIT by default)
│
├── .github/
│   ├── workflows/
│   │   ├── build.yml              # Multi-platform build workflow
│   │   └── deploy-pages.yml       # GitHub Pages deployment
│   │
│   └── SECURITY.md                # GitHub security policy
│
├── src-tauri/                     # Tauri v2 shell (core native app)
│   ├── Cargo.toml                 # Rust dependencies
│   ├── tauri.conf.json            # Tauri configuration
│   ├── src/
│   │   ├── main.rs                # Application entry point
│   │   ├── lib.rs                 # Tauri commands
│   │   │
│   │   ├── runtime/               # Web OS runtime implementation
│   │   │   ├── mod.rs
│   │   │   ├── filesystem.rs
│   │   │   ├── terminal.rs
│   │   │   ├── process.rs
│   │   │   ├── network.rs
│   │   │   ├── storage.rs
│   │   │   ├── permissions.rs
│   │   │   └── device.rs
│   │   │
│   │   └── platform/              # Platform-specific adapters
│   │       ├── mod.rs
│   │       ├── android.rs
│   │       ├── windows.rs
│   │       ├── linux.rs
│   │       └── macos.rs
│   │
│   └── icons/                     # App icon assets (generated)
│
├── src/                           # Web OS frontend (placeholder)
│   ├── index.html
│   ├── styles.css
│   └── webos-api.js               # Web OS API bridge
│
├── build-system/                  # Build automation
│   ├── scripts/
│   │   ├── extract-zip.sh
│   │   ├── validate-project.sh
│   │   ├── inject-webos.sh
│   │   ├── build-platform.sh
│   │   └── sign-artifact.sh
│   │
│   └── templates/                 # Configuration templates
│       ├── tauri.conf.json
│       └── Cargo.toml
│
├── dashboard/                     # GitHub Pages dashboard
│   ├── index.html                 # Upload interface
│   ├── styles.css                 # Dashboard styling
│   ├── app.js                     # Dashboard logic
│   └── api.js                     # GitHub API interaction (no tokens)
│
├── example-webos/                 # Minimal test Web OS
│   ├── app.json
│   ├── icon.png
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── tests/
│       └── test-apis.js
│
└── docs/                          # Additional documentation
    ├── SETUP.md                   # Detailed setup instructions
    ├── API.md                     # Full API documentation
    ├── DEPLOY.md                  # Deployment guide
    └── TROUBLESHOOT.md            # Troubleshooting guide
```

## Build Workflow

### Manual Workflow (via Dashboard)

1. User uploads Web OS ZIP via dashboard
2. Specifies app name, package ID, version, platforms
3. Dashboard triggers GitHub Actions via `repository_dispatch`
4. Build workflow:
   - Extracts ZIP
   - Validates project structure
   - Extracts `app.json` and `icon.png`
   - Generates Tauri configuration
   - Builds for requested platforms
   - Uploads artifacts to GitHub Releases (optional)
5. User downloads artifacts from dashboard

### CLI Workflow (for developers)

```bash
./build-system/scripts/build-platform.sh \
  --zip ./my-webos.zip \
  --name "My App" \
  --package-id "com.example.myapp" \
  --version "1.0.0" \
  --platform android \
  --output ./dist
```

## Security Considerations

### Design Principles
- **Least privilege**: No unrestricted native access by default
- **Sandboxed filesystem**: Virtual namespace, path traversal prevention
- **Validated commands**: All process execution validated
- **Permission system**: Explicit permission grants required
- **No credential exposure**: GitHub tokens never in frontend code

### Threat Model
- Assume Web OS can execute arbitrary JavaScript
- Prevent access to host system beyond sandbox
- Prevent path traversal attacks
- Prevent arbitrary process execution
- Prevent credential leakage

See `SECURITY.md` for full threat analysis.

## GitHub Pages Setup

The dashboard is deployed to GitHub Pages automatically via GitHub Actions.

1. **Enable Pages in Settings**
   - Go to Settings → Pages
   - Source: GitHub Actions

2. **No Additional Configuration Required**
   - Workflow automatically builds and deploys on push to main

3. **Dashboard URL**
   - `https://<username>.github.io/htmltoapp/`

## Local Development

### Prerequisites
- Node.js 18+
- Rust 1.70+
- Tauri 2.0+
- Android SDK (for Android builds)
- Platform-specific tools (Xcode for macOS, Visual Studio for Windows)

### Setup

```bash
# Install dependencies
npm install

# Install Rust toolchain
rustup target add wasm32-unknown-unknown

# For Android (optional)
rustup target add aarch64-linux-android

# Start development server
npm run dev

# Build example Web OS
npm run build:example

# Test individual platform builds
npm run build:windows
npm run build:linux
npm run build:macos
npm run build:android
```

## GitHub Actions Secrets (Optional)

For signing builds, configure these secrets in Settings → Secrets and variables → Actions:

- `ANDROID_KEYSTORE` - Base64-encoded Android keystore file
- `ANDROID_KEYSTORE_PASS` - Keystore password
- `ANDROID_KEY_ALIAS` - Key alias
- `ANDROID_KEY_PASS` - Key password

**Note**: For public distributions, you should set up proper code signing. See `DEPLOY.md`.

## Next Steps

1. Review `ARCHITECTURE.md` for detailed system design
2. Read `SECURITY.md` for threat model and security decisions
3. Check `.github/workflows/build.yml` for build configuration
4. Explore `src-tauri/` for runtime implementation
5. Test with `example-webos/`

## Contributing

See `CONTRIBUTING.md` for guidelines.

## License

MIT License - See LICENSE file

## Support

For issues and questions:
- Check `docs/TROUBLESHOOT.md`
- Review existing GitHub Issues
- Create a new Issue with platform and error details
