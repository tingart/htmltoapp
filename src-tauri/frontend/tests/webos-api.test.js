import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

class MemoryStorage {
  #items = new Map();
  get length() { return this.#items.size; }
  key(index) { return [...this.#items.keys()][index] ?? null; }
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(String(key), String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

async function createBrowserApi() {
  const window = {
    confirm: () => true,
    location: { href: 'https://example.test/' },
    fetch: async () => new Response('ok'),
  };
  const document = { title: 'Test app' };
  const source = await readFile(new URL('../webos-api.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    window,
    document,
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    navigator: { userAgent: 'test browser' },
    URL,
    TextEncoder,
    Blob,
    Response,
  });
  return window.webOS;
}

test('browser filesystem supports nested text files and rejects parent traversal', async () => {
  const api = await createBrowserApi();
  assert.equal(api.isNative, false);
  assert.equal((await api.device.getInfo()).platform, 'web');

  await api.fs.mkdir('/home/user/Documents', { recursive: true });
  await api.fs.mkdir('/home/user/Documents/empty');
  assert.deepEqual(Array.from(await api.fs.readdir('/home/user/Documents')), ['empty']);
  await api.fs.writeFile('/home/user/Documents/empty/note.txt', 'Hello from Forge');
  assert.equal(await api.fs.readFile('/home/user/Documents/empty/note.txt'), 'Hello from Forge');
  assert.equal((await api.fs.stat('/home/user/Documents/empty')).isDirectory, true);
  assert.deepEqual(Array.from(await api.fs.readdir('/home/user/Documents/empty')), ['note.txt']);
  await assert.rejects(api.fs.remove('/home/user/Documents/empty'), /Directory is not empty/);
  await api.fs.remove('/home/user/Documents/empty', { recursive: true });
  await assert.rejects(api.fs.readFile('/home/user/../../escape.txt'), /Invalid virtual filesystem path/);
});

test('browser terminal exposes only preview-safe built-ins', async () => {
  const api = await createBrowserApi();
  assert.match((await api.terminal.exec('echo safe')).stdout, /safe/);
  assert.equal((await api.terminal.exec('pwd')).stdout, '/home/user');
  assert.equal((await api.terminal.exec('whoami')).exitCode, 127);
  assert.deepEqual(Array.from(await api.process.list()), []);
});

test('browser key-value storage validates keys on every operation', async () => {
  const api = await createBrowserApi();
  await api.storage.setItem('theme', 'dark');
  assert.equal(await api.storage.getItem('theme'), 'dark');
  await api.storage.removeItem('theme');
  assert.equal(await api.storage.getItem('theme'), null);
  await assert.rejects(api.storage.removeItem('bad/key'), /Storage keys/);
  await assert.rejects(api.storage.setItem('é'.repeat(100), 'value'), /180 UTF-8 bytes/);
});
