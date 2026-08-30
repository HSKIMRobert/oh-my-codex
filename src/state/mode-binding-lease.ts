import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBaseStateDir } from '../mcp/state-paths.js';
import { JsonChildClient } from './pinned-atomic-file-darwin-client.js';

interface PinnedLockNamespace {
  path: string;
  handle: FileHandle;
  identity: { dev: number; ino: number };
}

const PARTIAL_NAMESPACE_MARKER_STALE_MS = 30_000;

export interface CanonicalModeBindingIdentity {
  path: string;
  leasePath: string;
  namespacePath: string;
  stateRootPath: string;
  stateRootIdentity: { dev: number; ino: number } | null;
}

interface ModeBindingOwnerContext {
  held: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  bindings: ReadonlyMap<string, {
    leasePath: string;
    authorizedBaseStateDir?: string;
    stateRootIdentity: { dev: number; ino: number } | null;
  }>;
  authorizedRoots: ReadonlySet<string>;
}

const ownerContext = new AsyncLocalStorage<ModeBindingOwnerContext>();
const ownerQueues = new Map<string, Promise<void>>();

async function withLocalOwnerQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const tail = ownerQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = tail.finally(() => gate);
  ownerQueues.set(key, queued);
  await tail.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (ownerQueues.get(key) === queued) ownerQueues.delete(key);
  }
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path;
  for (;;) {
    try { return join(await realpath(cursor), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function assertCanonicalModeBindingLeaseSupported(): void {
  assertSupportedPlatform();
}

export async function resolveValidatedCanonicalModeBinding(
  path: string,
  authorizedBaseStateDir?: string,
): Promise<CanonicalModeBindingIdentity> {
  assertSupportedPlatform();
  const absolute = resolve(path);
  const selectedRoot = authorizedBaseStateDir ? resolve(authorizedBaseStateDir) : null;
  const stateMarker = `${sep}.omx${sep}state${sep}`;
  const markerIndex = absolute.lastIndexOf(stateMarker);
  let rawStateRoot: string;
  let relative: string;
  if (selectedRoot) {
    const prefix = `${selectedRoot}${sep}`;
    if (!absolute.startsWith(prefix)) throw new Error('mode binding path must be inside the authorized state root');
    rawStateRoot = selectedRoot;
    relative = absolute.slice(prefix.length);
  } else {
    if (markerIndex < 1) throw new Error('mode binding path must be inside canonical .omx/state');
    rawStateRoot = absolute.slice(0, markerIndex + stateMarker.length - 1);
    relative = absolute.slice(markerIndex + stateMarker.length);
  }
  const parts = relative.split(sep);
  const validName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(value);
  const validSession = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
  if (!(parts.length === 1 && validName(parts[0])
    || parts.length === 3 && parts[0] === 'sessions' && validSession(parts[1]) && validName(parts[2]))) {
    throw new Error('mode binding path has an invalid canonical scope');
  }
  const canonicalStateRoot = await canonicalizeProspectivePath(rawStateRoot);
  const canonicalPath = join(canonicalStateRoot, ...parts);
  const canonicalOwnerPath = join(canonicalStateRoot, parts.at(-1)!);
  const namespaceParent = basename(canonicalStateRoot) === 'state' && basename(dirname(canonicalStateRoot)) === '.omx'
    ? dirname(dirname(canonicalStateRoot))
    : dirname(canonicalStateRoot);
  const namespacePath = join(namespaceParent, '.omx-state-locks');
  let stateRootIdentity: { dev: number; ino: number } | null = null;
  try {
    const visibleRoot = await lstat(canonicalStateRoot);
    if (!visibleRoot.isDirectory() || visibleRoot.isSymbolicLink()) throw new Error('authorized state root must be a real directory');
    stateRootIdentity = { dev: visibleRoot.dev, ino: visibleRoot.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    path: canonicalPath,
    leasePath: join(namespacePath, `${canonicalModeBindingLeaseKey(canonicalOwnerPath)}.lock`),
    namespacePath,
    stateRootPath: canonicalStateRoot,
    stateRootIdentity,
  };
}

export async function withCanonicalModeBindingLease<T>(
  binding: CanonicalModeBindingIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  assertSupportedPlatform();
  const namespace = await pinCanonicalStateLockNamespace(binding.namespacePath);
  const key = basename(binding.leasePath).slice(0, -'.lock'.length);
  const nonce = `${Date.now()}-${randomBytes(12).toString('hex')}`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./mode-binding-lease-helper.js', import.meta.url)), key, nonce,
      String(namespace.identity.dev), String(namespace.identity.ino)],
    { cwd: namespace.path, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  canonicalModeBindingLeaseTestHooks.onHelperSpawn?.(child);
  const client = new JsonChildClient(child, 'canonical mode binding lease helper');
  let primaryError: unknown;
  try {
    await client.initialize();
    await assertPinnedLockNamespace(namespace);
    await client.request({ op: 'assert' });
    await canonicalModeBindingLeaseTestHooks.afterAcquire?.(namespace.path);
    await assertPinnedLockNamespace(namespace);
    await client.request({ op: 'assert' });
    const result = await operation();
    await assertPinnedLockNamespace(namespace);
    await client.request({ op: 'assert' });
    await assertPinnedStateRoot(binding);
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await client.close();
    } catch (closeError) {
      if (primaryError === undefined) throw closeError;
    }
    finally { await namespace.handle.close(); }
  }
}

export async function withModeBindingOwnerTransaction<T>(
  path: string,
  work: () => Promise<T>,
  authorizedBaseStateDir?: string,
): Promise<T> {
  const inherited = ownerContext.getStore();
  const rawPath = resolve(path);
  const inheritedBinding = inherited?.bindings.get(rawPath);
  const contains = (root: string) => {
    const candidate = relative(resolve(root), rawPath);
    return candidate === '' || candidate !== '..'
      && !candidate.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(candidate);
  };
  const inheritedAuthority = [...(inherited?.authorizedRoots ?? [])].find(contains);
  const selectedAuthority = getBaseStateDir();
  const effectiveAuthority = authorizedBaseStateDir ?? inheritedBinding?.authorizedBaseStateDir
    ?? inheritedAuthority ?? (contains(selectedAuthority) ? selectedAuthority : undefined);
  let binding: CanonicalModeBindingIdentity;
  try { binding = await resolveValidatedCanonicalModeBinding(path, effectiveAuthority); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTSUP') throw error;
    const fallbackIdentity = `legacy:${rawPath}`;
    if (inherited?.held.has(fallbackIdentity)) return work();
    const runFallback = () => {
      const held = new Set(inherited?.held ?? []);
      const excluded = new Set(inherited?.excluded ?? []);
      const bindings = new Map(inherited?.bindings ?? []);
      const authorizedRoots = new Set(inherited?.authorizedRoots ?? []);
      held.add(fallbackIdentity);
      excluded.delete(fallbackIdentity);
      bindings.set(rawPath, {
        leasePath: fallbackIdentity,
        authorizedBaseStateDir: effectiveAuthority,
        stateRootIdentity: null,
      });
      if (effectiveAuthority) authorizedRoots.add(resolve(effectiveAuthority));
      return ownerContext.run({ held, excluded, bindings, authorizedRoots }, work);
    };
    return withLocalOwnerQueue(fallbackIdentity, runFallback);
  }
  const lockIdentity = binding.leasePath;
  if (inheritedBinding && inheritedBinding.leasePath !== lockIdentity) {
    throw new Error('mode binding path identity changed inside the owner transaction');
  }
  if (inheritedBinding?.stateRootIdentity && (!binding.stateRootIdentity
    || binding.stateRootIdentity.dev !== inheritedBinding.stateRootIdentity.dev
    || binding.stateRootIdentity.ino !== inheritedBinding.stateRootIdentity.ino)) {
    throw new Error('mode binding state root identity changed inside the owner transaction');
  }
  if (inherited?.held.has(lockIdentity)) {
    if (inheritedBinding && !inheritedBinding.stateRootIdentity && binding.stateRootIdentity) {
      inheritedBinding.stateRootIdentity = binding.stateRootIdentity;
    }
    return work();
  }
  const runWithLease = async () => {
    const held = new Set(inherited?.held ?? []);
    const excluded = new Set(inherited?.excluded ?? []);
    const bindings = new Map(inherited?.bindings ?? []);
    const authorizedRoots = new Set(inherited?.authorizedRoots ?? []);
    held.add(lockIdentity);
    excluded.delete(lockIdentity);
    const ownerBinding = {
      leasePath: lockIdentity,
      authorizedBaseStateDir: effectiveAuthority,
      stateRootIdentity: binding.stateRootIdentity,
    };
    bindings.set(rawPath, ownerBinding);
    if (effectiveAuthority) authorizedRoots.add(resolve(effectiveAuthority));
    const result = await ownerContext.run({ held, excluded, bindings, authorizedRoots }, work);
    const finalBinding = await resolveValidatedCanonicalModeBinding(path, effectiveAuthority);
    if (ownerBinding.stateRootIdentity && (!finalBinding.stateRootIdentity
      || finalBinding.stateRootIdentity.dev !== ownerBinding.stateRootIdentity.dev
      || finalBinding.stateRootIdentity.ino !== ownerBinding.stateRootIdentity.ino)) {
      throw new Error('mode binding state root identity changed inside the owner transaction');
    }
    return result;
  };
  if (inherited?.excluded.has(lockIdentity)) return withCanonicalModeBindingLease(binding, runWithLease);
  return withLocalOwnerQueue(lockIdentity, () => withCanonicalModeBindingLease(binding, runWithLease));
}

export function outsideModeBindingOwnerTransaction<T>(work: () => T): T {
  const inherited = ownerContext.getStore();
  const excluded = new Set(inherited?.excluded ?? []);
  for (const path of inherited?.held ?? []) excluded.add(path);
  return ownerContext.run({ held: new Set(), excluded, bindings: new Map(), authorizedRoots: new Set() }, work);
}

export async function assertModeBindingOwnerIdentity(path: string, authorizedBaseStateDir?: string): Promise<void> {
  const context = ownerContext.getStore();
  const rawPath = resolve(path);
  const owner = context?.bindings.get(rawPath);
  if (!owner || !context?.held.has(owner.leasePath)) throw new Error('canonical state owner transaction missing');
  const binding = await resolveValidatedCanonicalModeBinding(path, authorizedBaseStateDir ?? owner.authorizedBaseStateDir);
  if (binding.leasePath !== owner.leasePath || owner.stateRootIdentity && (!binding.stateRootIdentity
    || binding.stateRootIdentity.dev !== owner.stateRootIdentity.dev
    || binding.stateRootIdentity.ino !== owner.stateRootIdentity.ino)) {
    throw new Error('mode binding state root identity changed inside the owner transaction');
  }
}

function assertSupportedPlatform(): void {
  const platform = canonicalModeBindingLeaseTestHooks.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw Object.assign(new Error(`canonical mode binding leases are unsupported on ${platform}`), { code: 'ENOTSUP' });
  }
}

function canonicalModeBindingLeaseKey(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex');
}

async function assertPinnedStateRoot(binding: CanonicalModeBindingIdentity): Promise<void> {
  if (!binding.stateRootIdentity) return;
  const visible = await lstat(binding.stateRootPath);
  if (!visible.isDirectory() || visible.isSymbolicLink()
    || visible.dev !== binding.stateRootIdentity.dev || visible.ino !== binding.stateRootIdentity.ino) {
    throw new Error('mode binding state root identity changed inside the owner transaction');
  }
}

async function readLockNamespaceIdentity(path: string): Promise<{ dev: number; ino: number }> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('canonical mode binding lease namespace must be a real directory');
  return { dev: value.dev, ino: value.ino };
}

async function assertPinnedLockNamespace(namespace: PinnedLockNamespace): Promise<void> {
  const opened = await namespace.handle.stat();
  const visible = await readLockNamespaceIdentity(namespace.path);
  if (opened.dev !== namespace.identity.dev || opened.ino !== namespace.identity.ino
    || visible.dev !== namespace.identity.dev || visible.ino !== namespace.identity.ino) {
    throw new Error('canonical mode binding lease namespace changed');
  }
}

async function readPinnedNamespaceMarker(path: string): Promise<{ dev: number; ino: number } | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    const visible = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || !visible.isFile() || visible.isSymbolicLink()
      || visible.nlink !== 1 || before.dev !== visible.dev || before.ino !== visible.ino) {
      throw new Error('canonical mode binding lease namespace marker invalid');
    }
    const parsed = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
    if (typeof parsed.dev !== 'number' || typeof parsed.ino !== 'number') {
      throw new Error('canonical mode binding lease namespace marker malformed');
    }
    return { dev: parsed.dev, ino: parsed.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

async function publishNamespaceMarkerAtomically(
  markerPath: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  const tempPath = `${markerPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let marker: FileHandle | null = null;
  try {
    marker = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await marker.writeFile(`${JSON.stringify(identity)}\n`);
    await marker.sync();
    await marker.close(); marker = null;
    await link(tempPath, markerPath);
  } finally {
    await marker?.close();
    await unlink(tempPath).catch(() => undefined);
  }
}

async function recoverPartialNamespaceMarker(
  markerPath: string,
  namespacePath: string,
  identity: { dev: number; ino: number },
): Promise<boolean> {
  const beforeNamespace = await readLockNamespaceIdentity(namespacePath);
  if (beforeNamespace.dev !== identity.dev || beforeNamespace.ino !== identity.ino) return false;
  let handle: FileHandle | null = null;
  try {
    handle = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    const visible = await lstat(markerPath);
    if (!opened.isFile() || opened.nlink !== 1 || !visible.isFile() || visible.isSymbolicLink()
      || visible.nlink !== 1 || opened.dev !== visible.dev || opened.ino !== visible.ino
      || Date.now() - opened.mtimeMs < PARTIAL_NAMESPACE_MARKER_STALE_MS) return false;
    const quarantinePath = `${markerPath}.stale-${process.pid}-${randomBytes(8).toString('hex')}`;
    await handle.close(); handle = null;
    await rename(markerPath, quarantinePath);
    const quarantined = await lstat(quarantinePath);
    if (quarantined.dev !== opened.dev || quarantined.ino !== opened.ino
      || quarantined.size !== opened.size || quarantined.mtimeMs !== opened.mtimeMs) return false;
    const afterNamespace = await readLockNamespaceIdentity(namespacePath);
    if (afterNamespace.dev !== identity.dev || afterNamespace.ino !== identity.ino) return false;
    await unlink(quarantinePath);
    return true;
  } catch {
    return false;
  } finally { await handle?.close(); }
}

async function pinCanonicalStateLockNamespace(namespacePath: string): Promise<PinnedLockNamespace> {
  const markerPath = `${namespacePath}.identity.json`;
  try { await mkdir(namespacePath, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const identity = await readLockNamespaceIdentity(namespacePath);
  let recorded: { dev: number; ino: number } | null = null;
  try { recorded = await readPinnedNamespaceMarker(markerPath); }
  catch {
    if (!await recoverPartialNamespaceMarker(markerPath, namespacePath, identity)) throw new Error('canonical mode binding lease namespace marker malformed');
  }
  if (!recorded) {
    try {
      await publishNamespaceMarkerAtomically(markerPath, identity);
      recorded = identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      recorded = await readPinnedNamespaceMarker(markerPath);
    }
  }
  if (!recorded || recorded.dev !== identity.dev || recorded.ino !== identity.ino) {
    throw new Error('canonical mode binding lease namespace identity mismatch');
  }
  const handle = await open(namespacePath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  const namespace = { path: namespacePath, handle, identity };
  try { await assertPinnedLockNamespace(namespace); return namespace; }
  catch (error) { await handle.close(); throw error; }
}

const canonicalModeBindingLeaseTestHooks: {
  afterAcquire?: (namespacePath: string) => void | Promise<void>;
  onHelperSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  platform?: NodeJS.Platform;
} = {};

export function __setCanonicalModeBindingLeaseTestHooksForTests(
  hooks: typeof canonicalModeBindingLeaseTestHooks,
): void {
  canonicalModeBindingLeaseTestHooks.afterAcquire = hooks.afterAcquire;
  canonicalModeBindingLeaseTestHooks.onHelperSpawn = hooks.onHelperSpawn;
  canonicalModeBindingLeaseTestHooks.platform = hooks.platform;
}
