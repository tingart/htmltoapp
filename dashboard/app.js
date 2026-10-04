import { HTMLTOAPP_CONFIG as CONFIG } from './config.js';
import { createZip, guessMimeType, safeProjectPath, unzipArchive, validateProjectFilePaths } from './zip.js';

const DB_NAME = 'forge-htmltoapp-workspace';
const DB_VERSION = 1;
const SESSION_KEY = 'forge.relay.session';
const ACTIVE_PROJECT_KEY = 'forge.activeProject';
const RELAY_URL_KEY = 'forge.relay.url';
const BUILD_STATE_KEY = 'forge.latestBuild';
const PENDING_BUILD_KEY = 'forge.pendingBuildProject';
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

const $ = (id) => document.getElementById(id);
const state = {
  db: null,
  projects: [],
  project: null,
  currentPath: '',
  currentRecord: null,
  isText: false,
  dirty: false,
  saveTimer: 0,
  metaTimer: 0,
  collapsedFolders: new Set(),
  build: null,
  buildPollTimer: 0,
  relayUrl: '',
  sessionToken: '',
};

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Browser storage request failed.'));
  });
}

function transactionAsPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Browser storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Browser storage transaction was cancelled.'));
  });
}

async function openWorkspaceDatabase() {
  if (state.db) return state.db;
  if (!('indexedDB' in window)) throw new Error('This browser does not support local project storage. Try a recent version of Chrome, Edge, Safari or Firefox.');
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('files')) {
      const files = db.createObjectStore('files', { keyPath: ['projectId', 'path'] });
      files.createIndex('projectId', 'projectId', { unique: false });
    }
  };
  state.db = await requestAsPromise(request);
  return state.db;
}

const store = {
  async allProjects() {
    const db = await openWorkspaceDatabase();
    return requestAsPromise(db.transaction('projects', 'readonly').objectStore('projects').getAll());
  },
  async getProject(id) {
    const db = await openWorkspaceDatabase();
    return requestAsPromise(db.transaction('projects', 'readonly').objectStore('projects').get(id));
  },
  async saveProject(project) {
    const db = await openWorkspaceDatabase();
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(project);
    await transactionAsPromise(tx);
  },
  async filesForProject(id) {
    const db = await openWorkspaceDatabase();
    const index = db.transaction('files', 'readonly').objectStore('files').index('projectId');
    return requestAsPromise(index.getAll(id));
  },
  async file(id, path) {
    const db = await openWorkspaceDatabase();
    return requestAsPromise(db.transaction('files', 'readonly').objectStore('files').get([id, path]));
  },
  async putFile(id, entry) {
    const db = await openWorkspaceDatabase();
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put({ projectId: id, path: entry.path, data: copyArrayBuffer(entry.data), mimeType: entry.mimeType || guessMimeType(entry.path), updatedAt: Date.now() });
    await transactionAsPromise(tx);
  },
  async replaceFiles(project, entries) {
    const db = await openWorkspaceDatabase();
    const tx = db.transaction(['projects', 'files'], 'readwrite');
    const fileStore = tx.objectStore('files');
    const cursorRequest = fileStore.index('projectId').openKeyCursor(IDBKeyRange.only(project.id));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
        return;
      }
      for (const entry of entries) {
        fileStore.put({ projectId: project.id, path: entry.path, data: copyArrayBuffer(entry.data), mimeType: entry.mimeType || guessMimeType(entry.path), updatedAt: Date.now() });
      }
      tx.objectStore('projects').put(project);
    };
    await transactionAsPromise(tx);
  },
  async removeFile(id, path) {
    const db = await openWorkspaceDatabase();
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete([id, path]);
    await transactionAsPromise(tx);
  },
  async deleteProject(id) {
    const db = await openWorkspaceDatabase();
    const tx = db.transaction(['projects', 'files'], 'readwrite');
    tx.objectStore('projects').delete(id);
    const request = tx.objectStore('files').index('projectId').openKeyCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    await transactionAsPromise(tx);
  },
};

function copyArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (typeof data === 'string') return encoder.encode(data).buffer;
  throw new Error('Unsupported file data.');
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeName(value, fallback = 'My Web App') {
  const cleaned = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return cleaned || fallback;
}

function makePackageId(name) {
  const slug = String(name || 'myapp').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]+/g, '').slice(0, 30);
  return `com.example.${/^[a-z]/.test(slug) ? slug : `app${slug}`}`;
}

function starterFiles(name) {
  const appName = sanitizeName(name);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101916">
  <title>${escapeHtml(appName)}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="card">
    <div class="mark">F</div>
    <p class="eyebrow">YOUR APP, YOUR WAY</p>
    <h1>Hello, <span>native.</span></h1>
    <p class="copy">This is your starter project. Change the HTML, make it yours, and build it for the platforms you need.</p>
    <button id="native-check">Check native runtime <span>↗</span></button>
    <p class="result" id="result">Ready when you are.</p>
  </main>
  <script src="./app.js"></script>
</body>
</html>`;
  const css = `:root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #101916; color: #edf2e8; }
* { box-sizing: border-box; }
body { min-height: 100svh; display: grid; place-items: center; margin: 0; padding: 24px; background: radial-gradient(ellipse at 50% 25%, #25392a, #101916 67%); }
.card { width: min(100%, 470px); padding: 40px; border: 1px solid #3a4b3c; border-radius: 22px; background: rgba(22, 33, 26, .85); box-shadow: 0 28px 80px #0005; }
.mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 13px; background: #c7f36e; color: #142019; font-size: 22px; font-weight: 800; }
.eyebrow { margin: 28px 0 9px; color: #9eb882; font-size: 10px; font-weight: 700; letter-spacing: .16em; }
h1 { margin: 0; font-size: clamp(36px, 8vw, 54px); letter-spacing: -.065em; line-height: 1.05; }
h1 span { color: #c7f36e; }
.copy { margin: 16px 0 23px; color: #a7b5a8; font-size: 14px; line-height: 1.7; }
button { padding: 12px 16px; border: 0; border-radius: 8px; background: #c7f36e; color: #142019; font-weight: 700; cursor: pointer; }
button span { padding-left: 10px; }
.result { min-height: 20px; margin-bottom: 0; color: #91a28f; font-size: 12px; }`;
  const js = `const result = document.querySelector('#result');
document.querySelector('#native-check').addEventListener('click', async () => {
  if (!window.webOS) { result.textContent = 'Runtime API not loaded yet.'; return; }
  const info = await webOS.device.getInfo();
  result.textContent = info.isNative ? 'Running inside Tauri on ' + info.platform + '.' : 'Browser preview — native APIs use safe fallbacks.';
});`;
  const manifest = JSON.stringify({ name: appName, packageId: makePackageId(appName), version: '1.0.0', description: 'A web app packaged with Tauri v2.' }, null, 2);
  return [
    { path: 'index.html', data: encoder.encode(html), mimeType: 'text/html' },
    { path: 'styles.css', data: encoder.encode(css), mimeType: 'text/css' },
    { path: 'app.js', data: encoder.encode(js), mimeType: 'text/javascript' },
    { path: 'app.json', data: encoder.encode(manifest), mimeType: 'application/json' },
  ];
}

function projectRecord({ id = uid(), name, appName, packageId, version = '1.0.0', description = '', files, now = Date.now() }) {
  return {
    id,
    name: sanitizeName(name || appName || 'Untitled project', 'Untitled project'),
    appName: sanitizeName(appName || name || 'My Web App'),
    packageId: String(packageId || makePackageId(appName || name)),
    version: String(version || '1.0.0'),
    description: String(description || ''),
    filePaths: files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
    createdAt: now,
    updatedAt: now,
  };
}

function validManifest(data, fallbackName) {
  try {
    const parsed = JSON.parse(decoder.decode(data));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('app.json must contain an object.');
    return {
      appName: sanitizeName(parsed.name || fallbackName),
      packageId: String(parsed.packageId || parsed.identifier || makePackageId(parsed.name || fallbackName)).trim(),
      version: String(parsed.version || '1.0.0').trim(),
      description: String(parsed.description || '').slice(0, 300),
    };
  } catch (error) {
    throw new Error(`app.json could not be read: ${error.message}`);
  }
}

function showToast(message, type = 'success', duration = 3300) {
  const region = $('toast-region');
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function confirmAction({ title, message, confirmLabel = 'Delete' }) {
  const dialog = $('confirm-dialog');
  // window.confirm is silently blocked (always returns false) inside embedded
  // previews and some mobile webviews, so destructive actions need an
  // in-page confirmation dialog to stay reliable everywhere.
  if (!dialog || typeof dialog.showModal !== 'function') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok-button').textContent = confirmLabel;
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose);
    openDialog(dialog);
  });
}

function updateSaveBadge(kind) {
  const badge = $('save-status');
  badge.classList.toggle('saving', kind === 'saving');
  badge.innerHTML = kind === 'saving' ? '<span></span>Saving…' : '<span></span>All changes saved';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatUpdated(timestamp) {
  const age = Date.now() - (timestamp || Date.now());
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function extensionOf(path) {
  return path.split('/').pop().split('.').pop().toLowerCase();
}

function isTextFile(record) {
  if (!record || !record.data) return false;
  const extension = extensionOf(record.path);
  const textExtensions = new Set(['html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'txt', 'md', 'xml', 'svg', 'yml', 'yaml', 'csv', 'toml', 'ini', 'sql', 'sh', 'py', 'rs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'map', 'env', 'gitignore', 'webmanifest']);
  if (!textExtensions.has(extension)) return false;
  const bytes = new Uint8Array(record.data);
  return !bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
}

function languageFor(path) {
  const extension = extensionOf(path);
  const languages = { html: 'HTML', htm: 'HTML', css: 'CSS', js: 'JAVASCRIPT', mjs: 'JAVASCRIPT', cjs: 'JAVASCRIPT', json: 'JSON', md: 'MARKDOWN', svg: 'SVG', xml: 'XML', ts: 'TYPESCRIPT', tsx: 'TSX', jsx: 'JSX', yml: 'YAML', yaml: 'YAML', py: 'PYTHON', rs: 'RUST', sh: 'SHELL' };
  return languages[extension] || extension.toUpperCase() || 'TEXT';
}

function fileGlyph(path) {
  const extension = extensionOf(path);
  if (['html', 'htm'].includes(extension)) return ['HTML', '#e8a17a'];
  if (extension === 'css') return ['CSS', '#80bce2'];
  if (['js', 'mjs', 'cjs'].includes(extension)) return ['JS', '#e2c273'];
  if (extension === 'json') return ['{}', '#c9a0df'];
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'ico'].includes(extension)) return ['◈', '#9ac68a'];
  if (['woff', 'woff2', 'ttf', 'otf'].includes(extension)) return ['Aa', '#cc9bb0'];
  return ['·', '#7f8c82'];
}

function setBuildButtonText(text, busy = false) {
  $('build-button-label').textContent = text;
  $('build-button').classList.toggle('is-busy', busy);
  $('build-button').disabled = busy || !state.project || getSelectedPlatforms().length === 0;
}

function getSelectedPlatforms() {
  return Array.from(document.querySelectorAll('input[name="platform"]:checked')).map((input) => input.value);
}

function updateBuildControls() {
  const hasProject = Boolean(state.project);
  for (const input of [$('app-name'), $('package-id'), $('app-version')]) input.disabled = !hasProject;
  for (const input of document.querySelectorAll('input[name="platform"]')) input.disabled = !hasProject;
  const selected = getSelectedPlatforms();
  $('build-button').disabled = !hasProject || selected.length === 0 || $('build-button').classList.contains('is-busy');
  $('build-hint').textContent = !hasProject ? 'Choose a project and platform to continue.' : selected.length ? `${selected.length} target${selected.length === 1 ? '' : 's'} selected · your project is saved locally.` : 'Select at least one platform to build.';
}

function setActiveProjectUI() {
  const hasProject = Boolean(state.project);
  $('editor-workspace').hidden = !hasProject;
  $('welcome-screen').hidden = hasProject;
  $('project-actions').hidden = !hasProject;
  $('active-project-name').textContent = hasProject ? state.project.name : 'No project selected';
  $('project-subtitle').textContent = hasProject ? `${state.project.filePaths.length} files · Last edited ${formatUpdated(state.project.updatedAt)}` : 'Create a project or import your HTML app to get started.';
  $('topbar-project').textContent = hasProject ? state.project.name : 'No project open';
  $('status-project').textContent = hasProject ? state.project.name : 'No project';
  $('app-name').value = hasProject ? state.project.appName : '';
  $('package-id').value = hasProject ? state.project.packageId : '';
  $('app-version').value = hasProject ? state.project.version : '';
  $('app-name').disabled = !hasProject;
  $('package-id').disabled = !hasProject;
  $('app-version').disabled = !hasProject;
  $('code-editor').disabled = !hasProject;
  updateBuildControls();
  renderProjectList();
  if (!hasProject) {
    state.currentPath = '';
    state.currentRecord = null;
    $('code-editor').value = '';
    $('line-numbers').textContent = '1';
    $('current-file-name').textContent = 'index.html';
    $('editor-language').textContent = 'HTML';
  }
}

function renderProjectList() {
  const container = $('project-list');
  $('project-count').textContent = String(state.projects.length);
  container.replaceChildren();
  if (!state.projects.length) {
    const empty = document.createElement('p');
    empty.className = 'project-empty-hint';
    empty.textContent = 'No projects yet. Create one or bring in an existing ZIP.';
    container.append(empty);
    return;
  }
  const ordered = [...state.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const project of ordered) {
    const item = document.createElement('button');
    item.className = `project-item${state.project?.id === project.id ? ' active' : ''}`;
    item.type = 'button';
    item.dataset.projectId = project.id;
    item.title = `${project.name} · ${project.filePaths.length} files`;
    const glyph = document.createElement('span');
    glyph.className = 'project-glyph';
    glyph.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h6l1.5 2H17v9H3V5Z"/><path d="M3 8h14"/></svg>';
    const copy = document.createElement('span');
    copy.className = 'project-item-copy';
    const title = document.createElement('strong');
    title.textContent = project.name;
    const meta = document.createElement('small');
    meta.textContent = `${project.filePaths.length} FILE${project.filePaths.length === 1 ? '' : 'S'} · ${formatUpdated(project.updatedAt)}`;
    copy.append(title, meta);
    item.append(glyph, copy);
    if (state.project?.id === project.id) {
      const active = document.createElement('span');
      active.className = 'project-active-mark';
      item.append(active);
    }
    container.append(item);
  }
}

function renderFileTree() {
  const container = $('file-tree');
  container.replaceChildren();
  if (!state.project) return;
  const paths = [...state.project.filePaths].sort((a, b) => a.localeCompare(b));
  const folders = new Set();
  const filesByFolder = new Map();
  for (const path of paths) {
    const pieces = path.split('/');
    let parent = '';
    for (const folder of pieces.slice(0, -1)) {
      parent = parent ? `${parent}/${folder}` : folder;
      folders.add(parent);
    }
    const directory = pieces.length > 1 ? pieces.slice(0, -1).join('/') : '';
    if (!filesByFolder.has(directory)) filesByFolder.set(directory, []);
    filesByFolder.get(directory).push(path);
  }
  const foldersByParent = new Map();
  for (const folder of folders) {
    const pieces = folder.split('/');
    const parent = pieces.length > 1 ? pieces.slice(0, -1).join('/') : '';
    if (!foldersByParent.has(parent)) foldersByParent.set(parent, []);
    foldersByParent.get(parent).push(folder);
  }
  const renderFolder = (parent, depth) => {
    for (const folder of (foldersByParent.get(parent) || []).sort((a, b) => a.localeCompare(b))) {
      const isCollapsed = state.collapsedFolders.has(folder);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `tree-folder${isCollapsed ? ' collapsed' : ''}`;
      button.dataset.folder = folder;
      button.style.paddingLeft = `${7 + depth * 10}px`;
      const leaf = folder.split('/').pop();
      button.innerHTML = `<span class="tree-arrow">⌄</span><span class="tree-folder-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5h5l1.3 1.4h6.7v6.8h-13V4.5Z"/></svg></span>`;
      const label = document.createElement('span');
      label.className = 'tree-folder-label';
      label.textContent = leaf;
      button.append(label);
      container.append(button);
      if (isCollapsed) continue;
      renderFolder(folder, depth + 1);
    }
    for (const path of (filesByFolder.get(parent) || []).sort((a, b) => a.localeCompare(b))) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `tree-file${path === state.currentPath ? ' selected' : ''}`;
      button.dataset.path = path;
      button.style.paddingLeft = `${9 + depth * 10}px`;
      const [glyph, colour] = fileGlyph(path);
      const icon = document.createElement('span');
      icon.className = 'tree-file-icon';
      icon.style.color = colour;
      icon.textContent = glyph;
      const label = document.createElement('span');
      label.className = 'tree-file-label';
      label.textContent = path.split('/').pop();
      button.title = path;
      button.append(icon, label);
      container.append(button);
    }
  };
  renderFolder('', 0);
  const totalBytes = state.project.filePaths.reduce((sum, path) => sum + (state.project.sizes?.[path] || 0), 0);
  $('file-count-label').textContent = `${paths.length} file${paths.length === 1 ? '' : 's'}${totalBytes ? ` · ${formatBytes(totalBytes)}` : ''}`;
}

async function loadProject(id) {
  if (!(await flushEditorSave()) || !(await flushMetaSave())) return;
  const project = await store.getProject(id);
  if (!project) return;
  state.project = project;
  state.currentPath = '';
  state.currentRecord = null;
  localStorage.setItem(ACTIVE_PROJECT_KEY, project.id);
  $('project-sidebar').classList.remove('mobile-open');
  $('mobile-menu-button').setAttribute('aria-expanded', 'false');
  setActiveProjectUI();
  renderFileTree();
  const preferred = project.filePaths.includes('index.html') ? 'index.html' : project.filePaths[0];
  if (preferred) await openFile(preferred);
  else setEmptyEditor();
  updateSaveBadge('saved');
}

function setEmptyEditor() {
  state.currentPath = '';
  state.currentRecord = null;
  state.isText = false;
  $('current-file-name').textContent = 'No file selected';
  $('editor-language').textContent = 'TEXT';
  $('code-editor').value = '';
  $('code-editor').disabled = true;
  $('line-numbers').textContent = '1';
  $('binary-message').hidden = false;
  $('binary-message').replaceChildren();
  const title = document.createElement('strong');
  title.textContent = 'This project is empty';
  const description = document.createElement('span');
  description.textContent = 'Add a file, upload assets or import a project ZIP to begin.';
  $('binary-message').append(title, description);
}

async function openFile(path) {
  if (!(await flushEditorSave())) return;
  if (!state.project) return;
  const record = await store.file(state.project.id, path);
  if (!record) return;
  state.currentPath = path;
  state.currentRecord = record;
  const text = isTextFile(record) && new Uint8Array(record.data).byteLength <= MAX_EDIT_BYTES;
  state.isText = text;
  $('current-file-name').textContent = path.split('/').pop();
  $('current-file-name').title = path;
  $('editor-language').textContent = languageFor(path);
  $('delete-file-button').disabled = path === 'index.html' && state.project.filePaths.length <= 1;
  $('code-editor').hidden = !text;
  $('line-numbers').hidden = !text;
  $('binary-message').hidden = text;
  if (text) {
    $('code-editor').disabled = false;
    $('code-editor').value = decoder.decode(record.data);
    $('code-editor').scrollTop = 0;
    $('code-editor').scrollLeft = 0;
    updateLineNumbers();
    updateCursorPosition();
    $('editor-body').scrollTop = 0;
    $('editor-body').scrollLeft = 0;
  } else {
    $('code-editor').value = '';
    $('code-editor').disabled = true;
    $('line-numbers').textContent = '';
    renderBinaryMessage(record);
  }
  $('file-size-label').textContent = formatBytes(new Uint8Array(record.data).byteLength);
  $('dirty-indicator').hidden = true;
  state.dirty = false;
  renderFileTree();
}

function renderBinaryMessage(record) {
  const message = $('binary-message');
  message.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = 'Previewing a project asset';
  const description = document.createElement('span');
  description.textContent = `${record.path} · ${formatBytes(new Uint8Array(record.data).byteLength)}. Binary assets stay in the project and are included in your build.`;
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'button button-secondary';
  download.textContent = 'Download this file';
  download.addEventListener('click', () => downloadBytes(record.path, new Uint8Array(record.data), record.mimeType));
  message.append(title, description, download);
}

function updateLineNumbers() {
  const value = $('code-editor').value;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) === 10) lines += 1;
  const output = new Array(Math.min(lines, 20000));
  for (let index = 0; index < output.length; index += 1) output[index] = String(index + 1);
  $('line-numbers').textContent = output.join('\n');
  const lineHeight = 22;
  const height = Math.max(240, $('code-editor').scrollHeight, lines * lineHeight + 24);
  $('code-editor').style.height = `${height}px`;
  $('line-numbers').style.height = `${height}px`;
}

function updateCursorPosition() {
  const editor = $('code-editor');
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split('\n').length;
  const column = editor.selectionStart - before.lastIndexOf('\n');
  $('cursor-position').textContent = `Ln ${line}, Col ${column}`;
}

function markEditorDirty() {
  if (!state.project || !state.currentPath || !state.isText) return;
  state.dirty = true;
  $('dirty-indicator').hidden = false;
  updateSaveBadge('saving');
  updateLineNumbers();
  updateCursorPosition();
  const bytes = encoder.encode($('code-editor').value);
  $('file-size-label').textContent = formatBytes(bytes.byteLength);
  clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => { void flushEditorSave(); }, 550);
}

async function flushEditorSave() {
  clearTimeout(state.saveTimer);
  if (!state.dirty || !state.project || !state.currentPath || !state.isText) return true;
  const bytes = encoder.encode($('code-editor').value);
  try {
    await store.putFile(state.project.id, { path: state.currentPath, data: bytes, mimeType: guessMimeType(state.currentPath) });
    state.project.updatedAt = Date.now();
    state.project.sizes ||= {};
    state.project.sizes[state.currentPath] = bytes.byteLength;
    await store.saveProject(state.project);
    state.currentRecord = { projectId: state.project.id, path: state.currentPath, data: bytes.buffer, mimeType: guessMimeType(state.currentPath) };
    state.dirty = false;
    $('dirty-indicator').hidden = true;
    $('file-size-label').textContent = formatBytes(bytes.byteLength);
    $('project-subtitle').textContent = `${state.project.filePaths.length} files · Last edited just now`;
    updateSaveBadge('saved');
    renderProjectList();
    return true;
  } catch (error) {
    showToast(`Couldn't save this edit: ${error.message}`, 'error');
    return false;
  }
}

async function flushMetaSave() {
  clearTimeout(state.metaTimer);
  if (!state.project) return true;
  state.project.appName = sanitizeName($('app-name').value);
  state.project.packageId = $('package-id').value.trim();
  state.project.version = $('app-version').value.trim();
  state.project.updatedAt = Date.now();
  $('active-project-name').textContent = state.project.name;
  $('topbar-project').textContent = state.project.name;
  $('project-subtitle').textContent = `${state.project.filePaths.length} files · Last edited just now`;
  updateSaveBadge('saving');
  try {
    await store.saveProject(state.project);
    updateSaveBadge('saved');
    renderProjectList();
    return true;
  } catch (error) {
    showToast(`Couldn't save project settings: ${error.message}`, 'error');
    return false;
  }
}

function scheduleMetaSave() {
  if (!state.project) return;
  state.project.appName = sanitizeName($('app-name').value);
  state.project.packageId = $('package-id').value.trim();
  state.project.version = $('app-version').value.trim();
  state.project.updatedAt = Date.now();
  $('topbar-project').textContent = state.project.name;
  updateSaveBadge('saving');
  clearTimeout(state.metaTimer);
  state.metaTimer = window.setTimeout(() => { void flushMetaSave(); }, 450);
}

function createNewProject(name) {
  const appName = sanitizeName(name, 'My Web App');
  const entries = starterFiles(appName);
  const project = projectRecord({ name: appName, appName, packageId: makePackageId(appName), files: entries });
  return store.replaceFiles(project, entries).then(async () => {
    state.projects.push(project);
    await loadProject(project.id);
    showToast(`${project.name} is ready. Your edits auto-save on this device.`);
  });
}

function addManifestIfMissing(entries, metadata) {
  const manifest = entries.find((entry) => entry.path === 'app.json');
  const data = encoder.encode(JSON.stringify({
    name: metadata.appName,
    packageId: metadata.packageId,
    version: metadata.version,
    description: metadata.description || '',
  }, null, 2));
  if (manifest) manifest.data = data;
  else entries.push({ path: 'app.json', data, mimeType: 'application/json' });
}

function normalizeArchiveEntries(entries) {
  const paths = entries.map((entry) => entry.path);
  if (paths.includes('index.html')) return entries;
  const roots = new Set(paths.map((path) => path.split('/')[0]));
  if (roots.size === 1) {
    const root = [...roots][0];
    const prefix = `${root}/`;
    if (paths.includes(`${prefix}index.html`)) return entries.map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  }
  throw new Error('Could not find index.html at the project root (or inside one top-level folder). Check the ZIP and try again.');
}

async function importZip(file) {
  const oldLabel = $('build-button-label').textContent;
  try {
    $('build-button-label').textContent = 'Reading ZIP…';
    const entries = normalizeArchiveEntries(await unzipArchive(file));
    const baseName = sanitizeName(file.name.replace(/\.zip$/i, '').replace(/[_-]+/g, ' '), 'Imported project');
    const manifestEntry = entries.find((entry) => entry.path === 'app.json');
    let metadata = { appName: baseName, packageId: makePackageId(baseName), version: '1.0.0', description: '' };
    if (manifestEntry) metadata = { ...metadata, ...validManifest(manifestEntry.data, baseName) };
    addManifestIfMissing(entries, metadata);
    const project = projectRecord({ name: baseName, appName: metadata.appName, packageId: metadata.packageId, version: metadata.version, description: metadata.description, files: entries });
    project.sizes = Object.fromEntries(entries.map((entry) => [entry.path, entry.data.byteLength]));
    await store.replaceFiles(project, entries);
    state.projects.push(project);
    await loadProject(project.id);
    $('zip-input').value = '';
    showToast(`Imported ${entries.length} files from ${file.name}.`);
  } catch (error) {
    $('zip-input').value = '';
    showToast(error.message || 'Could not import this ZIP.', 'error', 6000);
  } finally {
    $('build-button-label').textContent = oldLabel;
    updateBuildControls();
  }
}

async function importFiles(fileList) {
  // Snapshot the File objects synchronously: a FileList is bound to its input
  // element and becomes empty as soon as that input is reset, which can happen
  // before this async function resumes.
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.project) {
    openDialog($('project-dialog'));
    showToast('Create or import a project first, then add files.');
    return;
  }
  if (!(await flushEditorSave())) return;
  const added = [];
  try {
    const paths = validateProjectFilePaths(
      state.project.filePaths,
      files.map((file) => safeProjectPath(file.webkitRelativePath || file.name)),
      { allowExactOverwrite: true },
    );
    for (const [index, file] of files.entries()) {
      const path = paths[index];
      added.push({ path, data: new Uint8Array(await file.arrayBuffer()), mimeType: file.type || guessMimeType(path) });
    }
    const nextPaths = new Set(state.project.filePaths);
    for (const entry of added) nextPaths.add(entry.path);
    state.project.filePaths = [...nextPaths].sort((a, b) => a.localeCompare(b));
    state.project.sizes ||= {};
    for (const entry of added) state.project.sizes[entry.path] = entry.data.byteLength;
    state.project.updatedAt = Date.now();
    await store.saveProject(state.project);
    for (const entry of added) await store.putFile(state.project.id, entry);
    setActiveProjectUI();
    renderFileTree();
    if (added.length === 1) await openFile(added[0].path);
    showToast(`Added ${added.length} file${added.length === 1 ? '' : 's'}${added.length ? ' to ' + state.project.name : ''}.`);
  } catch (error) {
    showToast(error.message || 'Could not upload the selected files.', 'error', 5500);
  }
}

async function createProjectZip(project = state.project, options = {}) {
  if (!project) throw new Error('Create or open a project first.');
  if (!(await flushEditorSave()) || !(await flushMetaSave())) throw new Error('Save your latest project changes before exporting or building.');
  const records = await store.filesForProject(project.id);
  const entries = records.map((record) => ({ path: record.path, data: record.data }));
  const metadata = {
    appName: sanitizeName($('app-name').value || project.appName),
    packageId: $('package-id').value.trim() || project.packageId,
    version: $('app-version').value.trim() || project.version,
    description: project.description || '',
  };
  addManifestIfMissing(entries, metadata);
  return createZip(entries, options);
}

function downloadBytes(filename, bytes, mimeType = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.split('/').pop() || 'download.bin';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportProject() {
  if (!state.project) return;
  try {
    const blob = await createProjectZip();
    const slug = sanitizeName(state.project.name, 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${slug}.zip`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast(`Exported ${state.project.name} as a ZIP (${formatBytes(blob.size)}).`);
  } catch (error) {
    showToast(error.message || 'Could not export this project.', 'error');
  }
}

async function deleteCurrentFile() {
  if (!state.project || !state.currentPath) return;
  const confirmed = await confirmAction({
    title: 'Delete this file?',
    message: `“${state.currentPath}” will be removed from ${state.project.name} on this device. This cannot be undone.`,
    confirmLabel: 'Delete file',
  });
  if (!confirmed) return;
  const path = state.currentPath;
  await store.removeFile(state.project.id, path);
  state.project.filePaths = state.project.filePaths.filter((entry) => entry !== path);
  if (state.project.sizes) delete state.project.sizes[path];
  state.project.updatedAt = Date.now();
  await store.saveProject(state.project);
  state.currentPath = '';
  state.currentRecord = null;
  if (state.project.filePaths.length) await openFile(state.project.filePaths.includes('index.html') ? 'index.html' : state.project.filePaths[0]);
  else setEmptyEditor();
  setActiveProjectUI();
  renderFileTree();
  showToast(`Deleted ${path}.`);
}

async function deleteProject(project) {
  const confirmed = await confirmAction({
    title: 'Delete this project?',
    message: `“${project.name}” and all of its files will be removed from this browser. This cannot be undone.`,
    confirmLabel: 'Delete project',
  });
  if (!confirmed) return;
  if (state.project?.id === project.id) clearTimeout(state.metaTimer);
  if (localStorage.getItem(PENDING_BUILD_KEY) === project.id) localStorage.removeItem(PENDING_BUILD_KEY);
  await store.deleteProject(project.id);
  state.projects = state.projects.filter((entry) => entry.id !== project.id);
  if (state.project?.id === project.id) {
    state.project = null;
    localStorage.removeItem(ACTIVE_PROJECT_KEY);
    setActiveProjectUI();
    $('line-numbers').textContent = '1';
    $('code-editor').value = '';
  }
  renderProjectList();
  showToast(`Deleted ${project.name}.`);
}

function updateRelayIndicator() {
  const dot = $('relay-status-dot');
  dot.classList.toggle('connected', Boolean(state.relayUrl));
  dot.title = state.relayUrl ? 'Build relay configured' : 'Build relay not configured';
}

function loadRelayUrl() {
  try {
    state.relayUrl = localStorage.getItem(RELAY_URL_KEY) ?? CONFIG.relayUrl ?? '';
  } catch { state.relayUrl = CONFIG.relayUrl || ''; }
  state.relayUrl = String(state.relayUrl || '').replace(/\/$/, '');
  updateRelayIndicator();
}

function normalizeRelayUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Enter the HTTPS URL of your Cloudflare Worker.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use a clean HTTPS Worker URL without a path, query string or credentials.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('The build relay must use HTTPS.');
  return url.origin;
}

function parseJwt(token) {
  try {
    const segment = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
  } catch { return null; }
}

function readAuthCallback() {
  const hash = window.location.hash;
  if (!hash) return false;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('relay_session');
  const relayError = params.get('relay_error');
  if (!token && !relayError) return false;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (relayError) {
    localStorage.removeItem(PENDING_BUILD_KEY);
    const messages = {
      github_state: 'GitHub sign-in could not be verified. Please try again.',
      github_cancelled: 'GitHub sign-in was cancelled.',
      github_login: 'GitHub sign-in failed. Please try again.',
      repo_access: 'Your GitHub account needs write access to the configured repository.',
    };
    showToast(messages[relayError] || 'GitHub sign-in could not be completed.', 'error', 6000);
    return false;
  }
  sessionStorage.setItem(SESSION_KEY, token);
  state.sessionToken = token;
  return true;
}

function getSessionToken() {
  const token = state.sessionToken || sessionStorage.getItem(SESSION_KEY) || '';
  const payload = token ? parseJwt(token) : null;
  if (!payload || payload.exp * 1000 <= Date.now() + 15_000) {
    state.sessionToken = '';
    sessionStorage.removeItem(SESSION_KEY);
    return '';
  }
  state.sessionToken = token;
  return token;
}

async function relayFetch(path, options = {}) {
  if (!state.relayUrl) throw new Error('Connect your Cloudflare build relay before starting a build.');
  const token = getSessionToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${state.relayUrl}${path}`, { ...options, headers, redirect: 'follow' });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      state.sessionToken = '';
    }
    const message = payload?.error || `Build relay returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

async function verifyRelaySession() {
  if (!state.relayUrl || !getSessionToken()) return false;
  try {
    const identity = await relayFetch('/v1/me');
    if (identity?.login) {
      $('build-hint').textContent = `Connected as @${identity.login}. Choose targets and build.`;
      return true;
    }
  } catch (error) {
    if (error.message && !/401|expired|session/i.test(error.message)) console.info('Forge relay session check:', error.message);
  }
  return false;
}

async function connectRelayAndReturn() {
  if (!state.relayUrl) {
    openDialog($('relay-dialog'));
    return;
  }
  if (!state.project) {
    showToast('Open a project before connecting a build.', 'error');
    return;
  }
  const button = $('build-button');
  button.classList.add('is-busy');
  button.disabled = true;
  $('build-button-label').textContent = 'Saving before GitHub sign-in…';
  try {
    if (!(await flushEditorSave()) || !(await flushMetaSave())) throw new Error('Your latest changes could not be saved. Try again before signing in.');
    localStorage.setItem(PENDING_BUILD_KEY, state.project.id);
    window.location.assign(`${state.relayUrl}/v1/auth/start`);
  } catch (error) {
    showToast(error.message || 'Could not save before GitHub sign-in.', 'error', 6000);
    button.classList.remove('is-busy');
    $('build-button-label').textContent = 'Build app';
    updateBuildControls();
  }
}

function validateBuildMetadata() {
  const appName = sanitizeName($('app-name').value);
  const packageId = $('package-id').value.trim();
  const version = $('app-version').value.trim();
  const platforms = getSelectedPlatforms();
  if (!appName || appName.length > 64) throw new Error('App name must be between 1 and 64 characters.');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/.test(appName)) throw new Error('Use letters, numbers, spaces, dots, dashes, underscores or parentheses in the app name.');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(packageId)) throw new Error('Package ID must be lowercase reverse-domain format, for example com.example.myapp.');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Version must look like 1.0.0 or 1.0.0-beta.1.');
  if (!platforms.length) throw new Error('Select at least one target platform.');
  return { appName, packageId, version, platforms };
}

function encodeManifestHeader(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function startBuild({ afterLogin = false } = {}) {
  if (!state.project) return showToast('Create or open a project first.', 'error');
  if (!state.relayUrl) {
    openDialog($('relay-dialog'));
    return;
  }
  let metadata;
  try { metadata = validateBuildMetadata(); }
  catch (error) { showToast(error.message, 'error'); return; }
  if (!getSessionToken()) {
    await connectRelayAndReturn();
    return;
  }
  const buildButton = $('build-button');
  buildButton.classList.add('is-busy');
  buildButton.disabled = true;
  $('build-button-label').textContent = afterLogin ? 'Preparing build…' : 'Packaging project…';
  try {
    if (!(await flushEditorSave()) || !(await flushMetaSave())) throw new Error('Save your latest project changes before starting a build.');
    const maxUpload = Number(CONFIG.maxUploadBytes) || 80 * 1024 * 1024;
    const blob = await createProjectZip(state.project, { maxBytes: maxUpload });
    if (blob.size > maxUpload) throw new Error(`This ZIP is ${formatBytes(blob.size)}. The configured relay limit is ${formatBytes(maxUpload)}.`);
    $('build-button-label').textContent = 'Uploading & starting…';
    const manifest = encodeManifestHeader(metadata);
    const result = await relayFetch('/v1/builds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-HTMLToApp-Manifest': manifest },
      body: blob,
    });
    if (!result?.buildId) throw new Error('The relay accepted the upload but did not return a build ID.');
    state.build = {
      id: result.buildId,
      appName: metadata.appName,
      platforms: metadata.platforms,
      createdAt: Date.now(),
      status: 'queued',
      runUrl: result.runUrl || `https://github.com/${CONFIG.repository || 'tingart/htmltoapp'}/actions`,
      artifacts: [],
    };
    localStorage.setItem(BUILD_STATE_KEY, JSON.stringify(state.build));
    localStorage.removeItem(PENDING_BUILD_KEY);
    renderBuildCard();
    showToast('Build queued. GitHub Actions is preparing your native app.');
    void pollBuildStatus();
  } catch (error) {
    showToast(error.message || 'Could not start this build.', 'error', 6000);
  } finally {
    buildButton.classList.remove('is-busy');
    $('build-button-label').textContent = 'Build app';
    updateBuildControls();
  }
}

function restoreBuild() {
  try {
    state.build = JSON.parse(localStorage.getItem(BUILD_STATE_KEY) || 'null');
    if (state.build?.createdAt && Date.now() - state.build.createdAt > 7 * 24 * 60 * 60 * 1000) state.build = null;
  } catch { state.build = null; }
  renderBuildCard();
}

function renderBuildCard() {
  const card = $('active-build-card');
  if (!state.build) { card.hidden = true; return; }
  card.hidden = false;
  const status = state.build.status || 'queued';
  const completed = status === 'completed';
  const success = completed && state.build.conclusion === 'success';
  const failure = completed && !success;
  const label = completed ? (success ? 'Build complete' : state.build.conclusion === 'cancelled' ? 'Build cancelled' : 'Build failed') : status === 'in_progress' ? 'Build in progress' : 'Build queued';
  const copy = completed ? (success ? 'Artifacts are ready to download.' : 'Open the Actions run to review the build logs.') : 'You can leave this page; status is saved in this browser.';
  card.replaceChildren();
  const header = document.createElement('div');
  header.className = 'active-build-head';
  const dot = document.createElement('span');
  dot.className = `build-state-dot${success ? ' completed' : failure ? ' failure' : ''}`;
  const title = document.createElement('span');
  title.textContent = `${label} · ${state.build.appName || 'Native app'}`;
  header.append(dot, title);
  const description = document.createElement('p');
  description.className = 'active-build-copy';
  description.textContent = copy;
  card.append(header, description);
  if (Array.isArray(state.build.artifacts)) {
    for (const artifact of state.build.artifacts) {
      if (!artifact.downloadUrl) continue;
      const link = document.createElement('a');
      link.className = 'active-build-link';
      link.href = artifact.downloadUrl;
      link.textContent = `↓ ${artifact.name} · ${formatBytes(artifact.size || 0)}`;
      link.target = '_blank';
      link.rel = 'noreferrer';
      card.append(link);
    }
  }
  const actions = document.createElement('a');
  actions.className = 'active-build-link';
  actions.href = state.build.runUrl || `https://github.com/${CONFIG.repository || 'tingart/htmltoapp'}/actions`;
  actions.target = '_blank';
  actions.rel = 'noreferrer';
  actions.textContent = completed ? 'Open GitHub Actions run ↗' : 'View build in GitHub Actions ↗';
  card.append(actions);
}

async function pollBuildStatus() {
  if (!state.build || !state.relayUrl || !getSessionToken()) return;
  clearTimeout(state.buildPollTimer);
  try {
    const result = await relayFetch(`/v1/builds/${encodeURIComponent(state.build.id)}`);
    if (result) {
      state.build.status = result.status || state.build.status;
      state.build.conclusion = result.conclusion || '';
      state.build.runUrl = result.runUrl || state.build.runUrl;
      state.build.artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
      state.build.updatedAt = Date.now();
      localStorage.setItem(BUILD_STATE_KEY, JSON.stringify(state.build));
      renderBuildCard();
    }
    if (state.build.status !== 'completed') state.buildPollTimer = window.setTimeout(() => { void pollBuildStatus(); }, 9000);
  } catch (error) {
    if (!/expired|session|401/i.test(error.message || '')) console.warn('Forge build status is temporarily unavailable:', error.message);
    state.buildPollTimer = window.setTimeout(() => { void pollBuildStatus(); }, 20000);
  }
}

function setInputFromRecord(project) {
  $('app-name').value = project.appName;
  $('package-id').value = project.packageId;
  $('app-version').value = project.version;
}

function bindEvents() {
  $('top-create-project').addEventListener('click', () => openDialog($('project-dialog')));
  $('sidebar-new-project').addEventListener('click', () => openDialog($('project-dialog')));
  $('welcome-create-project').addEventListener('click', () => openDialog($('project-dialog')));
  $('welcome-import-zip').addEventListener('click', () => $('zip-input').click());
  $('import-zip-button').addEventListener('click', () => $('zip-input').click());
  $('zip-input').addEventListener('change', (event) => { const file = event.target.files?.[0]; if (file) void importZip(file); });
  $('upload-files-button').addEventListener('click', () => $('files-input').click());
  $('files-input').addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    // Reset the input only after snapshotting the File objects; clearing it
    // empties the live FileList, which previously made uploads import nothing.
    event.target.value = '';
    if (files.length) void importFiles(files);
  });
  $('project-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-project-id]');
    if (item) void loadProject(item.dataset.projectId);
  });
  $('file-tree').addEventListener('click', (event) => {
    const folder = event.target.closest('[data-folder]');
    if (folder) {
      if (state.collapsedFolders.has(folder.dataset.folder)) state.collapsedFolders.delete(folder.dataset.folder);
      else state.collapsedFolders.add(folder.dataset.folder);
      renderFileTree();
      return;
    }
    const file = event.target.closest('[data-path]');
    if (file) void openFile(file.dataset.path);
  });
  $('add-file-button').addEventListener('click', () => { $('new-file-path').value = ''; openDialog($('file-dialog')); });
  $('file-add-shortcut').addEventListener('click', () => { $('new-file-path').value = ''; openDialog($('file-dialog')); });
  $('download-project-button').addEventListener('click', () => void exportProject());
  $('delete-file-button').addEventListener('click', () => void deleteCurrentFile());
  $('project-menu-button').addEventListener('click', () => { if (state.project) void deleteProject(state.project); });
  $('code-editor').addEventListener('input', markEditorDirty);
  $('code-editor').addEventListener('click', updateCursorPosition);
  $('code-editor').addEventListener('keyup', updateCursorPosition);
  $('code-editor').addEventListener('select', updateCursorPosition);
  $('code-editor').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void flushEditorSave(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      const editor = $('code-editor');
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.setRangeText('  ', start, end, 'end');
      markEditorDirty();
    }
  });
  for (const id of ['app-name', 'package-id', 'app-version']) $(id).addEventListener('input', scheduleMetaSave);
  for (const checkbox of document.querySelectorAll('input[name="platform"]')) checkbox.addEventListener('change', updateBuildControls);
  $('build-button').addEventListener('click', () => void startBuild());
  $('mobile-menu-button').addEventListener('click', () => {
    const sidebar = $('project-sidebar');
    sidebar.classList.toggle('mobile-open');
    $('mobile-menu-button').setAttribute('aria-expanded', String(sidebar.classList.contains('mobile-open')));
  });
  $('help-button').addEventListener('click', () => openDialog($('help-dialog')));
  $('relay-settings-button').addEventListener('click', () => {
    $('relay-url-input').value = state.relayUrl;
    $('disconnect-relay-button').hidden = !state.relayUrl;
    openDialog($('relay-dialog'));
  });
  $('relay-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('relay-url-input').value.trim();
    try {
      state.relayUrl = value ? normalizeRelayUrl(value) : '';
      if (state.relayUrl) localStorage.setItem(RELAY_URL_KEY, state.relayUrl);
      else localStorage.removeItem(RELAY_URL_KEY);
      updateRelayIndicator();
      closeDialog($('relay-dialog'));
      if (state.relayUrl) showToast('Build relay saved. Sign in with GitHub when you start the next build.');
    } catch (error) { showToast(error.message, 'error'); }
  });
  $('disconnect-relay-button').addEventListener('click', () => {
    state.relayUrl = '';
    state.sessionToken = '';
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(RELAY_URL_KEY);
    localStorage.removeItem(PENDING_BUILD_KEY);
    updateRelayIndicator();
    closeDialog($('relay-dialog'));
    showToast('Build relay disconnected.');
  });
  $('project-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('new-project-name').value.trim();
    if (!name) return;
    closeDialog($('project-dialog'));
    void createNewProject(name).catch((error) => showToast(error.message, 'error'));
  });
  $('file-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.project) return;
    try {
      const path = safeProjectPath($('new-file-path').value);
      validateProjectFilePaths(state.project.filePaths, [path]);
      const bytes = encoder.encode('');
      state.project.filePaths.push(path);
      state.project.filePaths.sort((a, b) => a.localeCompare(b));
      state.project.sizes ||= {};
      state.project.sizes[path] = 0;
      state.project.updatedAt = Date.now();
      await store.putFile(state.project.id, { path, data: bytes, mimeType: guessMimeType(path) });
      await store.saveProject(state.project);
      closeDialog($('file-dialog'));
      setActiveProjectUI();
      renderFileTree();
      await openFile(path);
      showToast(`Created ${path}.`);
    } catch (error) { showToast(error.message, 'error'); }
  });
  $('drop-zone').addEventListener('dragenter', (event) => { event.preventDefault(); $('drop-zone').classList.add('drag-over'); });
  $('drop-zone').addEventListener('dragover', (event) => event.preventDefault());
  $('drop-zone').addEventListener('dragleave', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) $('drop-zone').classList.remove('drag-over'); });
  $('drop-zone').addEventListener('drop', (event) => {
    event.preventDefault();
    $('drop-zone').classList.remove('drag-over');
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) void importZip(files[0]);
    else void importFiles(files);
  });
  window.addEventListener('beforeunload', () => {
    if (state.dirty) void flushEditorSave();
  });
}

async function initialize() {
  readAuthCallback();
  loadRelayUrl();
  bindEvents();
  restoreBuild();
  try {
    await openWorkspaceDatabase();
    state.projects = await store.allProjects();
    state.projects.sort((a, b) => b.updatedAt - a.updatedAt);
    setActiveProjectUI();
    const savedId = localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (savedId && state.projects.some((project) => project.id === savedId)) await loadProject(savedId);
    else if (state.projects.length) await loadProject(state.projects[0].id);
    await verifyRelaySession();
    const pendingProject = localStorage.getItem(PENDING_BUILD_KEY);
    if (pendingProject && state.project?.id === pendingProject && getSessionToken()) {
      localStorage.removeItem(PENDING_BUILD_KEY);
      window.setTimeout(() => { void startBuild({ afterLogin: true }); }, 250);
    } else if (state.build && state.build.status !== 'completed') {
      void pollBuildStatus();
    }
  } catch (error) {
    showToast(error.message || 'Could not open the local workspace.', 'error', 7000);
  }
}

void initialize();
