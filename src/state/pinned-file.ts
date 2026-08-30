import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PinnedFileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface PinnedDirectoryIdentity { dev: number; ino: number }

/** @internal Deterministic race seams for state transaction tests. */
export const PINNED_FILE_TEST_HOOKS: {
  beforeQuarantineRename?: (path: string) => void | Promise<void>;
} = {};

export async function snapshotPinnedParent(path: string): Promise<PinnedDirectoryIdentity> {
  const value = await lstat(dirname(path));
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('pinned_file_parent_invalid');
  return { dev: value.dev, ino: value.ino };
}

export async function snapshotPinnedFile(path: string): Promise<PinnedFileSnapshot | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    const visible = await lstat(path);
    if (!opened.isFile() || opened.nlink !== 1 || !visible.isFile() || visible.isSymbolicLink()
      || visible.nlink !== 1 || opened.dev !== visible.dev || opened.ino !== visible.ino) {
      throw new Error('pinned_file_identity_invalid');
    }
    return { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs };
  } finally {
    await handle.close();
  }
}

const DARWIN_PINNED_FILE_HELPER = String.raw`
const fs = require('node:fs/promises');
const c = require('node:fs').constants;
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const same = (s, e) => e === null ? s === null : s !== null && s.dev === e.dev && s.ino === e.ino && s.size === e.size && s.mtimeMs === e.mtimeMs;
const snap = async n => { try { const h = await fs.open(n, c.O_RDONLY | c.O_NOFOLLOW); try { const o = await h.stat(); const v = await fs.lstat(n); if (!o.isFile() || o.nlink !== 1 || !v.isFile() || v.isSymbolicLink() || v.nlink !== 1 || o.dev !== v.dev || o.ino !== v.ino) throw new Error('identity'); return { dev:o.dev, ino:o.ino, size:o.size, mtimeMs:o.mtimeMs }; } finally { await h.close(); } } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
(async () => {
  const d = await fs.lstat('.'); const ds = await fs.stat('.');
  if (!d.isDirectory() || d.isSymbolicLink() || d.dev !== input.parent.dev || d.ino !== input.parent.ino || ds.dev !== d.dev || ds.ino !== d.ino) throw new Error('parent');
  if (input.op === 'replace') {
    if (!same(await snap(input.name), input.expected)) throw new Error('cas');
    const h = await fs.open(input.temp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
    try { await h.writeFile(Buffer.from(input.data, 'base64')); await h.sync(); } finally { await h.close(); }
    if (!same(await snap(input.name), input.expected)) throw new Error('cas');
    await fs.rename(input.temp, input.name);
  } else if (input.op === 'create') {
    const h = await fs.open(input.name, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
    try { await h.writeFile(Buffer.from(input.data, 'base64')); await h.sync(); } finally { await h.close(); }
  } else if (input.op === 'mkdir') {
    await fs.mkdir(input.name);
  } else if (input.op === 'remove') {
    if (!same(await snap(input.name), input.expected)) throw new Error('cas');
    await fs.rename(input.name, input.temp);
    if (!same(await snap(input.temp), input.expected)) throw new Error('cas');
    await fs.unlink(input.temp);
  } else if (input.op === 'rename') {
    if (!same(await snap(input.name), input.expected)) throw new Error('cas');
    try { await fs.lstat(input.destination); throw new Error('destination'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.rename(input.name, input.destination);
    if (!same(await snap(input.destination), input.expected)) throw new Error('cas');
  } else throw new Error('op');
  const dir = await fs.open('.', c.O_RDONLY | c.O_DIRECTORY); try { await dir.sync(); } finally { await dir.close(); }
  process.stdout.write('{"ok":true}\n');
})().catch(e => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
`;

function sameSnapshot(left: PinnedFileSnapshot | null, right: PinnedFileSnapshot | null): boolean {
  return left === null ? right === null : right !== null
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function withPinnedParent<T>(path: string, work: (input: {
  parentPath: string;
  parent: { dev: number; ino: number };
  operationPath: string;
}) => Promise<T>, expectedParent?: PinnedDirectoryIdentity): Promise<T> {
  const parentPath = dirname(path);
  const before = await lstat(parentPath);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('pinned_file_parent_invalid');
  if (expectedParent && (before.dev !== expectedParent.dev || before.ino !== expectedParent.ino)) {
    throw new Error('pinned_file_parent_changed');
  }
  const handle = await open(parentPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const visible = await lstat(parentPath);
    if (opened.dev !== before.dev || opened.ino !== before.ino || visible.dev !== before.dev || visible.ino !== before.ino
      || !visible.isDirectory() || visible.isSymbolicLink()) throw new Error('pinned_file_parent_changed');
    return await work({
      parentPath,
      parent: { dev: opened.dev, ino: opened.ino },
      operationPath: process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : parentPath,
    });
  } finally {
    await handle.close();
  }
}

async function runDarwinPinned(parentPath: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await execFileAsync(process.execPath, ['-e', DARWIN_PINNED_FILE_HELPER, Buffer.from(JSON.stringify(payload)).toString('base64')], {
      cwd: parentPath,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    const wrapped = new Error(stderr || 'pinned Darwin operation failed') as NodeJS.ErrnoException;
    if (stderr.includes('EEXIST')) wrapped.code = 'EEXIST';
    else if (stderr.includes('ENOENT')) wrapped.code = 'ENOENT';
    else if (stderr.includes('cas')) wrapped.code = 'ESTALE';
    throw wrapped;
  }
}

export async function replacePinnedFile(
  path: string,
  bytes: Buffer | string,
  expected: PinnedFileSnapshot | null,
  expectedParent?: PinnedDirectoryIdentity,
): Promise<void> {
  await withPinnedParent(path, async ({ parentPath, parent, operationPath }) => {
    const name = basename(path);
    const temp = `${name}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (process.platform === 'darwin') {
      await runDarwinPinned(parentPath, { op: 'replace', parent, name, temp, expected, data: Buffer.from(bytes).toString('base64') });
      return;
    }
    const target = join(operationPath, name);
    const tempPath = join(operationPath, temp);
    try {
      if (!sameSnapshot(await snapshotPinnedFile(target), expected)) throw new Error('pinned_file_cas_mismatch');
      const handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (!sameSnapshot(await snapshotPinnedFile(target), expected)) throw new Error('pinned_file_cas_mismatch');
      await rename(tempPath, target);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }, expectedParent);
}

export async function createPinnedFileExclusive(path: string, bytes: Buffer | string, expectedParent?: PinnedDirectoryIdentity): Promise<void> {
  await withPinnedParent(path, async ({ parentPath, parent, operationPath }) => {
    const name = basename(path);
    if (process.platform === 'darwin') {
      await runDarwinPinned(parentPath, { op: 'create', parent, name, data: Buffer.from(bytes).toString('base64') });
      return;
    }
    const handle = await open(join(operationPath, name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }, expectedParent);
}

export async function createPinnedDirectory(path: string, expectedParent?: PinnedDirectoryIdentity): Promise<void> {
  await withPinnedParent(path, async ({ parentPath, parent, operationPath }) => {
    const name = basename(path);
    if (process.platform === 'darwin') {
      await runDarwinPinned(parentPath, { op: 'mkdir', parent, name });
      return;
    }
    await mkdir(join(operationPath, name));
  }, expectedParent);
}

export async function removePinnedFile(path: string, expected: PinnedFileSnapshot, expectedParent?: PinnedDirectoryIdentity): Promise<void> {
  await withPinnedParent(path, async ({ parentPath, parent, operationPath }) => {
    const name = basename(path);
    const quarantine = `${name}.remove-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (process.platform === 'darwin') {
      await runDarwinPinned(parentPath, { op: 'remove', parent, name, temp: quarantine, expected });
      return;
    }
    const target = join(operationPath, name);
    if (!sameSnapshot(await snapshotPinnedFile(target), expected)) throw new Error('pinned_file_cas_mismatch');
    const quarantinePath = join(operationPath, quarantine);
    await rename(target, quarantinePath);
    if (!sameSnapshot(await snapshotPinnedFile(quarantinePath), expected)) throw new Error('pinned_file_cas_mismatch');
    await rm(quarantinePath, { force: false });
  }, expectedParent);
}

export async function quarantinePinnedFile(
  path: string,
  destinationName: string,
  expected: PinnedFileSnapshot,
  expectedParent?: PinnedDirectoryIdentity,
): Promise<string> {
  return withPinnedParent(path, async ({ parentPath, parent, operationPath }) => {
    const name = basename(path);
    await PINNED_FILE_TEST_HOOKS.beforeQuarantineRename?.(path);
    if (process.platform === 'darwin') {
      await runDarwinPinned(parentPath, { op: 'rename', parent, name, destination: destinationName, expected });
      return join(parentPath, destinationName);
    }
    const source = join(operationPath, name);
    const destination = join(operationPath, destinationName);
    if (!sameSnapshot(await snapshotPinnedFile(source), expected)) throw new Error('pinned_file_cas_mismatch');
    await rename(source, destination);
    if (!sameSnapshot(await snapshotPinnedFile(destination), expected)) throw new Error('pinned_file_cas_mismatch');
    return join(parentPath, destinationName);
  }, expectedParent);
}
