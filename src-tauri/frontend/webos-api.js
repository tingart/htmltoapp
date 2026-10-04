/*
 * Common Web OS API injected into user apps by the build factory.
 * Tauri builds use a deliberately small Rust command surface; ordinary browser
 * previews fall back to browser storage and harmless terminal mocks.
 */
(() => {
  'use strict';
  if (window.webOS) return;

  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const isNative = typeof tauriInvoke === 'function';
  const invoke = (command, args = {}) => {
    if (!isNative) return Promise.reject(new Error(`Native command “${command}” is unavailable in a browser.`));
    return tauriInvoke(command, args);
  };
  const browserPermissionKey = 'webos.browser.permissions';
  const browserFilePrefix = 'webos.browser.file:';
  const browserDirectoryPrefix = 'webos.browser.directory:';
  const supportedPermissions = [
    'filesystem:read', 'filesystem:write', 'filesystem:delete',
    'terminal:exec', 'process:spawn', 'network:fetch', 'storage:read', 'storage:write',
  ];

  function virtualPath(path) {
    if (typeof path !== 'string' || !path.trim()) throw new Error('A virtual filesystem path is required.');
    const value = path.startsWith('/') ? path : `/${path}`;
    const parts = value.split('/').filter(Boolean);
    if (parts.some((part) => part === '.' || part === '..' || part.includes('\\') || part.includes('\0') || part.includes(':'))) {
      throw new Error('Invalid virtual filesystem path. Parent traversal and platform-specific paths are blocked.');
    }
    return `/${parts.join('/')}`;
  }

  function readBrowserPermissions() {
    try { return new Set(JSON.parse(sessionStorage.getItem(browserPermissionKey) || '[]')); }
    catch { return new Set(); }
  }

  const browserGranted = readBrowserPermissions();
  const permissionLabels = {
    'filesystem:read': 'read files inside this app’s browser-only virtual filesystem',
    'filesystem:write': 'write files inside this app’s browser-only virtual filesystem',
    'filesystem:delete': 'delete files inside this app’s browser-only virtual filesystem',
    'terminal:exec': 'run the app’s limited, simulated terminal commands',
    'process:spawn': 'start a limited app task (not an operating-system process)',
    'network:fetch': 'make an HTTPS request from this app',
    'storage:read': 'read this app’s private key-value storage',
    'storage:write': 'write this app’s private key-value storage',
  };

  const permissions = {
    async request(permission) {
      if (!supportedPermissions.includes(permission)) throw new Error(`Unsupported permission: ${permission}`);
      if (isNative) return invoke('permissions_request', { permission });
      if (browserGranted.has(permission)) return true;
      const allow = typeof window.confirm === 'function' && window.confirm(`Allow this app to ${permissionLabels[permission]}?\n\nBrowser mode does not grant native operating-system access.`);
      if (allow) {
        browserGranted.add(permission);
        sessionStorage.setItem(browserPermissionKey, JSON.stringify([...browserGranted]));
      }
      return Boolean(allow);
    },
    async check(permission) {
      if (!supportedPermissions.includes(permission)) return false;
      if (isNative) return invoke('permissions_check', { permission });
      return browserGranted.has(permission);
    },
    async list() {
      if (isNative) return invoke('permissions_list');
      return supportedPermissions.map((name) => ({ name, granted: browserGranted.has(name) }));
    },
  };

  async function requirePermission(permission) {
    if (await permissions.check(permission)) return;
    if (await permissions.request(permission)) return;
    throw new Error(`Permission denied: ${permission}`);
  }

  function readBrowserFile(path) {
    const value = localStorage.getItem(browserFilePrefix + path);
    if (value === null) throw new Error(`File not found: ${path}`);
    return value;
  }

  function writeBrowserFile(path, content) {
    try { localStorage.setItem(browserFilePrefix + path, String(content)); }
    catch { throw new Error('Browser storage is full. The native filesystem is available only in a Tauri build.'); }
  }

  function browserReaddir(path) {
    const base = path === '/' ? '/' : `${path}/`;
    const found = new Set();
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const isDirectory = key.startsWith(browserDirectoryPrefix);
      if (!isDirectory && !key.startsWith(browserFilePrefix)) continue;
      const child = key.slice(isDirectory ? browserDirectoryPrefix.length : browserFilePrefix.length);
      if (!child.startsWith(base) || child === path) continue;
      const rest = child.slice(base.length);
      const name = rest.split('/')[0];
      if (name) found.add(name);
    }
    return [...found].sort((a, b) => a.localeCompare(b));
  }

  const fs = {
    async readFile(path) {
      await requirePermission('filesystem:read');
      const safe = virtualPath(path);
      return isNative ? invoke('fs_read_file', { path: safe }) : readBrowserFile(safe);
    },
    async writeFile(path, content) {
      await requirePermission('filesystem:write');
      const safe = virtualPath(path);
      if (typeof content !== 'string') throw new Error('writeFile expects UTF-8 text.');
      if (isNative) return invoke('fs_write_file', { path: safe, content });
      writeBrowserFile(safe, content);
    },
    async readdir(path = '/') {
      await requirePermission('filesystem:read');
      const safe = virtualPath(path);
      return isNative ? invoke('fs_readdir', { path: safe }) : browserReaddir(safe);
    },
    async mkdir(path, options = {}) {
      await requirePermission('filesystem:write');
      const safe = virtualPath(path);
      const recursive = Boolean(options.recursive);
      if (isNative) return invoke('fs_mkdir', { path: safe, recursive });
      localStorage.setItem(browserDirectoryPrefix + safe, '1');
    },
    async remove(path, options = {}) {
      await requirePermission('filesystem:delete');
      const safe = virtualPath(path);
      if (safe === '/') throw new Error('The virtual filesystem root cannot be removed.');
      const recursive = Boolean(options.recursive);
      if (isNative) return invoke('fs_remove', { path: safe, recursive });
      const fileKey = browserFilePrefix + safe;
      const directoryKey = browserDirectoryPrefix + safe;
      const fileChildren = fileKey + '/';
      const directoryChildren = directoryKey + '/';
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && (key === fileKey || key.startsWith(fileChildren) || key === directoryKey || key.startsWith(directoryChildren))) keys.push(key);
      }
      const hasChildren = keys.some((key) => key !== directoryKey && key !== fileKey);
      const isDirectory = localStorage.getItem(directoryKey) !== null || hasChildren;
      if (isDirectory && hasChildren && !recursive) throw new Error('Directory is not empty. Pass { recursive: true } to remove it.');
      for (const key of keys) localStorage.removeItem(key);
    },
    async stat(path) {
      await requirePermission('filesystem:read');
      const safe = virtualPath(path);
      if (isNative) return invoke('fs_stat', { path: safe });
      const value = localStorage.getItem(browserFilePrefix + safe);
      if (value !== null) return { name: safe.split('/').pop(), isDirectory: false, size: new Blob([value]).size };
      const exists = localStorage.getItem(browserDirectoryPrefix + safe) !== null || browserReaddir(safe).length > 0;
      if (!exists) throw new Error(`Path not found: ${safe}`);
      return { name: safe.split('/').pop() || '/', isDirectory: true, size: 0 };
    },
  };

  const terminal = {
    async exec(command, args = []) {
      await requirePermission('terminal:exec');
      if (isNative) {
        const line = Array.isArray(args) ? [String(command), ...args.map(String)].join(' ') : String(command);
        return invoke('terminal_exec', { command: line });
      }
      const input = Array.isArray(args) ? [String(command), ...args.map(String)].join(' ') : String(command);
      const [verb, ...rest] = input.trim().split(/\s+/);
      if (!verb) return { stdout: '', stderr: '', exitCode: 0 };
      if (verb === 'help') return { stdout: 'Browser preview: help, pwd, echo. Native builds add sandboxed ls, cat, mkdir, touch and rm.', stderr: '', exitCode: 0 };
      if (verb === 'pwd') return { stdout: '/home/user', stderr: '', exitCode: 0 };
      if (verb === 'echo') return { stdout: rest.join(' '), stderr: '', exitCode: 0 };
      return { stdout: '', stderr: `“${verb}” is unavailable in the browser preview.`, exitCode: 127 };
    },
    async spawn(command, args = []) {
      await requirePermission('process:spawn');
      if (!Array.isArray(args)) throw new Error('terminal.spawn expects an argument array.');
      if (isNative) return invoke('process_spawn', { command: String(command), args: args.map(String) });
      return `browser-task-${Date.now()}`;
    },
    async write(processId, data) {
      if (!isNative) throw new Error('Interactive terminal sessions are not available in a browser preview.');
      return invoke('process_write', { processId, data: String(data) });
    },
    async resize(processId, columns, rows) {
      if (!isNative) return false;
      return invoke('process_resize', { processId, columns, rows });
    },
    async kill(processId) { return webOS.process.kill(processId); },
  };

  const processApi = {
    async spawn(command, args = []) { return terminal.spawn(command, args); },
    async list() { return isNative ? invoke('process_list') : []; },
    async kill(processId) {
      await requirePermission('process:spawn');
      return isNative ? invoke('process_kill', { processId }) : false;
    },
  };

  function validateStorageKey(key) {
    if (typeof key !== 'string' || !key || new TextEncoder().encode(key).byteLength > 180 || /[\\/\u0000-\u001f]/.test(key)) {
      throw new Error('Storage keys must be 1–180 UTF-8 bytes and cannot contain slashes or control characters.');
    }
    return key;
  }

  const storage = {
    async setItem(key, value) {
      await requirePermission('storage:write');
      key = validateStorageKey(key);
      if (typeof value !== 'string') throw new Error('Storage values must be strings.');
      if (isNative) return invoke('storage_set_item', { key, value });
      localStorage.setItem(`webos.app.storage:${key}`, value);
    },
    async getItem(key) {
      await requirePermission('storage:read');
      key = validateStorageKey(key);
      if (isNative) return invoke('storage_get_item', { key });
      return localStorage.getItem(`webos.app.storage:${key}`);
    },
    async removeItem(key) {
      await requirePermission('storage:write');
      key = validateStorageKey(key);
      if (isNative) return invoke('storage_remove_item', { key });
      localStorage.removeItem(`webos.app.storage:${key}`);
    },
  };

  function validateNetworkUrl(value) {
    const url = new URL(value, window.location.href);
    const protocolAllowed = isNative ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol);
    if (!protocolAllowed || url.username || url.password) throw new Error('Network requests must use a public HTTP(S) URL without embedded credentials.');
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '::1') {
      throw new Error('Requests to localhost and local-network hosts are blocked.');
    }
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const octets = ipv4.slice(1).map(Number);
      if (octets.some((octet) => octet > 255) || octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || octets[0] === 169 && octets[1] === 254 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
        throw new Error('Requests to private or loopback IP addresses are blocked.');
      }
    }
    return url;
  }

  const network = {
    async fetch(url, options = {}) {
      await requirePermission('network:fetch');
      const target = validateNetworkUrl(String(url));
      return window.fetch(target.href, options);
    },
  };

  const device = {
    async getInfo() {
      if (isNative) return invoke('runtime_info');
      return { isNative: false, platform: 'web', os: 'web', browser: navigator.userAgent, appName: document.title || 'Web App' };
    },
    async getPlatform() {
      const info = await device.getInfo();
      return info.platform || 'web';
    },
  };

  const api = {
    version: '1.0.0',
    isNative,
    fs,
    terminal,
    process: processApi,
    network,
    storage,
    permissions,
    device,
  };
  Object.defineProperty(window, 'webOS', { value: Object.freeze(api), configurable: false, enumerable: true, writable: false });
})();
