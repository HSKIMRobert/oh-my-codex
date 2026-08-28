import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { appendFile, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { getBaseStateDir } from '../state/paths.js';
import { projectAdvisoryReviewLifecycle, type AdvisoryReviewLifecycle } from './advisory-evidence.js';

export const RALPLAN_ADVISORY_SCHEMA_VERSION = 1;
export type AdvisoryFenceState = 'pending_closeout' | 'recovery_required' | 'closed' | 'abandoned' | 'released';
export type AdvisoryOutcome = 'approved' | 'exhausted' | 'rejected' | 'failed' | 'cancelled' | 'abandoned';
export type AdvisoryIntent = 'execute' | 'replan' | 'new_advisory' | 'abandon' | 'unrelated';
export type AdvisoryIntegrityStatus = 'proven' | 'unproven';

const JOURNAL_STEPS = [
  'session_mode', 'root_mode', 'session_skill', 'root_skill',
  'post_digest', 'journal_commit', 'fence_terminal',
] as const;
type JournalStep = (typeof JOURNAL_STEPS)[number];

type AdvisoryEventType =
  | 'ralplan_advisory_fence_created'
  | 'ralplan_advisory_closeout_step'
  | 'ralplan_advisory_closeout_reconciled'
  | 'ralplan_advisory_closeout_committed'
  | 'ralplan_advisory_fence_closed'
  | 'ralplan_advisory_digest_mismatch';

export function ralplanAdvisoryEventsPath(cwd: string, now = new Date()): string {
  return join(dirname(getBaseStateDir(cwd)), 'logs', `ralplan-advisory-${now.toISOString().slice(0, 10)}.jsonl`);
}

async function emitAdvisoryEvent(cwd: string, event: {
  type: AdvisoryEventType;
  generationId: string;
  iteration?: number;
  transition: string;
  checkpoint: string;
  reason: string;
  path: string;
  digest?: string;
}): Promise<void> {
  const path = ralplanAdvisoryEventsPath(cwd);
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await appendFile(path, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: event.type,
    generation_id: event.generationId,
    ...(event.iteration !== undefined ? { iteration: event.iteration } : {}),
    state_transition: event.transition,
    checkpoint: event.checkpoint,
    reason: event.reason,
    relative_path: relative(cwd, event.path),
    ...(event.digest ? { digest_prefix: event.digest.slice(0, 12) } : {}),
  })}\n`).catch(() => {});
}

export interface AdvisoryActivation {
  schema_version: 1;
  generation_id: string;
  predecessor_generation_id?: string;
  canonical_cwd: string;
  session_id: string;
  root_thread_id: string;
  activation_turn_id: string;
  created_at: string;
}

export interface AdvisoryFence extends AdvisoryActivation {
  state: AdvisoryFenceState;
  closing_turn_id: string;
  iteration: number;
  iteration_id?: string;
  plan_manifest_sha256?: string;
  architect_review_sha256?: string;
  critic_review_sha256?: string;
  evidence_bundle_sha256?: string;
  outcome?: AdvisoryOutcome;
  integrity_status?: AdvisoryIntegrityStatus;
  release_turn_id?: string;
  release_thread_id?: string;
  release_prompt_sha256?: string;
  requested_lane?: string;
  authority_kind?: 'new_root_user_execution_request';
  updated_at: string;
  sequence: number;
  previous_event_sha256?: string;
}

interface AdvisoryCurrentPointer {
  schema_version: 1;
  generation_id: string;
  predecessor_generation_id?: string;
  session_id: string;
  canonical_cwd: string;
  updated_at: string;
}

interface AdvisoryRolloverIntent {
  schema_version: 1;
  predecessor_generation_id?: string;
  generation_id: string;
  session_id: string;
  root_thread_id: string;
  activation_turn_id: string;
  activation_prompt_sha256?: string;
  canonical_cwd: string;
  created_at: string;
}

function valuesMatch(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
}

function hasActiveRalplanSkill(value: Record<string, unknown>, sessionId?: string): boolean {
  const entries = Array.isArray(value.active_skills) ? value.active_skills : [];
  if (entries.some((entry) => {
    const record = object(entry);
    return record?.skill === 'ralplan' && record.active !== false
      && (!sessionId || record.session_id === sessionId || record.session_id === undefined);
  })) return true;
  return value.active === true && value.skill === 'ralplan'
    && (!sessionId || value.session_id === sessionId || value.session_id === undefined);
}

async function closeoutStepPostcondition(
  cwd: string,
  sessionId: string,
  step: Extract<JournalStep, 'session_mode' | 'root_mode' | 'session_skill' | 'root_skill'>,
  patch: Record<string, unknown> | undefined,
  expectedSkill?: Record<string, unknown> | null,
): Promise<boolean> {
  if (!patch) return true;
  const base = getBaseStateDir(cwd);
  if (step === 'session_mode' || step === 'root_mode') {
    const path = step === 'session_mode'
      ? join(base, 'sessions', sessionId, 'ralplan-state.json')
      : join(base, 'ralplan-state.json');
    const value = await readStrictJson(path);
    if (step === 'root_mode' && value === null) return true;
    if (step === 'root_mode' && value && typeof value.session_id === 'string' && value.session_id !== sessionId) return true;
    if (step === 'root_mode') {
      return Boolean(value && valuesMatch(value, patch));
    }
    return Boolean(value && valuesMatch(value, patch));
  }
  const path = step === 'session_skill'
    ? join(base, 'sessions', sessionId, 'skill-active-state.json')
    : join(base, 'skill-active-state.json');
  const value = await readStrictJson(path);
  if (expectedSkill !== undefined) return JSON.stringify(value) === JSON.stringify(expectedSkill);
  return value === null || !hasActiveRalplanSkill(value, sessionId);
}

export interface AdvisoryJournal {
  schema_version: 1;
  generation_id: string;
  outcome: AdvisoryOutcome;
  integrity_status: AdvisoryIntegrityStatus;
  evidence_bundle_sha256?: string;
  terminal_mode_updates?: Record<string, unknown>;
  terminal_skill_updates?: { session_skill?: Record<string, unknown> | null; root_skill?: Record<string, unknown> | null };
  terminal_timestamp: string;
  phase: 'prepared' | 'committed';
  steps: Record<JournalStep, 'pending' | 'applied'>;
  created_at: string;
  updated_at: string;
}

export interface AdvisoryAdminEvent {
  schema_version: 1;
  action: 'abandon';
  generation_id: string;
  session_id: string;
  root_thread_id: string;
  turn_id: string;
  prior_fence_sha256: string;
  prior_journal_sha256?: string;
  created_at: string;
}

export interface AdvisoryProjection {
  activation: AdvisoryActivation;
  fence: AdvisoryFence | null;
  journal: AdvisoryJournal | null;
  admin_event?: AdvisoryAdminEvent | null;
  /** @deprecated Compatibility diagnostic only. Always false; never used for enforcement. */
  denyProductWrites: boolean;
  corruption: string | null;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..';
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

async function readStrictJson(path: string): Promise<Record<string, unknown> | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error('invalid_file');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
      throw new Error('file_changed_during_read');
    }
    const parsed = JSON.parse(bytes.toString('utf8'));
    const record = object(parsed);
    if (!record) throw new Error('invalid_json_object');
    return record;
  } finally { await handle.close(); }
}

function advisoryRoot(cwd: string, sessionId: string): string {
  if (!safeId(sessionId)) throw new Error('ralplan_advisory_session_id_invalid');
  return join(getBaseStateDir(cwd), 'sessions', sessionId, 'ralplan-advisory');
}

function generationDir(cwd: string, sessionId: string, generationId: string): string {
  if (!safeId(generationId)) throw new Error('ralplan_advisory_generation_id_invalid');
  return join(advisoryRoot(cwd, sessionId), generationId);
}

function activationValid(value: Record<string, unknown>, cwd: string, sessionId: string, generationId: string): boolean {
  return value.schema_version === 1 && value.generation_id === generationId && value.session_id === sessionId
    && value.canonical_cwd === cwd && typeof value.root_thread_id === 'string' && safeId(value.root_thread_id)
    && typeof value.activation_turn_id === 'string' && safeId(value.activation_turn_id)
    && typeof value.created_at === 'string'
    && (value.predecessor_generation_id === undefined || (typeof value.predecessor_generation_id === 'string' && safeId(value.predecessor_generation_id)));
}

function fenceValid(value: Record<string, unknown>, activation: AdvisoryActivation): boolean {
  const states: AdvisoryFenceState[] = ['pending_closeout', 'recovery_required', 'closed', 'abandoned', 'released'];
  return activationValid(value, activation.canonical_cwd, activation.session_id, activation.generation_id)
    && states.includes(value.state as AdvisoryFenceState)
    && typeof value.closing_turn_id === 'string' && safeId(value.closing_turn_id)
    && Number.isSafeInteger(value.iteration) && Number(value.iteration) > 0
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
    && typeof value.updated_at === 'string';
}

const FENCE_INHERITED_FIELDS = [
  'schema_version', 'generation_id', 'predecessor_generation_id', 'canonical_cwd', 'session_id',
  'root_thread_id', 'activation_turn_id', 'created_at', 'closing_turn_id', 'iteration',
  'iteration_id', 'plan_manifest_sha256', 'architect_review_sha256', 'critic_review_sha256',
  'evidence_bundle_sha256',
] as const;

function fenceStateSemanticsValid(fence: AdvisoryFence): boolean {
  if (fence.state === 'pending_closeout') return fence.outcome === undefined && fence.integrity_status === undefined;
  if (fence.state === 'recovery_required') return fence.integrity_status === 'unproven' && fence.outcome !== undefined;
  if (fence.state === 'closed') {
    return fence.outcome === 'approved' && fence.integrity_status === 'proven'
      && [fence.iteration_id, fence.plan_manifest_sha256, fence.architect_review_sha256,
        fence.critic_review_sha256, fence.evidence_bundle_sha256]
        .every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value));
  }
  if (fence.state === 'abandoned') return fence.outcome !== undefined && fence.outcome !== 'approved'
    && (fence.integrity_status === 'proven' || fence.integrity_status === 'unproven');
  return false;
}

function fenceTransitionSemanticsValid(prior: AdvisoryFence, event: AdvisoryFence): boolean {
  if (!FENCE_INHERITED_FIELDS.every((field) => JSON.stringify(event[field]) === JSON.stringify(prior[field]))) return false;
  return fenceStateSemanticsValid(event);
}

function releasedEventValid(
  prior: AdvisoryFence,
  event: AdvisoryFence,
  journal: Record<string, unknown> | null,
): boolean {
  if (!['closed', 'abandoned'].includes(prior.state)) return false;
  if (!FENCE_INHERITED_FIELDS.every((field) => JSON.stringify(event[field]) === JSON.stringify(prior[field]))) return false;
  if (prior.state === 'closed' && !committedJournalMatchesFence(
    journal as AdvisoryJournal | null, prior, true,
  )) return false;
  if (prior.state === 'closed' && !fenceStateSemanticsValid(prior)) return false;
  return event.authority_kind === 'new_root_user_execution_request'
    && typeof event.release_turn_id === 'string' && safeId(event.release_turn_id)
    && typeof event.release_thread_id === 'string' && safeId(event.release_thread_id)
    && typeof event.release_prompt_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(event.release_prompt_sha256)
    && typeof event.requested_lane === 'string' && event.requested_lane.trim().length > 0;
}

function committedJournalMatchesFence(
  journal: AdvisoryJournal | null,
  fence: AdvisoryFence,
  requireCompleteSteps = false,
): boolean {
  return Boolean(journal && journal.phase === 'committed'
    && journal.outcome === fence.outcome
    && journal.integrity_status === fence.integrity_status
    && journal.evidence_bundle_sha256 === fence.evidence_bundle_sha256
    && (!requireCompleteSteps || JOURNAL_STEPS.every((step) => journal.steps[step] === 'applied')));
}

function journalValid(value: Record<string, unknown>, generationId: string): boolean {
  const outcome = ['approved', 'exhausted', 'rejected', 'failed', 'cancelled', 'abandoned'].includes(String(value.outcome));
  const steps = object(value.steps);
  const skillUpdates = value.terminal_skill_updates === undefined ? null : object(value.terminal_skill_updates);
  return value.schema_version === 1 && value.generation_id === generationId && outcome
    && (value.integrity_status === 'proven' || value.integrity_status === 'unproven')
    && (value.phase === 'prepared' || value.phase === 'committed')
    && typeof value.terminal_timestamp === 'string' && Number.isFinite(Date.parse(value.terminal_timestamp))
    && (value.terminal_mode_updates === undefined || object(value.terminal_mode_updates) !== null)
    && (value.terminal_mode_updates === undefined ? value.terminal_skill_updates === undefined : (skillUpdates !== null
      && ['session_skill', 'root_skill'].every((key) => Object.prototype.hasOwnProperty.call(skillUpdates, key)
        && (skillUpdates[key] === null || object(skillUpdates[key]) !== null))))
    && Boolean(steps) && JOURNAL_STEPS.every((step) => steps?.[step] === 'pending' || steps?.[step] === 'applied');
}

function completeLifecycleBinding(lifecycle: AdvisoryReviewLifecycle | undefined): lifecycle is AdvisoryReviewLifecycle {
  return Boolean(lifecycle?.complete === true && lifecycle.sequence_valid === true
    && Number.isSafeInteger(lifecycle.iteration) && lifecycle.iteration > 0
    && [lifecycle.iteration_id, lifecycle.plan_manifest_sha256, lifecycle.architect_review_sha256,
      lifecycle.critic_review_sha256, lifecycle.evidence_bundle_sha256]
      .every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)));
}

async function canonicalCwd(cwd: string): Promise<string> {
  return realpath(cwd);
}

async function acquireAdvisoryLock(lockPath: string, directory: string, heldError: string): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${JSON.stringify({ schema_version: 1, pid: process.pid, created_at: new Date().toISOString() })}\n`);
      await handle.sync();
      await syncDirectory(directory);
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readStrictJson(lockPath).catch(() => null);
      const pid = owner?.schema_version === 1 && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
        ? Number(owner.pid)
        : null;
      if (attempt > 0 || pid === null) throw new Error(heldError);
      try {
        process.kill(pid, 0);
        throw new Error(heldError);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
      }
      await rm(lockPath, { force: false });
      await syncDirectory(directory);
    }
  }
  throw new Error(heldError);
}

async function withCurrentLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lockPath = join(root, 'current.lock');
  const lock = await acquireAdvisoryLock(lockPath, root, 'ralplan_advisory_current_lock_held');
  try { return await work(); }
  finally { await lock.close().catch(() => {}); await rm(lockPath, { force: true }); await syncDirectory(root).catch(() => {}); }
}

export async function withRalplanAdvisoryCurrentLock<T>(
  cwd: string,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  const canonical = await canonicalCwd(cwd);
  return withCurrentLock(advisoryRoot(canonical, sessionId), work);
}

async function withGenerationLock<T>(cwd: string, sessionId: string, generationId: string, work: () => Promise<T>): Promise<T> {
  const dir = generationDir(await canonicalCwd(cwd), sessionId, generationId);
  const lockPath = join(dir, 'generation.lock');
  const lock = await acquireAdvisoryLock(lockPath, dir, 'ralplan_advisory_generation_lock_held');
  try { return await work(); }
  finally { await lock.close().catch(() => {}); await rm(lockPath, { force: true }); await syncDirectory(dir).catch(() => {}); }
}

export async function activateRalplanAdvisory(input: {
  cwd: string; sessionId: string; rootThreadId: string; activationTurnId: string;
  predecessorGenerationId?: string; generationId?: string; nowIso?: string; activationPrompt?: string;
  failpoint?: (name: 'rollover_intent' | 'rollover_activation' | 'rollover_pointer') => void | Promise<void>;
}): Promise<AdvisoryActivation> {
  const cwd = await canonicalCwd(input.cwd);
  if (![input.sessionId, input.rootThreadId, input.activationTurnId].every(safeId)) throw new Error('ralplan_advisory_identity_missing');
  const root = advisoryRoot(cwd, input.sessionId);
  return withCurrentLock(root, async () => {
    const pointerPath = join(root, 'current.json');
    const intentPath = join(root, 'rollover-intent.json');
    let current = await readStrictJson(pointerPath);
    const expectedPredecessor = input.predecessorGenerationId;
    const pendingRaw = await readStrictJson(intentPath);
    if (pendingRaw) {
      throw new Error('ralplan_advisory_rollover_intent_pending_admin');
    }
    if (current && current.generation_id !== expectedPredecessor) throw new Error('ralplan_advisory_current_cas_mismatch');
    if (!current && expectedPredecessor) throw new Error('ralplan_advisory_current_cas_mismatch');
    const generationId = input.generationId ?? randomUUID();
    if (!safeId(generationId)) throw new Error('ralplan_advisory_generation_id_invalid');
    const createdAt = input.nowIso ?? new Date().toISOString();
    {
      const intent: AdvisoryRolloverIntent = {
        schema_version: 1, ...(expectedPredecessor ? { predecessor_generation_id: expectedPredecessor } : {}), generation_id: generationId,
        session_id: input.sessionId, root_thread_id: input.rootThreadId,
        activation_turn_id: input.activationTurnId,
        ...(input.activationPrompt !== undefined ? { activation_prompt_sha256: sha256(input.activationPrompt) } : {}),
        canonical_cwd: cwd, created_at: createdAt,
      };
      await writeExclusive(intentPath, intent);
      await input.failpoint?.('rollover_intent');
    }
    const activation: AdvisoryActivation = {
      schema_version: 1,
      generation_id: generationId,
      ...(expectedPredecessor ? { predecessor_generation_id: expectedPredecessor } : {}),
      canonical_cwd: cwd,
      session_id: input.sessionId,
      root_thread_id: input.rootThreadId,
      activation_turn_id: input.activationTurnId,
      created_at: createdAt,
    };
    const dir = generationDir(cwd, input.sessionId, generationId);
    await mkdir(dir, { recursive: false });
    await writeExclusive(join(dir, 'activation.json'), activation);
    await input.failpoint?.('rollover_activation');
    const pointer: AdvisoryCurrentPointer = {
      schema_version: 1, generation_id: generationId,
      ...(expectedPredecessor ? { predecessor_generation_id: expectedPredecessor } : {}),
      session_id: input.sessionId, canonical_cwd: cwd, updated_at: activation.created_at,
    };
    await writeAtomic(pointerPath, pointer);
    await input.failpoint?.('rollover_pointer');
    await syncDirectory(root);
    return activation;
  });
}

export async function readAuthorizedPendingRalplanActivation(input: {
  cwd: string; sessionId: string; producer: string; threadKind: string;
  rootThreadId: string; activationTurnId: string; prompt: string;
}): Promise<AdvisoryActivation | null> {
  const cwd = await canonicalCwd(input.cwd);
  const pending = await readStrictJson(join(advisoryRoot(cwd, input.sessionId), 'rollover-intent.json'));
  if (!pending) return null;
  const authorized = input.producer === 'native' && input.threadKind === 'root-or-drift'
    && pending.schema_version === 1 && pending.session_id === input.sessionId && pending.canonical_cwd === cwd
    && pending.root_thread_id === input.rootThreadId && pending.activation_turn_id === input.activationTurnId
    && typeof pending.activation_prompt_sha256 === 'string'
    && pending.activation_prompt_sha256 === sha256(input.prompt)
    && typeof pending.generation_id === 'string' && safeId(pending.generation_id)
    && typeof pending.created_at === 'string';
  if (!authorized) throw new Error('ralplan_advisory_pending_activation_authority_mismatch');
  return {
    schema_version: 1, generation_id: String(pending.generation_id),
    ...(typeof pending.predecessor_generation_id === 'string' ? { predecessor_generation_id: pending.predecessor_generation_id } : {}),
    canonical_cwd: cwd, session_id: input.sessionId, root_thread_id: input.rootThreadId,
    activation_turn_id: input.activationTurnId, created_at: String(pending.created_at),
  };
}

async function commitBoundActivationIntent(
  cwd: string,
  sessionId: string,
  pending: Record<string, unknown>,
): Promise<AdvisoryActivation> {
  const root = advisoryRoot(cwd, sessionId);
  return withCurrentLock(root, async () => {
    const intentPath = join(root, 'rollover-intent.json');
    const currentIntent = await readStrictJson(intentPath);
    if (!currentIntent || JSON.stringify(currentIntent) !== JSON.stringify(pending)) {
      throw new Error('ralplan_advisory_rollover_intent_changed');
    }
    const generationId = String(pending.generation_id ?? '');
    const rootThreadId = String(pending.root_thread_id ?? '');
    const activationTurnId = String(pending.activation_turn_id ?? '');
    if (!safeId(generationId) || !safeId(rootThreadId) || !safeId(activationTurnId)
      || pending.schema_version !== 1 || pending.session_id !== sessionId || pending.canonical_cwd !== cwd) {
      throw new Error('ralplan_advisory_rollover_intent_invalid');
    }
    const dir = generationDir(cwd, sessionId, generationId);
    await mkdir(dir, { recursive: true });
    let activationRaw = await readStrictJson(join(dir, 'activation.json'));
    if (!activationRaw) {
      const activation: AdvisoryActivation = {
        schema_version: 1, generation_id: generationId,
        ...(typeof pending.predecessor_generation_id === 'string' ? { predecessor_generation_id: pending.predecessor_generation_id } : {}),
        canonical_cwd: cwd, session_id: sessionId, root_thread_id: rootThreadId,
        activation_turn_id: activationTurnId, created_at: String(pending.created_at ?? ''),
      };
      await writeExclusive(join(dir, 'activation.json'), activation);
      activationRaw = activation as unknown as Record<string, unknown>;
    }
    if (!activationValid(activationRaw, cwd, sessionId, generationId)) throw new Error('ralplan_advisory_rollover_activation_invalid');
    const pointerPath = join(root, 'current.json');
    const current = await readStrictJson(pointerPath);
    const predecessor = typeof pending.predecessor_generation_id === 'string' ? pending.predecessor_generation_id : undefined;
    if (current && current.generation_id !== generationId && current.generation_id !== predecessor) {
      throw new Error('ralplan_advisory_current_cas_mismatch');
    }
    if (!current || current.generation_id !== generationId) {
      await writeAtomic(pointerPath, {
        schema_version: 1, generation_id: generationId, ...(predecessor ? { predecessor_generation_id: predecessor } : {}),
        session_id: sessionId, canonical_cwd: cwd, updated_at: String(pending.created_at ?? ''),
      } satisfies AdvisoryCurrentPointer);
    }
    await rm(intentPath, { force: false });
    await syncDirectory(root);
    return activationRaw as unknown as AdvisoryActivation;
  });
}

async function readProjectionForGeneration(cwdInput: string, sessionId: string, generationId: string): Promise<AdvisoryProjection> {
  const cwd = await canonicalCwd(cwdInput);
  const dir = generationDir(cwd, sessionId, generationId);
  try {
    const canonicalDir = await realpath(dir);
    if (canonicalDir !== dir || relative(advisoryRoot(cwd, sessionId), canonicalDir).startsWith('..')) throw new Error('generation_path_invalid');
  } catch { return { activation: null as never, fence: null, journal: null, denyProductWrites: false, corruption: 'generation_missing_or_untrusted' }; }
  let activationRaw: Record<string, unknown> | null;
  try { activationRaw = await readStrictJson(join(dir, 'activation.json')); }
  catch { return { activation: null as never, fence: null, journal: null, denyProductWrites: false, corruption: 'activation_corrupt' }; }
  if (!activationRaw || !activationValid(activationRaw, cwd, sessionId, generationId)) {
    return { activation: null as never, fence: null, journal: null, denyProductWrites: false, corruption: 'activation_invalid' };
  }
  const activation = activationRaw as unknown as AdvisoryActivation;
  let base: Record<string, unknown> | null;
  let journalRaw: Record<string, unknown> | null;
  try {
    base = await readStrictJson(join(dir, 'fence.json'));
    journalRaw = await readStrictJson(join(dir, 'closeout-journal.json'));
  } catch {
    return { activation, fence: null, journal: null, denyProductWrites: false, corruption: 'fence_or_journal_corrupt' };
  }
  let fence = base ? base as unknown as AdvisoryFence : null;
  if (fence && !fenceValid(base!, activation)) return { activation, fence: null, journal: null, denyProductWrites: false, corruption: 'fence_invalid' };
  if (fence && (fence.state !== 'pending_closeout' || !fenceStateSemanticsValid(fence)
    || fence.sequence !== 0 || fence.previous_event_sha256 !== undefined
    || base?.release_turn_id !== undefined || base?.release_thread_id !== undefined || base?.authority_kind !== undefined)) {
    return { activation, fence: null, journal: null, denyProductWrites: false, corruption: 'fence_base_semantics_invalid' };
  }
  let sequence = fence?.sequence ?? -1;
  let priorDigest = fence ? sha256(`${JSON.stringify(fence)}\n`) : undefined;
  let abandonedPredecessorBytes: Buffer | null = null;
  let releaseSeen = false;
  for (let index = 1; ; index += 1) {
    let event: Record<string, unknown> | null;
    try { event = await readStrictJson(join(dir, `fence-event-${String(index).padStart(4, '0')}.json`)); }
    catch { return { activation, fence, journal: null, denyProductWrites: false, corruption: 'fence_event_corrupt' }; }
    if (!event) break;
    if (event.state === 'released') {
      if (!fence || !fenceValid(event, activation) || event.sequence !== sequence + 1
        || event.previous_event_sha256 !== priorDigest
        || !releasedEventValid(fence, event as unknown as AdvisoryFence, journalRaw)) {
        return { activation, fence, journal: null, denyProductWrites: true, corruption: 'fence_event_chain_invalid' };
      }
      // Valid release records are historical and inert in the non-authoritative
      // projection. Keep the terminal predecessor as the planning result.
      releaseSeen = true;
      break;
    }
    if (event.state === 'abandoned') {
      const predecessorPath = index === 1 ? join(dir, 'fence.json') : join(dir, `fence-event-${String(index - 1).padStart(4, '0')}.json`);
      abandonedPredecessorBytes = await readFile(predecessorPath).catch(() => null);
    }
    if (!fence || !fenceValid(event, activation) || event.sequence !== sequence + 1 || event.previous_event_sha256 !== priorDigest
      || !transitionAllowed(fence.state, event.state as AdvisoryFenceState)
      || !fenceTransitionSemanticsValid(fence, event as unknown as AdvisoryFence)) {
      return { activation, fence, journal: null, denyProductWrites: false, corruption: 'fence_event_chain_invalid' };
    }
    fence = event as unknown as AdvisoryFence;
    sequence = fence.sequence;
    priorDigest = sha256(`${JSON.stringify(fence)}\n`);
  }
  if (releaseSeen) {
    let trailing: Record<string, unknown> | null;
    try { trailing = await readStrictJson(join(dir, `fence-event-${String(sequence + 1).padStart(4, '0')}.json`)); }
    catch { return { activation, fence, journal: null, denyProductWrites: true, corruption: 'fence_event_chain_invalid' }; }
    if (trailing) return { activation, fence, journal: null, denyProductWrites: true, corruption: 'fence_event_chain_invalid' };
  }
  const journal = journalRaw && journalValid(journalRaw, generationId) ? journalRaw as unknown as AdvisoryJournal : null;
  if (journalRaw && !journal) return { activation, fence, journal: null, denyProductWrites: false, corruption: 'journal_invalid' };
  let adminRaw: Record<string, unknown> | null;
  try { adminRaw = await readStrictJson(join(dir, 'admin-event-0001.json')); }
  catch { return { activation, fence, journal, denyProductWrites: false, corruption: 'admin_event_corrupt' }; }
  const adminEvent = adminRaw as unknown as AdvisoryAdminEvent | null;
  const terminalFence = fence;
  const priorFenceBytes = adminRaw ? abandonedPredecessorBytes : null;
  const journalBytes = adminRaw && journal ? await readFile(join(dir, 'closeout-journal.json')).catch(() => null) : null;
  if (adminRaw && (adminRaw.schema_version !== 1 || adminRaw.action !== 'abandon'
    || adminRaw.generation_id !== generationId || adminRaw.session_id !== sessionId
    || typeof adminRaw.root_thread_id !== 'string' || !safeId(adminRaw.root_thread_id)
    || typeof adminRaw.turn_id !== 'string' || !safeId(adminRaw.turn_id)
    || typeof adminRaw.created_at !== 'string' || typeof adminRaw.prior_fence_sha256 !== 'string'
    || (adminRaw.prior_journal_sha256 !== undefined && typeof adminRaw.prior_journal_sha256 !== 'string')
    || !['abandoned', 'released'].includes(String(terminalFence?.state)) || !priorFenceBytes || sha256(priorFenceBytes) !== adminRaw.prior_fence_sha256
    || (journalBytes ? sha256(journalBytes) : undefined) !== adminRaw.prior_journal_sha256)) {
    return { activation, fence, journal, admin_event: null, denyProductWrites: false, corruption: 'admin_event_invalid' };
  }
  if (terminalFence?.state === 'closed' && !committedJournalMatchesFence(journal, terminalFence)) {
    return { activation, fence, journal, denyProductWrites: false, corruption: 'closed_without_committed_journal' };
  }
  if (terminalFence?.state === 'closed' && (terminalFence.outcome !== 'approved' || terminalFence.integrity_status !== 'proven'
    || journal?.outcome !== 'approved' || journal.integrity_status !== 'proven'
    || !terminalFence.iteration_id || !terminalFence.plan_manifest_sha256 || !terminalFence.architect_review_sha256
    || !terminalFence.critic_review_sha256 || !terminalFence.evidence_bundle_sha256
    || journal.evidence_bundle_sha256 !== terminalFence.evidence_bundle_sha256)) {
    return { activation, fence, journal, admin_event: adminEvent, denyProductWrites: false, corruption: 'approved_proven_binding_invalid' };
  }
  if (terminalFence?.state === 'abandoned'
    && !committedJournalMatchesFence(journal, terminalFence)
    && !adminEvent) {
    return { activation, fence, journal, admin_event: null, denyProductWrites: false, corruption: 'abandoned_without_matching_journal_or_admin_event' };
  }
  return { activation, fence, journal, admin_event: adminEvent, denyProductWrites: false, corruption: null };
}

export async function readCurrentRalplanAdvisory(cwdInput: string, sessionId: string): Promise<AdvisoryProjection | null> {
  const cwd = await canonicalCwd(cwdInput);
  const root = advisoryRoot(cwd, sessionId);
  let current: Record<string, unknown> | null;
  try { current = await readStrictJson(join(root, 'current.json')); }
  catch { return { activation: null as never, fence: null, journal: null, denyProductWrites: false, corruption: 'current_corrupt' }; }
  if (!current) {
    try {
      const rootStat = await stat(root);
      if (rootStat.isDirectory()) return { activation: null as never, fence: null, journal: null, denyProductWrites: false, corruption: 'current_missing_with_advisory_state' };
      return { activation: null as never, fence: null, journal: null, denyProductWrites: false, corruption: 'advisory_root_not_directory' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { activation: null as never, fence: null, journal: null, denyProductWrites: false, corruption: 'current_state_stat_failed' };
      }
    }
    return null;
  }
  if (current.schema_version !== 1 || current.session_id !== sessionId || current.canonical_cwd !== cwd
    || typeof current.generation_id !== 'string' || !safeId(current.generation_id)) {
    return { activation: null as never, fence: null, journal: null, denyProductWrites: false, corruption: 'current_invalid' };
  }
  const projection = await readProjectionForGeneration(cwd, sessionId, current.generation_id);
  const pendingRollover = await readStrictJson(join(root, 'rollover-intent.json')).catch(() => ({ invalid: true }));
  if (pendingRollover) {
    return { ...projection, denyProductWrites: false, corruption: 'rollover_pending_admin' };
  }
  if (projection.activation?.generation_id) {
    let bound: Record<string, unknown> | null;
    try {
      bound = await readStrictJson(join(getBaseStateDir(cwd), 'sessions', sessionId, 'ralplan-state.json'));
    } catch {
      return { ...projection, denyProductWrites: false, corruption: 'generation_mode_binding_corrupt' };
    }
    const canonicalBinding = Boolean(bound && bound.mode === 'ralplan' && bound.session_id === sessionId
      && bound.workflow_variant === 'advisory' && bound.advisory_generation_id === projection.activation.generation_id);
    const hasAdvisoryMarkers = Boolean(bound && (
      bound.workflow_variant === 'advisory'
      || Object.prototype.hasOwnProperty.call(bound, 'advisory_generation_id')
      || Object.prototype.hasOwnProperty.call(bound, 'execution_handoff_authorized')
      || Object.prototype.hasOwnProperty.call(bound, 'host_verified')
    ));
    const genuineStandardRalplan = Boolean(bound && bound.mode === 'ralplan' && bound.session_id === sessionId && !hasAdvisoryMarkers);
    if (projection.fence && ['closed', 'abandoned', 'recovery_required', 'released'].includes(projection.fence.state)) {
      if (hasAdvisoryMarkers && !canonicalBinding) {
        return { ...projection, denyProductWrites: true, corruption: 'generation_mode_binding_missing' };
      }
      if (bound?.workflow_variant === 'advisory' && bound.active === false) {
        const inactiveError = validateAdvisoryInactiveState(bound, projection);
        if (inactiveError) return { ...projection, denyProductWrites: true, corruption: inactiveError };
      }
      if (genuineStandardRalplan || canonicalBinding) return projection;
    }
    const publicationState = genuineStandardRalplan && bound?.active === true;
    if (!projection.fence && !canonicalBinding && !publicationState) {
      return { ...projection, denyProductWrites: false, corruption: 'inactive_without_closeout' };
    }
    if (projection.fence && !canonicalBinding) {
      return { ...projection, denyProductWrites: false, corruption: 'generation_mode_binding_missing' };
    }
  }
  return projection;
}

function transitionAllowed(from: AdvisoryFenceState, to: AdvisoryFenceState): boolean {
  return (from === 'pending_closeout' && ['recovery_required', 'closed', 'abandoned'].includes(to))
    || (from === 'recovery_required' && to === 'abandoned')
    || (from === 'closed' && to === 'abandoned');
}

async function appendFenceEvent(cwd: string, fence: AdvisoryFence, next: Omit<AdvisoryFence, keyof AdvisoryActivation | 'sequence' | 'previous_event_sha256'>): Promise<AdvisoryFence> {
  if (!transitionAllowed(fence.state, next.state)) throw new Error('ralplan_advisory_fence_transition_invalid');
  const dir = generationDir(cwd, fence.session_id, fence.generation_id);
  const event: AdvisoryFence = {
    ...fence, ...next,
    sequence: fence.sequence + 1,
    previous_event_sha256: sha256(`${JSON.stringify(fence)}\n`),
  };
  await writeExclusive(join(dir, `fence-event-${String(event.sequence).padStart(4, '0')}.json`), event);
  return event;
}

export async function prepareAdvisoryCloseout(input: {
  cwd: string; sessionId: string; generationId: string; closingTurnId: string;
  iteration: number; lifecycle?: AdvisoryReviewLifecycle; nowIso?: string;
  beforeMutation?: (checkpoint: string) => void | Promise<void>;
}): Promise<AdvisoryFence> {
  const projection = await readProjectionForGeneration(input.cwd, input.sessionId, input.generationId);
  if (projection.corruption) throw new Error(`ralplan_advisory_${projection.corruption}`);
  if (projection.fence) {
    if (projection.fence.closing_turn_id !== input.closingTurnId) throw new Error('ralplan_advisory_closeout_turn_mismatch');
    if (projection.fence.iteration !== input.iteration
      || projection.fence.evidence_bundle_sha256 !== input.lifecycle?.evidence_bundle_sha256
      || projection.fence.iteration_id !== input.lifecycle?.iteration_id
      || projection.fence.plan_manifest_sha256 !== input.lifecycle?.plan_manifest_sha256
      || projection.fence.architect_review_sha256 !== input.lifecycle?.architect_review_sha256
      || projection.fence.critic_review_sha256 !== input.lifecycle?.critic_review_sha256) {
      throw new Error('ralplan_advisory_closeout_binding_mismatch');
    }
    return projection.fence;
  }
  const fence: AdvisoryFence = {
    ...projection.activation,
    state: 'pending_closeout',
    closing_turn_id: input.closingTurnId,
    iteration: input.iteration,
    ...(input.lifecycle ? {
      iteration_id: input.lifecycle.iteration_id,
      plan_manifest_sha256: input.lifecycle.plan_manifest_sha256,
      architect_review_sha256: input.lifecycle.architect_review_sha256,
      critic_review_sha256: input.lifecycle.critic_review_sha256,
      evidence_bundle_sha256: input.lifecycle.evidence_bundle_sha256,
    } : {}),
    updated_at: input.nowIso ?? new Date().toISOString(),
    sequence: 0,
  };
  const fencePath = join(generationDir(projection.activation.canonical_cwd, input.sessionId, input.generationId), 'fence.json');
  await input.beforeMutation?.('fence_create');
  await writeExclusive(fencePath, fence);
  await emitAdvisoryEvent(projection.activation.canonical_cwd, {
    type: 'ralplan_advisory_fence_created', generationId: input.generationId, iteration: input.iteration,
    transition: 'active->pending_closeout', checkpoint: 'fence_create', reason: 'closeout_started',
    path: fencePath, digest: input.lifecycle?.evidence_bundle_sha256,
  });
  return fence;
}

function terminalState(outcome: AdvisoryOutcome, integrity: AdvisoryIntegrityStatus): AdvisoryFenceState {
  if (integrity === 'unproven') return 'recovery_required';
  return outcome === 'approved' ? 'closed' : 'abandoned';
}

function newJournal(
  generationId: string,
  outcome: AdvisoryOutcome,
  integrity: AdvisoryIntegrityStatus,
  evidenceDigest: string | undefined,
  terminalModeUpdates: Record<string, unknown> | undefined,
  terminalSkillUpdates: AdvisoryJournal['terminal_skill_updates'],
  now: string,
): AdvisoryJournal {
  return {
    schema_version: 1, generation_id: generationId, outcome, integrity_status: integrity,
    ...(evidenceDigest ? { evidence_bundle_sha256: evidenceDigest } : {}),
    ...(terminalModeUpdates ? { terminal_mode_updates: terminalModeUpdates } : {}),
    ...(terminalSkillUpdates ? { terminal_skill_updates: terminalSkillUpdates } : {}),
    terminal_timestamp: now,
    phase: 'prepared', created_at: now, updated_at: now,
    steps: Object.fromEntries(JOURNAL_STEPS.map((step) => [step, 'pending'])) as Record<JournalStep, 'pending' | 'applied'>,
  };
}

export interface TerminalizeAdvisoryOptions {
  cwd: string; sessionId: string; generationId: string; closingTurnId: string; iteration: number;
  outcome: AdvisoryOutcome; integrityStatus: AdvisoryIntegrityStatus; lifecycle?: AdvisoryReviewLifecycle;
  applyStep?: (
    step: Exclude<JournalStep, 'post_digest' | 'journal_commit' | 'fence_terminal'>,
    storedPatch: Record<string, unknown> | undefined,
    storedTimestamp: string,
  ) => Promise<void>;
  terminalModeUpdates?: Record<string, unknown>;
  revalidateEvidence?: () => Promise<string | undefined>;
  failpoint?: (name: string) => void | Promise<void>;
  beforeMutation?: (checkpoint: string) => void | Promise<void>;
  nowIso?: string;
}

async function terminalizeRalplanAdvisoryUnlocked(options: TerminalizeAdvisoryOptions): Promise<AdvisoryProjection> {
  const now = options.nowIso ?? new Date().toISOString();
  const currentBinding = await readStrictJson(join(
    getBaseStateDir(await canonicalCwd(options.cwd)), 'sessions', options.sessionId, 'ralplan-state.json',
  ));
  if (!currentBinding || currentBinding.workflow_variant !== 'advisory'
    || currentBinding.advisory_generation_id !== options.generationId) {
    throw new Error('ralplan_advisory_current_generation_changed');
  }
  if (options.outcome === 'approved' && options.integrityStatus === 'proven'
    && (!completeLifecycleBinding(options.lifecycle) || !options.revalidateEvidence)) {
    throw new Error('ralplan_advisory_approved_proven_requires_complete_lifecycle_and_revalidation');
  }
  await options.failpoint?.('before-fence-create');
  let fence = await prepareAdvisoryCloseout({ ...options, lifecycle: options.lifecycle, nowIso: now });
  await options.failpoint?.('after-fence-create');
  const dir = generationDir(fence.canonical_cwd, options.sessionId, options.generationId);
  const journalPath = join(dir, 'closeout-journal.json');
  let journalRaw = await readStrictJson(journalPath);
  let journal: AdvisoryJournal;
  if (journalRaw) {
    if (!journalValid(journalRaw, options.generationId)) throw new Error('ralplan_advisory_journal_invalid');
    journal = journalRaw as unknown as AdvisoryJournal;
    if (journal.evidence_bundle_sha256 !== options.lifecycle?.evidence_bundle_sha256) {
      throw new Error('ralplan_advisory_journal_binding_mismatch');
    }
  } else {
    let terminalSkillUpdates: AdvisoryJournal['terminal_skill_updates'];
    if (options.terminalModeUpdates) {
      const base = getBaseStateDir(fence.canonical_cwd);
      const [currentMode, rootSkillState, sessionSkillState] = await Promise.all([
        readStrictJson(join(base, 'sessions', options.sessionId, 'ralplan-state.json')),
        readStrictJson(join(base, 'skill-active-state.json')),
        readStrictJson(join(base, 'sessions', options.sessionId, 'skill-active-state.json')),
      ]);
      const { projectRalplanTerminalSkillMirrors } = await import('../state/operations.js');
      terminalSkillUpdates = projectRalplanTerminalSkillMirrors({
        rootSkillState, sessionSkillState,
        terminalState: { ...(currentMode ?? {}), ...options.terminalModeUpdates },
        sessionId: options.sessionId, nowIso: now,
      });
    }
    journal = newJournal(
      options.generationId, options.outcome, options.integrityStatus,
      options.lifecycle?.evidence_bundle_sha256, options.terminalModeUpdates, terminalSkillUpdates, now,
    );
    await options.beforeMutation?.('journal_prepare');
    await writeAtomic(journalPath, journal);
  }
  await options.failpoint?.('journal-prepare');
  const mark = async (step: JournalStep) => {
    journal.steps[step] = 'applied'; journal.updated_at = new Date().toISOString();
    await options.beforeMutation?.(`journal_step_${step}`);
    await writeAtomic(journalPath, journal);
    await emitAdvisoryEvent(fence.canonical_cwd, {
      type: 'ralplan_advisory_closeout_step', generationId: fence.generation_id, iteration: fence.iteration,
      transition: 'pending->applied', checkpoint: step, reason: 'closeout_checkpoint_applied',
      path: journalPath, digest: journal.evidence_bundle_sha256,
    });
    await options.failpoint?.(step);
  };
  for (const step of ['session_mode', 'root_mode', 'session_skill', 'root_skill'] as const) {
    const expectedSkill = step === 'session_skill' || step === 'root_skill'
      ? journal.terminal_skill_updates?.[step]
      : undefined;
    if (journal.steps[step] === 'applied'
      && await closeoutStepPostcondition(fence.canonical_cwd, options.sessionId, step, journal.terminal_mode_updates, expectedSkill)) continue;
    if ((step === 'session_skill' || step === 'root_skill') && expectedSkill !== undefined) {
      await options.beforeMutation?.(`mirror_${step}`);
      const base = getBaseStateDir(fence.canonical_cwd);
      const path = step === 'session_skill'
        ? join(base, 'sessions', options.sessionId, 'skill-active-state.json')
        : join(base, 'skill-active-state.json');
      if (expectedSkill === null) await rm(path, { force: true });
      else await writeAtomic(path, expectedSkill);
    } else {
      await options.beforeMutation?.(`mirror_${step}`);
      await options.applyStep?.(step, journal.terminal_mode_updates, journal.terminal_timestamp);
    }
    if (!await closeoutStepPostcondition(fence.canonical_cwd, options.sessionId, step, journal.terminal_mode_updates, expectedSkill)) {
      throw new Error(`ralplan_advisory_${step}_postcondition_failed`);
    }
    await mark(step);
  }
  if (journal.steps.post_digest !== 'applied') {
    const digest = await options.revalidateEvidence?.();
    if (options.lifecycle && digest !== options.lifecycle.evidence_bundle_sha256) {
      await options.beforeMutation?.('fence_recovery_required');
      await emitAdvisoryEvent(fence.canonical_cwd, {
        type: 'ralplan_advisory_digest_mismatch', generationId: fence.generation_id, iteration: fence.iteration,
        transition: `${fence.state}->recovery_required`, checkpoint: 'post_digest', reason: 'evidence_digest_changed',
        path: journalPath, digest: digest ?? options.lifecycle.evidence_bundle_sha256,
      });
      fence = await appendFenceEvent(fence.canonical_cwd, fence, {
        state: 'recovery_required', closing_turn_id: fence.closing_turn_id, iteration: fence.iteration,
        outcome: journal.outcome, integrity_status: 'unproven', updated_at: journal.terminal_timestamp,
      });
      return readProjectionForGeneration(fence.canonical_cwd, options.sessionId, options.generationId);
    }
    await mark('post_digest');
  }
  if (journal.steps.journal_commit !== 'applied') {
    journal.steps.journal_commit = 'applied'; journal.phase = 'committed'; journal.updated_at = new Date().toISOString();
    await options.beforeMutation?.('journal_commit');
    await writeAtomic(journalPath, journal);
    await emitAdvisoryEvent(fence.canonical_cwd, {
      type: 'ralplan_advisory_closeout_committed', generationId: fence.generation_id, iteration: fence.iteration,
      transition: 'prepared->committed', checkpoint: 'journal_commit', reason: 'all_closeout_postconditions_satisfied',
      path: journalPath, digest: journal.evidence_bundle_sha256,
    });
    await options.failpoint?.('journal_commit');
  }
  if (journal.steps.fence_terminal !== 'applied') {
    const targetState = terminalState(journal.outcome, journal.integrity_status);
    if (fence.state !== targetState) {
      const priorState = fence.state;
      await options.beforeMutation?.('fence_terminal');
      fence = await appendFenceEvent(fence.canonical_cwd, fence, {
        state: targetState, closing_turn_id: fence.closing_turn_id,
        iteration: fence.iteration, outcome: journal.outcome, integrity_status: journal.integrity_status,
        updated_at: journal.terminal_timestamp,
      });
      await emitAdvisoryEvent(fence.canonical_cwd, {
        type: 'ralplan_advisory_fence_closed', generationId: fence.generation_id, iteration: fence.iteration,
        transition: `${priorState}->${targetState}`, checkpoint: 'fence_terminal', reason: `closeout_${journal.outcome}`,
        path: join(dir, `fence-event-${String(fence.sequence).padStart(4, '0')}.json`), digest: journal.evidence_bundle_sha256,
      });
    }
    journal.steps.fence_terminal = 'applied'; journal.updated_at = new Date().toISOString();
    await options.beforeMutation?.('journal_fence_terminal');
    await writeAtomic(journalPath, journal); await options.failpoint?.('fence_terminal');
  }
  return readProjectionForGeneration(fence.canonical_cwd, options.sessionId, options.generationId);
}

export async function terminalizeRalplanAdvisory(options: TerminalizeAdvisoryOptions): Promise<AdvisoryProjection> {
  return withRalplanAdvisoryCurrentLock(options.cwd, options.sessionId, () =>
    withGenerationLock(options.cwd, options.sessionId, options.generationId, () => terminalizeRalplanAdvisoryUnlocked(options)));
}

/** Replays the stored terminal mode patch after a crash, then completes the
 * journal/fence tail. Every checkpoint is persisted before advancing. */
class AdvisoryLiveBindingConflictError extends Error {
  constructor(readonly diagnostic: string) {
    super(diagnostic);
  }
}

async function liveAdvisoryBindingConflict(
  cwd: string,
  sessionId: string,
  generationId: string,
): Promise<string | null> {
  let binding: Record<string, unknown> | null;
  try {
    binding = await readStrictJson(join(getBaseStateDir(cwd), 'sessions', sessionId, 'ralplan-state.json'));
  } catch {
    return 'live_session_binding_unreadable';
  }
  return binding?.active === true
    && (binding.workflow_variant !== 'advisory' || binding.advisory_generation_id !== generationId)
    ? 'live_session_binding_conflict'
    : null;
}

async function reconcileRalplanAdvisoryUnlocked(
  cwd: string,
  sessionId: string,
  beforeReplayCheck?: (checkpoint: string) => void | Promise<void>,
): Promise<AdvisoryProjection | null> {
  const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
  if (!projection || projection.corruption || !projection.fence || !projection.journal) return projection;
  const { fence, journal } = projection;
  if (fence.state === 'recovery_required') return projection;
  const guardReplay = async (checkpoint: string): Promise<void> => {
    await beforeReplayCheck?.(checkpoint);
    const conflict = await liveAdvisoryBindingConflict(cwd, sessionId, fence.generation_id);
    if (conflict) throw new AdvisoryLiveBindingConflictError(conflict);
  };
  const immutableAdminRecovery = Boolean(projection.admin_event);
  const journalPath = join(generationDir(fence.canonical_cwd, sessionId, fence.generation_id), 'closeout-journal.json');
  let reconciled = false;
  const emitReconciled = async (reason: string): Promise<void> => {
    if (!reconciled) return;
    await guardReplay('emit_reconciled');
    await emitAdvisoryEvent(fence.canonical_cwd, {
      type: 'ralplan_advisory_closeout_reconciled', generationId: fence.generation_id, iteration: fence.iteration,
      transition: `${fence.state}->${fence.state}`, checkpoint: 'reconcile', reason,
      path: journalPath, digest: journal.evidence_bundle_sha256,
    });
  };
  const mark = async (step: JournalStep): Promise<void> => {
    journal.steps[step] = 'applied';
    journal.updated_at = new Date().toISOString();
    await guardReplay(`journal_step_${step}`);
    await writeAtomic(journalPath, journal);
    reconciled = true;
    await guardReplay(`emit_step_${step}`);
    await emitAdvisoryEvent(fence.canonical_cwd, {
      type: 'ralplan_advisory_closeout_step', generationId: fence.generation_id, iteration: fence.iteration,
      transition: 'pending->applied', checkpoint: step, reason: 'reconciled_checkpoint',
      path: journalPath, digest: journal.evidence_bundle_sha256,
    });
  };
  if (journal.terminal_mode_updates) {
    const canonicalPatch = async (): Promise<void> => {
      const { updateModeState } = await import('../modes/base.js');
      await updateModeState(
        'ralplan',
        journal.terminal_mode_updates!,
        cwd,
        sessionId,
        (site) => guardReplay(`mode_commit_${site}`),
      );
    };
    for (const step of ['session_mode', 'root_mode', 'session_skill', 'root_skill'] as const) {
      const expectedSkill = step === 'session_skill' || step === 'root_skill'
        ? journal.terminal_skill_updates?.[step]
        : undefined;
      if (!await closeoutStepPostcondition(cwd, sessionId, step, journal.terminal_mode_updates, expectedSkill)) {
        reconciled = true;
        if ((step === 'session_skill' || step === 'root_skill') && expectedSkill !== undefined) {
          const base = getBaseStateDir(cwd);
          const path = step === 'session_skill'
            ? join(base, 'sessions', sessionId, 'skill-active-state.json')
            : join(base, 'skill-active-state.json');
          await guardReplay(`mirror_${step}`);
          if (expectedSkill === null) await rm(path, { force: true });
          else await writeAtomic(path, expectedSkill);
        } else {
          await guardReplay(`mirror_${step}`);
          await canonicalPatch();
        }
      }
      if (!await closeoutStepPostcondition(cwd, sessionId, step, journal.terminal_mode_updates, expectedSkill)) {
        throw new Error(`ralplan_advisory_reconcile_${step}_postcondition_failed`);
      }
      if (!immutableAdminRecovery && journal.steps[step] !== 'applied') await mark(step);
    }
    if (immutableAdminRecovery) {
      await emitReconciled('admin_recovery_mirrors_repaired');
      return readCurrentRalplanAdvisory(cwd, sessionId);
    }
    if (journal.steps.post_digest !== 'applied') {
      if (fence.evidence_bundle_sha256) {
        const { readModeStateForExplicitSession } = await import('../modes/base.js');
        const state = await readModeStateForExplicitSession('ralplan', sessionId, cwd);
        const history = Array.isArray(state?.review_history) ? state.review_history : [];
        const item = object(history[fence.iteration - 1]);
        const draft = object(item?.draft);
        const architect = object(item?.architect_review);
        const critic = object(item?.critic_review);
        const lifecycle = await projectAdvisoryReviewLifecycle({
          cwd, sessionId, generationId: fence.generation_id,
          activationTurnId: fence.activation_turn_id, activationCreatedAt: fence.created_at,
          rootThreadId: fence.root_thread_id, iteration: fence.iteration,
          planPaths: [String(draft?.planPath ?? state?.latest_plan_path ?? '')],
          architect: {
            threadId: String(architect?.thread_id ?? ''), artifactPath: String(architect?.artifact_path ?? ''),
            verdict: String(architect?.verdict ?? ''), sessionId: typeof architect?.session_id === 'string' ? architect.session_id : undefined,
          },
          critic: {
            threadId: String(critic?.thread_id ?? ''), artifactPath: String(critic?.artifact_path ?? ''),
            verdict: String(critic?.verdict ?? ''), sessionId: typeof critic?.session_id === 'string' ? critic.session_id : undefined,
          },
        });
        if (lifecycle.evidence_bundle_sha256 !== fence.evidence_bundle_sha256) {
          await guardReplay('emit_digest_mismatch');
          await emitAdvisoryEvent(fence.canonical_cwd, {
            type: 'ralplan_advisory_digest_mismatch', generationId: fence.generation_id, iteration: fence.iteration,
            transition: `${fence.state}->recovery_required`, checkpoint: 'post_digest', reason: 'reconcile_evidence_digest_changed',
            path: journalPath, digest: lifecycle.evidence_bundle_sha256,
          });
          await guardReplay('fence_recovery_required');
          await appendFenceEvent(fence.canonical_cwd, fence, {
            state: 'recovery_required', closing_turn_id: fence.closing_turn_id, iteration: fence.iteration,
            outcome: journal.outcome, integrity_status: 'unproven', updated_at: new Date().toISOString(),
          });
          return readCurrentRalplanAdvisory(cwd, sessionId);
        }
      }
      await mark('post_digest');
    }
  }
  if (immutableAdminRecovery) {
    await emitReconciled('admin_recovery_preserved');
    return readCurrentRalplanAdvisory(cwd, sessionId);
  }
  const prerequisiteSteps: JournalStep[] = ['session_mode', 'root_mode', 'session_skill', 'root_skill', 'post_digest'];
  if (!prerequisiteSteps.every((step) => journal.steps[step] === 'applied')) {
    await emitReconciled('partial_closeout_replay');
    return readCurrentRalplanAdvisory(cwd, sessionId);
  }
  if (journal.phase !== 'committed') {
    journal.phase = 'committed';
    journal.steps.journal_commit = 'applied';
    journal.updated_at = new Date().toISOString();
    await guardReplay('journal_commit');
    await writeAtomic(journalPath, journal);
    reconciled = true;
    await guardReplay('emit_journal_commit');
    await emitAdvisoryEvent(fence.canonical_cwd, {
      type: 'ralplan_advisory_closeout_committed', generationId: fence.generation_id, iteration: fence.iteration,
      transition: 'prepared->committed', checkpoint: 'journal_commit', reason: 'reconciled_closeout_commit',
      path: journalPath, digest: journal.evidence_bundle_sha256,
    });
  }
  const target = terminalState(journal.outcome, journal.integrity_status);
  if (fence.state !== target) {
    await guardReplay('fence_terminal');
    const terminalFence = await appendFenceEvent(fence.canonical_cwd, fence, {
      state: target, closing_turn_id: fence.closing_turn_id, iteration: fence.iteration,
      outcome: journal.outcome, integrity_status: journal.integrity_status, updated_at: journal.terminal_timestamp,
    });
    reconciled = true;
    await guardReplay('emit_fence_terminal');
    await emitAdvisoryEvent(fence.canonical_cwd, {
      type: 'ralplan_advisory_fence_closed', generationId: fence.generation_id, iteration: fence.iteration,
      transition: `${fence.state}->${target}`, checkpoint: 'fence_terminal', reason: 'reconciled_terminal_fence',
      path: join(dirname(journalPath), `fence-event-${String(terminalFence.sequence).padStart(4, '0')}.json`), digest: journal.evidence_bundle_sha256,
    });
  }
  if (journal.steps.fence_terminal !== 'applied') {
    journal.steps.fence_terminal = 'applied';
    journal.updated_at = new Date().toISOString();
    await guardReplay('journal_fence_terminal');
    await writeAtomic(journalPath, journal);
    reconciled = true;
  }
  await emitReconciled('stored_closeout_replayed');
  return readCurrentRalplanAdvisory(cwd, sessionId);
}

export async function reconcileRalplanAdvisory(
  cwd: string,
  sessionId: string,
  authority?: {
    producer: string; threadKind: string; rootThreadId: string; activationTurnId: string;
    beforeReplayCheck?: (checkpoint: string) => void | Promise<void>;
  },
): Promise<AdvisoryProjection | null> {
  const cwdCanonical = await canonicalCwd(cwd);
  const root = advisoryRoot(cwdCanonical, sessionId);
  const pending = await readStrictJson(join(root, 'rollover-intent.json')).catch(() => null);
  if (pending) {
    const authenticated = authority?.producer === 'native' && authority.threadKind === 'root-or-drift'
      && authority.rootThreadId === pending.root_thread_id
      && authority.activationTurnId === pending.activation_turn_id;
    if (!authenticated) return readCurrentRalplanAdvisory(cwdCanonical, sessionId);
    const bound = await readStrictJson(join(getBaseStateDir(cwdCanonical), 'sessions', sessionId, 'ralplan-state.json')).catch(() => null);
    if (!bound || bound.active !== true || bound.workflow_variant !== 'advisory'
      || bound.advisory_generation_id !== pending.generation_id) {
      return readCurrentRalplanAdvisory(cwdCanonical, sessionId);
    }
    await commitBoundActivationIntent(cwdCanonical, sessionId, pending);
  }
  const projection = await readCurrentRalplanAdvisory(cwdCanonical, sessionId);
  if (!projection?.activation?.generation_id) return projection;
  const initialConflict = await liveAdvisoryBindingConflict(cwdCanonical, sessionId, projection.activation.generation_id);
  if (initialConflict) return { ...projection, corruption: initialConflict };
  if (projection.corruption) return projection;
  return withGenerationLock(cwd, sessionId, projection.activation.generation_id, async () => {
    const conflict = await liveAdvisoryBindingConflict(cwdCanonical, sessionId, projection.activation.generation_id);
    if (conflict) return { ...projection, corruption: conflict };
    try {
      return await reconcileRalplanAdvisoryUnlocked(cwd, sessionId, authority?.beforeReplayCheck);
    } catch (error) {
      if (error instanceof AdvisoryLiveBindingConflictError) {
        const current = await readCurrentRalplanAdvisory(cwdCanonical, sessionId) ?? projection;
        return { ...current, corruption: error.diagnostic };
      }
      throw error;
    }
  });
}

const EXECUTION_VERBS = /\b(?:implement(?:á|a|e|ar)?|fix(?:e|ear|á)?|correg(?:í|ir|i)|ejecut(?:á|a|e|ar)|corr(?:é|e|er)|build|ship|deploy|aplic(?:á|a|ar)|cre(?:á|a|ar))\b/iu;
const EXECUTION_ANCHOR = /(?:\b(?:issue|bug|test|tests|command|comando|task|tarea|plan|prd|spec|archivo|file|path|ruta)\b\s*(?:#?\w+|[.:/-])|(?:^|\s)(?:\.\.?\/|\/)[^\s]+|`[^`]+`|#[0-9]+)/iu;
const QUESTION = /\?|\b(?:qué|como|cómo|cuál|cual|por qué|porqué|status|estado|explic(?:á|a)|revis(?:á|a)|opin(?:á|a))\b/iu;
const FUTURE_OR_CONDITIONAL = /\b(?:si|cuando|después|luego|podr(?:ía|ias|íamos)|deber(?:ía|ias|íamos)|quiero que eventualmente|más adelante)\b/iu;
const NEGATION = /\b(?:no|nunca|sin)\s+(?:implement|ejecut|corr|build|ship|deploy|aplic|cre)/iu;
const ENGLISH_NEGATION = /\b(?:do\s+not|don't|never|without)\s+(?:implement|execute|run|build|ship|deploy|apply|create)/iu;
const DEFERRED_EXECUTION = /\b(?:after\s+approval|when\s+ready|later|eventually|despu[eé]s\s+de\s+aprobar|cuando\s+est[eé]\s+listo|m[aá]s\s+adelante)\b/iu;
const CLAUSE_NEGATION = /\b(?:pero|but)\b[^.!?;]*(?:no\s+(?:lo\s+)?(?:ejecut|implement)|do\s+not\s+(?:execute|implement|run))/iu;
const MODAL_SPANISH = /\b(?:pod(?:és|es|rías?|ria|ría)|deber(?:ías?|ias?|ía)|quer(?:és|es|rías?|ria|ría)|sería\s+posible)\b/iu;
const CLAUSE_CONSERVATIVE_NEGATION = /\b(?:no|nunca|sin|not|never|without|cannot|can't|won't|don't)\b/iu;
const ENGLISH_MODAL_QUESTION = /(?:\b(?:can|could|would|will)\s+you\b|\b(?:should|can|could|would)\s+(?:i|we)\b|\bwhether\b|\basking\s+(?:if|whether)\b)/iu;
const META_OR_DOCUMENTAL_DIRECTIVE = /^\s*(?:(?:por\s+favor|please)\s+)?(?:consider(?:á|a|ar)?|copi(?:á|a|ar)|copy|confirm(?:á|a|ar)?|quote|cit(?:á|a|ar)|document(?:á|a|ar)?|traduc(?:í|ir)|translate)\b/iu;
const QUOTED_OR_CODE_DIRECTIVE = /^\s*(?:>|```|~~~|[`"“'‘])|(?:```|~~~)[\s\S]*(?:implement|execute|fix|ejecut|correg)/iu;
const PRIMARY_EXECUTION_DIRECTIVE = /^\s*(?:(?:por\s+favor|please)\s+)?(?:implement(?:á|a|e|ar)?|fix(?:e|ear|á)?|correg(?:í|ir|i)|ejecut(?:á|a|e|ar)|corr(?:é|e|er)|build|ship|deploy|aplic(?:á|a|ar)|cre(?:á|a|ar))\b/iu;

export function isDirectRalplanAdvisoryInvocation(text: string): boolean {
  const tokens = text.trim().split(/\s+/u);
  if (!/^\$(?:oh-my-codex:)?ralplan$/u.test(tokens[0] ?? '') || tokens[1] !== '--advisory') return false;
  return tokens.slice(2).every((token) => !token.startsWith('-') && !token.startsWith('$'));
}

export function classifyAdvisoryPrompt(prompt: string): AdvisoryIntent {
  const text = prompt.trim();
  if (!text) return 'unrelated';
  if (META_OR_DOCUMENTAL_DIRECTIVE.test(text) || QUOTED_OR_CODE_DIRECTIVE.test(text)
    || QUESTION.test(text) || FUTURE_OR_CONDITIONAL.test(text) || MODAL_SPANISH.test(text) || ENGLISH_MODAL_QUESTION.test(text)
    || CLAUSE_CONSERVATIVE_NEGATION.test(text) || NEGATION.test(text)
    || ENGLISH_NEGATION.test(text) || DEFERRED_EXECUTION.test(text) || CLAUSE_NEGATION.test(text)) return 'unrelated';
  if (/^\s*(?:abandon(?:á|a|ar)?|cancel(?:á|a|ar)?)\s+(?:el\s+)?(?:ralplan|advisory|plan)/iu.test(text)) return 'abandon';
  if (isDirectRalplanAdvisoryInvocation(text)
    || /^\s*(?:inici(?:á|a|ar)|cre(?:á|a|ar)|hac(?:é|e|er))\s+(?:un\s+)?(?:new advisory|nuevo advisory|nueva planificación advisory)\b/iu.test(text)) return 'new_advisory';
  if (/^\s*(?:replan\b|replanific(?:á|a|ar)(?:\s|$)|volv(?:é|e)(?:\s|$)\s+a\s+planificar\b)/iu.test(text)) return 'replan';
  if (/^(?:continue|continuá|dale|ok|sí|si|go|proceed)[.!]?$/iu.test(text)) return 'unrelated';
  return PRIMARY_EXECUTION_DIRECTIVE.test(text) && EXECUTION_VERBS.test(text) && EXECUTION_ANCHOR.test(text) ? 'execute' : 'unrelated';
}

export async function observeRalplanAdvisoryPrompt(input: {
  cwd: string; sessionId: string; turnId: string; threadId: string; prompt: string;
  producer: 'native' | string; threadKind: 'root-or-drift' | string;
  isSubagentPromptSubmit: boolean; markedContinuation?: boolean; synthetic?: boolean;
  reservedInput?: string | null;
  activationFailpoint?: (name: 'rollover_intent' | 'rollover_activation' | 'rollover_pointer') => void | Promise<void>;
}): Promise<{ intent: AdvisoryIntent; projection: AdvisoryProjection | null }> {
  // Prompt observation is deliberately read-only. In particular, an explicit
  // execution request must not reconcile state, append an event, or mint any
  // durable authorization. Lifecycle mutations below are reserved for the
  // explicit administrative abandon/replan/new-advisory intents.
  let projection = await readCurrentRalplanAdvisory(input.cwd, input.sessionId);
  if (!projection) return { intent: 'unrelated', projection: null };
  if (projection.activation?.generation_id) {
    const bindingConflict = await liveAdvisoryBindingConflict(
      projection.activation.canonical_cwd,
      input.sessionId,
      projection.activation.generation_id,
    );
    if (bindingConflict) {
      return { intent: 'unrelated', projection: { ...projection, corruption: bindingConflict } };
    }
  }
  if (projection.corruption || !projection.fence) return { intent: 'unrelated', projection };
  if (input.threadId !== projection.activation.root_thread_id) {
    return { intent: 'unrelated', projection };
  }
  if (input.producer !== 'native' || input.isSubagentPromptSubmit
    || input.markedContinuation || input.synthetic || input.reservedInput || !safeId(input.turnId) || !safeId(input.threadId)
    || input.turnId === projection.fence.closing_turn_id) {
    return { intent: 'unrelated', projection };
  }
  const intent = classifyAdvisoryPrompt(input.prompt);
  if (intent === 'execute') {
    return { intent, projection };
  }
  if (intent === 'unrelated') return { intent, projection };

  // Administrative lifecycle intents may mutate durable state, so they require
  // both the authenticated root classification and the exact current Advisory
  // session binding. Historical Advisory evidence must stay inert after another
  // workflow has replaced that binding.
  if (input.producer !== 'native' || input.threadKind !== 'root-or-drift') {
    return { intent: 'unrelated', projection };
  }
  let binding: Record<string, unknown> | null;
  try {
    binding = await readStrictJson(join(getBaseStateDir(projection.activation.canonical_cwd), 'sessions', input.sessionId, 'ralplan-state.json'));
  } catch {
    return { intent: 'unrelated', projection };
  }
  if (!binding || binding.mode !== 'ralplan' || binding.session_id !== input.sessionId || binding.active !== true
    || binding.thread_id !== projection.activation.root_thread_id
    || binding.workflow_variant !== 'advisory'
    || binding.advisory_generation_id !== projection.activation.generation_id) {
    return { intent: 'unrelated', projection };
  }

  projection = await reconcileRalplanAdvisory(input.cwd, input.sessionId, {
    producer: input.producer,
    threadKind: input.threadKind,
    rootThreadId: input.threadId,
    activationTurnId: input.turnId,
  }) ?? projection;
  if (projection.corruption || !projection.fence) return { intent: 'unrelated', projection };
  if (intent === 'abandon' && ['recovery_required', 'closed'].includes(projection.fence.state)) {
    return {
      intent,
      projection: await administrativelyAbandonRalplanAdvisory({
        cwd: input.cwd, sessionId: input.sessionId, generationId: projection.activation.generation_id,
        rootThreadId: input.threadId, turnId: input.turnId,
      }),
    };
  }
  if (intent === 'replan' || intent === 'new_advisory') {
    if (projection.fence.state === 'pending_closeout') {
      return { intent: 'unrelated', projection };
    }
    if (projection.fence.state === 'recovery_required') {
      await administrativelyAbandonRalplanAdvisory({
        cwd: input.cwd, sessionId: input.sessionId, generationId: projection.activation.generation_id,
        rootThreadId: input.threadId, turnId: input.turnId,
      });
    }
    await activateRalplanAdvisory({
      cwd: projection.activation.canonical_cwd, sessionId: input.sessionId,
      rootThreadId: input.threadId, activationTurnId: input.turnId,
      predecessorGenerationId: projection.activation.generation_id,
      activationPrompt: input.prompt,
      failpoint: input.activationFailpoint,
    });
    return { intent, projection: await readCurrentRalplanAdvisory(input.cwd, input.sessionId) };
  }
  return { intent, projection };
}

export async function administrativelyAbandonRalplanAdvisory(input: {
  cwd: string; sessionId: string; generationId: string; rootThreadId: string; turnId: string; nowIso?: string;
  failpoint?: (name: 'after_fence_event' | 'after_admin_event') => void | Promise<void>;
  beforeMutation?: (checkpoint: string) => void | Promise<void>;
}): Promise<AdvisoryProjection> {
  if (![input.sessionId, input.generationId, input.rootThreadId, input.turnId].every(safeId)) {
    throw new Error('ralplan_advisory_admin_identity_missing');
  }
  return withGenerationLock(input.cwd, input.sessionId, input.generationId, async () => {
    let projection = await readCurrentRalplanAdvisory(input.cwd, input.sessionId);
    const recoverableMissingAdmin = projection?.corruption === 'abandoned_without_matching_journal_or_admin_event'
      && projection.fence?.state === 'abandoned';
    if (!projection || (projection.corruption && !recoverableMissingAdmin) || !projection.fence
      || projection.activation.generation_id !== input.generationId
      || (!['pending_closeout', 'recovery_required', 'closed'].includes(projection.fence.state)
        && projection.fence.state !== 'abandoned')) {
      throw new Error(`ralplan_advisory_admin_abandon_invalid:${projection?.corruption ?? projection?.fence?.state ?? 'missing'}`);
    }
    if (projection.fence.state === 'abandoned' && projection.admin_event) return projection;
    const now = input.nowIso ?? new Date().toISOString();
    const dir = generationDir(projection.activation.canonical_cwd, input.sessionId, input.generationId);
    const alreadyAppended = projection.fence.state === 'abandoned';
    const priorSequence = alreadyAppended ? projection.fence.sequence - 1 : projection.fence.sequence;
    const priorFencePath = priorSequence === 0
      ? join(dir, 'fence.json')
      : join(dir, `fence-event-${String(priorSequence).padStart(4, '0')}.json`);
    const priorFenceBytes = await readFile(priorFencePath);
    const priorJournalBytes = projection.journal ? await readFile(join(dir, 'closeout-journal.json')) : null;
    const adminEvent: AdvisoryAdminEvent = {
      schema_version: 1, action: 'abandon', generation_id: input.generationId, session_id: input.sessionId,
      root_thread_id: input.rootThreadId, turn_id: input.turnId,
      prior_fence_sha256: sha256(priorFenceBytes),
      ...(priorJournalBytes ? { prior_journal_sha256: sha256(priorJournalBytes) } : {}),
      created_at: now,
    };
    if (!alreadyAppended) {
      await input.beforeMutation?.('admin_fence_event');
      await appendFenceEvent(projection.activation.canonical_cwd, projection.fence, {
        state: 'abandoned', closing_turn_id: projection.fence.closing_turn_id, iteration: projection.fence.iteration,
        outcome: 'abandoned', integrity_status: 'unproven', updated_at: now,
      });
      await input.failpoint?.('after_fence_event');
      projection = await readProjectionForGeneration(projection.activation.canonical_cwd, input.sessionId, input.generationId);
    }
    await input.beforeMutation?.('admin_event');
    await writeExclusive(join(dir, 'admin-event-0001.json'), adminEvent);
    await input.failpoint?.('after_admin_event');
    return readProjectionForGeneration(projection.activation.canonical_cwd, input.sessionId, input.generationId);
  });
}

export function validateAdvisoryInactiveState(state: Record<string, unknown>, projection: AdvisoryProjection | null): string | null {
  if (state.mode !== 'ralplan' || state.workflow_variant !== 'advisory' || state.active !== false) return null;
  if (!projection || projection.corruption || !projection.fence || (!projection.journal && !projection.admin_event)) return 'ralplan_advisory_inactive_requires_canonical_fence_and_journal';
  if (!['closed', 'abandoned', 'recovery_required'].includes(projection.fence.state)) return 'ralplan_advisory_inactive_fence_not_terminal';
  if (!projection.admin_event && projection.journal?.phase !== 'committed') return 'ralplan_advisory_inactive_journal_not_committed';
  if (projection.fence.generation_id !== state.advisory_generation_id) return 'ralplan_advisory_inactive_generation_mismatch';
  if (state.execution_handoff_authorized !== false || state.host_verified !== false
    || object(state.ralplan_consensus_gate)?.complete !== false) return 'ralplan_advisory_inactive_explicit_false_fields_required';
  if (projection.journal && projection.journal.outcome !== 'approved' && object(state.ralplan_review_lifecycle)?.complete === true) {
    return 'ralplan_advisory_negative_outcome_lifecycle_complete_forbidden';
  }
  return null;
}

/** Internal fence-first write boundary used by the canonical mode writer while
 * a prepared closeout journal is still in progress. Public state_write remains
 * stricter and requires the terminal committed projection above. */
export function validateAdvisoryPreparedInactiveWrite(state: Record<string, unknown>, projection: AdvisoryProjection | null): string | null {
  if (state.mode !== 'ralplan' || state.workflow_variant !== 'advisory' || state.active !== false) return null;
  if (!projection || projection.corruption || !projection.fence || !projection.journal) return 'ralplan_advisory_inactive_requires_prepared_fence_and_journal';
  if (projection.fence.state !== 'pending_closeout') return 'ralplan_advisory_prepared_write_requires_pending_fence';
  if (projection.journal.phase !== 'prepared') return 'ralplan_advisory_prepared_write_requires_prepared_journal';
  if (projection.fence.generation_id !== state.advisory_generation_id || projection.journal.generation_id !== state.advisory_generation_id) {
    return 'ralplan_advisory_prepared_write_generation_mismatch';
  }
  if (state.execution_handoff_authorized !== false || state.host_verified !== false) {
    return 'ralplan_advisory_prepared_explicit_false_fields_required';
  }
  return null;
}
