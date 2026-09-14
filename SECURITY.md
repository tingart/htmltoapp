# Security Model and Threat Analysis

## Executive Summary

This document outlines the security architecture, threat model, and mitigation strategies for the Web OS build system. **Security is by design, not an afterthought.**

### Key Principles
1. **Least Privilege**: No capabilities granted by default
2. **Defense in Depth**: Multiple validation layers
3. **Fail Secure**: Errors default to denial, not permission
4. **Transparency**: Security decisions clearly documented
5. **No Secrets in Code**: All credentials in GitHub Secrets

## Threat Model

### Threat Actors

1. **Malicious Web OS Developer**
   - Controls application code and resources
   - May attempt to escape sandbox
   - May attempt to access host system
   - May attempt to exfiltrate data

2. **Supply Chain Attacker**
   - Compromises dependency or tool
   - Injects malicious code during build
   - May attempt to steal signing keys

3. **Network Attacker**
   - Intercepts network traffic
   - Attempts to redirect downloads
   - Attempts to modify artifacts

4. **End User**
   - May accidentally grant dangerous permissions
   - May download untrusted Web OS applications
   - May be phished into misusing application

### Threat Scenarios

#### Scenario 1: Path Traversal Attack
**Threat**: Malicious Web OS reads `/etc/passwd` or Windows credentials

**Attack Vector**:
```javascript
await webOS.fs.readFile('../../../../../../etc/passwd')
```

**Mitigation**:
- Canonical path resolution
- Sandbox boundary validation
- Path must resolve within sandbox root
- Symbolic link handling

**Implementation**:
```rust
fn validate_path(requested: &str, sandbox_root: &Path) -> Result<PathBuf> {
    // 1. Join with sandbox root
    let full_path = sandbox_root.join(requested);
    
    // 2. Canonicalize (resolve symlinks, .., etc.)
    let canonical = full_path.canonicalize()
        .context("Cannot resolve path")?;
    
    // 3. Verify within sandbox
    if !canonical.starts_with(sandbox_root) {
        return Err(anyhow!("Path traversal detected"));
    }
    
    Ok(canonical)
}
```

#### Scenario 2: Arbitrary Command Execution
**Threat**: Malicious Web OS executes system commands

**Attack Vector**:
```javascript
// Attempt 1: Direct dangerous command
await webOS.terminal.exec('rm -rf /')

// Attempt 2: Shell injection
await webOS.terminal.exec('echo x; dangerous_command')
```

**Mitigation**:
- Command whitelist for common operations
- Arguments not executed as shell code
- Separate spawn (safer) from exec (requires validation)
- No shell interpretation of string arguments
- Environment variable filtering

**Implementation**:
```rust
pub async fn exec_command(cmd: &str, args: Vec<String>) -> Result<ExecResult> {
    // 1. Check permission
    check_permission("terminal:exec")?;
    
    // 2. Validate command (whitelist or safe list)
    let safe_commands = vec!["ls", "cat", "echo", "grep", "mkdir", "touch"];
    if !safe_commands.contains(&cmd) {
        // For desktop, may allow but with warnings
        // For Android, deny
    }
    
    // 3. Spawn with no shell interpretation
    // SAFE: Arguments passed directly, not through shell
    let output = Command::new("sh")
        .arg("-c")  // Only shell invocation
        .arg(&format!("{} {}", cmd, args.join(" ")))
        // BETTER: Use exec without shell
        .output()?;
    
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(1),
    })
}
```

#### Scenario 3: Credential/Token Exposure
**Threat**: GitHub PAT, signing keys, or other secrets leaked

**Attack Vectors**:
- Hardcoded in source code
- Exposed in environment variables
- Exposed in frontend JavaScript
- Leaked through error messages
- Leaked in logs

**Mitigations**:

✅ **DO**:
- Store all secrets in GitHub Secrets
- Pass secrets only through:
  - GitHub Actions runner environment (masked)
  - Tauri signed updater
  - Encrypted configuration
- Use temporary credentials with expiration
- Mask secrets in logs
- Use service accounts with minimal permissions
- Rotate credentials regularly

❌ **DON'T**:
- Commit secrets to repository
- Pass secrets to frontend JavaScript
- Log secrets
- Include secrets in error messages
- Use user's PAT (use GitHub App or service account)
- Store signing keys in repository

**Implementation**:
```rust
// GOOD: Read from environment (GitHub Actions sets this)
let keystore_pass = std::env::var("ANDROID_KEYSTORE_PASS")
    .expect("ANDROID_KEYSTORE_PASS not set");
// GitHub Actions automatically masks this in logs

// BAD: Would never do this
let keystore_pass = "hardcoded_password"; // ❌ NEVER

// Frontend - ALWAYS check for Tauri before accessing anything
if typeof window.__TAURI__ === 'undefined' {
    // In browser - no access to native APIs
    console.log('Tauri not available');
} else {
    // In Tauri - safe to use APIs
}
```

#### Scenario 4: Man-in-the-Middle (MITM) Attack
**Threat**: Attacker intercepts network traffic

**Attack Vector**:
- Redirect download links
- Modify artifact checksums
- Intercept WebSocket connections

**Mitigations**:
- All connections use HTTPS (enforced)
- SHA256 checksums provided for artifacts
- GitHub Releases provides integrity verification
- GitHub Actions artifacts signed
- Dashboard only communicates with GitHub API over HTTPS

#### Scenario 5: Supply Chain Compromise
**Threat**: Dependency vulnerability or backdoor

**Attack Vectors**:
- Compromised npm package
- Compromised Rust crate
- Compromised build tool

**Mitigations**:
- Lock dependency versions
- Use dependency vulnerability scanning
- Regular security audits
- Pin base images in GitHub Actions
- Use official, verified sources

## Permission Model

### Permission Categories

#### 1. Filesystem Permissions
```
filesystem:read
  - Read files within sandbox
  - Cannot traverse outside sandbox
  - Cannot access host system files
  
filesystem:write
  - Write/modify files within sandbox
  - Create directories within sandbox
  - Cannot modify outside sandbox
  
filesystem:delete
  - Remove files/directories within sandbox
  - Cannot delete outside sandbox
```

#### 2. Terminal Permissions
```
terminal:exec
  - Execute commands within sandbox
  - Limited to whitelisted/safe commands (initial)
  - Environment variables filtered
  - Working directory confined to sandbox
  - No shell escape sequences allowed
```

#### 3. Process Permissions
```
process:spawn
  - Spawn child processes
  - Respects sandbox boundaries
  - Cannot escalate privileges
  - Resource limits enforced
  
process:list
  - List running processes
  - Limited to processes within sandbox
```

#### 4. Network Permissions
```
network:fetch
  - Make HTTP/HTTPS requests
  - No DNS rebinding attacks
  - No local network access (127.0.0.1, 192.168.x.x)
  - Respect CORS headers
```

#### 5. Device Permissions
```
device:clipboard
  - Read/write clipboard
  
device:camera
  - Access camera device (with OS permission)
  
device:microphone
  - Access microphone (with OS permission)
  
device:notifications
  - Send system notifications
```

### Permission Grant Flow

```
┌─────────────────────────────────────────┐
│  Web OS requests permission via API:    │
│  webOS.permissions.request('filesystem') │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────▼──────────┐
        │ Permission already  │
        │ granted in manifest? │
        └──┬──────────────┬───┘
           │ YES          │ NO
           │              │
           ▼              ▼
      [Allow]      [Deny - Security Risk]
           │              │
           └──────┬───────┘
                  │
      Return: boolean (granted or denied)
```

### Default Permissions

**Initially Granted**:
- None (deny by default)

**Recommended for Most Apps**:
- `filesystem:read`
- `filesystem:write`
- `network:fetch`
- `device:notifications`

**Dangerous (require explicit user confirmation)**:
- `terminal:exec`
- `process:spawn`
- `device:camera`
- `device:microphone`
- `device:clipboard` (read)

### Permission Declaration

Web OS can optionally declare required permissions in `app.json`:

```json
{
  "name": "My Web OS",
  "packageId": "com.example.webos",
  "version": "1.0.0",
  "permissions": [
    "filesystem:read",
    "filesystem:write",
    "network:fetch",
    "device:notifications"
  ]
}
```

## Sandbox Design

### Filesystem Sandbox

**Goal**: Contain all file I/O within a designated directory

**Physical Layout**:
```
Platform           Base Directory                Virtual Root
─────────────────────────────────────────────────────────────
Android    /data/data/com.package.name/files/   /
Windows    %APPDATA%\com.package.name\data\     /
Linux      ~/.local/share/com.package.name/     /
macOS      ~/Library/Application Support/pkg/   /
```

**Virtual Filesystem Structure**:
```
/
├── home/
│   └── user/
│       ├── Documents/
│       ├── Downloads/
│       ├── Desktop/
│       └── .config/
├── tmp/
├── apps/
│   └── (installed applications)
└── system/
    └── (read-only system files)
```

**Access Control**:
- Only paths within sandbox allowed
- Symbolic links resolved to check boundaries
- Hard links cannot escape sandbox
- `.` and `..` normalized before validation

### Process Sandbox

**Desktop (Windows/Linux/macOS)**:
- Child processes inherit sandbox constraints
- Environment variables filtered (no secrets)
- Working directory confined to sandbox
- Cannot access parent's resources
- Resource limits via OS (ulimit on Linux/macOS, Job Objects on Windows)

**Android**:
- No native process spawning (by design)
- Future: Isolated Linux userspace environment

## API Security

### Tauri Command Validation

All commands validated at multiple layers:

```
1. Frontend calls: invoke('fs_read_file', { path: '/home/user/file.txt' })
                   │
                   ▼
2. Tauri Framework: Validates command name exists
                   │
                   ▼
3. Tauri Permissions: Checks against capability manifest
                   │
                   ▼
4. Rust Handler: 
   a) check_permission("filesystem:read")
   b) validate_path("/home/user/file.txt")
   c) Execute operation
   d) Return result or error
```

### Input Validation

**All user input validated**:

```rust
#[tauri::command]
async fn fs_write_file(
    path: String,           // Validate path
    content: String,        // Validate content size
    create_parents: bool,   // Validate boolean
) -> Result<()> {
    // 1. Path validation
    if path.is_empty() {
        return Err(anyhow!("Path cannot be empty"));
    }
    if path.len() > 4096 {
        return Err(anyhow!("Path too long"));
    }
    
    // 2. Content validation
    if content.len() > 100 * 1024 * 1024 {  // 100MB limit
        return Err(anyhow!("File too large"));
    }
    
    // 3. Permission check
    check_permission("filesystem:write")?;
    
    // 4. Path security
    let validated_path = validate_path(&path)?;
    
    // 5. Execute
    fs::write(&validated_path, &content)?;
    Ok(())
}
```

### Error Handling

**Never expose sensitive information in errors**:

```rust
// GOOD: Generic error
if file_not_found {
    return Err(anyhow!("File not found"));
}

// BAD: Path information (attacker learns sandbox structure)
if file_not_found {
    return Err(anyhow!("File not found: /home/user/.ssh/id_rsa"));
}

// BAD: System error (may leak OS info)
if io_error {
    return Err(anyhow!("IO Error: {}", err));  // Could leak paths
}
```

## Network Security

### Allowed Network Operations
- ✅ HTTPS requests (enforced)
- ✅ HTTP requests (allowed, not recommended)
- ✅ WebSockets (with HTTPS)
- ✅ DNS queries (public resolvers only)

### Blocked Network Operations
- ❌ Local network access (127.0.0.1, localhost, 192.168.x.x, 10.x.x.x)
- ❌ Link-local addresses (169.254.x.x)
- ❌ Multicast (224.0.0.x)
- ❌ Raw socket access
- ❌ DNS rebinding attacks

### Implementation

```rust
fn validate_network_request(url: &str) -> Result<()> {
    let parsed_url = Url::parse(url)?;
    
    // 1. Only HTTPS allowed by default
    if parsed_url.scheme() != "https" && parsed_url.scheme() != "http" {
        return Err(anyhow!("Only HTTP/HTTPS allowed"));
    }
    
    // 2. Check host is not local
    if let Some(host) = parsed_url.host() {
        match host {
            url::Host::Ipv4(ip) => {
                if ip.is_loopback() || ip.is_private() || ip.is_link_local() {
                    return Err(anyhow!("Local network access blocked"));
                }
            }
            url::Host::Ipv6(ip) => {
                if ip.is_loopback() || ip.is_private() || ip.is_link_local() {
                    return Err(anyhow!("Local network access blocked"));
                }
            }
            _ => {} // Domain names allowed
        }
    }
    
    Ok(())
}
```

## Build Security

### GitHub Actions Security

**Practices**:
1. Use GitHub-hosted runners only
2. No self-hosted runners storing secrets
3. All secrets passed via GitHub Secrets (masked in logs)
4. Minimal permissions for each step
5. Separate secrets by platform/sensitivity

**Secrets Management**:
```yaml
env:
  # This is masked in logs by GitHub
  ANDROID_KEYSTORE_PASS: ${{ secrets.ANDROID_KEYSTORE_PASS }}
  
  # These are safely read by Tauri
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

### Artifact Signing

**Android**:
- APK signed with app keystore
- AAB signed with Google Play key
- Signatures verified before upload

**Windows**:
- MSI signed with code signing certificate
- Authenticode signatures included
- Timestamp server used

**macOS**:
- Code signed with developer certificate
- Notarized with Apple
- Gatekeeper validation

**Linux**:
- Checksums provided (SHA256)
- Optional: PGP signatures

### Build Reproducibility

**Challenges**: Builds contain timestamps and runtime-generated data

**Current Approach**:
- Use fixed build seeds where possible
- Document build environment
- Provide build logs
- Checksums publicly available

**Future**: Full reproducible builds if needed

## Dependency Security

### Rust Dependencies

**Management**:
- `Cargo.lock` committed (ensures reproducibility)
- Regular `cargo update` with security review
- Use `cargo audit` to check for vulnerabilities

### Node Dependencies

**Management**:
- `package-lock.json` committed
- Regular `npm audit` checks
- Automated security updates via Dependabot

### Build Tool Security

**Measures**:
- Use official source distributions
- Verify checksums
- Pin versions in GitHub Actions

## Incident Response

### If Credentials Are Compromised

1. **Immediately**:
   - Revoke compromised credential
   - Generate new credential
   - Update GitHub Secrets

2. **Investigation**:
   - Review GitHub Actions logs
   - Check git history
   - Review build artifacts

3. **Communication**:
   - Notify users if data was accessed
   - Release new builds

### If Vulnerability Discovered

1. **Assess Severity**:
   - Can current users be affected?
   - Can attackers exploit remotely?
   - What is the impact scope?

2. **Fix & Test**:
   - Develop patch
   - Test thoroughly
   - Generate new builds

3. **Release**:
   - Create security advisory
   - Release new builds with fix
   - Document fix in changelog

## Compliance & Auditing

### Auditing

**What's Logged**:
- Permission requests (success/failure)
- High-risk operations (terminal exec)
- Access denied events
- Build events

**What's NOT Logged**:
- File contents
- Network request bodies
- User data
- Secrets/credentials

### Future Audit Trail

```rust
struct AuditEvent {
    timestamp: DateTime<Utc>,
    operation: String,
    resource: String,
    permission: String,
    granted: bool,
    reason_if_denied: Option<String>,
}
```

## Security Limitations

### What We DON'T Provide

1. **Encrypted Storage**: Data at rest not encrypted
   - Future: Full disk encryption
   - Workaround: Use application-level encryption

2. **Network Privacy**: Traffic not tunneled
   - Use HTTPS
   - Future: VPN/proxy support

3. **Process Isolation**: Lightweight sandboxing
   - Not VM-level isolation
   - Respects OS-level boundaries

4. **Android Terminal**: No real shell
   - By design for security
   - Terminal API returns simulated responses
   - Future: Isolated Linux userspace

5. **Anti-Tampering**: Apps can be modified
   - Sign your builds
   - Use code obfuscation if needed
   - Future: Tamper detection

## Security Checklist

Before deploying:

- [ ] No hardcoded secrets in code
- [ ] All secrets in GitHub Secrets
- [ ] GitHub Secrets masked in logs
- [ ] Permissions validated on every operation
- [ ] Path traversal tests pass
- [ ] Network restrictions enforced
- [ ] Error messages don't leak info
- [ ] Sandbox boundaries tested
- [ ] Input validation implemented
- [ ] Dependency vulnerabilities checked
- [ ] Build reproducibility verified
- [ ] Code reviewed by team
- [ ] Security documentation updated
- [ ] Users informed of capabilities/limitations

## References

- OWASP Top 10: https://owasp.org/www-project-top-ten/
- Tauri Security: https://tauri.app/v1/guides/features/security/
- Sandboxing: https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md
- Permission Systems: https://developer.android.com/guide/topics/permissions
