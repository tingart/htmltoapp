# Architecture

Forge is a static project IDE, an optional authenticated upload relay, a GitHub Actions build factory, and one reusable Tauri v2 shell. The factory packages **static web output**; it does not run arbitrary project build scripts inside CI.

## System overview

```text
┌────────────────────────────────────────────────────────────┐
│ GitHub Pages: dashboard/                                    │
│ Projects + file tree + editor + ZIP import/export           │
│ Files are saved to this browser's IndexedDB                 │
└───────────────────────┬────────────────────────────────────┘
                        │ ZIP + metadata + short-lived session
                        ▼
┌────────────────────────────────────────────────────────────┐
│ Optional Cloudflare Worker + R2                             │
│ GitHub App OAuth · write-access check · rate limit           │
│ temporary ZIP storage · workflow_dispatch · build status     │
│ GitHub tokens/private key stay server-side                   │
└───────────────────────┬────────────────────────────────────┘
                        │ workflow_dispatch(upload_id, metadata)
                        ▼
┌────────────────────────────────────────────────────────────┐
│ GitHub Actions: .github/workflows/build.yml                  │
│ verify runner identity → download ZIP → validate/extract     │
│ inject API → configure reusable Tauri shell → native build   │
└───────────────────────┬────────────────────────────────────┘
                        │ same shared shell + different runner
             ┌──────────┼───────────┬───────────┐
             ▼          ▼           ▼           ▼
          Android    Windows      Linux       macOS
          APK/AAB    MSI/EXE      AppImage/DEB  DMG

Built app:
HTML/JS → window.webOS → Tauri v2 IPC → validated Rust commands
                                           └→ app-owned data sandbox
```

The browser dashboard still runs as a normal web page. The **downloaded app** is packaged in a Tauri native host and uses the platform WebView plus Rust IPC. A Tauri app is not a different rendering engine, and Tauri does not automatically grant unrestricted OS access.

## 1. Static project IDE

**Files:** `dashboard/index.html`, `styles.css`, `app.js`, `zip.js`, `config.js`.

- New projects contain `index.html`, `styles.css`, `app.js`, and `app.json`.
- Projects can be switched from the sidebar. Their metadata and file bytes live in IndexedDB under the current browser origin.
- Text files open in a small, dependency-free editor. File edits save automatically; ZIP import/export, multi-file uploads, new files, and drag/drop are supported.
- ZIP import understands stored and Deflate entries, checks CRCs, rejects unsafe paths/symlinks/encrypted ZIPs/duplicate case-folded paths, and supports a single wrapper directory.
- The editor is intentionally local-first: no project source is sent to a server until the user clicks **Build app**. Keep ZIP exports as backups because clearing browser data removes IndexedDB projects.

The Pages bundle is the contents of `dashboard/`. `dashboard/config.js` contains only public defaults. A Worker URL can be entered in the UI or set in that file; neither location may contain a secret.

## 2. Secure upload and build control

A GitHub Pages page cannot safely store a GitHub PAT, GitHub App private key, or a reusable Actions token. The included optional Worker is the small authenticated bridge used for one-click upload:

1. GitHub App OAuth redirects through the Worker. The Worker checks that the signed-in GitHub account has write permission to the configured repository.
2. The Worker exchanges the OAuth code server-side, discards the GitHub user token, and returns a Worker-signed, 30-minute session in the Pages URL fragment. The dashboard keeps that short-lived relay session in `sessionStorage`; it is not a GitHub token.
3. The browser sends a ZIP stream and validated metadata to the Worker. The Worker checks the exact allowed Pages origin, session, rate limit, size, ZIP signature and manifest before streaming the ZIP to private R2 storage.
4. The Worker obtains a repository-scoped GitHub App installation token and dispatches `build.yml` with an opaque upload ID, app metadata and target list. The App token/private key never reaches the browser or Actions build job.
5. The Actions runner presents its short-lived, read-only `GITHUB_TOKEN` and run ID to the Worker. The Worker checks the run against GitHub's Actions API and streams the matching ZIP to that runner.
6. The dashboard polls the Worker for status. The Worker uses its App installation token to list run metadata/artifacts and issues short-lived artifact download tickets. Source ZIPs are cleaned after 7 days; Actions artifacts expire after 14 days.

The manual workflow fallback accepts a repository-relative ZIP or a public HTTPS ZIP URL. It is for maintainers and does not bypass workflow/repository permissions.

### Worker API

- `GET /v1/health`: public, minimal health response.
- `GET /v1/auth/start` and `/v1/auth/callback`: GitHub App OAuth and repo-write verification.
- `GET /v1/me`: validate the short-lived relay session.
- `POST /v1/builds`: stream ZIP + `X-HTMLToApp-Manifest` to R2 and dispatch Actions.
- `GET /v1/builds/{uuid}`: build status, run URL and temporary artifact ZIP links.
- `GET /v1/source/{uuid}`: Actions-runner-only source retrieval, checked against the current GitHub run token and run ID.
- `GET /v1/artifacts/{uuid}/{artifact_id}`: validate a short-lived ticket then redirect to a signed GitHub artifact URL.

CORS is exact-origin, not wildcard. CORS is not authentication; uploads also require a short-lived signed session for a collaborator with repository write access and are rate-limited. The Worker uses a repository-scoped GitHub App installation token. Configure Worker secrets and R2/Pages values as described in [`docs/SETUP.md`](docs/SETUP.md).

## 3. Build factory and reusable Tauri shell

**Build inputs:** one ZIP, app name, package ID, version, comma-separated platforms.

**Permanent Tauri source:** `src-tauri/`. The user's files are staged under the ignored `app/` directory during the Actions job; separate permanent shells are not created.

For every selected platform job, Actions:

1. checks out the factory and installs only its locked build tools;
2. receives the ZIP from the Worker or validates a maintainer-selected manual source;
3. extracts with `build-system/scripts/prepare_project.py` (no `extractall`), limits entry/file/aggregate sizes, blocks path traversal, symlinks, duplicate case-insensitive names, special files, encrypted entries and extreme expansion ratios, then verifies `index.html`;
4. reads `app.json`, lets explicit workflow metadata override its matching fields, writes normalized metadata, and injects the common API script;
5. generates Tauri's PNG/ICO/ICNS/Android icons from `icon.png` or the factory icon and generates the per-app Tauri config;
6. builds on the native runner and uploads platform bundles plus SHA-256 files and a JSON manifest as Actions artifacts.

No user `package.json` scripts, shell scripts, npm dependencies, or project build hooks execute in the runner. Framework projects must arrive as static output containing root `index.html`. Resource paths are preserved. A single wrapper folder around the project is flattened; multiple top-level folders without a root `index.html` are rejected.

### Platform build details

- **Android:** Ubuntu + Java 17 + Android SDK/NDK. ARM64 APK/AAB. Optional signing secrets configure an Android release key; otherwise the output is unsigned.
- **Windows:** Windows 2025 runner; unsigned NSIS Setup EXE and MSI.
- **Linux:** Ubuntu 24.04 runner; AppImage and DEB.
- **macOS:** macOS 15 runner; unsigned, not-notarized DMG.

Actions artifacts are ZIPs that contain the named bundle(s), checksum files, and `manifest.json`. They can be downloaded from the dashboard while a valid short-lived ticket exists, or from the GitHub Actions run page.

## 4. Tauri frontend API and IPC bridge

The factory injects `src-tauri/frontend/webos-api.js` as `__htmltoapp_runtime.js`, before the project's own scripts. Tauri config enables `window.__TAURI__.core.invoke`; the public JS facade stays platform-independent:

```js
await webOS.permissions.request('filesystem:read');
const names = await webOS.fs.readdir('/home/user/Documents');
const info = await webOS.device.getInfo();
```

Tauri mode invokes only the registered Rust commands in `src-tauri/src/runtime/`. In a regular browser, the facade degrades to browser-local storage and a harmless simulated terminal; it never pretends that browser mode has native filesystem/shell access.

### Current runtime surface

- `webOS.fs`: text read/write, directory listing/creation, remove, stat, virtual paths only.
- `webOS.storage`: string key/value data in a per-app data directory.
- `webOS.permissions`: query/list/request a small explicit permission set. Native requests use Tauri's native dialog plugin; grants are in-memory and reset when the app restarts.
- `webOS.terminal`: fixed built-in commands only; no shell, pipes, redirection, host executable lookup, or Android shell.
- `webOS.process`: short-lived built-in task records. It does not create host operating-system processes. Interactive stdin/resize are deliberately unsupported.
- `webOS.network.fetch`: HTTPS WebView fetch through the common wrapper after a `network:fetch` grant; browser/WebView networking has platform/CORS limits and is not a strong network sandbox.
- `webOS.device`: OS/platform/build information, not access to camera/microphone or arbitrary device data.

## 5. Filesystem boundary

Virtual paths such as `/home/user/Documents/note.txt`, `/tmp/session.log`, `/apps/example/`, and `/storage/<key>` map beneath Tauri's app-specific data directory. Commands require the corresponding filesystem permission. The resolver accepts absolute virtual paths, rejects `..`, platform prefixes and symlinks, canonicalizes existing ancestors, and checks the app-data boundary.

This is a conservative **application-level path boundary**, not a kernel-level sandbox; a same-user host process can still access application data, and path-based checks cannot eliminate every filesystem race. There is no command in the starter runtime that executes user-supplied host shell text. The boundary must be re-reviewed before adding file-picker access to arbitrary host paths, native process spawning, camera, microphone, clipboard, or other OS APIs.

## 6. Testing and verification

- `npm test`: ZIP round-trip/path checks, browser-fallback `webOS` API tests, Worker relay/upload checks, and Python packager/signing/artifact tests.
- Python tests cover `app.json`, package IDs, ZIP root normalization, path traversal, symlinks, duplicate names, expansion ratios, and runtime injection.
- `npm run build`: production dashboard bundle.
- GitHub Actions has separate native runner jobs; Tauri/Rust/Android and macOS bundle builds must run on their actual platform runners.

The factory's most important production invariants are: no GitHub secrets in Pages, no user project scripts executed by CI, source ZIPs outside Git history, platform-native runners, explicit runtime permissions, and no arbitrary host shell in the default Tauri bridge.
