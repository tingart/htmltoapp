# Web OS Build System Architecture

## Overview

This document describes the complete architecture of the htmltoapp Web OS build system, a Tauri v2-based factory for packaging large HTML/CSS/JavaScript applications as native applications.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Web OS Frontend (HTML/CSS/JS)               │
│              (Your large existing Web OS application)           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Common Web OS JavaScript API                    │
│  window.webOS.fs, .terminal, .process, .network, .storage, etc  │
│              (Platform-independent interface)                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Tauri v2 Bridge                              │
│          (IPC: invoke, listen, emit between JS ↔ Rust)         │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Web OS Runtime (Rust Implementation)               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Common Runtime Layer (platform-agnostic logic)          │  │
│  │  - Permission validation                                  │  │
│  │  - Sandbox boundary enforcement                          │  │
│  │  - Path traversal prevention                             │  │
│  │  - Command validation                                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                        │
│         ┌───────────────┼───────────────┬────────────────┐      │
│         ▼               ▼               ▼                ▼      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐ │
│  │  Android  │ │  Windows  │ │   Linux   │ │    macOS    │ │
│  │  Adapter  │ │  Adapter  │ │  Adapter  │ │   Adapter   │ │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────┘ │
└─────────────────┬──────────────────────────────┬─────────────────┘
                  │                              │
        ┌─────────▼──────────┐      ┌────────────▼──────────┐
        │ Android Sandbox    │      │  Desktop Sandbox      │
        │ - Java interop     │      │  - Process control    │
        │ - Permission API   │      │  - FS restriction     │
        │ - Limited shell    │      │  - Full capabilities  │
        └────────────────────┘      └───────────────────────┘
```

## Component Deep Dive

### 1. Web OS Frontend Layer

**Purpose**: Your existing HTML/CSS/JavaScript application

**Key Constraints**:
- Must not contain platform-specific code (Android vs Windows, etc.)
- Detects Tauri availability at runtime
- Gracefully degrades in browser environment
- Uses common `window.webOS` API

**Browser Compatibility Detection**:
```javascript
const hasNativeRuntime = typeof window.__TAURI__ !== 'undefined';

if (hasNativeRuntime) {
  // Use full Web OS runtime API
  await webOS.fs.readFile('/home/user/document.txt');
} else {
  // Use browser APIs or mock fallbacks
  const content = localStorage.getItem('document.txt');
}
```

### 2. Common Web OS JavaScript API

**File Location**: `src/webos-api.js`

**Responsibility**: Bridge between frontend and native runtime

**No Platform-Specific Logic**: The API surface is identical across all platforms.

**Example Structure**:
```javascript
window.webOS = {
  fs: {
    readFile(path) { /* delegates to Tauri */ },
    writeFile(path, content) { /* delegates to Tauri */ },
    // ...
  },
  terminal: {
    exec(command) { /* delegates to Tauri */ },
    spawn(command, args) { /* delegates to Tauri */ },
    // ...
  },
  permissions: {
    request(perm) { /* delegates to Tauri */ },
    check(perm) { /* delegates to Tauri */ },
    // ...
  },
  // ... other modules
};
```

### 3. Tauri v2 Bridge

**Technology**: Tauri's IPC system

**Communication Flow**:
1. Frontend calls `window.__TAURI__.invoke('command_name', { arg1, arg2 })`
2. Message serialized to JSON
3. Routed to Rust backend
4. Handler executes, returns result
5. Frontend receives serialized response

**Security**: Tauri validates all command invocations against declared capabilities

**Configuration**: Defined in `src-tauri/tauri.conf.json` capabilities

### 4. Web OS Runtime (Rust Layer)

**Location**: `src-tauri/src/runtime/`

**Architecture**:

```
runtime/
├── mod.rs                    # Runtime initialization
├── filesystem.rs             # Sandboxed FS operations
├── terminal.rs               # Process execution (platform-aware)
├── process.rs                # Process management
├── network.rs                # Network operations
├── storage.rs                # Local/persistent storage
├── permissions.rs            # Permission system
└── device.rs                 # Platform/device info
```

#### 4a. Common Runtime Layer

All platform-specific implementations share common validation logic:

**Path Traversal Prevention**:
```rust
fn validate_path(requested_path: &str, sandbox_root: &Path) -> Result<PathBuf> {
    let full_path = sandbox_root.join(requested_path).canonicalize()?;
    
    // Ensure resolved path is within sandbox
    if !full_path.starts_with(sandbox_root) {
        return Err("Path traversal attempt detected");
    }
    
    Ok(full_path)
}
```

**Permission Validation**:
```rust
fn check_permission(operation: &str) -> Result<()> {
    let perms = get_granted_permissions();
    if !perms.contains(operation) {
        return Err(format!("Permission denied: {}", operation));
    }
    Ok(())
}
```

#### 4b. Platform Adapters

Each platform has specialized implementation in `src-tauri/src/platform/`

**Android**:
- Process execution limited to Java/Kotlin via JNI
- Terminal API provides controlled shell simulation
- Filesystem sandboxed to app-specific directory
- No direct native code execution

**Windows/Linux/macOS**:
- Full process execution with safety validation
- Terminal spawns actual shells in controlled manner
- Filesystem sandboxed to designated app directory
- All native capabilities available with permission checks

### 5. Sandboxed Runtime

#### Filesystem Sandbox

**Virtual Namespace** (not host filesystem):
```
/home/
  /user/
    /Documents/
    /Downloads/
    /Desktop/
/tmp/
/apps/
  /installed-app-1/
  /installed-app-2/
```

**Implementation**:
- Physical location: Platform-specific app data directory
  - Android: `/data/data/com.package.name/files/webos/`
  - Windows: `%APPDATA%\webos\`
  - Linux: `~/.local/share/webos/`
  - macOS: `~/Library/Application Support/webos/`
- Logical paths mapped to physical paths
- All path operations validated for sandbox escape

**Example**:
```rust
// User requests: /home/user/document.txt
// Resolves to:
//   Windows: C:\Users\username\AppData\Roaming\webos\home\user\document.txt
//   Linux: ~/.local/share/webos/home/user/document.txt
//   Android: /data/data/com.package.name/files/webos/home/user/document.txt
```

#### Process Execution Sandbox

**Desktop (Windows/Linux/macOS)**:
- Process spawned with restricted environment
- Limited environment variables (no secrets)
- Working directory confined to sandbox
- Resource limits (memory, CPU, file descriptors)
- Signal handling controlled

**Android**:
- No native process execution by default
- Terminal API simulated or uses Java ProcessBuilder with restrictions
- Can be extended to use isolated userspace runtime (future)

#### Permission System

**Permission Categories**:
- `filesystem:read` - Read files from sandbox
- `filesystem:write` - Write files to sandbox
- `terminal:exec` - Execute commands
- `process:spawn` - Spawn child processes
- `network:fetch` - HTTP/HTTPS requests
- `device:clipboard` - Access clipboard
- `device:camera` - Access camera
- `device:microphone` - Access microphone
- `device:notifications` - Send notifications

**Permission Enforcement**:
```rust
enum Permission {
    FilesystemRead,
    FilesystemWrite,
    TerminalExec,
    ProcessSpawn,
    NetworkFetch,
    DeviceClipboard,
    DeviceCamera,
    DeviceMicrophone,
    DeviceNotifications,
}

struct PermissionManager {
    granted: HashSet<Permission>,
}

impl PermissionManager {
    fn check(&self, perm: Permission) -> bool {
        self.granted.contains(&perm)
    }
    
    fn request(&mut self, perm: Permission) -> bool {
        // Show permission prompt (future: interactive UI)
        // For now: return based on manifest
        true
    }
}
```

## Build Factory Architecture

### Reusable Tauri Shell

**Key Insight**: One permanent Tauri project serves all Web OS applications.

**Process**:
1. Repository contains a "template" Tauri application
2. During build, temporary directory created
3. Web OS ZIP extracted into temporary directory
4. Web OS files copied to `src/` (frontend files)
5. Metadata (app.json) parsed and injected into configuration
6. Icons extracted and placed in `src-tauri/icons/`
7. Tauri configuration generated with correct app name, package ID, version
8. Build executed for target platform
9. Artifacts collected and uploaded
10. Temporary directory cleaned up

**Benefits**:
- No git bloat from permanent multiple Tauri projects
- Single source of truth for runtime implementation
- Easy to update runtime for all apps
- Efficient CI/CD pipeline

### GitHub Actions Workflow

**Trigger**: `repository_dispatch` from dashboard

**Matrix Strategy**:
```yaml
strategy:
  matrix:
    platform: [android, windows, linux, macos]
    exclude:
      # Only run requested platforms
      - platform: android
        if: ${{ !contains(github.event.inputs.platforms, 'android') }}
```

**Build Steps**:
1. Checkout repository
2. Extract Web OS ZIP from input
3. Validate project structure
4. Extract metadata
5. Generate Tauri configuration
6. Setup platform-specific tools (NDK, MSVC, etc.)
7. Build for platform
8. Sign artifacts (if credentials available)
9. Upload to GitHub Releases or Actions artifacts
10. Update dashboard with download links

## Communication Flow Examples

### Example 1: Read File from Web OS

```
┌─ Frontend ─────────────────────────────────────────────────────┐
│ const content = await webOS.fs.readFile('/home/user/file.txt'); │
└────────────────────────┬────────────────────────────────────────┘
                         │
    invoke('fs_read_file', { path: '/home/user/file.txt' })
                         │
┌────────────────────────▼────────────────────────────────────────┐
│ Tauri Handler (src-tauri/src/lib.rs)                           │
│ #[tauri::command]                                              │
│ async fn fs_read_file(path: String) -> Result<String>          │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────┐
│ Runtime Layer (src-tauri/src/runtime/filesystem.rs)            │
│ 1. check_permission("filesystem:read")                         │
│ 2. validate_path(&path)  → /home/user/file.txt                │
│ 3. canonicalize → ~/.local/share/webos/home/user/file.txt     │
│ 4. fs::read_to_string(&full_path)                             │
└────────────────────────┬────────────────────────────────────────┘
                         │
          Returns: String | Error
                         │
┌────────────────────────▼────────────────────────────────────────┐
│ Frontend receives: content                                      │
│ JavaScript continues with file content                         │
└────────────────────────────────────────────────────────────────┘
```

### Example 2: Execute Command

```
Frontend: await webOS.terminal.exec('ls -la /home/user/')
           │
           invoke('terminal_exec', { command: 'ls -la /home/user/' })
           │
        ┌──▼───────────────────────────────────────────┐
        │ Tauri Handler: terminal_exec                 │
        └──┬───────────────────────────────────────────┘
           │
        ┌──▼───────────────────────────────────────────┐
        │ Permission check: terminal:exec              │
        │ Command validation: 'ls' is safe            │
        │ Platform-specific execution:                │
        │   - Windows: Not available / error           │
        │   - Linux/macOS: spawn('sh', ['-c', cmd])   │
        │   - Android: Simulated or limited           │
        └──┬───────────────────────────────────────────┘
           │
      Returns: ExecResult { stdout, stderr, exitCode }
           │
Frontend: Displays output to user
```

## Security Boundaries

### What's Allowed
- ✅ Read/write within sandbox filesystem
- ✅ Execute validated commands (Linux/macOS only)
- ✅ Make network requests
- ✅ Access granted permissions
- ✅ Interact with device via permissions

### What's Blocked
- ❌ Path traversal outside sandbox
- ❌ Arbitrary native code execution (Android)
- ❌ Environment variable access (except whitelist)
- ❌ Direct host filesystem access
- ❌ Unrestricted process spawning
- ❌ Access to system credentials
- ❌ GitHub API tokens in frontend

## Platform-Specific Implementation Details

### Android

**Challenges**:
- No native shell execution capability
- Sandboxed environment by design
- Limited inter-process communication
- JNI complexity

**Solutions**:
- Terminal/shell API returns "Not available" or simulated responses
- Filesystem operations use Android Context.getFilesDir()
- Process API uses Java ProcessBuilder with restrictions
- Future: Integrate isolated Linux userspace (busybox-like) if needed

**Permissions**:
- Mapped to Android Manifest permissions
- Runtime permission requests via Android API

### Windows

**Advantages**:
- Full process execution capability
- Extensive native APIs available
- Well-documented Tauri integration

**Implementation**:
- Process spawning via std::process::Command
- Filesystem operations use Windows APIs
- Terminal uses cmd.exe or PowerShell
- Registry access available if needed

### Linux

**Advantages**:
- Full POSIX API availability
- Shell execution fully functional
- Standard system APIs

**Implementation**:
- Process spawning via std::process::Command
- Filesystem operations use standard POSIX calls
- Terminal uses /bin/sh or bash
- Full capabilities available

### macOS

**Advantages**:
- POSIX-compatible like Linux
- Cocoa framework integration
- Similar to Linux with additional native APIs

**Implementation**:
- Process spawning via std::process::Command
- Filesystem operations use standard POSIX calls
- Terminal uses /bin/sh or bash
- Notarization required for distribution

## Build System Architecture

### Workflow Trigger

**GitHub Pages Dashboard** → **repository_dispatch** → **GitHub Actions Workflow**

### Build Steps

1. **Input Validation**
   - Validate JSON inputs (app name, package ID, version)
   - Verify platforms list
   - Check ZIP size limits

2. **Artifact Preparation**
   - Download or mount Web OS ZIP
   - Extract to temporary directory
   - Parse app.json if present
   - Extract icon.png if present
   - Validate structure (index.html exists)

3. **Configuration Generation**
   - Generate Tauri configuration with correct metadata
   - Update package ID, version, app name
   - Inject icon paths
   - Configure capabilities/permissions

4. **Build Execution**
   - For each requested platform:
     - Setup platform-specific tools (NDK, MSVC, etc.)
     - Run `tauri build --target <platform>`
     - Collect artifacts
     - Sign if credentials available

5. **Artifact Processing**
   - Rename to standard format
   - Generate checksums
   - Upload to GitHub Releases or artifacts
   - Create download manifest

6. **Cleanup**
   - Delete temporary directory
   - Remove intermediate build artifacts
   - Update workflow status

## Extensibility Points

### Adding New Platform Adapters

1. Create `src-tauri/src/platform/newplatform.rs`
2. Implement trait:
   ```rust
   pub trait PlatformAdapter {
       fn execute_command(&self, cmd: &str, args: &[&str]) -> Result<ExecResult>;
       fn read_file(&self, path: &Path) -> Result<Vec<u8>>;
       // ... other methods
   }
   ```
3. Register in `src-tauri/src/platform/mod.rs`
4. Add to GitHub Actions matrix

### Adding New Runtime Modules

1. Create `src-tauri/src/runtime/newmodule.rs`
2. Implement command handlers
3. Expose via Tauri `#[tauri::command]` macro
4. Add JavaScript wrapper in `src/webos-api.js`
5. Document in API.md

### Extending Permission System

1. Add new variant to `Permission` enum
2. Update permission validation logic
3. Update manifest parsing
4. Update permission request UI (future)

## Configuration Flow

```
app.json (user provided)
├── name: "My Web OS"
├── packageId: "com.example.webos"
├── version: "1.0.0"
└── description: "My operating system"
     │
     ▼
[Build System Parsing]
     │
     ▼
Generated tauri.conf.json
├── productName: "My Web OS"
├── identifier: "com.example.webos"
├── version: "1.0.0"
├── description: "My operating system"
├── capabilities: [platform-specific]
└── iconPath: "path/to/icon.png"
     │
     ▼
[Tauri Compiler]
     │
     ├─▶ APK (Android)
     ├─▶ MSI (Windows)
     ├─▶ AppImage (Linux)
     └─▶ DMG (macOS)
```

## Summary

This architecture provides:
1. **Platform independence** at the frontend level
2. **Pluggable platform adapters** for native functionality
3. **Security by default** with sandboxing and validation
4. **Efficiency** through reusable Tauri shell
5. **Extensibility** for future enhancements
6. **Maintainability** through clear separation of concerns
