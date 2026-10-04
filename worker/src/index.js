const API_BASE = 'https://api.github.com';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_ID_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/;
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$/;
const VALID_PLATFORMS = new Set(['android', 'windows', 'linux', 'macos']);
const SESSION_LIFETIME_SECONDS = 30 * 60;
const ARTIFACT_TICKET_SECONDS = 10 * 60;
const SOURCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_UPLOAD = 80 * 1024 * 1024;
const API_VERSION = '2022-11-28';

class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asBytes(value) {
  return encoder.encode(String(value));
}

function base64Url(bytes) {
  let binary = '';
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function decodeManifest(value) {
  if (!value || value.length > 8192) throw new RelayError(400, 'Build manifest is missing or too large.');
  try {
    return JSON.parse(decoder.decode(fromBase64Url(value)));
  } catch {
    throw new RelayError(400, 'Build manifest must be valid UTF-8 JSON.');
  }
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-HTMLToApp-Manifest',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

function json(request, env, value, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(request, env),
    ...extraHeaders,
  });
  return new Response(JSON.stringify(value), { status, headers });
}

function requireAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) {
    throw new RelayError(403, 'This dashboard origin is not allowed by the build relay.');
  }
}

function apiHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'htmltoapp-build-relay',
  };
}

function repositoryName(env) {
  const owner = String(env.GITHUB_OWNER || '').trim();
  const repo = String(env.GITHUB_REPO || '').trim();
  if (!owner || !repo || /[^A-Za-z0-9_.-]/.test(owner + repo)) {
    throw new RelayError(503, 'The build relay repository is not configured.');
  }
  return `${owner}/${repo}`;
}

function workflowPath(env) {
  return String(env.WORKFLOW_PATH || '.github/workflows/build.yml');
}

function workflowId(env) {
  return String(env.WORKFLOW_ID || 'build.yml');
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new RelayError(400, 'Build manifest must be a JSON object.');
  const appName = String(manifest.appName || '').trim();
  const packageId = String(manifest.packageId || '').trim();
  const version = String(manifest.version || '').trim();
  const platforms = Array.isArray(manifest.platforms) ? [...new Set(manifest.platforms.map((platform) => String(platform).toLowerCase()))] : [];
  if (!APP_NAME_RE.test(appName)) throw new RelayError(400, 'App name must use 1–64 safe ASCII characters.');
  if (!PACKAGE_ID_RE.test(packageId)) throw new RelayError(400, 'Package ID must be lowercase reverse-domain format, e.g. com.example.myapp.');
  if (!VERSION_RE.test(version)) throw new RelayError(400, 'Version must look like 1.0.0 or 1.0.0-beta.1.');
  if (!platforms.length || platforms.some((platform) => !VALID_PLATFORMS.has(platform))) throw new RelayError(400, 'Select one or more supported build targets.');
  return { appName, packageId, version, platforms };
}

function sessionKey(env) {
  const secret = String(env.SESSION_SECRET || '');
  if (secret.length < 32) throw new RelayError(503, 'The build relay session secret is not configured.');
  return crypto.subtle.importKey('raw', asBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signBytes(data, env) {
  const key = await sessionKey(env);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, asBytes(data)));
}

async function createToken(payload, env) {
  const header = base64Url(asBytes(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64Url(asBytes(JSON.stringify(payload)));
  const unsigned = `${header}.${body}`;
  const signature = base64Url(await signBytes(unsigned, env));
  return `${unsigned}.${signature}`;
}

async function verifyToken(token, env, expectedType) {
  if (!token || token.length > 8192) return null;
  const pieces = token.split('.');
  if (pieces.length !== 3) return null;
  try {
    const unsigned = `${pieces[0]}.${pieces[1]}`;
    const key = await sessionKey(env);
    const isValid = await crypto.subtle.verify('HMAC', key, fromBase64Url(pieces[2]), asBytes(unsigned));
    if (!isValid) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(pieces[1])));
    if (payload.typ !== expectedType || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function getSession(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new RelayError(401, 'Sign in with GitHub to use the build relay.');
  const payload = await verifyToken(authorization.slice(7).trim(), env, 'session');
  if (!payload || typeof payload.sub !== 'string') throw new RelayError(401, 'Your GitHub session expired. Sign in again to continue.');
  return payload;
}

async function githubRequest(env, token, path, init = {}) {
  const url = path.startsWith('https://') ? path : `${API_BASE}${path}`;
  const headers = new Headers(apiHeaders(token));
  new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
  const response = await fetch(url, { ...init, headers });
  if (response.status === 204) return null;
  if (!response.ok) {
    // Never include response bodies: GitHub error payloads can contain sensitive context.
    const messages = { 401: 'GitHub authorization was rejected.', 403: 'The GitHub App needs additional repository permissions.', 404: 'The requested GitHub build resource was not found.' };
    throw new RelayError(response.status === 404 ? 404 : 502, messages[response.status] || `GitHub API request failed (${response.status}).`);
  }
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json') ? response.json() : null;
}

let installationTokenCache = { token: '', expiresAt: 0, key: '' };

function pemBytes(pemValue) {
  const pem = String(pemValue || '').replace(/\\n/g, '\n').trim();
  const begin = '-----BEGIN PRIVATE KEY-----';
  const end = '-----END PRIVATE KEY-----';
  if (pem.includes('BEGIN RSA PRIVATE KEY') || !pem.startsWith(begin) || !pem.includes(end)) {
    throw new RelayError(503, 'Store the GitHub App private key as PKCS#8 PEM. Convert GitHub’s RSA key with openssl pkcs8 before adding it as a Worker secret.');
  }
  const endOffset = pem.indexOf(end, begin.length);
  const content = pem.slice(begin.length, endOffset).replace(/\s/g, '');
  if (!content || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new RelayError(503, 'The GitHub App private key is not valid PEM.');
  try { return fromBase64Url(content.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')); }
  catch { throw new RelayError(503, 'The GitHub App private key is not valid PEM.'); }
}

async function appJwt(env) {
  const appId = String(env.GITHUB_APP_ID || '').trim();
  if (!appId || !env.GITHUB_APP_PRIVATE_KEY) throw new RelayError(503, 'GitHub App credentials are not configured in the Worker.');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(env.GITHUB_APP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(asBytes(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(asBytes(JSON.stringify({ iat: now - 60, exp: now + 8 * 60, iss: appId })));
  const unsigned = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, asBytes(unsigned)));
  return `${unsigned}.${base64Url(signature)}`;
}

async function getInstallationToken(env) {
  const installId = String(env.GITHUB_APP_INSTALLATION_ID || '').trim();
  const key = `${env.GITHUB_APP_ID}:${installId}:${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  if (!installId) throw new RelayError(503, 'GitHub App installation ID is not configured.');
  if (installationTokenCache.key === key && installationTokenCache.expiresAt > Date.now() + 60_000) return installationTokenCache.token;

  const jwt = await appJwt(env);
  const url = `${API_BASE}/app/installations/${encodeURIComponent(installId)}/access_tokens`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'htmltoapp-build-relay' },
    body: JSON.stringify({ repositories: [String(env.GITHUB_REPO)] }),
  });
  if (!response.ok) throw new RelayError(502, 'Could not create a repository-scoped GitHub App installation token.');
  const result = await response.json();
  installationTokenCache = { token: result.token, expiresAt: Date.parse(result.expires_at) || Date.now() + 50 * 60_000, key };
  return installationTokenCache.token;
}

async function rateLimit(env, key) {
  if (!env.UPLOAD_LIMITER) throw new RelayError(503, 'The build relay rate limiter is not configured.');
  try {
    const result = await env.UPLOAD_LIMITER.limit({ key });
    return Boolean(result.success);
  } catch {
    // Fail closed rather than opening a public dispatcher if the rate-limit service is unavailable.
    throw new RelayError(503, 'The build relay rate limiter is temporarily unavailable.');
  }
}

function validUploadId(value) {
  return UPLOAD_ID_RE.test(value || '') && value.length <= 36;
}

async function readZipPrefix(body, requiredBytes = 4, maxBytes = DEFAULT_MAX_UPLOAD, expectedLength = null) {
  if (!body) throw new RelayError(400, 'No ZIP file was uploaded.');
  const reader = body.getReader();
  const chunks = [];
  let prefixLength = 0;
  try {
    while (prefixLength < requiredBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      prefixLength += value.byteLength;
      if (prefixLength > maxBytes) throw new RelayError(413, 'ZIP upload exceeded the relay size limit.');
    }
    const prefix = new Uint8Array(prefixLength);
    let offset = 0;
    for (const chunk of chunks) { prefix.set(chunk, offset); offset += chunk.byteLength; }
    if (prefix.length < requiredBytes) {
      await reader.cancel();
      throw new RelayError(400, 'Uploaded file is too small to be a ZIP archive.');
    }
    let prefixSent = false;
    let bytesRead = prefixLength;
    const stream = new ReadableStream({
      async pull(controller) {
        if (!prefixSent) {
          prefixSent = true;
          controller.enqueue(prefix);
          return;
        }
        try {
          const next = await reader.read();
          if (next.done) {
            if (expectedLength !== null && bytesRead !== expectedLength) {
              controller.error(new RelayError(400, 'ZIP upload length did not match its Content-Length.'));
              return;
            }
            controller.close();
          } else {
            bytesRead += next.value.byteLength;
            if (bytesRead > maxBytes) {
              controller.error(new RelayError(413, 'ZIP upload exceeded the relay size limit.'));
              await reader.cancel();
              return;
            }
            controller.enqueue(next.value);
          }
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return { prefix, stream };
  } catch (error) {
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
    throw error;
  }
}

function isZipHeader(prefix) {
  return prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b
    && ((prefix[2] === 0x03 && prefix[3] === 0x04)
      || (prefix[2] === 0x05 && prefix[3] === 0x06)
      || (prefix[2] === 0x07 && prefix[3] === 0x08));
}

async function submitBuild(request, env, session) {
  requireAllowedOrigin(request, env);
  const repository = repositoryName(env);
  const allowed = await rateLimit(env, `upload:${session.sub.toLowerCase()}`);
  if (!allowed) throw new RelayError(429, 'Build limit reached. Try again later.');
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/zip' && contentType !== 'application/x-zip-compressed') {
    throw new RelayError(415, 'Upload the project as a ZIP archive.');
  }
  const lengthHeader = request.headers.get('Content-Length') || '';
  const length = Number(lengthHeader);
  const maxBytes = Math.min(Number(env.MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD, Number(env.CLOUDFLARE_BODY_LIMIT_BYTES) || 100 * 1024 * 1024);
  if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(length) || length < 22) throw new RelayError(411, 'The ZIP upload must include a valid Content-Length.');
  if (length > maxBytes) throw new RelayError(413, `ZIP uploads are limited to ${Math.floor(maxBytes / (1024 * 1024))} MB on this relay.`);
  const manifest = validateManifest(decodeManifest(request.headers.get('X-HTMLToApp-Manifest')));
  const { prefix, stream } = await readZipPrefix(request.body, 4, maxBytes, length);
  if (!isZipHeader(prefix)) throw new RelayError(415, 'The uploaded file does not look like a ZIP archive.');

  const id = crypto.randomUUID();
  const key = `uploads/${id}.zip`;
  const createdAt = new Date().toISOString();
  try {
    await env.BUILDS.put(key, stream, {
      httpMetadata: { contentType: 'application/zip', cacheControl: 'private, no-store' },
      customMetadata: {
        buildId: id,
        owner: session.sub,
        appName: manifest.appName,
        packageId: manifest.packageId,
        version: manifest.version,
        platforms: manifest.platforms.join(','),
        createdAt,
      },
    });

    const token = await getInstallationToken(env);
    const path = `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${encodeURIComponent(workflowId(env))}/dispatches`;
    await githubRequest(env, token, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: String(env.DEFAULT_BRANCH || 'main'),
        inputs: {
          upload_id: id,
          app_name: manifest.appName,
          package_id: manifest.packageId,
          version: manifest.version,
          platforms: manifest.platforms.join(','),
        },
      }),
    });
    return json(request, env, {
      buildId: id,
      status: 'queued',
      runUrl: `https://github.com/${repository}/actions`,
    }, 202);
  } catch (error) {
    try { await env.BUILDS.delete(key); } catch { /* keep the original build error */ }
    if (error instanceof RelayError) throw error;
    throw new RelayError(502, 'Could not start GitHub Actions. Check the GitHub App installation and its Actions: write permission.');
  }
}

async function verifyActionRun(request, env, uploadId, runId) {
  if (!validUploadId(uploadId) || !/^\d+$/.test(runId || '')) throw new RelayError(400, 'Invalid build reference.');
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new RelayError(401, 'A short-lived GitHub Actions token is required.');
  const token = authorization.slice(7).trim();
  if (token.length > 8192) throw new RelayError(401, 'Invalid GitHub Actions token.');
  const data = await githubRequest(env, token, `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/runs/${runId}`);
  const repository = repositoryName(env).toLowerCase();
  const expectedWorkflowPath = workflowPath(env);
  const runRepository = String(data?.repository?.full_name || '').toLowerCase();
  if (
    data?.event !== 'workflow_dispatch'
    || runRepository !== repository
    || !String(data?.path || '').includes(expectedWorkflowPath)
    || String(data?.head_branch || '') !== String(env.DEFAULT_BRANCH || 'main')
    || !String(data?.display_title || '').includes(uploadId)
  ) {
    throw new RelayError(403, 'This source download is not tied to the matching build workflow run.');
  }
  return data;
}

async function downloadSource(request, env, uploadId) {
  if (request.headers.get('Origin')) throw new RelayError(403, 'The source endpoint is for GitHub Actions runners only.');
  const runId = request.headers.get('X-GitHub-Run-Id') || '';
  await verifyActionRun(request, env, uploadId, runId);
  const key = `uploads/${uploadId}.zip`;
  const object = await env.BUILDS.get(key);
  if (!object) throw new RelayError(404, 'The temporary project ZIP has expired or was already removed.');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="project.zip"',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function getBuildRun(env, token, uploadId) {
  const path = `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${encodeURIComponent(workflowId(env))}/runs?event=workflow_dispatch&per_page=100`;
  const result = await githubRequest(env, token, path);
  const runs = Array.isArray(result?.workflow_runs) ? result.workflow_runs : [];
  return runs.find((run) => String(run?.display_title || '').includes(uploadId) || String(run?.name || '').includes(uploadId)) || null;
}

async function buildStatus(request, env, session, uploadId) {
  requireAllowedOrigin(request, env);
  if (!validUploadId(uploadId)) throw new RelayError(404, 'Build not found.');
  const key = `uploads/${uploadId}.zip`;
  const stored = await env.BUILDS.head(key);
  if (!stored || stored.customMetadata?.owner?.toLowerCase() !== session.sub.toLowerCase()) throw new RelayError(404, 'Build not found.');
  const token = await getInstallationToken(env);
  const run = await getBuildRun(env, token, uploadId);
  if (!run) return json(request, env, { buildId: uploadId, status: 'queued', runUrl: `https://github.com/${repositoryName(env)}/actions` });

  const status = String(run.status || 'queued');
  const artifacts = [];
  if (status === 'completed') {
    const result = await githubRequest(env, token, `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/runs/${run.id}/artifacts?per_page=100`);
    for (const artifact of (result?.artifacts || []).slice(0, 20)) {
      if (artifact.expired) continue;
      const ticket = await createToken({
        typ: 'artifact',
        sub: session.sub,
        uploadId,
        artifactId: String(artifact.id),
        runId: String(run.id),
        exp: Math.floor(Date.now() / 1000) + ARTIFACT_TICKET_SECONDS,
      }, env);
      const relayOrigin = new URL(request.url).origin;
      artifacts.push({
        name: artifact.name,
        size: artifact.size_in_bytes,
        downloadUrl: `${relayOrigin}/v1/artifacts/${uploadId}/${artifact.id}?ticket=${encodeURIComponent(ticket)}`,
      });
    }
  }
  return json(request, env, {
    buildId: uploadId,
    status,
    conclusion: run.conclusion || null,
    runId: run.id,
    runUrl: run.html_url,
    artifacts,
  });
}

async function downloadArtifact(request, env, uploadId, artifactId) {
  if (!validUploadId(uploadId) || !/^\d+$/.test(artifactId || '')) throw new RelayError(404, 'Artifact not found.');
  const url = new URL(request.url);
  const ticket = await verifyToken(url.searchParams.get('ticket'), env, 'artifact');
  if (!ticket || ticket.uploadId !== uploadId || ticket.artifactId !== artifactId || !ticket.sub) {
    throw new RelayError(401, 'This artifact download link expired. Refresh build status to get a new link.');
  }
  const stored = await env.BUILDS.head(`uploads/${uploadId}.zip`);
  if (!stored || stored.customMetadata?.owner?.toLowerCase() !== String(ticket.sub).toLowerCase()) throw new RelayError(404, 'Artifact not found.');
  const token = await getInstallationToken(env);
  const artifact = await githubRequest(env, token, `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/artifacts/${artifactId}`);
  if (String(artifact?.workflow_run?.id || '') !== String(ticket.runId)) throw new RelayError(403, 'Artifact does not belong to this build.');
  const apiUrl = `${API_BASE}/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/artifacts/${artifactId}/zip`;
  const response = await fetch(apiUrl, { headers: apiHeaders(token), redirect: 'manual' });
  const location = response.headers.get('Location');
  if ([301, 302, 303, 307, 308].includes(response.status) && location) {
    const destination = new URL(location);
    if (destination.protocol !== 'https:' || !(destination.hostname.endsWith('.blob.core.windows.net') || destination.hostname.endsWith('.githubusercontent.com') || destination.hostname.endsWith('.actions.githubusercontent.com'))) {
      throw new RelayError(502, 'GitHub returned an unexpected artifact download host.');
    }
    return new Response(null, { status: 302, headers: { Location: destination.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  if (!response.ok) throw new RelayError(502, 'GitHub could not prepare this artifact download.');
  return new Response(response.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="native-build-${artifactId}.zip"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function readCookie(request, cookieName) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === cookieName) return value.join('=');
  }
  return '';
}

function workerOrigin(request) {
  return new URL(request.url).origin;
}

function pagesRedirect(env, fragment) {
  const pages = new URL(String(env.PAGES_URL || ''));
  if (pages.protocol !== 'https:' || pages.username || pages.password) throw new RelayError(503, 'The HTTPS GitHub Pages URL is not configured.');
  pages.hash = fragment;
  return pages.href;
}

async function startOAuth(request, env) {
  const clientId = String(env.GITHUB_APP_CLIENT_ID || '').trim();
  if (!clientId || !env.GITHUB_APP_CLIENT_SECRET) throw new RelayError(503, 'GitHub App OAuth credentials are not configured in the Worker.');
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const signature = base64Url(await signBytes(state, env));
  const redirectUri = `${workerOrigin(request)}/v1/auth/callback`;
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('state', `${state}.${signature}`);
  authorize.searchParams.set('allow_signup', 'false');
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.href,
      'Cache-Control': 'no-store',
      'Set-Cookie': `forge_oauth_state=${state}.${signature}; Path=/v1/auth/callback; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function exchangeOAuthCode(env, code, redirectUri) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'htmltoapp-build-relay' },
    body: JSON.stringify({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  if (!response.ok) throw new RelayError(502, 'GitHub sign-in could not be completed.');
  const result = await response.json();
  if (!result.access_token || result.error) throw new RelayError(401, 'GitHub sign-in was cancelled or expired.');
  return result.access_token;
}

async function finishOAuth(request, env) {
  const url = new URL(request.url);
  const [queryState, querySignature] = String(url.searchParams.get('state') || '').split('.');
  const [cookieState, cookieSignature] = readCookie(request, 'forge_oauth_state').split('.');
  const clearCookie = 'forge_oauth_state=; Path=/v1/auth/callback; Max-Age=0; Secure; HttpOnly; SameSite=Lax';
  const cancel = (reason) => new Response(null, {
    status: 302,
    headers: { Location: pagesRedirect(env, `relay_error=${encodeURIComponent(reason)}`), 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });

  if (!queryState || !querySignature || queryState !== cookieState || querySignature !== cookieSignature) return cancel('github_state');
  let stateValid = false;
  try { stateValid = await crypto.subtle.verify('HMAC', await sessionKey(env), fromBase64Url(querySignature), asBytes(queryState)); }
  catch { stateValid = false; }
  if (!stateValid) return cancel('github_state');
  if (url.searchParams.has('error')) return cancel('github_cancelled');
  const code = url.searchParams.get('code');
  if (!code || code.length > 2048) return cancel('github_login');

  try {
    const redirectUri = `${workerOrigin(request)}/v1/auth/callback`;
    const userToken = await exchangeOAuthCode(env, code, redirectUri);
    const user = await githubRequest(env, userToken, '/user');
    const repo = await githubRequest(env, userToken, `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`);
    const canPush = Boolean(repo?.permissions?.push || repo?.permissions?.admin);
    if (!user?.login || !canPush) return cancel('repo_access');
    const now = Math.floor(Date.now() / 1000);
    const session = await createToken({ typ: 'session', sub: user.login, iat: now, exp: now + SESSION_LIFETIME_SECONDS }, env);
    return new Response(null, {
      status: 302,
      headers: {
        Location: pagesRedirect(env, `relay_session=${session}`),
        'Set-Cookie': clearCookie,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    if (error instanceof RelayError && error.status === 403) return cancel('repo_access');
    return cancel('github_login');
  }
}

async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    requireAllowedOrigin(request, env);
    return new Response(null, { status: 204, headers: { ...corsHeaders(request, env), 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'GET' && path === '/v1/auth/start') return startOAuth(request, env);
  if (request.method === 'GET' && path === '/v1/auth/callback') return finishOAuth(request, env);
  if (request.method === 'GET' && path === '/v1/health') return json(request, env, { ok: true, service: 'htmltoapp-build-relay' });

  const meMatch = path.match(/^\/v1\/me$/);
  if (request.method === 'GET' && meMatch) {
    requireAllowedOrigin(request, env);
    const session = await getSession(request, env);
    return json(request, env, { login: session.sub, expiresAt: session.exp });
  }

  if (request.method === 'POST' && path === '/v1/builds') {
    const session = await getSession(request, env);
    return submitBuild(request, env, session);
  }

  const statusMatch = path.match(/^\/v1\/builds\/([0-9a-f-]{36})$/i);
  if (request.method === 'GET' && statusMatch) {
    const session = await getSession(request, env);
    return buildStatus(request, env, session, statusMatch[1]);
  }

  const sourceMatch = path.match(/^\/v1\/source\/([0-9a-f-]{36})$/i);
  if (request.method === 'GET' && sourceMatch) return downloadSource(request, env, sourceMatch[1]);

  const artifactMatch = path.match(/^\/v1\/artifacts\/([0-9a-f-]{36})\/(\d+)$/i);
  if (request.method === 'GET' && artifactMatch) return downloadArtifact(request, env, artifactMatch[1], artifactMatch[2]);

  return json(request, env, { error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env, context) {
    try {
      return await handleRequest(request, env, context);
    } catch (error) {
      const status = error instanceof RelayError ? error.status : 500;
      const message = error instanceof RelayError ? error.message : 'The build relay could not complete this request.';
      if (!(error instanceof RelayError)) console.error('Relay request failed:', error?.name || 'Error');
      return json(request, env, { error: message }, status);
    }
  },

  async scheduled(_event, env, _context) {
    const cutoff = Date.now() - SOURCE_RETENTION_MS;
    let cursor;
    do {
      const page = await env.BUILDS.list({ prefix: 'uploads/', cursor, limit: 1000, include: ['customMetadata'] });
      const expired = page.objects
        .filter((object) => {
          const created = Date.parse(object.customMetadata?.createdAt || object.uploaded || '');
          return Number.isFinite(created) && created < cutoff;
        })
        .map((object) => object.key);
      if (expired.length) await env.BUILDS.delete(expired);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  },
};
