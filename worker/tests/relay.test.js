import assert from 'node:assert/strict';
import test from 'node:test';
import relay from '../src/index.js';

const secret = 'test-only-session-secret-with-32-bytes';
const allowedOrigin = 'https://tingart.github.io';
const env = {
  ALLOWED_ORIGINS: `${allowedOrigin},http://localhost:5173`,
  GITHUB_OWNER: 'tingart',
  GITHUB_REPO: 'htmltoapp',
};
const context = {};

function base64Url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signedSession(sub = 'test-user') {
  const encode = (value) => base64Url(JSON.stringify(value));
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ typ: 'session', sub, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function manifestHeader() {
  return base64Url(JSON.stringify({ appName: 'Sample app', packageId: 'com.example.sample', version: '1.0.0', platforms: ['linux'] }));
}

test('health endpoint is public but emits exact-origin CORS', async () => {
  const response = await relay.fetch(new Request('https://relay.example/v1/health', { headers: { Origin: allowedOrigin } }), env, context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.deepEqual(await response.json(), { ok: true, service: 'htmltoapp-build-relay' });
});

test('preflight allows only an explicitly configured origin', async () => {
  const allowed = await relay.fetch(new Request('https://relay.example/v1/builds', { method: 'OPTIONS', headers: { Origin: allowedOrigin } }), env, context);
  assert.equal(allowed.status, 204);
  assert.match(allowed.headers.get('Access-Control-Allow-Headers'), /X-HTMLToApp-Manifest/i);

  const blocked = await relay.fetch(new Request('https://relay.example/v1/builds', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env, context);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), null);
});

test('build and status routes require a signed relay session', async () => {
  const me = await relay.fetch(new Request('https://relay.example/v1/me', { headers: { Origin: allowedOrigin } }), env, context);
  assert.equal(me.status, 401);
  assert.match((await me.json()).error, /Sign in/);

  const build = await relay.fetch(new Request('https://relay.example/v1/builds', { method: 'POST', headers: { Origin: allowedOrigin } }), env, context);
  assert.equal(build.status, 401);
});

test('upload fails closed if the configured rate limiter is missing or exhausted', async () => {
  const token = await signedSession();
  const buildRequest = () => new Request('https://relay.example/v1/builds', {
    method: 'POST',
    headers: { Origin: allowedOrigin, Authorization: `Bearer ${token}` },
  });

  const missing = await relay.fetch(buildRequest(), { ...env, SESSION_SECRET: secret }, context);
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /rate limiter is not configured/i);

  const exhausted = await relay.fetch(buildRequest(), {
    ...env,
    SESSION_SECRET: secret,
    UPLOAD_LIMITER: { limit: async () => ({ success: false }) },
  }, context);
  assert.equal(exhausted.status, 429);
});

test('upload checks streamed byte count before dispatch and removes failed source objects', async () => {
  const token = await signedSession();
  const archiveBytes = new Uint8Array(22);
  archiveBytes.set([0x50, 0x4b, 0x03, 0x04]);
  const archive = new Blob([archiveBytes], { type: 'application/zip' });
  let savedObject;
  let deletedKey;
  const storage = {
    async put(key, body, options) {
      const reader = body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        size += part.value.byteLength;
      }
      savedObject = { key, options, size, bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) };
    },
    async delete(key) { deletedKey = key; },
  };
  const request = new Request('https://relay.example/v1/builds', {
    method: 'POST',
    headers: {
      Origin: allowedOrigin,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
      'X-HTMLToApp-Manifest': manifestHeader(),
      'Content-Length': String(archive.size),
    },
    body: archive,
  });
  const response = await relay.fetch(request, {
    ...env,
    SESSION_SECRET: secret,
    MAX_UPLOAD_BYTES: '128',
    CLOUDFLARE_BODY_LIMIT_BYTES: '128',
    UPLOAD_LIMITER: { limit: async () => ({ success: true }) },
    GITHUB_OWNER: 'tingart',
    GITHUB_REPO: 'htmltoapp',
    BUILDS: storage,
  }, context);

  // Without App credentials dispatch fails, but only after the R2 body has been consumed.
  assert.equal(response.status, 503);
  assert.equal(savedObject.size, archive.size);
  assert.deepEqual(savedObject.bytes, Buffer.from(archiveBytes));
  assert.equal(savedObject.options.customMetadata.owner, 'test-user');
  assert.equal(deletedKey, savedObject.key);
});
