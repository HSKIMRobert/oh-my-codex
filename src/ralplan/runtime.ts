import {
  readModeState,
  readModeStateForExplicitSession,
  startMode,
  updateAutopilotPipelineState,
  updateModeState,
} from '../modes/base.js';
import { resolveWritableStateScope } from '../mcp/state-paths.js';
import { requirePersistedHandoffCarrier } from '../state/handoff-carrier.js';
import { syncExplicitSessionModeState } from '../state/operations.js';
import { readSubagentTrackingState, recordSubagentTurnForSession } from '../subagents/tracker.js';
import { digestAdvisoryArtifacts, projectAdvisoryReviewLifecycle, type AdvisoryReviewLifecycle } from './advisory-evidence.js';
import {
  administrativelyAbandonRalplanAdvisory,
  activateRalplanAdvisory,
  isCanonicalInactiveAdvisoryBinding,
  readCurrentRalplanAdvisory,
  reconcileRalplanAdvisory,
  terminalizeRalplanAdvisory,
  type AdvisoryProjection,
  type AdvisoryOutcome,
} from './advisory.js';

export const RALPLAN_ACTIVE_PHASES = [
  'draft',
  'architect-review',
  'critic-review',
  'complete',
] as const;

export type RalplanActivePhase = (typeof RALPLAN_ACTIVE_PHASES)[number];
export type RalplanTerminalPhase = 'complete' | 'cancelled' | 'failed';
export type RalplanReviewVerdict = 'approve' | 'iterate' | 'reject';
export type RalplanExecutionLane = 'ultragoal' | 'team' | 'ralph' | 'conductor' | 'execution' | 'none';

export interface RalplanReusableRoleLane {
  agent_role: 'architect' | 'critic';
  thread_id?: string;
  lane_id?: string;
  session_id?: string;
  native_session_id?: string;
  tracker_path?: string;
}


export interface RalplanDraftResult {
  summary?: string;
  planPath?: string;
  artifacts?: Record<string, unknown>;
  session_id?: string;
  thread_id?: string;
  native_session_id?: string;
  agent_role?: 'planner' | 'architect' | 'critic' | 'executor';
  lane_id?: string;
  tracker_path?: string;
}

export interface RalplanReviewResult {
  verdict: RalplanReviewVerdict;
  summary?: string;
  artifacts?: Record<string, unknown>;
  provenance_kind?: 'native_subagent';

  session_id?: string;
  thread_id?: string;
  native_session_id?: string;
  artifact_path?: string;
  agent_role?: 'architect' | 'critic';
  lane_id?: string;
  tracker_path?: string;
  new_lane_reason?: string;
  sequence_index?: number;
}

export interface RalplanConsensusGate {
  required: true;
  complete: boolean;
  sequence: ['architect-review', 'critic-review'];
  planning_artifacts_are_not_consensus: true;
  required_review_roles: ['architect', 'critic'];
  ralplan_architect_review: (RalplanReviewResult & { agent_role: 'architect'; iteration: number }) | null;
  ralplan_critic_review: (RalplanReviewResult & { agent_role: 'critic'; iteration: number }) | null;
  architect_review: (RalplanReviewResult & { agent_role: 'architect'; iteration: number }) | null;
  critic_review: (RalplanReviewResult & { agent_role: 'critic'; iteration: number }) | null;
  blocked_reason: string | null;
}

export interface RalplanConsensusIterationContext {
  task: string;
  cwd: string;
  iteration: number;
  priorDrafts: RalplanDraftResult[];
  architectReviews: RalplanReviewResult[];
  criticReviews: RalplanReviewResult[];
  reusableRoleLanes: {
    architect?: RalplanReusableRoleLane;
    critic?: RalplanReusableRoleLane;
  };
}

export interface RalplanConsensusExecutor {
  draft(ctx: RalplanConsensusIterationContext): Promise<RalplanDraftResult>;
  architectReview(
    ctx: RalplanConsensusIterationContext & { draft: RalplanDraftResult },
  ): Promise<RalplanReviewResult>;
  criticReview(
    ctx: RalplanConsensusIterationContext & {
      draft: RalplanDraftResult;
      architectReview: RalplanReviewResult;
    },
  ): Promise<RalplanReviewResult>;
}

export interface RunRalplanConsensusOptions {
  task: string;
  cwd?: string;
  maxIterations?: number;
  sessionId?: string;
  requireNativeSubagents?: boolean;
  selectedExecutionLane?: RalplanExecutionLane;
  workflowVariant?: 'standard' | 'advisory';
  rootThreadId?: string;
  activationTurnId?: string;
  closingTurnId?: string;
}

export interface RalplanRuntimeResult {
  status: 'completed' | 'failed' | 'cancelled';
  iteration: number;
  phase: RalplanTerminalPhase;
  planningComplete: boolean;
  drafts: RalplanDraftResult[];
  architectReviews: RalplanReviewResult[];
  criticReviews: RalplanReviewResult[];
  ralplanConsensusGate: RalplanConsensusGate;
  latestPlanPath?: string;
  artifacts: Record<string, unknown>;
  error?: string;
  selectedExecutionLane?: RalplanExecutionLane;
  executionHandoffStarted?: boolean;
  workflowVariant?: 'advisory';
  ralplanReviewLifecycle?: AdvisoryReviewLifecycle;
  executionHandoffAuthorized?: false;
  hostVerified?: false;
  returnToCaller?: boolean;
}

type AdvisoryCatchRecoveryProjection = Pick<AdvisoryProjection, 'corruption'> & {
  fence: { state: string } | null;
  journal: { outcome: string } | null;
};

export function isCompletedAdvisoryCatchRecovery(
  recovered: AdvisoryCatchRecoveryProjection | null,
  binding: Record<string, unknown> | null,
  sessionId: string,
  generationId: string,
): boolean {
  return recovered?.corruption === null
    && recovered.fence?.state === 'closed'
    && recovered.journal?.outcome === 'approved'
    && isCanonicalInactiveAdvisoryBinding(binding, sessionId, generationId);
}

interface RalplanModeUpdates {
  active?: boolean;
  current_phase?: string;
  completed_at?: string;
  error?: string;
  planning_complete?: boolean;
  iteration?: number;
  latest_plan_path?: string;
  latest_draft_summary?: string;
  latest_architect_verdict?: RalplanReviewVerdict;
  latest_architect_summary?: string;
  latest_critic_verdict?: RalplanReviewVerdict;
  latest_critic_summary?: string;
  ralplan_consensus_gate?: RalplanConsensusGate;
  status_message?: string;
  review_history?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function buildReviewHistory(
  drafts: RalplanDraftResult[],
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const total = Math.max(drafts.length, architectReviews.length, criticReviews.length);
  for (let index = 0; index < total; index++) {
    entries.push({
      iteration: index + 1,
      draft: drafts[index] ?? null,
      architect_review: architectReviews[index] ?? null,
      critic_review: criticReviews[index] ?? null,
    });
  }
  return entries;
}

async function recordRalplanSubagentTurn(
  cwd: string,
  sessionId: string | undefined,
  input: {
    threadId?: string;
    role?: 'planner' | 'architect' | 'critic' | 'executor';
    laneId?: string;
    scope?: string;
    summary?: string;
    completed?: boolean;
    completionSource?: string;
    preserveCompletionEvidence?: boolean;
  },
): Promise<void> {
  const normalizedSessionId = sessionId?.trim();
  const normalizedThreadId = input.threadId?.trim();
  if (!normalizedSessionId || !normalizedThreadId) return;

  await recordSubagentTurnForSession(cwd, {
    sessionId: normalizedSessionId,
    threadId: normalizedThreadId,
    mode: input.role,
    ...(input.role ? { role: input.role } : {}),
    ...(input.laneId ? { laneId: input.laneId } : input.role ? { laneId: input.role } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.summary?.trim() ? { lastHandoffSummary: input.summary.trim() } : {}),
    ...(input.completed ? { completed: true, completionSource: input.completionSource } : {}),
    ...(input.preserveCompletionEvidence ? { preserveCompletionEvidence: true } : {}),
    kind: 'subagent',
  }).catch(() => {});
}

function isApprovingReviewPair(
  architectReview: RalplanReviewResult | undefined,
  criticReview: RalplanReviewResult | undefined,
  requireNativeSubagents: boolean,
): boolean {
  if (
    architectReview?.verdict !== 'approve'
    || criticReview?.verdict !== 'approve'
    || architectReview.agent_role !== 'architect'
    || criticReview.agent_role !== 'critic'
  ) return false;
  if (!requireNativeSubagents) return true;

  const architectThreadId = architectReview.thread_id?.trim();
  const criticThreadId = criticReview.thread_id?.trim();
  return architectReview.provenance_kind === 'native_subagent'
    && criticReview.provenance_kind === 'native_subagent'
    && Boolean(architectThreadId)
    && Boolean(criticThreadId)
    && architectThreadId !== criticThreadId;
}

function reviewBlocker(
  architectReview: RalplanReviewResult | undefined,
  criticReview: RalplanReviewResult | undefined,
  requireNativeSubagents: boolean,
  nativeEvidenceComplete = true,
): string | null {
  if (architectReview?.verdict !== 'approve') return 'architect_review_missing_or_not_approved';
  if (criticReview?.verdict !== 'approve') return 'critic_review_missing_or_not_approved';
  if (!isApprovingReviewPair(architectReview, criticReview, requireNativeSubagents) || !nativeEvidenceComplete) {
    return 'native_subagent_consensus_evidence_missing';
  }
  return null;
}

async function hasCompletedNativeReviewEvidence(
  cwd: string,
  sessionId: string | undefined,
  architectReview: RalplanReviewResult,
  criticReview: RalplanReviewResult,
): Promise<boolean> {
  if (!sessionId?.trim()) return false;
  const threads = (await readSubagentTrackingState(cwd)).sessions[sessionId]?.threads;
  return Boolean(threads?.[architectReview.thread_id ?? '']?.completed_at && threads?.[criticReview.thread_id ?? '']?.completed_at);
}

function buildRalplanConsensusGate(
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
  options: { cwd?: string; sessionId?: string; requireNativeSubagents?: boolean; nativeEvidenceComplete?: boolean; iteration?: number } = {},
): RalplanConsensusGate {
  const latestArchitect = architectReviews.at(-1);
  const latestCritic = criticReviews.at(-1);
  // P1-3: stamp the authoritative global Ralplan loop iteration as
  // review_cycle on both role reviews. Never derive from per-role array
  // lengths, which diverge on Architect revision/retry.
  const authoritativeCycle = typeof options.iteration === 'number' ? options.iteration : 1;
  // P1-2: stamp authoritative sequence_index (architect=1, critic=2) from
  // the trusted runtime, so external executors that omit it still produce
  // correctly ordered persisted artifacts. Forged/reordered persisted
  // artifacts are caught by the gate validator.
  const ralplanArchitectReview = latestArchitect
    ? { ...latestArchitect, agent_role: 'architect' as const, session_id: options.sessionId, iteration: authoritativeCycle, review_cycle: authoritativeCycle, sequence_index: 1 }
    : null;
  const ralplanCriticReview = latestCritic
    ? { ...latestCritic, agent_role: 'critic' as const, session_id: options.sessionId, iteration: authoritativeCycle, review_cycle: authoritativeCycle, sequence_index: 2 }
    : null;
  const blockedReason = reviewBlocker(latestArchitect, latestCritic, options.requireNativeSubagents === true, options.nativeEvidenceComplete);
  return {
    required: true,
    complete: blockedReason === null,
    sequence: ['architect-review', 'critic-review'],
    planning_artifacts_are_not_consensus: true,
    required_review_roles: ['architect', 'critic'],
    ralplan_architect_review: ralplanArchitectReview,
    ralplan_critic_review: ralplanCriticReview,
    architect_review: ralplanArchitectReview,
    critic_review: ralplanCriticReview,
    blocked_reason: blockedReason,
  };
}

function hasNativeSubagentEvidence(review: RalplanReviewResult): boolean {
  return review.provenance_kind === 'native_subagent';
}

function normalizeReviewForLane(
  review: RalplanReviewResult,
  laneRole: 'architect' | 'critic',
  requireNativeSubagents: boolean,
): RalplanReviewResult {
  if (requireNativeSubagents) {
    if (!review.agent_role) {
      throw new Error(`ralplan_${laneRole}_review_role_missing: expected agent_role=${laneRole}`);
    }
    if (review.agent_role !== laneRole) {
      throw new Error(`ralplan_${laneRole}_review_role_mismatch: expected agent_role=${laneRole}, received ${review.agent_role}`);
    }
    if (!hasNativeSubagentEvidence(review)) {
      throw new Error(`ralplan_${laneRole}_review_provenance_invalid: expected provenance_kind=native_subagent`);
    }
    if (!review.thread_id?.trim()) {
      throw new Error(`ralplan_${laneRole}_review_thread_missing: native_subagent review must declare thread_id`);
    }
  } else if (review.provenance_kind !== undefined && !hasNativeSubagentEvidence(review)) {
    throw new Error(`ralplan_${laneRole}_review_provenance_invalid: adapted provenance cannot authorize a review lane`);
  }
  return { ...review, agent_role: laneRole };
}



function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function latestCompatibleRoleLane(
  reviews: RalplanReviewResult[],
  role: 'architect' | 'critic',
  sessionId?: string,
): RalplanReusableRoleLane | undefined {
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const review = reviews[index];
    if (review.agent_role !== role) continue;
    if (!nonEmptyString(review.thread_id) && !nonEmptyString(review.lane_id)) continue;
    const reviewSessionId = nonEmptyString(review.session_id);
    if (sessionId && reviewSessionId && reviewSessionId !== sessionId) continue;
    return {
      agent_role: role,
      ...(nonEmptyString(review.thread_id) ? { thread_id: nonEmptyString(review.thread_id) } : {}),
      ...(nonEmptyString(review.lane_id) ? { lane_id: nonEmptyString(review.lane_id) } : {}),
      ...(reviewSessionId ? { session_id: reviewSessionId } : {}),
      ...(nonEmptyString(review.native_session_id) ? { native_session_id: nonEmptyString(review.native_session_id) } : {}),
      ...(nonEmptyString(review.tracker_path) ? { tracker_path: nonEmptyString(review.tracker_path) } : {}),
    };
  }
  return undefined;
}

function assertRoleLaneReuse(
  priorLane: RalplanReusableRoleLane | undefined,
  review: RalplanReviewResult,
  role: 'architect' | 'critic',
): void {
  if (!priorLane) return;
  if (review.agent_role !== role) return;
  const priorThreadId = nonEmptyString(priorLane.thread_id);
  const nextThreadId = nonEmptyString(review.thread_id);
  const priorLaneId = nonEmptyString(priorLane.lane_id);
  const nextLaneId = nonEmptyString(review.lane_id);
  const reusedThread = priorThreadId && nextThreadId && priorThreadId === nextThreadId;
  const reusedLane = priorLaneId && nextLaneId && priorLaneId === nextLaneId;
  if (reusedThread || reusedLane) return;
  if (nonEmptyString(review.new_lane_reason)) return;
  if ((priorThreadId || priorLaneId) && (nextThreadId || nextLaneId)) {
    throw new Error(`ralplan_${role}_lane_reuse_required`);
  }
}


async function updateRalplanState(
  cwd: string,
  updates: RalplanModeUpdates,
  sessionId?: string,
  beforeCommit?: (site: string) => void | Promise<void>,
): Promise<void> {
  await updateModeState('ralplan', updates, cwd, sessionId, beforeCommit);
}

function requiredAdvisoryIdentity(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`ralplan_advisory_${name}_required`);
  return normalized;
}

async function terminalizeRuntimeAdvisory(input: {
  cwd: string;
  sessionId: string;
  generationId: string;
  closingTurnId: string;
  iteration: number;
  outcome: AdvisoryOutcome;
  lifecycle?: AdvisoryReviewLifecycle;
  updates: RalplanModeUpdates;
  revalidateEvidence?: () => Promise<string | undefined>;
  revalidateAuthority?: (checkpoint: string) => void | Promise<void>;
}): Promise<void> {
  let modeWritten = false;
  const terminalModeUpdates: RalplanModeUpdates = {
    ...input.updates,
    active: false,
    workflow_variant: 'advisory',
    advisory_generation_id: input.generationId,
    advisory_closing_turn_id: input.closingTurnId,
    execution_handoff_authorized: false,
    host_verified: false,
    ralplan_consensus_gate: {
      ...(input.updates.ralplan_consensus_gate ?? buildRalplanConsensusGate([], [])),
      complete: false,
    },
    ...(input.lifecycle ? { ralplan_review_lifecycle: input.lifecycle } : {}),
  };
  const projection = await terminalizeRalplanAdvisory({
    cwd: input.cwd,
    sessionId: input.sessionId,
    generationId: input.generationId,
    closingTurnId: input.closingTurnId,
    iteration: input.iteration,
    outcome: input.outcome,
    integrityStatus: input.lifecycle || input.outcome !== 'approved' ? 'proven' : 'unproven',
    lifecycle: input.lifecycle,
    terminalModeUpdates: terminalModeUpdates as Record<string, unknown>,
    revalidateEvidence: input.revalidateEvidence,
    beforeMutation: input.revalidateAuthority,
    failpoint: async (name) => {
      if (process.env.NODE_ENV === 'test' && process.env.OMX_RALPLAN_ADVISORY_FAILPOINT === name) {
        throw new Error(`ralplan_advisory_test_failpoint:${name}`);
      }
    },
    applyStep: async (step, storedPatch) => {
      // updateModeState is the existing canonical writer: it writes the
      // session/root mode and skill mirrors under its scope revalidator. The
      // remaining journal steps verify/reconcile that idempotent result.
      if (!modeWritten && step === 'session_mode') {
        await updateRalplanState(
          input.cwd,
          storedPatch as RalplanModeUpdates,
          input.sessionId,
          input.revalidateAuthority
            ? (site) => input.revalidateAuthority?.(`mode_commit_${site}`)
            : undefined,
        );
        await input.revalidateAuthority?.('mode_update_complete');
        modeWritten = true;
      }
    },
  });
  const terminalStateValid = input.outcome === 'approved'
    ? projection.fence?.state === 'closed'
    : Boolean(projection.fence && ['closed', 'abandoned', 'recovery_required'].includes(projection.fence.state));
  if (projection.corruption || !terminalStateValid) {
    throw new Error(`ralplan_advisory_terminalization_unproven:${projection.corruption ?? projection.fence?.state ?? 'missing'}`);
  }
}

export async function runRalplanConsensus(
  executor: RalplanConsensusExecutor,
  options: RunRalplanConsensusOptions,
): Promise<RalplanRuntimeResult> {
  const cwd = options.cwd ?? process.cwd();
  // Pin the writable session once for the whole run. A caller may omit an
  // explicit session while the workspace pointer selects one; startMode then
  // writes session-scoped state, so every subsequent read/update must use the
  // same explicit scope instead of falling back to root-only discovery.
  const runtimeSessionId = options.sessionId
    ?? (await resolveWritableStateScope(cwd)).sessionId;
  const maxIterations = options.maxIterations ?? 5;
  const gateOptions = {
    cwd,
    sessionId: runtimeSessionId,
    requireNativeSubagents: options.requireNativeSubagents,
    get iteration() { return iteration; },
  };
  const drafts: RalplanDraftResult[] = [];
  const architectReviews: RalplanReviewResult[] = [];
  const criticReviews: RalplanReviewResult[] = [];
  const aggregatedArtifacts: Record<string, unknown> = {};
  let latestPlanPath: string | undefined;
  let iteration = 1;
  const advisory = options.workflowVariant === 'advisory';
  let advisorySessionId: string | undefined;
  let advisoryGenerationId: string | undefined;
  let advisoryActivationTurnId: string | undefined;
  let advisoryClosingTurnId: string | undefined;
  let advisoryRootThreadId: string | undefined;
  let advisoryLifecycle: AdvisoryReviewLifecycle | undefined;
  let advisoryPlanDigestBeforeReviews: string | undefined;
  const writeRalplanState = (
    updates: RalplanModeUpdates,
    sessionId = advisorySessionId ?? runtimeSessionId,
  ): Promise<void> => updateRalplanState(cwd, updates, sessionId);

  const existing = runtimeSessionId
    ? await readModeStateForExplicitSession('ralplan', runtimeSessionId, cwd)
    : await readModeState('ralplan', cwd);
  if (existing?.active && !(advisory && existing.workflow_variant === 'advisory')) {
    throw new Error('ralplan_active_mode_exists');
  }
  if (advisory) {
    advisorySessionId = requiredAdvisoryIdentity(runtimeSessionId ?? String(existing?.session_id ?? ''), 'session_id');
    advisoryActivationTurnId = requiredAdvisoryIdentity(options.activationTurnId ?? String(existing?.turn_id ?? ''), 'activation_turn_id');
    advisoryClosingTurnId = requiredAdvisoryIdentity(options.closingTurnId ?? advisoryActivationTurnId, 'closing_turn_id');
    advisoryRootThreadId = requiredAdvisoryIdentity(options.rootThreadId ?? String(existing?.thread_id ?? ''), 'root_thread_id');
    if (existing?.active && existing.workflow_variant === 'advisory') {
      advisoryGenerationId = requiredAdvisoryIdentity(String(existing.advisory_generation_id ?? ''), 'generation_id');
    } else {
      let prior = await readCurrentRalplanAdvisory(cwd, advisorySessionId);
      if (prior?.corruption || prior?.fence?.state === 'pending_closeout') {
        prior = await reconcileRalplanAdvisory(cwd, advisorySessionId);
        if (prior?.fence?.state === 'pending_closeout' && !prior.journal) {
          await administrativelyAbandonRalplanAdvisory({
            cwd, sessionId: advisorySessionId, generationId: prior.activation.generation_id,
            rootThreadId: prior.activation.root_thread_id, turnId: prior.fence.closing_turn_id,
          });
          prior = await readCurrentRalplanAdvisory(cwd, advisorySessionId);
        }
      }
      if (prior?.corruption) throw new Error(`ralplan_advisory_${prior.corruption}`);
      if (prior && (!prior.fence || !['closed', 'abandoned', 'recovery_required'].includes(prior.fence.state))) {
        throw new Error('ralplan_advisory_existing_generation_not_terminal');
      }
      // Reconcile/read the previous generation before replacing its mode
      // binding. A crash can leave a pending journal while the mode is already
      // inactive; startMode first would poison the generation binding and
      // strand the closeout forever.
      await startMode('ralplan', options.task, maxIterations, cwd, advisorySessionId);
      const activation = await activateRalplanAdvisory({
        cwd, sessionId: advisorySessionId, rootThreadId: advisoryRootThreadId, activationTurnId: advisoryActivationTurnId,
        ...(prior ? { predecessorGenerationId: prior.activation.generation_id } : {}),
      });
      advisoryGenerationId = activation.generation_id;
      await writeRalplanState({
        session_id: advisorySessionId,
        workflow_variant: 'advisory',
        advisory_generation_id: advisoryGenerationId,
        execution_handoff_authorized: false,
        host_verified: false,
      });
      await syncExplicitSessionModeState('ralplan', cwd, advisorySessionId);
      const committedActivation = await reconcileRalplanAdvisory(cwd, advisorySessionId, {
        producer: 'native', threadKind: 'root-or-drift', rootThreadId: advisoryRootThreadId,
        activationTurnId: advisoryActivationTurnId,
      });
      if (committedActivation?.corruption) throw new Error(`ralplan_advisory_${committedActivation.corruption}`);
    }
  } else {
    await startMode('ralplan', options.task, maxIterations, cwd, runtimeSessionId);
  }

  try {
    while (iteration <= maxIterations) {
      const reusableRoleLanes = {
        architect: latestCompatibleRoleLane(architectReviews, 'architect', runtimeSessionId),
        critic: latestCompatibleRoleLane(criticReviews, 'critic', runtimeSessionId),
      };
      const iterationContext: RalplanConsensusIterationContext = {
        task: options.task,
        cwd,
        iteration,
        priorDrafts: [...drafts],
        architectReviews: [...architectReviews],
        criticReviews: [...criticReviews],
        reusableRoleLanes,
      };

      await writeRalplanState({
        iteration,
        current_phase: 'draft',
        planning_complete: false,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      }, runtimeSessionId);
      const draft = await executor.draft(iterationContext);
      drafts.push(draft);
      if (draft.artifacts) Object.assign(aggregatedArtifacts, draft.artifacts);
      if (draft.planPath) latestPlanPath = draft.planPath;
      if (advisory) {
        if (!latestPlanPath) throw new Error('ralplan_advisory_plan_artifact_required');
        advisoryPlanDigestBeforeReviews = (await digestAdvisoryArtifacts(cwd, [latestPlanPath])).sha256;
      }
      await recordRalplanSubagentTurn(cwd, runtimeSessionId, {
        threadId: draft.thread_id,
        role: draft.agent_role ?? undefined,
        laneId: draft.lane_id,
        scope: options.task,
        summary: draft.summary,
        completed: true,
        completionSource: 'ralplan-draft',
      });

      await writeRalplanState({
        iteration,
        current_phase: 'architect-review',
        latest_plan_path: latestPlanPath,
        latest_draft_summary: draft.summary,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      }, runtimeSessionId);
      const architectReview = normalizeReviewForLane(await executor.architectReview({
        ...iterationContext,
        draft,
      }), 'architect', options.requireNativeSubagents === true);
      if (advisory && latestPlanPath
        && (await digestAdvisoryArtifacts(cwd, [latestPlanPath])).sha256 !== advisoryPlanDigestBeforeReviews) {
        throw new Error('ralplan_advisory_plan_changed_during_architect_review');
      }
      assertRoleLaneReuse(reusableRoleLanes.architect, architectReview, 'architect');
      architectReviews.push(architectReview);
      if (architectReview.artifacts) Object.assign(aggregatedArtifacts, architectReview.artifacts);
      await recordRalplanSubagentTurn(cwd, runtimeSessionId, {
        threadId: architectReview.thread_id,
        role: 'architect',
        laneId: architectReview.lane_id,
        scope: advisory ? `ralplan-advisory:${advisoryGenerationId}` : options.task,
        summary: architectReview.summary,
        preserveCompletionEvidence: true,
      });

      if (architectReview.verdict !== 'approve') {
        const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
        const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions);
        await writeRalplanState({
          iteration,
          current_phase: 'architect-review',
          latest_architect_verdict: architectReview.verdict,
          latest_architect_summary: architectReview.summary,
          ralplan_consensus_gate: consensusGate,
          review_history: reviewHistory,
        }, runtimeSessionId);

        if (iteration >= maxIterations) {
          const error = `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
          if (advisory) {
            await terminalizeRuntimeAdvisory({
              cwd, sessionId: advisorySessionId!, generationId: advisoryGenerationId!,
              closingTurnId: advisoryClosingTurnId!, iteration, outcome: 'exhausted',
              updates: {
                iteration, current_phase: 'failed', completed_at: new Date().toISOString(), planning_complete: false,
                latest_plan_path: latestPlanPath, latest_architect_verdict: architectReview.verdict,
                latest_architect_summary: architectReview.summary, ralplan_consensus_gate: consensusGate,
                review_history: reviewHistory, status_message: 'Status: advisory exhausted — control returned to the caller without an execution handoff.', error,
              },
            });
            return {
              status: 'failed', iteration, phase: 'failed', planningComplete: false, drafts, architectReviews, criticReviews,
              ralplanConsensusGate: consensusGate, latestPlanPath, artifacts: aggregatedArtifacts, error,
              workflowVariant: 'advisory', executionHandoffAuthorized: false, hostVerified: false, returnToCaller: true,
            };
          }
          await writeRalplanState({
            active: false,
            iteration,
            current_phase: 'failed',
            completed_at: new Date().toISOString(),
            planning_complete: false,
            latest_plan_path: latestPlanPath,
            latest_architect_verdict: architectReview.verdict,
            latest_architect_summary: architectReview.summary,
            ralplan_consensus_gate: consensusGate,
            review_history: reviewHistory,
            status_message: `Status: paused_for_review — ralplan reached the ${maxIterations}-iteration review limit without Architect approval; continue from the best current artifact or ask the user how to proceed.`,
            error,
          }, runtimeSessionId);
          return {
            status: 'failed',
            iteration,
            phase: 'failed',
            planningComplete: false,
            drafts,
            architectReviews,
            criticReviews,
            ralplanConsensusGate: consensusGate,
            latestPlanPath,
            artifacts: aggregatedArtifacts,
            error,
          };
        }

        iteration += 1;
        continue;
      }

      await writeRalplanState({
        iteration,
        current_phase: 'critic-review',
        latest_architect_verdict: architectReview.verdict,
        latest_architect_summary: architectReview.summary,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      }, runtimeSessionId);
      const criticReview = normalizeReviewForLane(await executor.criticReview({
        ...iterationContext,
        draft,
        architectReview,
      }), 'critic', options.requireNativeSubagents === true);
      if (advisory && latestPlanPath
        && (await digestAdvisoryArtifacts(cwd, [latestPlanPath])).sha256 !== advisoryPlanDigestBeforeReviews) {
        throw new Error('ralplan_advisory_plan_changed_during_critic_review');
      }
      assertRoleLaneReuse(reusableRoleLanes.critic, criticReview, 'critic');
      criticReviews.push(criticReview);
      if (criticReview.artifacts) Object.assign(aggregatedArtifacts, criticReview.artifacts);
      await recordRalplanSubagentTurn(cwd, runtimeSessionId, {
        threadId: criticReview.thread_id,
        role: 'critic',
        laneId: criticReview.lane_id,
        scope: advisory ? `ralplan-advisory:${advisoryGenerationId}` : options.task,
        summary: criticReview.summary,
        preserveCompletionEvidence: true,
      });

      const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
      const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, {
        ...gateOptions,
        nativeEvidenceComplete: options.requireNativeSubagents !== true
          || await hasCompletedNativeReviewEvidence(cwd, runtimeSessionId, architectReview, criticReview),
      });
      if (advisory && architectReview.verdict === 'approve' && criticReview.verdict === 'approve') {
        advisoryLifecycle = await projectAdvisoryReviewLifecycle({
          cwd,
          sessionId: advisorySessionId!,
          generationId: advisoryGenerationId!,
          activationTurnId: advisoryActivationTurnId!,
          activationCreatedAt: (await readCurrentRalplanAdvisory(cwd, advisorySessionId!))!.activation.created_at,
          rootThreadId: advisoryRootThreadId!,
          iteration,
          planPaths: [latestPlanPath!],
          architect: {
            threadId: requiredAdvisoryIdentity(architectReview.thread_id, 'architect_thread_id'),
            artifactPath: requiredAdvisoryIdentity(architectReview.artifact_path, 'architect_artifact_path'),
            verdict: architectReview.verdict,
            sessionId: architectReview.session_id,
          },
          critic: {
            threadId: requiredAdvisoryIdentity(criticReview.thread_id, 'critic_thread_id'),
            artifactPath: requiredAdvisoryIdentity(criticReview.artifact_path, 'critic_artifact_path'),
            verdict: criticReview.verdict,
            sessionId: criticReview.session_id,
          },
        });
      }
      await writeRalplanState({
        iteration,
        current_phase: 'critic-review',
        latest_critic_verdict: criticReview.verdict,
        latest_critic_summary: criticReview.summary,
        ralplan_consensus_gate: consensusGate,
        review_history: reviewHistory,
      }, runtimeSessionId);

      if (advisory && advisoryLifecycle) {
        const revalidate = async () => (await projectAdvisoryReviewLifecycle({
          cwd,
          sessionId: advisorySessionId!,
          generationId: advisoryGenerationId!,
          activationTurnId: advisoryActivationTurnId!,
          activationCreatedAt: (await readCurrentRalplanAdvisory(cwd, advisorySessionId!))!.activation.created_at,
          rootThreadId: advisoryRootThreadId!,
          iteration,
          planPaths: [latestPlanPath!],
          architect: {
            threadId: requiredAdvisoryIdentity(architectReview.thread_id, 'architect_thread_id'),
            artifactPath: requiredAdvisoryIdentity(architectReview.artifact_path, 'architect_artifact_path'),
            verdict: architectReview.verdict,
            sessionId: architectReview.session_id,
          },
          critic: {
            threadId: requiredAdvisoryIdentity(criticReview.thread_id, 'critic_thread_id'),
            artifactPath: requiredAdvisoryIdentity(criticReview.artifact_path, 'critic_artifact_path'),
            verdict: criticReview.verdict,
            sessionId: criticReview.session_id,
          },
        })).evidence_bundle_sha256;
        await terminalizeRuntimeAdvisory({
          cwd, sessionId: advisorySessionId!, generationId: advisoryGenerationId!,
          closingTurnId: advisoryClosingTurnId!, iteration, outcome: 'approved', lifecycle: advisoryLifecycle,
          revalidateEvidence: revalidate,
          updates: {
            iteration, current_phase: 'complete', completed_at: new Date().toISOString(), planning_complete: true,
            latest_plan_path: latestPlanPath, latest_architect_verdict: architectReview.verdict,
            latest_architect_summary: architectReview.summary, latest_critic_verdict: criticReview.verdict,
            latest_critic_summary: criticReview.summary, ralplan_consensus_gate: consensusGate,
            ralplan_review_lifecycle: advisoryLifecycle, review_history: reviewHistory,
            status_message: 'Status: advisory complete — local review lifecycle approved; control returned to the caller without an automatic execution handoff. Later user instructions follow normal host rules.',
          },
        });
        return {
          status: 'completed', iteration, phase: 'complete', planningComplete: true,
          drafts, architectReviews, criticReviews, ralplanConsensusGate: { ...consensusGate, complete: false },
          latestPlanPath, artifacts: aggregatedArtifacts, workflowVariant: 'advisory',
          ralplanReviewLifecycle: advisoryLifecycle, executionHandoffAuthorized: false,
          hostVerified: false, returnToCaller: true,
        };
      }

      if (consensusGate.complete) {
        // Architect→Critic lifecycle consensus is complete; planning is done and
        // execution may proceed without any host consensus receipt.
        const completedAt = new Date().toISOString();
        const autopilotParent = runtimeSessionId
          ? await readModeStateForExplicitSession('autopilot', runtimeSessionId, cwd)
          : null;
        const supervisedAutopilot = options.selectedExecutionLane === 'ultragoal'
          && autopilotParent?.active === true
          && autopilotParent.current_phase === 'ralplan';
        const executionHandoff = {
          authorized: true,
          reason: 'Sequential Architect and Critic approval completed the execution-ready Ralplan stage.',
          authorized_at: completedAt,
          session_id: runtimeSessionId,
          review_cycle: iteration,
          source: supervisedAutopilot ? 'autopilot' : 'user',
        };
        await updateRalplanState(cwd, {
          active: false,
          iteration,
          current_phase: 'complete',
          completed_at: completedAt,
          planning_complete: true,
          latest_plan_path: latestPlanPath,
          latest_critic_verdict: criticReview.verdict,
          latest_critic_summary: criticReview.summary,
          ralplan_consensus_gate: consensusGate,
          ralplan_execution_handoff: executionHandoff,
          review_history: reviewHistory,
          status_message: 'Status: complete — Architect and Critic consensus is complete; proceed to execution.',
        }, runtimeSessionId);

        if (supervisedAutopilot && runtimeSessionId && autopilotParent) {
            // Never spread a corrupt persisted carrier into a fresh object: that laundered a stored
            // array into a valid-looking record and defeated the writer-side guard. A corrupt parent
            // carrier fails closed here instead.
            // Both representations, because the gate reads either one.
            const parentNested = autopilotParent.state;
            const nestedCarrier = parentNested && typeof parentNested === 'object' && !Array.isArray(parentNested)
              ? (parentNested as Record<string, unknown>).handoff_artifacts
              : undefined;
            requirePersistedHandoffCarrier(nestedCarrier, 'parent state.handoff_artifacts carrier');
            const existingHandoffs = requirePersistedHandoffCarrier(
              autopilotParent.handoff_artifacts,
              'parent handoff_artifacts carrier',
            );
            await updateAutopilotPipelineState({
              active: true,
              current_phase: 'ultragoal',
              handoff_artifacts: {
                ...existingHandoffs,
                ralplan: {
                  plan_path: latestPlanPath,
                  artifacts: aggregatedArtifacts,
                },
              },
              ralplan_consensus_gate: consensusGate,
              ralplan_execution_handoff: executionHandoff,
            }, cwd, runtimeSessionId);
        }
        return {
          status: 'completed',
          iteration,
          phase: 'complete',
            planningComplete: true,
          drafts,
          architectReviews,
          criticReviews,
          ralplanConsensusGate: consensusGate,
          latestPlanPath,
          artifacts: aggregatedArtifacts,
        };
      }

      if (iteration >= maxIterations) {
        const error = `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
        if (advisory) {
          const outcome: AdvisoryOutcome = criticReview.verdict === 'reject' ? 'rejected' : 'exhausted';
          await terminalizeRuntimeAdvisory({
            cwd, sessionId: advisorySessionId!, generationId: advisoryGenerationId!, closingTurnId: advisoryClosingTurnId!,
            iteration, outcome,
            updates: {
              iteration, current_phase: 'failed', completed_at: new Date().toISOString(), planning_complete: false,
              latest_plan_path: latestPlanPath, latest_critic_verdict: criticReview.verdict,
              latest_critic_summary: criticReview.summary, ralplan_consensus_gate: consensusGate,
              review_history: reviewHistory, status_message: `Status: advisory ${outcome} — control returned to the caller without an execution handoff.`, error,
            },
          });
          return {
            status: 'failed', iteration, phase: 'failed', planningComplete: false, drafts, architectReviews, criticReviews,
            ralplanConsensusGate: consensusGate, latestPlanPath, artifacts: aggregatedArtifacts, error,
            workflowVariant: 'advisory', executionHandoffAuthorized: false, hostVerified: false, returnToCaller: true,
          };
        }
        await updateRalplanState(cwd, {
          active: false,
          iteration,
          current_phase: 'failed',
          completed_at: new Date().toISOString(),
          planning_complete: false,
          latest_plan_path: latestPlanPath,
          latest_critic_verdict: criticReview.verdict,
          latest_critic_summary: criticReview.summary,
          ralplan_consensus_gate: consensusGate,
          review_history: reviewHistory,
          status_message: `Status: paused_for_review — ralplan reached the ${maxIterations}-iteration review limit without approval; continue from the best current artifact or ask the user how to proceed.`,
          error,
        }, runtimeSessionId);
        return {
          status: 'failed',
          iteration,
          phase: 'failed',
          planningComplete: false,
          drafts,
          architectReviews,
          criticReviews,
          ralplanConsensusGate: consensusGate,
          latestPlanPath,
          artifacts: aggregatedArtifacts,
          error,
        };
      }

      iteration += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (advisory && advisorySessionId && advisoryGenerationId && advisoryClosingTurnId) {
      const recovered = await reconcileRalplanAdvisory(cwd, advisorySessionId).catch(() => null);
      const recoveredBinding = await readModeStateForExplicitSession('ralplan', advisorySessionId, cwd).catch(() => null);
      if (isCompletedAdvisoryCatchRecovery(recovered, recoveredBinding, advisorySessionId, advisoryGenerationId)) {
        return {
          status: 'completed', iteration, phase: 'complete', planningComplete: true,
          drafts, architectReviews, criticReviews,
          ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
          latestPlanPath, artifacts: aggregatedArtifacts, workflowVariant: 'advisory',
          ...(advisoryLifecycle ? { ralplanReviewLifecycle: advisoryLifecycle } : {}),
          executionHandoffAuthorized: false, hostVerified: false, returnToCaller: true,
        };
      }
      await terminalizeRuntimeAdvisory({
        cwd, sessionId: advisorySessionId, generationId: advisoryGenerationId,
        closingTurnId: advisoryClosingTurnId, iteration, outcome: 'failed',
        updates: {
          iteration, current_phase: 'failed', completed_at: new Date().toISOString(), planning_complete: false,
          latest_plan_path: latestPlanPath, ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
          review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
          status_message: 'Status: advisory failed — control returned to the caller without an execution handoff.', error: message,
        },
      });
      return {
        status: 'failed', iteration, phase: 'failed', planningComplete: false, drafts, architectReviews, criticReviews,
        ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        latestPlanPath, artifacts: aggregatedArtifacts, error: message,
        workflowVariant: 'advisory', executionHandoffAuthorized: false, hostVerified: false, returnToCaller: true,
      };
    }
    await writeRalplanState({
      active: false,
      iteration,
      current_phase: 'failed',
      completed_at: new Date().toISOString(),
      planning_complete: false,
      latest_plan_path: latestPlanPath,
      ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
      review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      status_message: 'Status: failed — ralplan encountered an error and cannot continue without inspecting the failure.',
      error: message,
    }, runtimeSessionId);
    return {
      status: 'failed',
      iteration,
      phase: 'failed',
      planningComplete: false,
      drafts,
      architectReviews,
      criticReviews,
      ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
      latestPlanPath,
      artifacts: aggregatedArtifacts,
      error: message,
    };
  }

  const unreachableError = 'ralplan_runtime_unreachable_state';
  if (advisory && advisorySessionId && advisoryGenerationId && advisoryClosingTurnId) {
    await terminalizeRuntimeAdvisory({
      cwd, sessionId: advisorySessionId, generationId: advisoryGenerationId,
      closingTurnId: advisoryClosingTurnId, iteration, outcome: 'failed',
      updates: {
        iteration, current_phase: 'failed', completed_at: new Date().toISOString(), planning_complete: false,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        status_message: 'Status: advisory failed — unexpected runtime state; control returned to the caller without an execution handoff.', error: unreachableError,
      },
    });
    return {
      status: 'failed', iteration, phase: 'failed', planningComplete: false, drafts, architectReviews, criticReviews,
      ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions), latestPlanPath,
      artifacts: aggregatedArtifacts, error: unreachableError, workflowVariant: 'advisory',
      executionHandoffAuthorized: false, hostVerified: false, returnToCaller: true,
    };
  }
  await writeRalplanState({
    active: false,
    iteration,
    current_phase: 'failed',
    completed_at: new Date().toISOString(),
    planning_complete: false,
    ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
    status_message: 'Status: failed — ralplan reached an unexpected runtime state.',
    error: unreachableError,
  }, runtimeSessionId);
  return {
    status: 'failed',
    iteration,
    phase: 'failed',
    planningComplete: false,
    drafts,
    architectReviews,
    criticReviews,
    ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
    latestPlanPath,
    artifacts: aggregatedArtifacts,
    error: unreachableError,
  };
}

export async function cancelRalplanConsensus(
  cwd?: string,
  sessionId?: string,
  options: { revalidateAuthority?: (checkpoint: string) => void | Promise<void> } = {},
): Promise<boolean> {
  const root = cwd ?? process.cwd();
  await options.revalidateAuthority?.('cancel_read');
  const state = sessionId
    ? await readModeStateForExplicitSession('ralplan', sessionId, root)
    : await readModeState('ralplan', root);
  if (state?.workflow_variant === 'advisory') {
    const advisorySessionId = requiredAdvisoryIdentity(sessionId ?? String(state.session_id ?? ''), 'session_id');
    const projection = await readCurrentRalplanAdvisory(root, advisorySessionId);
    await options.revalidateAuthority?.('cancel_projection');
    if (!projection || projection.corruption) {
      throw new Error(`ralplan_advisory_cancel_projection_unavailable:${projection?.corruption ?? 'missing'}`);
    }
    const generationId = requiredAdvisoryIdentity(
      String(state.advisory_generation_id ?? projection.activation.generation_id),
      'generation_id',
    );
    const closingTurnId = requiredAdvisoryIdentity(
      String(projection.fence?.closing_turn_id ?? state.turn_id ?? projection.activation.activation_turn_id),
      'closing_turn_id',
    );
    if (projection.fence?.state === 'pending_closeout' && !projection.journal) {
      await administrativelyAbandonRalplanAdvisory({
        cwd: root, sessionId: advisorySessionId, generationId,
        rootThreadId: requiredAdvisoryIdentity(String(state.thread_id ?? projection.activation.root_thread_id), 'root_thread_id'),
        turnId: closingTurnId,
        beforeMutation: options.revalidateAuthority,
      });
      await options.revalidateAuthority?.('cancel_mode_update');
      await updateRalplanState(root, {
        active: false, current_phase: 'cancelled', completed_at: new Date().toISOString(), planning_complete: false,
        workflow_variant: 'advisory', advisory_generation_id: generationId,
        advisory_closing_turn_id: closingTurnId, execution_handoff_authorized: false, host_verified: false,
        ralplan_consensus_gate: { ...buildRalplanConsensusGate([], []), complete: false },
        status_message: 'Status: advisory administratively abandoned — control returned to the caller; later user instructions follow normal host rules.',
      }, advisorySessionId, options.revalidateAuthority
        ? (site) => options.revalidateAuthority?.(`mode_commit_${site}`)
        : undefined);
      await options.revalidateAuthority?.('mode_update_complete');
      await options.revalidateAuthority?.('cancel_mode_updated');
      return true;
    }
    await terminalizeRuntimeAdvisory({
      cwd: root, sessionId: advisorySessionId, generationId, closingTurnId,
      iteration: typeof state.iteration === 'number' && state.iteration > 0 ? state.iteration : 1,
      outcome: 'cancelled',
      updates: {
        current_phase: 'cancelled', completed_at: new Date().toISOString(), planning_complete: false,
        status_message: 'Status: advisory cancelled — control returned to the caller; later user instructions follow normal host rules.',
      },
      revalidateAuthority: options.revalidateAuthority,
    });
    return true;
  }
  if (state?.active) {
    await updateModeState('ralplan', {
      active: false,
      current_phase: 'cancelled',
      completed_at: new Date().toISOString(),
    }, root, sessionId);
    return true;
  }
  return false;
}
