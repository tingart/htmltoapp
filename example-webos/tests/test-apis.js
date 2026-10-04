// Lightweight manual smoke test. Run this in the bundled WebView console after
// granting filesystem:read, filesystem:write, terminal:exec and process:spawn.
export async function smokeTestWebOS() {
  if (!window.webOS) throw new Error('window.webOS is not available. Package the project with Forge first.');
  const info = await webOS.device.getInfo();
  if (!info.platform) throw new Error('Device platform was not returned.');

  await webOS.permissions.request('filesystem:write');
  await webOS.permissions.request('filesystem:read');
  const path = '/home/user/Documents/forge-smoke-test.txt';
  await webOS.fs.mkdir('/home/user/Documents', { recursive: true });
  await webOS.fs.writeFile(path, 'forge smoke test');
  if (await webOS.fs.readFile(path) !== 'forge smoke test') throw new Error('Filesystem round-trip failed.');

  await webOS.permissions.request('terminal:exec');
  const command = await webOS.terminal.exec('echo safe');
  if (command.stdout !== 'safe' || command.exitCode !== 0) throw new Error('Safe terminal built-in failed.');

  await webOS.permissions.request('process:spawn');
  await webOS.permissions.request('filesystem:delete');
  const processId = await webOS.process.spawn('pwd', []);
  if (!(await webOS.process.list()).some((process) => process.processId === processId)) throw new Error('Process task was not listed.');
  await webOS.fs.remove(path);
  return { ok: true, platform: info.platform };
}
