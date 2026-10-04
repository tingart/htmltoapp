const platformLabel = document.querySelector('#platform-label');
const setOutput = (id, value) => { document.querySelector(id).textContent = value; };

async function run(action, output) {
  try {
    const value = await action();
    setOutput(output, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } catch (error) {
    setOutput(output, `Denied or unavailable\n${error?.message || error}`);
  }
}

async function renderRuntime() {
  try {
    const info = await window.webOS?.device?.getInfo();
    platformLabel.textContent = info?.isNative ? `Tauri · ${info.platform}` : 'Browser preview';
  } catch {
    platformLabel.textContent = 'Web runtime unavailable';
  }
}

renderRuntime();

document.querySelector('#filesystem-button').addEventListener('click', () => run(async () => {
  await webOS.permissions.request('filesystem:write');
  await webOS.permissions.request('filesystem:read');
  const folder = '/home/user/Documents';
  await webOS.fs.mkdir(folder, { recursive: true });
  const path = `${folder}/hello.txt`;
  const note = `Hello from ${await webOS.device.getPlatform()} at ${new Date().toISOString()}`;
  await webOS.fs.writeFile(path, note);
  return { path, content: await webOS.fs.readFile(path), entries: await webOS.fs.readdir(folder) };
}, '#filesystem-output'));

document.querySelector('#terminal-button').addEventListener('click', () => run(async () => {
  await webOS.permissions.request('terminal:exec');
  const result = await webOS.terminal.exec('help');
  return result.stdout;
}, '#terminal-output'));

document.querySelector('#process-button').addEventListener('click', () => run(async () => {
  await webOS.permissions.request('process:spawn');
  await webOS.permissions.request('terminal:exec');
  const processId = await webOS.process.spawn('pwd', []);
  return { processId, tasks: await webOS.process.list() };
}, '#process-output'));
