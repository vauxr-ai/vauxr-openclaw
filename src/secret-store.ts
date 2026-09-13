import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { ProtectedStore, SecretRecord } from './auth.js';
import { VauxrError } from './transport.js';

const queues = new Map<string, Promise<unknown>>();
const unavailable = () => new VauxrError('storage_error');

/** OpenClaw's supported private secret-file SDK, with strict durability before ACK.
 * The files are permission-protected, not encrypted at rest. Construction does no I/O.
 */
export function createProtectedStore(stateDir: string, bindingKey: string): ProtectedStore {
  const root = path.resolve(stateDir);
  const parent = path.join(root, 'vauxr-auth');
  const directory = path.join(parent, createHash('sha256').update(bindingKey).digest('hex'));
  const file = path.join(directory, 'credentials.json');

  async function inspect(target: string, isDirectory: boolean, privateMode = true) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile()) ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
        (privateMode && (info.mode & 0o077) !== 0) || (!isDirectory && info.nlink !== 1)) throw unavailable();
    return info;
  }
  async function directories(create: boolean) {
    // Do not change existing gateway state permissions or follow a replaced state root.
    await inspect(root, true, false);
    for (const item of [parent, directory]) {
      if (create) {
        try { await mkdir(item, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      await inspect(item, true);
    }
  }
  async function read(): Promise<SecretRecord | undefined> {
    try {
      await directories(false);
      await inspect(file, false);
      const { readSecretFile } = await import('openclaw/plugin-sdk/secret-file');
      const raw = await readSecretFile(file, 'Vauxr credential', { rejectSymlink: true, rejectHardlinks: true, maxBytes: 65536 });
      const record: unknown = JSON.parse(raw);
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
          (record as SecretRecord).version !== 1 || typeof (record as SecretRecord).origin !== 'string' ||
          typeof (record as SecretRecord).wsUrl !== 'string') throw unavailable();
      return record as SecretRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw unavailable();
    }
  }
  async function flush(target: string, isDirectory: boolean) {
    const expected = await inspect(target, isDirectory, target !== root);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : 0));
    try {
      const actual = await handle.stat();
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw unavailable();
      await handle.sync(); // Unlike the SDK fallback, a flush failure MUST prevent ACK.
    } finally { await handle.close(); }
  }
  async function commit(record: SecretRecord) {
    // Snapshot immediately: callers cannot mutate queued credential material.
    let content: string;
    try { content = JSON.stringify(record); } catch { throw unavailable(); }
    const previous = queues.get(file) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      try {
        if (process.platform === 'win32') throw unavailable(); // No POSIX privacy/directory-fsync guarantee.
        if (Buffer.byteLength(content) > 65536) throw unavailable();
        await directories(true);
        try { await inspect(file, false); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const { writePrivateSecretFileAtomic } = await import('openclaw/plugin-sdk/infra-runtime');
        await writePrivateSecretFileAtomic({ rootDir: parent, filePath: file, content, mode: 0o600, dirMode: 0o700 });
        await flush(file, false);
        // Flush every newly created directory entry, including the root's child.
        for (const item of [directory, parent, root]) await flush(item, true);
        if (JSON.stringify(await read()) !== content) throw unavailable();
      } catch { throw unavailable(); }
    });
    queues.set(file, task);
    try { await task; }
    finally { if (queues.get(file) === task) queues.delete(file); }
  }
  return { read, commit };
}
