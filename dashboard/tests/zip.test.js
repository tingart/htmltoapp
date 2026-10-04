import assert from 'node:assert/strict';
import test from 'node:test';
import { createZip, safeProjectPath, unzipArchive, validateProjectFilePaths } from '../zip.js';

test('creates and reads a ZIP while preserving nested and binary files', async () => {
  const payload = new Uint8Array([0, 1, 127, 128, 255]);
  const archive = createZip([
    { path: 'index.html', data: '<!doctype html><title>Forge</title>' },
    { path: 'assets/logo.bin', data: payload },
  ]);
  assert.equal(archive.type, 'application/zip');
  assert.throws(() => createZip([{ path: 'a', data: 'x' }], { maxBytes: 100 }), /configured build relay size limit/);
  const entries = await unzipArchive(archive);
  assert.equal(entries.length, 2);
  assert.equal(new TextDecoder().decode(entries.find((entry) => entry.path === 'index.html').data), '<!doctype html><title>Forge</title>');
  assert.deepEqual([...entries.find((entry) => entry.path === 'assets/logo.bin').data], [...payload]);
});

test('project file uploads reject case and file-folder collisions but allow exact replacement', () => {
  assert.deepEqual(validateProjectFilePaths(['index.html'], ['index.html'], { allowExactOverwrite: true }), ['index.html']);
  assert.throws(() => validateProjectFilePaths(['index.html'], ['INDEX.html'], { allowExactOverwrite: true }), /differs only by case/i);
  assert.throws(() => validateProjectFilePaths(['assets/logo.png'], ['assets'], { allowExactOverwrite: true }), /folder structure/i);
  assert.throws(() => validateProjectFilePaths(['assets'], ['assets/logo.png'], { allowExactOverwrite: true }), /folder structure/i);
  assert.throws(() => validateProjectFilePaths([], ['assets/logo.png', 'assets']), /folder structure/i);
});

test('rejects traversal, absolute paths, platform aliases, and case conflicts', async () => {
  for (const path of ['../secret.txt', '/etc/passwd', 'C:/Windows/system.ini', 'folder\\..\\secret', 'CON.txt']) {
    assert.throws(() => safeProjectPath(path), /Unsafe|reserved/i);
  }
  assert.throws(() => createZip([{ path: 'a/../secret.txt', data: 'nope' }]), /Unsafe/);
  const archive = createZip([
    { path: 'App.js', data: 'one' },
    { path: 'app.js', data: 'two' },
  ]);
  await assert.rejects(() => unzipArchive(archive), /duplicate or case-conflicting/i);
});
