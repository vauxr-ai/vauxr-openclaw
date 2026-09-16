import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createProtectedStore } from '../dist/src/secret-store.js';

const artifacts = path.resolve('test-artifacts');
async function fixture(t) {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, 'vauxr-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = 'http://127.0.0.1:8080';
  const dir = path.join(root, 'vauxr-auth', createHash('sha256').update(binding).digest('hex'));
  return { root, binding, dir, file: path.join(dir, 'credentials.json'), store: createProtectedStore(root, binding) };
}
const record = n => ({ version: 1, origin: 'http://127.0.0.1:8080', wsUrl: 'ws://127.0.0.1:8080/ws', credential: `synthetic-test-only-${n}` });
const safeError = error => error.message === 'Vauxr: storage_error' && !error.cause;

test('supported SDK persists privately and a new instance recovers the exact record', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.read(), undefined);
  await f.store.commit(record(1));
  assert.deepEqual(await createProtectedStore(f.root, f.binding).read(), record(1));
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
  assert.equal((await lstat(f.dir)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.dirname(f.dir))).mode & 0o777, 0o700);
  assert.equal(await createProtectedStore(f.root, 'another-binding').read(), undefined);
});

test('serialized replacement retains complete records across concurrent instances', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => createProtectedStore(f.root, f.binding).commit(record(i))));
  assert.deepEqual(await f.store.read(), record(7));
});

test('weakened permissions fail closed without silently repairing or revealing private data', async t => {
  const f = await fixture(t);
  await f.store.commit(record(1));
  await chmod(f.file, 0o644);
  await assert.rejects(f.store.read(), safeError);
  await assert.rejects(f.store.commit(record(2)), safeError);
  assert.equal((await lstat(f.file)).mode & 0o777, 0o644);
  await chmod(f.file, 0o600);
  assert.deepEqual(await f.store.read(), record(1));
  await chmod(f.dir, 0o755);
  await assert.rejects(f.store.read(), safeError);
});

test('file and directory symlinks fail closed and do not overwrite targets', async t => {
  const f = await fixture(t);
  await f.store.commit(record(1));
  const target = path.join(f.root, 'target');
  await writeFile(target, 'unchanged', { mode: 0o600 });
  await rm(f.file);
  await symlink(target, f.file);
  await assert.rejects(f.store.read(), safeError);
  await assert.rejects(f.store.commit(record(2)), safeError);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  await rm(f.dir, { recursive: true });
  await symlink(f.root, f.dir);
  await assert.rejects(f.store.commit(record(3)), safeError);
});

test('corrupt persisted records and oversized writes produce only redacted failures', async t => {
  const f = await fixture(t);
  await f.store.commit(record(1));
  await assert.rejects(f.store.commit({ ...record(2), credential: 'x'.repeat(70000) }), safeError);
  assert.deepEqual(await f.store.read(), record(1));
  await writeFile(f.file, 'synthetic-sensitive-corrupt-json');
  await assert.rejects(f.store.read(), safeError);
});


test('fsync failure rejects the commit so callers cannot acknowledge durable save', async t => {
  const f = await fixture(t);
  await f.store.commit(record(1));
  const handle = await open(f.file, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const mock = t.mock.method(prototype, 'sync', async () => { throw new Error('synthetic-private-error'); });
  await assert.rejects(f.store.commit(record(2)), safeError);
  assert.ok(mock.mock.callCount() > 0);
});
