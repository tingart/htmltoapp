# Forge — HTML to native apps

Forge is a local-first project workspace and a reusable **Tauri v2 build factory**. Create or import a plain HTML/CSS/JavaScript project in the static dashboard, then use GitHub Actions to build it as an Android APK/AAB, Windows installer, Linux package, or macOS DMG.

This repository is the factory — your Web OS source ZIP is uploaded to temporary storage for a build and is **not committed to Git**.

## Live demo

**[https://tingart.github.io/htmltoapp/](https://tingart.github.io/htmltoapp/)**

The dashboard is deployed on GitHub Pages and runs entirely in your browser — create projects, upload your HTML files, edit code, and export ZIPs. No account or install needed; everything is saved locally on your device.

## What is implemented

- A responsive, static project IDE in [`dashboard/`](dashboard/): multiple saved projects, nested file tree, lightweight editor, multi-file upload, ZIP import/export, and app metadata.
- Browser-only project storage using IndexedDB. Projects remain on the device/browser where they were created until you choose to export or build them.
- A reusable Tauri v2 Rust shell and a common `window.webOS` API. It uses the OS WebView with a native Rust command bridge; it is not just a website deployed as an APK.
- Safe ZIP validation/extraction, Tauri metadata generation, icon generation, native platform runners, checksums, and GitHub Actions artifacts.
- An optional Cloudflare Worker + R2 relay for direct ZIP upload and secure build triggering. The dashboard never contains a GitHub PAT or GitHub App private key.
- An optional manual Actions workflow path for maintainers who already have a ZIP in the repository or at a public HTTPS URL.

## Try the dashboard

```bash
npm ci
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). Select **New project**, edit its files, and export a ZIP whenever you want a local copy. The dashboard itself is static; GitHub Pages deploys the contents of `dashboard/` with [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml).

The editor and ZIP tools work without an account or backend. To use **Build app**, the repository owner must deploy the optional secure relay once (see [`docs/SETUP.md`](docs/SETUP.md)); enter its public HTTPS Worker URL under **Build connection**. Sign in with GitHub when prompted. Only a repository collaborator with write access can submit a build.

## Build workflow

### From the dashboard

1. Create a project or import a ZIP with `index.html` at its root (a single enclosing folder is okay).
2. Set the app name, reverse-domain package ID, version, and target platforms.
3. Configure the Worker URL and connect GitHub once.
4. Click **Build app**. The ZIP streams to temporary Cloudflare R2 storage; the Worker dispatches the `Build native app` workflow.
5. Watch the Actions run or download its artifact ZIP from the dashboard. Inside are the platform bundle(s), a `manifest.json`, and SHA-256 checksums.

No GitHub credential is placed in the page. OAuth and the GitHub App are handled by the Worker; see the setup guide for the secrets and minimum permissions.

### Manual maintainer fallback

Open **Actions → Build native app → Run workflow** and provide exactly one source:

- `source_path`: a repository-relative ZIP path, or
- `source_url`: a public HTTPS ZIP URL.

Then set the app metadata and comma-separated platforms. The workflow deliberately does not accept a browser-supplied GitHub token or execute user ZIP build scripts.

## Output formats and runners

| Target | GitHub runner | Output |
|---|---|---|
| Android | Ubuntu 24.04 | APK + AAB, ARM64 |
| Windows | Windows 2025 | MSI + NSIS Setup EXE |
| Linux | Ubuntu 24.04 | AppImage + DEB |
| macOS | macOS 15 | DMG |

The workflow uses native runners rather than pretending to cross-compile desktop installers. Android output is unsigned unless you configure the optional keystore secrets. Windows installers and macOS DMGs are also unsigned and macOS builds are not notarized; SmartScreen/Gatekeeper warnings are expected until you add platform signing credentials. A signed Android app is required for Play Store publishing and for repeat installs/upgrades under the same app identity.

GitHub Actions artifacts are retained for 14 days. The temporary source ZIP is stored in R2 for up to 7 days and is removed by the Worker’s hourly cleanup job. App name, package ID and version can be supplied in `app.json` or in the build settings. The package ID must use lowercase reverse-domain format, such as `com.example.myapp`.

## The Tauri runtime

The build factory accepts **static web projects**: HTML, CSS, JavaScript modules, fonts, images, JSON, WASM, audio/video and other project assets are copied into the app without changing their relative paths. It does not run an uploaded `npm install`, bundler, shell script, or package lifecycle hook. If your app uses a framework, build it yourself first and ZIP the static output containing `index.html`.

Before building, the factory:

1. checks the ZIP for path traversal, symlinks, duplicate case-insensitive paths, encryption and extreme expansion ratios;
2. finds the project root and validates `app.json`/metadata;
3. injects the shared `webOS` API into `index.html`;
4. writes a per-build Tauri v2 config and generates icons; and
5. builds only on the requested platform runner.

The Rust runtime provides a virtual filesystem under the app’s own data directory, app storage, device/platform information, and native permission prompts. Terminal commands are a small built-in allowlist (`help`, `pwd`, `ls`, `cat`, `echo`, `mkdir`, `touch`, `rm`, `clear`) — **no host shell is exposed**. The process API currently records short-lived built-in tasks; it does not start arbitrary desktop or Android processes. Android is not treated as desktop Linux.

Tauri applications use the operating system’s WebView for rendering plus a native Rust host and IPC bridge. They can request explicitly implemented native features, but they do not automatically receive unrestricted access to host files, shell, camera, or microphone. See [`SECURITY.md`](SECURITY.md) and [`docs/API.md`](docs/API.md) before exposing more native APIs.

## Local checks

```bash
npm ci
npm test
npm run build
```

`npm test` runs ZIP round-trip/path checks, browser-fallback API tests, Worker relay/security tests, and Python tests for metadata validation, safe extraction, Android signing setup, and artifact selection. A full Rust/Tauri bundle needs Rust, Tauri’s platform prerequisites, and the appropriate native SDKs; see [`docs/SETUP.md`](docs/SETUP.md).

## Repository map

```text
dashboard/                 Static, local-first project IDE
src-tauri/                 Reusable Tauri v2 shell and Rust runtime
worker/                    Optional secure Cloudflare upload/dispatch relay
build-system/scripts/      ZIP validation, config and artifact tooling
.github/workflows/         GitHub Pages deployment and native builds
example-webos/             Small API example project
```

## Important limits

- Browser ZIP import: 200 MiB compressed, 512 MiB total extracted, and 128 MiB per file. Text files larger than 2 MiB stay in the project but open read-only in the lightweight editor.
- The default secure relay upload limit is 80 MiB. Cloudflare request-body limits depend on the account plan; update the Worker configuration if you need larger uploads.
- Browser project persistence uses that browser’s IndexedDB quota. Export ZIP backups; clearing browser data removes the local workspace.
- The Tauri filesystem boundary is a logical app-data sandbox, not a kernel-level container. The starter runtime intentionally offers no arbitrary process execution.
- Build artifacts are uploaded as Actions artifact ZIPs. Direct links are short-lived and the actual bundles are inside each downloaded artifact.

## Docs

- [Detailed architecture](ARCHITECTURE.md)
- [Security model and limitations](SECURITY.md)
- [First-time GitHub Pages, GitHub App, Cloudflare Worker and signing setup](docs/SETUP.md)
- [Web OS API reference](docs/API.md)
