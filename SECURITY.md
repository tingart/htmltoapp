# Security model and limitations

Forge accepts user-controlled HTML/JavaScript and ZIP files, publishes a static dashboard, optionally uploads projects to a Worker, and packages apps in GitHub Actions. Treat project content and build metadata as untrusted.

## Trust boundaries

```text
Browser / GitHub Pages
  - public static code only
  - local projects in IndexedDB
  - short-lived relay session, no GitHub PAT/App key
        │ HTTPS + exact-origin CORS
        ▼
Cloudflare Worker / R2
  - GitHub App private key + OAuth client secret in Worker secrets
  - session, collaborator check, rate limit, ZIP streaming
  - temporary private source object, no source code in Git history
        │ workflow_dispatch
        ▼
GitHub Actions
  - factory-owned, locked tool dependencies
  - short-lived GITHUB_TOKEN: contents:read, actions:read
  - no project npm install or project build hook
        │ Tauri native bundles
        ▼
Installed Tauri app
  - untrusted HTML/JavaScript runs in the OS WebView
  - Rust IPC commands enforce narrow app-data/permission rules
```

## GitHub credentials and upload flow

- Never add a PAT, OAuth client secret, GitHub App private key, Android keystore, or signing password to the dashboard, `config.js`, a project ZIP, a commit, or a Pages artifact.
- GitHub App credentials live only as Cloudflare Worker secrets. The Worker mints a repository-scoped installation token server-side and asks GitHub to dispatch the build workflow.
- The Worker completes OAuth code exchange server-side, checks the account's write permission on the configured repository, discards the user access token, and returns a short-lived HMAC-signed Worker session (30 minutes). The dashboard keeps it in `sessionStorage`, not as a GitHub credential.
- The R2 object uses a random UUID and remains private. The Actions runner presents its run-scoped `GITHUB_TOKEN` and run ID; the Worker verifies the run via the GitHub API, including repository, workflow path, event, branch and display title, before returning source bytes.
- GitHub App permission is limited to **Actions: read/write** for the installed repository. The build job's `GITHUB_TOKEN` is limited to `contents: read` and `actions: read`. Do not add release publishing, package-write, or other permissions unless a separate reviewed feature needs them.
- CORS is exact-origin, never `*`. It prevents unrelated browser origins from reading responses but is not authentication. Build submission additionally requires a signed session for a repository writer and a rate-limit binding.
- Artifact download tickets are short-lived and scoped to one run/artifact. GitHub Actions artifacts are available to people with access to the repository; links expire with the ticket/artifact.
- Source ZIPs stay out of Git history and are cleaned from R2 after 7 days. Build artifacts expire after 14 days.

## Untrusted archive and build handling

The Python packager validates each ZIP entry before writing it. It rejects absolute paths, `..`, Windows drive/prefix paths, path ambiguities, symlinks/special files, encrypted entries, duplicate case-insensitive files, high compression ratios, excessive entry counts and excessive expanded size. It does not call `ZipFile.extractall`. The project root must contain `index.html` (or be inside one wrapper directory).

The runner does **not** run uploaded package lifecycle scripts, `npm install`, shell scripts, user Cargo manifests, or user build commands. Only static project files are copied into the trusted reusable Tauri shell. Project source is never inserted into `Cargo.toml` or Tauri configuration other than validated name, package ID, version, and description fields. `icon.png` is parsed to produce platform icons; malformed icons fail the build.

This reduces CI code-execution exposure but does not make arbitrary project content safe to install. A produced app contains the ZIP's own HTML/JavaScript and can make network requests within WebView rules. Only package and install apps you trust.

## Tauri runtime permissions

### What is implemented

- `window.webOS` calls a small, registered Rust command set; unknown Rust commands are not exposed.
- Each filesystem, terminal, process and storage operation checks a named grant. Grants default to denied, are shown through Tauri's native dialog plugin, and reset when the app restarts.
- Virtual filesystem paths are absolute namespace paths mapped under the Tauri app-data directory. Path traversal, platform prefixes, and symlinks are rejected; reads/writes use UTF-8 text with size limits.
- The terminal supports only fixed Rust built-ins (`help`, `pwd`, `ls`, `cat`, `echo`, `mkdir`, `touch`, `rm`, `clear`). No `sh -c`, PowerShell, `cmd.exe`, executable search, shell parsing, pipelines or redirection are present.
- The starter process API records short-lived built-in tasks. It does not run native processes on desktop or Android.
- `webOS.network.fetch` uses the WebView's Fetch API. It checks a permission, requires HTTPS in native mode, and blocks obvious localhost/private IPv4 URLs.

### Explicit limitations

- Tauri's Rust process still runs as the current OS user. The virtual path checks are an application boundary, **not** a kernel sandbox, container, or protection against a same-user hostile process. Path-based checks cannot eliminate every filesystem TOCTOU race. Do not add arbitrary process execution under this model.
- The webOS network wrapper is not a complete SSRF/DNS-rebinding defense. App JavaScript can call native-WebView `fetch` directly; CSP and browser CORS are not an OS-level network sandbox.
- No arbitrary host filesystem picker, camera, microphone, clipboard, notifications, or unrestricted device APIs are enabled. An app-data sandbox does not need broad Android storage permissions.
- Browser fallbacks are convenience previews only. They do not grant native permission and browser local storage is not equivalent to the Rust filesystem.

Before adding a real terminal/process API, use an OS-enforced isolation mechanism on desktop and a separate Android userspace/runtime. Before adding a host file picker, copy selected files through a Rust-owned dialog flow into a scoped app directory rather than accepting arbitrary absolute paths from JavaScript.

## Signing and supply chain

- Android signing secrets are optional GitHub Actions secrets and are not made available to user JavaScript. The Android job writes a temporary keystore under the runner's temporary directory and does not upload it.
- Use a stable Android signing key for upgrades; rotating it can prevent installation as an update.
- Windows bundles and macOS DMGs are unsigned; macOS builds are not notarized. Add and separately review platform-specific signing/notarization flows before distributing them broadly.
- `package-lock.json` locks the Node build tools; Rust dependencies are maintained in the Tauri shell's `Cargo.toml` and resolved by Cargo on native runners. Keep actions, Tauri CLI, Rust crates, and platform SDKs updated and review changes.
- The workflow intentionally uploads Actions artifacts rather than writing source ZIPs into the repository or creating releases by default.

## If you find a vulnerability

Do not put exploit details or credentials in a public issue. Contact the repository maintainer privately and include affected versions, platform, reproduction steps, and impact. Rotate any accidentally exposed GitHub App or signing credential immediately.
