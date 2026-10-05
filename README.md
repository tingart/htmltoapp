# Forge — HTML to native apps

Forge is a local-first project workspace and a reusable **Tauri v2 build factory**. Create or import a plain HTML/CSS/JavaScript project in the static dashboard, then use GitHub Actions to build it as an Android APK/AAB, Windows installer, Linux package, or macOS DMG.

This repository is the build factory. Direct Actions builds use a ZIP you upload to the repository (or a public HTTPS URL); the optional relay instead stores source ZIPs temporarily and keeps them out of Git history.

## Live demo

**[https://tingart.github.io/htmltoapp/](https://tingart.github.io/htmltoapp/)**

The dashboard is deployed on GitHub Pages and runs entirely in your browser — create projects, upload your HTML files, edit code, and export ZIPs. No account or install needed; everything is saved locally on your device.

## What is implemented

- A responsive, static project IDE in [`dashboard/`](dashboard/): multiple saved projects, nested file tree, lightweight editor, multi-file upload, ZIP import/export, and app metadata.
- Browser-only project storage using IndexedDB. Projects remain on the device/browser where they were created until you choose to export or build them.
- A reusable Tauri v2 Rust shell and a common `window.webOS` API. It uses the OS WebView with a native Rust command bridge; it is not just a website deployed as an APK.
- Safe ZIP validation/extraction, Tauri metadata generation, icon generation, native platform runners, checksums, and GitHub Actions artifacts.
- A direct GitHub Actions build path that needs no Cloudflare account or GitHub token in the dashboard: prepare a ZIP, add it to the build repository (or use a public HTTPS ZIP URL), then run the workflow.
- An optional Cloudflare Worker + R2 relay for private one-click uploads, workflow dispatch and build status. The dashboard never contains a GitHub PAT or GitHub App private key.

## Try the dashboard

```bash
npm ci
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). Select **New project**, edit its files, and export a ZIP whenever you want a local copy. The dashboard itself is static; GitHub Pages deploys the contents of `dashboard/` with [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml).

The editor and ZIP tools work without an account or backend. **Build app** works without Cloudflare: it downloads a project ZIP and shows the exact steps and inputs for running the GitHub Actions workflow. You upload the ZIP to the build repository and start the action yourself. The optional secure relay is only needed for private one-click uploads and automatic status updates; see [`docs/SETUP.md`](docs/SETUP.md).

## Build workflow

### Direct from the dashboard (no Cloudflare)

1. Create a project or import a ZIP with `index.html` at its root (a single enclosing folder is okay).
2. Set the app name, reverse-domain package ID, version, and target platforms.
3. Click **Build app**. The dashboard downloads a ZIP and shows the `source_path` and other workflow inputs to copy.
4. Upload the ZIP into the repository that contains this build workflow and commit it to the branch you will build from. For this repository, the suggested path is `projects/<app-name>.zip`.
5. Click **Open GitHub Actions**, choose **Build native app → Run workflow**, enter the displayed values in their matching fields, and start the run.
6. Download the platform artifact ZIP from the completed Actions run. Inside are the native bundle(s), a `manifest.json`, and SHA-256 checksums.

**Access & privacy:** you need write access to the build repository. A ZIP committed to a public repository is public and remains in Git history, even if it is later deleted. Use only for source you are okay publishing, use your own private build repository, or use the optional secure relay below. A `source_url` must also be publicly reachable by the runner.

### Optional one-click private build relay

For automatic ZIP upload and build triggering without committing your source, deploy the optional Cloudflare Worker + R2 relay (see [`docs/SETUP.md`](docs/SETUP.md)). Save its URL under **Optional relay** and sign in with GitHub. The browser receives only a short-lived relay session—not a PAT or GitHub App private key.

### Manual workflow inputs

The `Build native app` workflow accepts exactly one source:

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

GitHub Actions artifacts are retained for 14 days. Only builds submitted through the optional relay store a temporary source ZIP in R2; it is removed by the Worker’s hourly cleanup job after up to 7 days. Direct-mode ZIPs follow the repository's normal retention and visibility. App name, package ID and version can be supplied in `app.json` or in the build settings. The package ID must use lowercase reverse-domain format, such as `com.example.myapp`.

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
projects/                  Optional source ZIPs for direct workflow runs
build-system/scripts/      ZIP validation, config and artifact tooling
.github/workflows/         GitHub Pages deployment and native builds
example-webos/             Small API example project
```

## Important limits

- Browser ZIP import: 200 MiB compressed, 512 MiB total extracted, and 128 MiB per file. Text files larger than 2 MiB stay in the project but open read-only in the lightweight editor.
- The optional secure relay upload limit is 80 MiB by default. Cloudflare request-body limits depend on the account plan; update the Worker configuration if you use the relay and need larger uploads.
- Direct Actions builds require the source ZIP to be committed in the build repository or served at a public HTTPS URL. A ZIP in a public repository is public and persists in Git history; use a private build repository or the optional relay for private projects.
- Browser project persistence uses that browser’s IndexedDB quota. Export ZIP backups; clearing browser data removes the local workspace.
- The Tauri filesystem boundary is a logical app-data sandbox, not a kernel-level container. The starter runtime intentionally offers no arbitrary process execution.
- Build artifacts are uploaded as Actions artifact ZIPs. Direct links are short-lived and the actual bundles are inside each downloaded artifact.

## Docs

- [Detailed architecture](ARCHITECTURE.md)
- [Security model and limitations](SECURITY.md)
- [Direct Actions builds, optional relay, Pages and signing setup](docs/SETUP.md)
- [Web OS API reference](docs/API.md)
