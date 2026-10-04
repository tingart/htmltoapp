const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_FILE_UNCOMPRESSED = 128 * 1024 * 1024;
const MAX_FILES = 25000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export function safeProjectPath(value) {
  if (typeof value !== 'string') throw new Error('File path must be text.');
  const path = value.normalize('NFC').trim();
  if (!path || path.length > 240 || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`Unsafe project path: ${value}`);
  }
  if (/[\\\u0000-\u001f\u007f:]/.test(path)) throw new Error(`Unsafe characters in path: ${value}`);
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) {
    throw new Error(`Unsafe project path: ${value}`);
  }
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`A path uses a reserved Windows filename: ${value}`);
  }
  return parts.join('/');
}

export function validateProjectFilePaths(existingPaths, candidatePaths, { allowExactOverwrite = false } = {}) {
  const files = new Map();
  const directories = new Set();
  const addParents = (path) => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  };
  const keyFor = (path) => safeProjectPath(path).toLocaleLowerCase('en-US');

  for (const rawPath of existingPaths) {
    const path = safeProjectPath(rawPath);
    const key = keyFor(path);
    if (files.has(key)) throw new Error(`The project already contains duplicate or case-conflicting paths: ${path}`);
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (files.has(parent)) throw new Error(`A file path conflicts with the project folder structure: ${path}`);
    }
    if (directories.has(key)) throw new Error(`A file path conflicts with the project folder structure: ${path}`);
    files.set(key, path);
    addParents(key);
  }

  const added = new Set();
  const validated = [];
  for (const rawPath of candidatePaths) {
    const path = safeProjectPath(rawPath);
    const key = keyFor(path);
    if (added.has(key)) throw new Error(`This upload has duplicate or case-conflicting paths: ${path}`);
    added.add(key);

    const current = files.get(key);
    if (current !== undefined && current !== path) throw new Error(`This upload conflicts with an existing path that differs only by case: ${path}`);
    if (current !== undefined && !allowExactOverwrite) throw new Error(`A file with that path already exists: ${path}`);
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (files.has(parent)) throw new Error(`A file path conflicts with the project folder structure: ${path}`);
    }
    if (directories.has(key)) throw new Error(`A file path conflicts with the project folder structure: ${path}`);
    files.set(key, path);
    addParents(key);
    validated.push(path);
  }
  return validated;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readU16(view, offset) {
  if (offset + 2 > view.byteLength) throw new Error('This ZIP archive is truncated.');
  return view.getUint16(offset, true);
}

function readU32(view, offset) {
  if (offset + 4 > view.byteLength) throw new Error('This ZIP archive is truncated.');
  return view.getUint32(offset, true);
}

async function inflateRaw(compressed, expectedSize) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress ZIP files. Try a current version of Chrome, Edge, Safari or Firefox.');
  }
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const response = new Response(stream);
    const result = new Uint8Array(await response.arrayBuffer());
    if (result.byteLength !== expectedSize) throw new Error('The extracted file size does not match its ZIP directory.');
    return result;
  } catch (error) {
    if (error instanceof TypeError || /format|deflate|compression/i.test(error?.message || '')) {
      throw new Error('This browser cannot read this ZIP compression method. Recreate the ZIP using Deflate or Store compression, then try again.');
    }
    throw error;
  }
}

export async function unzipArchive(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Choose a ZIP file to import.');
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('This ZIP is larger than the 200 MB browser import limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstPossible = Math.max(0, bytes.length - 65557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= firstPossible; offset -= 1) {
    if (readU32(view, offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('This file does not contain a valid ZIP directory.');

  const diskNumber = readU16(view, endOffset + 4);
  const directoryDisk = readU16(view, endOffset + 6);
  const diskEntryCount = readU16(view, endOffset + 8);
  const entryCount = readU16(view, endOffset + 10);
  const directorySize = readU32(view, endOffset + 12);
  const directoryOffset = readU32(view, endOffset + 16);
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntryCount !== entryCount) {
    throw new Error('Multi-volume ZIP archives are not supported.');
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported by this browser editor yet.');
  }
  if (entryCount > MAX_FILES) throw new Error(`This ZIP contains more than ${MAX_FILES.toLocaleString()} files.`);
  if (directoryOffset + directorySize > endOffset) throw new Error('The ZIP central directory is invalid.');

  const files = [];
  const seen = new Set();
  let totalUncompressed = 0;
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(view, cursor) !== 0x02014b50) throw new Error('The ZIP central directory is corrupt.');
    const flags = readU16(view, cursor + 8);
    const method = readU16(view, cursor + 10);
    const crc = readU32(view, cursor + 16);
    const compressedSize = readU32(view, cursor + 20);
    const uncompressedSize = readU32(view, cursor + 24);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const commentLength = readU16(view, cursor + 32);
    const externalAttributes = readU32(view, cursor + 38);
    const localOffset = readU32(view, cursor + 42);
    const endOfEntry = cursor + 46 + nameLength + extraLength + commentLength;
    if (endOfEntry > bytes.length) throw new Error('The ZIP central directory is truncated.');
    const rawName = textDecoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor = endOfEntry;

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) throw new Error('Password-protected ZIP files are not supported.');
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method (${method}) for ${rawName}.`);
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    if (fileType === 0xa000 || (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000)) {
      throw new Error(`Links and special files are not allowed in project ZIPs: ${rawName}`);
    }

    const isDirectory = rawName.endsWith('/') || fileType === 0x4000;
    const cleanName = isDirectory ? rawName.replace(/\/+$/, '') : rawName;
    if (!cleanName) continue;
    const path = safeProjectPath(cleanName);
    if (isDirectory) continue;
    const key = path.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error(`The ZIP contains duplicate or case-conflicting paths: ${path}`);
    seen.add(key);
    if (uncompressedSize > MAX_FILE_UNCOMPRESSED) throw new Error(`${path} is larger than the 128 MB per-file import limit.`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error('The uncompressed project is larger than the 512 MB browser import limit.');
    if (compressedSize > 0 && uncompressedSize / compressedSize > 250) throw new Error(`The compression ratio for ${path} is too high. The archive may be a ZIP bomb.`);

    if (readU32(view, localOffset) !== 0x04034b50) throw new Error(`The ZIP local entry is corrupt: ${path}`);
    const localNameLength = readU16(view, localOffset + 26);
    const localExtraLength = readU16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > bytes.length || dataOffset < 0) throw new Error(`The ZIP data is truncated: ${path}`);
    const compressed = bytes.subarray(dataOffset, dataEnd);
    const data = method === 0 ? new Uint8Array(compressed) : await inflateRaw(compressed, uncompressedSize);
    if (data.byteLength !== uncompressedSize) throw new Error(`The extracted file size is invalid: ${path}`);
    if (crc32(data) !== crc) throw new Error(`The ZIP checksum failed for ${path}. The archive may be damaged.`);
    files.push({ path, data, mimeType: guessMimeType(path) });
  }
  if (!files.length) throw new Error('This ZIP does not contain any files.');
  return files;
}

export function guessMimeType(path) {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const types = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    json: 'application/json', map: 'application/json', txt: 'text/plain', md: 'text/markdown', xml: 'application/xml', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
    yml: 'text/yaml', yaml: 'text/yaml', csv: 'text/csv',
  };
  return types[extension] || 'application/octet-stream';
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return textEncoder.encode(value);
  throw new Error('A project file contains data that cannot be exported.');
}

function dosDateTime(now = new Date()) {
  const year = Math.max(1980, now.getFullYear());
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

export function createZip(entries, { maxBytes = Number.POSITIVE_INFINITY } = {}) {
  if (!Array.isArray(entries) || entries.length > 65535) throw new Error('This project has too many files to export as a classic ZIP.');
  if (!(maxBytes > 0) || maxBytes < 22) throw new Error('The ZIP size limit must be at least 22 bytes.');
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;
  let count = 0;
  const stamp = dosDateTime();

  for (const entry of entries) {
    const path = safeProjectPath(entry.path);
    const name = textEncoder.encode(path);
    const data = asUint8Array(entry.data);
    if (name.byteLength > 65535 || data.byteLength > 0xffffffff || offset > 0xffffffff) {
      throw new Error('A file is too large for a standard ZIP archive.');
    }
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x031e, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, stamp.time, true);
    centralView.setUint16(14, stamp.date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    const projectedSize = offset + local.byteLength + data.byteLength + centralSize + central.byteLength + 22;
    if (projectedSize > maxBytes) throw new Error('This project ZIP exceeds the configured build relay size limit. Remove large assets or raise the relay limit.');
    centralParts.push(central);
    offset += local.byteLength + data.byteLength;
    centralSize += central.byteLength;
    count += 1;
  }

  if (offset > 0xffffffff || centralSize > 0xffffffff) throw new Error('This project is too large for a standard ZIP archive.');
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, count, true);
  endView.setUint16(10, count, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}
