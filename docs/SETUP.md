# First-time setup

This guide sets up GitHub Pages for the static IDE, then optionally enables one-click, private ZIP uploads through a Cloudflare Worker + R2. The relay is optional; maintainers can always run the workflow manually with a ZIP path or public HTTPS URL.

## 1. Enable Pages and Actions

1. Push/merge the repository to its default branch (`main`).
2. In **Settings → Pages**, select **GitHub Actions** as the source. `.github/workflows/deploy-pages.yml` publishes the contents of `dashboard/`.
3. Confirm Actions are enabled for the repository and GitHub-hosted runners are available.
4. Open **Actions → Build native app** once the workflow is on the default branch. The workflow accepts manual inputs too.

The dashboard URL for this repository is `https://tingart.github.io/htmltoapp/`. The Pages **origin** is `https://tingart.github.io` (without the repository path).

## 2. Create a GitHub App for the relay

The Pages site must never receive a PAT or GitHub App private key. The optional Worker owns the GitHub App secret and dispatch token.

1. In GitHub **Settings → Developer settings → GitHub Apps → New GitHub App**, choose a name and set the homepage to the Pages URL.
2. Set **User authorization callback URL** to `https://YOUR-WORKER.YOUR-ACCOUNT.workers.dev/v1/auth/callback` (update it if you later use a custom Worker domain).
3. Disable webhooks unless you have a separate use for them.
4. Under **Repository permissions**, grant only **Actions: Read and write**. GitHub grants repository metadata read as a baseline. Do not grant Contents write or administration.
5. Install the App on only the target `tingart/htmltoapp` repository. Record the App ID, installation ID, client ID, and client secret. Generate a private key.
6. The person using the dashboard must also have repository **write** access. The Worker verifies this on OAuth callback before issuing a short-lived relay session.

The Worker requests a single-repository installation token. The token is used only to dispatch the configured workflow and inspect its run/artifact metadata; it never goes to the dashboard or build runner.

## 3. Deploy the Cloudflare Worker and R2 bucket

Install Wrangler 4.36 or newer, authenticate, and create the R2 bucket named in `worker/wrangler.toml`:

```bash
npx wrangler@4 login
npx wrangler@4 r2 bucket create htmltoapp-build-uploads
cd worker
npx wrangler@4 deploy
```

Before deploying, edit `worker/wrangler.toml` if required:

- `GITHUB_OWNER`, `GITHUB_REPO`, `DEFAULT_BRANCH`, `WORKFLOW_ID`, and `WORKFLOW_PATH`.
- `PAGES_URL` and the exact comma-separated `ALLOWED_ORIGINS` (include `https://tingart.github.io`; add `http://localhost:5173` only for local development).
- `MAX_UPLOAD_BYTES` defaults to 80 MiB. Cloudflare plan-level request-body limits still apply. Only raise both values if the account supports the larger request size.
- `[[ratelimits]] namespace_id` must be unique in your Cloudflare account. The sample limit is five dispatch attempts per user per minute.

Set Worker secrets from a secure terminal. Do not commit them or paste them into the Pages editor:

```bash
npx wrangler@4 secret put GITHUB_APP_ID
npx wrangler@4 secret put GITHUB_APP_INSTALLATION_ID
npx wrangler@4 secret put GITHUB_APP_CLIENT_ID
npx wrangler@4 secret put GITHUB_APP_CLIENT_SECRET
npx wrangler@4 secret put GITHUB_APP_PRIVATE_KEY
npx wrangler@4 secret put SESSION_SECRET
```

`SESSION_SECRET` must be a random value of at least 32 characters. For example, generate it locally with `openssl rand -hex 32` and pass it directly to `wrangler secret put`; do not save it in the repository. Use the GitHub App's installation ID, not the App ID, for `GITHUB_APP_INSTALLATION_ID`.

GitHub normally downloads its RSA private key as PKCS#1 PEM. Convert it to PKCS#8 for the Worker Web Crypto API, then provide the converted file on stdin:

```bash
openssl pkcs8 -topk8 -nocrypt \
  -in github-app.private-key.pem \
  -out github-app.pkcs8.pem
npx wrangler@4 secret put GITHUB_APP_PRIVATE_KEY < github-app.pkcs8.pem
```

Keep both key files outside the repo and remove local copies when finished. The Worker source logs only a generic error name, not secrets or GitHub responses.

The Worker has a scheduled hourly cleanup: temporary source ZIPs older than 7 days are deleted. GitHub Actions artifacts are retained for 14 days.

## 4. Connect Pages to the Worker

1. Set the repository Actions **variable** `UPLOAD_RELAY_URL` to the Worker origin, for example `https://htmltoapp-build-relay.your-account.workers.dev`. This is a URL, not a secret; the native build workflow uses it to download the matching ZIP.
2. In the dashboard, select **Build connection**, enter the same HTTPS URL, and save it. The value is kept in this browser's local storage. Alternatively, a maintainer can set the public `relayUrl` in `dashboard/config.js` before deploying Pages.
3. Click **Build app**. Sign in with GitHub. The OAuth token is exchanged and checked on the Worker; the page only receives a signed, 30-minute relay session in the URL fragment. The session is stored in tab-scoped `sessionStorage` and is not a GitHub token.
4. Choose one or more targets and submit. A successful run shows the GitHub Actions link and artifact download buttons.

If you preview the dashboard on another origin, add that exact origin to `ALLOWED_ORIGINS` and redeploy the Worker. Do not use `*` or a broad origin wildcard. CORS is an additional browser boundary, not a replacement for GitHub sign-in or rate limiting.

## 5. Manual build without the relay

For a one-off build, put the ZIP in the repository (for example `projects/my-webos.zip`) or host it at a public HTTPS URL. Open **Actions → Build native app → Run workflow** and provide exactly one of `source_path` or `source_url`. Select the metadata and platforms.

A public URL is recorded in workflow inputs and should not contain private credentials. For large/private uploads, use the Worker flow instead. The dashboard cannot securely upload a project ZIP to GitHub or trigger Actions by itself: a static page has no privileged GitHub credential.

## 6. Android signing (optional)

Without signing secrets, Android artifacts are unsigned. For repeat installs, private distribution, or Play Store upload, use a long-lived release keystore. Losing or rotating the key may prevent upgrades of already installed apps. Windows installers and macOS DMGs are currently unsigned, and macOS builds are not notarized; Windows SmartScreen and macOS Gatekeeper warnings are expected. This repository does not configure Windows Authenticode certificates or Apple Developer ID/notarization secrets.

Set these repository **Actions secrets**:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded `.jks` keystore (`base64 -w0 release.jks` on GNU/Linux; use `base64 < release.jks | tr -d '\n'` on macOS).
- `ANDROID_STORE_PASSWORD`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_KEY_ALIAS`

The Android job creates a temporary keystore file and a generated Gradle signing configuration only when all four secrets are present. The keystore and generated properties are not uploaded as artifacts. Never put signing secrets in `dashboard/config.js`, `app.json`, or source ZIPs.

## 7. Build outputs and troubleshooting

The GitHub Actions run uploads one artifact ZIP per selected platform. Each ZIP contains bundle files, `manifest.json` and `.sha256` files:

- Android ARM64 APK and AAB
- Windows MSI and NSIS setup EXE
- Linux AppImage and DEB
- macOS DMG

Common issues:

- **Relay CORS error:** check `ALLOWED_ORIGINS` against the browser origin exactly, including scheme and port. Redeploy the Worker after editing it.
- **GitHub sign-in returns to Pages with an error:** check App OAuth callback URL, App installation on this repository, and that the signed-in account has write permission.
- **Workflow dispatch fails:** check App installation ID, Actions: Read and write, default branch, workflow file on that branch, and `UPLOAD_RELAY_URL`.
- **Source download is rejected:** the Worker checks the Actions run ID, workflow path, default branch, `workflow_dispatch` event and opaque upload ID. Do not edit/rename the workflow without updating `WORKFLOW_PATH`/`WORKFLOW_ID`.
- **ZIP rejected:** include root `index.html`; avoid symlinks, encrypted archives, duplicate case-only paths, traversal paths, or a very high-compression archive.
- **Android unsigned:** configure all Android secrets. Keep the same keystore for later updates.
- **Icon generation failed:** provide a valid square PNG `icon.png` in the project ZIP or remove it to use the default Forge icon.
- **Large upload rejected:** the browser, Worker config and Cloudflare plan have separate limits. Increase the configured limit only if the deployed plan supports it.
