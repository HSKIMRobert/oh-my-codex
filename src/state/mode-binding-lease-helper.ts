import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, stat, type FileHandle, unlink, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

const RETRY_MS = 10;
type Identity = { dev: number; ino: number };
type OwnerState = { kind: 'valid'; token: string } | { kind: 'ownerless' } | { kind: 'ambiguous' };

function respond(value: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function sameIdentity(value: Identity, expected: Identity): boolean {
  return value.dev === expected.dev && value.ino === expected.ino;
}

async function readPinnedOwner(): Promise<OwnerState> {
  const entries = await readdir('.');
  if (entries.length === 0) return { kind: 'ownerless' };
  if (entries.length !== 1 || !entries[0].startsWith('owner-') || basename(entries[0]) !== entries[0]) {
    return { kind: 'ambiguous' };
  }
  let handle: FileHandle | null = null;
  try {
    handle = await open(entries[0], fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    const visible = await lstat(entries[0]);
    if (!before.isFile() || before.nlink !== 1 || !visible.isFile() || visible.isSymbolicLink()
      || visible.nlink !== 1 || !sameIdentity(before, visible)) return { kind: 'ambiguous' };
    const value = (await handle.readFile('utf8')).trim();
    const after = await handle.stat();
    if (!sameIdentity(before, after) || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { kind: 'ambiguous' };
    return entries[0] === `owner-${value}` && value ? { kind: 'valid', token: value } : { kind: 'ambiguous' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'ambiguous' };
    throw error;
  } finally { await handle?.close(); }
}

function ownerIsDead(value: string): boolean {
  const pid = Number.parseInt(value.split('-', 1)[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

async function runPinnedClaimMode(args: string[]): Promise<void> {
  const [lockName = '', replacementToken = '', nsDev = '', nsIno = '', lockDev = '', lockIno = ''] = args;
  if (!lockName || basename(lockName) !== lockName || !replacementToken || !nsDev || !nsIno || !lockDev || !lockIno) {
    throw new Error('invalid pinned canonical state lock claim arguments');
  }
  const namespaceIdentity = { dev: Number(nsDev), ino: Number(nsIno) };
  const lockIdentity = { dev: Number(lockDev), ino: Number(lockIno) };
  const current = await stat('.');
  const parent = await stat('..');
  if (!current.isDirectory() || !parent.isDirectory()
    || !sameIdentity(current, lockIdentity) || !sameIdentity(parent, namespaceIdentity)) {
    respond({ claimed: false }); return;
  }
  const observed = await readPinnedOwner();
  if (observed.kind === 'ambiguous' || observed.kind === 'valid' && !ownerIsDead(observed.token)) {
    respond({ claimed: false }); return;
  }
  const confirmed = await readPinnedOwner();
  const changed = confirmed.kind !== observed.kind
    || observed.kind === 'valid' && (confirmed.kind !== 'valid' || confirmed.token !== observed.token);
  if (changed || !sameIdentity(await stat('.'), lockIdentity) || !sameIdentity(await stat('..'), namespaceIdentity)) {
    respond({ claimed: false }); return;
  }
  if (observed.kind === 'valid') await unlink(`owner-${observed.token}`);
  await writeFile(`owner-${replacementToken}`, replacementToken, { flag: 'wx', mode: 0o600 });
  const finalOwner = await readPinnedOwner();
  respond({ claimed: finalOwner.kind === 'valid' && finalOwner.token === replacementToken });
}

if (process.argv[2] === '--claim-existing') {
  try { await runPinnedClaimMode(process.argv.slice(3)); } catch (error) {
    respond({ claimed: false, error: error instanceof Error ? error.message : String(error) });
  }
  process.exit(0);
}

const [key = '', nonce = '', expectedDev = '', expectedIno = ''] = process.argv.slice(2);
if (!key || basename(key) !== key || !nonce || !expectedDev || !expectedIno) {
  throw new Error('invalid canonical state lock helper arguments');
}
const token = `${process.pid}-${nonce}`;
const lockName = `${key}.lock`;
const namespaceIdentity = { dev: Number(expectedDev), ino: Number(expectedIno) };
let lockIdentity: Identity | null = null;

async function assertPinnedNamespace(): Promise<void> {
  const current = await stat(lockIdentity ? '..' : '.');
  if (!current.isDirectory() || !sameIdentity(current, namespaceIdentity)) {
    throw new Error('canonical state lock namespace changed');
  }
}

async function assertPinnedLock(): Promise<void> {
  if (!lockIdentity) throw new Error('canonical state lock was not pinned');
  await assertPinnedNamespace();
  const pinned = await stat('.');
  let visible: Awaited<ReturnType<typeof lstat>>;
  try { visible = await lstat(`../${lockName}`); } catch { throw new Error('canonical state lock ownership lost'); }
  if (!pinned.isDirectory() || !visible.isDirectory() || visible.isSymbolicLink()
    || !sameIdentity(pinned, lockIdentity) || !sameIdentity(visible, lockIdentity)) {
    throw new Error('canonical state lock ownership lost');
  }
}

async function enterPinnedLock(expected: Identity): Promise<void> {
  process.chdir(lockName);
  const pinned = await stat('.');
  const parent = await stat('..');
  if (!pinned.isDirectory() || !sameIdentity(pinned, expected) || !sameIdentity(parent, namespaceIdentity)) {
    throw new Error('canonical state lock changed while pinning');
  }
  lockIdentity = expected;
}

async function tryClaimExisting(expected: Identity): Promise<boolean> {
  const child = spawn(process.execPath, [process.argv[1], '--claim-existing', lockName, token,
    String(namespaceIdentity.dev), String(namespaceIdentity.ino), String(expected.dev), String(expected.ino)], {
    cwd: lockName, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  if (code !== 0) return false;
  const parsed = JSON.parse(output.trim()) as { claimed?: unknown; error?: unknown };
  if (typeof parsed.error === 'string') throw new Error(parsed.error);
  return parsed.claimed === true;
}

async function acquire(): Promise<void> {
  const deadline = Date.now() + 1_500;
  for (;;) {
    await assertPinnedNamespace();
    try {
      await mkdir(lockName);
      const created = await lstat(lockName);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('canonical state lock invalid');
      const identity = { dev: created.dev, ino: created.ino };
      await enterPinnedLock(identity);
      await writeFile(`owner-${token}`, token, { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (lockIdentity) throw error;
      let visible: Awaited<ReturnType<typeof lstat>> | null = null;
      try { visible = await lstat(lockName); } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
      }
      if (visible?.isDirectory() && !visible.isSymbolicLink()) {
        const identity = { dev: visible.dev, ino: visible.ino };
        if (await tryClaimExisting(identity)) {
          const confirmed = await lstat(lockName);
          if (!confirmed.isDirectory() || confirmed.isSymbolicLink() || !sameIdentity(confirmed, identity)) {
            throw new Error('canonical state lock changed after stale claim');
          }
          await enterPinnedLock(identity);
          const claimed = await readPinnedOwner();
          if (claimed.kind !== 'valid' || claimed.token !== token) throw new Error('canonical state lock ownership lost');
          return;
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for canonical state lock: ${lockName}`);
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

async function release(): Promise<void> {
  await assertPinnedLock();
  const observed = await readPinnedOwner();
  if (observed.kind !== 'valid' || observed.token !== token) throw new Error('canonical state lock ownership lost');
  await unlink(`owner-${token}`);
  // Retaining the empty pinned directory lets a later owner adopt it without
  // pathname-based rmdir/recreate races or touching a successor.
}

let acquired = false;
try {
  await acquire(); acquired = true;
  await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify({ id: 0, ok: true, ready: true })}\n`, () => resolve()));
} catch (error) {
  const response = { id: 0, ok: false, error: error instanceof Error ? error.message : String(error) };
  await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(response)}\n`, () => resolve()));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
if (!acquired) lines.close();
for await (const line of acquired ? lines : []) {
  let id: number | undefined;
  try {
    const request = JSON.parse(line) as { id?: number; op?: string };
    id = request.id;
    if (request.op === 'assert') {
      await assertPinnedLock();
      const observed = await readPinnedOwner();
      if (observed.kind !== 'valid' || observed.token !== token) throw new Error('canonical state lock ownership lost');
      respond({ id, ok: true });
    } else if (request.op === 'close') {
      await release(); respond({ id, ok: true }); break;
    } else throw new Error('unsupported canonical state lock operation');
  } catch (error) { respond({ id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
}
