// Where installed voice files live: OPFS readkit/voices/<name>, plus <name>.ok, a small JSON
// marker written only after the bytes were checked. A file without its marker is a partial
// download that install() resumes. Works on the main thread and in workers.

export const DIR = ['readkit', 'voices'];

export async function voicesDir(create = false) {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) throw Object.assign(new Error('OPFS is not available in this browser'), { code: 'no-opfs' });
  let d = await navigator.storage.getDirectory();
  for (const part of DIR) d = await d.getDirectoryHandle(part, { create });
  return d;
}

async function tryDir() {
  try {
    return await voicesDir(false);
  } catch (e) {
    return null;
  }
}

async function getFile(dir, name) {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    return null;
  }
}

// { size, complete, marker } for one stored file (size 0 when absent).
export async function fileState(name) {
  const dir = await tryDir();
  if (!dir) return { size: 0, complete: false, marker: null };
  const file = await getFile(dir, name);
  if (!file) return { size: 0, complete: false, marker: null };
  let marker = null;
  const m = await getFile(dir, name + '.ok');
  if (m) {
    try {
      marker = JSON.parse(await m.text());
    } catch (e) {
      marker = null;
    }
  }
  const complete = !!marker && marker.bytes === file.size;
  return { size: file.size, complete, marker };
}

// The verified File, or null when it is not fully installed.
export async function storedFile(name) {
  const dir = await tryDir();
  if (!dir) return null;
  const st = await fileState(name);
  return st.complete ? getFile(dir, name) : null;
}

export async function removeFile(name) {
  const dir = await tryDir();
  if (!dir) return;
  for (const n of [name + '.ok', name]) {
    try {
      await dir.removeEntry(n);
    } catch (e) {
      /* absent */
    }
  }
}

export async function writeMarker(dir, name, marker) {
  const h = await dir.getFileHandle(name + '.ok', { create: true });
  const bytes = new TextEncoder().encode(JSON.stringify(marker));
  if (h.createSyncAccessHandle) {
    // Dedicated workers: the sync handle is the one write path every Chrome version has.
    const a = await h.createSyncAccessHandle();
    try {
      a.truncate(0);
      a.write(bytes, { at: 0 });
      a.flush();
    } finally {
      a.close();
    }
    return;
  }
  const w = await h.createWritable();
  await w.write(bytes);
  await w.close();
}
