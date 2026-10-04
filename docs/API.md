# `window.webOS` API

During packaging, the factory injects `__htmltoapp_runtime.js` before the application's scripts. This defines one platform-independent `window.webOS` facade.

```js
if (window.webOS?.isNative) {
  const info = await webOS.device.getInfo();
  console.log(`Tauri on ${info.platform}`);
} else {
  console.log('Browser preview with safe fallbacks');
}
```

The frontend can render in a normal browser, but browser mode cannot access the native Rust runtime. In a Tauri build, calls cross Tauri v2 IPC and are validated again in Rust. Sensitive permissions default to denied and show a native permission dialog when requested. Grants currently last for the lifetime of the app process and reset on restart.

## Permissions

```js
await webOS.permissions.request('filesystem:read');
const granted = await webOS.permissions.check('filesystem:write');
const statuses = await webOS.permissions.list();
```

Supported names:

- `filesystem:read`, `filesystem:write`, `filesystem:delete`
- `terminal:exec`, `process:spawn`
- `network:fetch`
- `storage:read`, `storage:write`

A `true` response means the user allowed the app-level operation. It does **not** grant unrestricted access to the host filesystem or create an OS-level process/container sandbox.

## Virtual filesystem

```js
const docs = '/home/user/Documents';
await webOS.permissions.request('filesystem:read');
await webOS.permissions.request('filesystem:write');

await webOS.fs.mkdir(docs, { recursive: true });
await webOS.fs.writeFile(`${docs}/hello.txt`, 'Hello from a Tauri app');
const text = await webOS.fs.readFile(`${docs}/hello.txt`);
const names = await webOS.fs.readdir(docs);
const stats = await webOS.fs.stat(`${docs}/hello.txt`);
await webOS.fs.remove(`${docs}/hello.txt`);
```

The accepted namespace is absolute virtual paths such as `/home/user/Documents`, `/home/user/Downloads`, `/home/user/Desktop`, `/tmp`, `/apps`, and `/storage`. Paths are resolved under the application data directory. Parent traversal and symlinks are rejected. `readFile`/`writeFile` handle UTF-8 text; the editor/build pipeline preserves binary files in the frontend ZIP, but this initial runtime does not expose a binary `Uint8Array` file API.

`readdir()` returns child names. `stat()` returns `{ name, isDirectory, size, modifiedAtMs }`. `mkdir()` accepts `{ recursive: true }`; `remove()` accepts `{ recursive: true }`. The virtual root `/` cannot be removed.

## Terminal and processes

```js
await webOS.permissions.request('terminal:exec');
const result = await webOS.terminal.exec('echo hello');
// { stdout: 'hello', stderr: '', exitCode: 0 }

await webOS.permissions.request('process:spawn');
const taskId = await webOS.process.spawn('pwd', []);
const tasks = await webOS.process.list();
await webOS.process.kill(taskId);
```

The command interpreter is **not a host shell**. It supports only safe built-ins: `help`, `pwd`, `ls`, `cat`, `echo`, `mkdir`, `touch`, `rm`, and `clear`. Arguments are not passed through a shell; pipelines, redirection, environment expansion and arbitrary executable names are unavailable. Filesystem built-ins also need the matching filesystem permission.

`process.spawn()` runs a short-lived built-in task and records its result. `list()` returns recent task records and `kill()` removes a record; no OS process is launched. `terminal.write()` is explicitly unsupported for these completed tasks and `terminal.resize()` returns `false`. A real interactive terminal or desktop process manager is a future adapter and would require a stronger OS-level sandbox first. Android never uses desktop process APIs.

## Network

```js
await webOS.permissions.request('network:fetch');
const response = await webOS.network.fetch('https://api.example.com/status');
const data = await response.json();
```

The wrapper requires HTTPS in native mode, rejects embedded URL credentials and obvious localhost/private IPv4 destinations, and uses WebView `fetch`. CORS still applies. This is not a native HTTP proxy or a complete SSRF/DNS-rebinding defense; malicious app JavaScript can also call ordinary `fetch` directly. Do not treat this API as a network-security boundary for untrusted apps.

## Key/value storage

```js
await webOS.permissions.request('storage:write');
await webOS.permissions.request('storage:read');
await webOS.storage.setItem('theme', 'dark');
const theme = await webOS.storage.getItem('theme');
await webOS.storage.removeItem('theme');
```

Values are strings. Native storage is kept in the app-specific data directory; browser fallback uses `localStorage`. Keys are 1–180 UTF-8 bytes and cannot contain slashes or control characters. Native values are limited to 4 MiB.

## Device information

```js
const info = await webOS.device.getInfo();
// Native: { isNative: true, platform, os, architecture, appName, appVersion }
// Browser: { isNative: false, platform: 'web', ... }
const platform = await webOS.device.getPlatform();
```

`getPlatform()` is asynchronous in this implementation. Camera, microphone, clipboard, notifications, arbitrary host paths, and arbitrary host processes are not exposed by the starter runtime.

## Browser fallback

The injected facade does not crash when Tauri is absent:

- filesystem text and key/value fallbacks use browser storage and remain origin-local;
- `device.getInfo()` returns `platform: 'web'`;
- `help`, `pwd` and `echo` have simulated terminal responses;
- browser permission prompts explicitly explain that no native OS access is granted;
- process tasks are empty/simulated.

The browser fallback is for preview and basic app logic only. It is not a secure substitute for Tauri.
