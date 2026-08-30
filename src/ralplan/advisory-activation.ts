import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { startMode } from '../modes/base.js';
import { getBaseStateDir } from '../mcp/state-paths.js';
import { getSkillActiveStatePathsForStateDir, listActiveSkills, mergeRootSkillStateForExactSession, updateRootSkillActiveStateForStateDir, writeSkillActiveStateCopiesForStateDir } from '../state/skill-active.js';
import { syncExplicitSessionModeState } from '../state/operations.js';
import {
  commitPreparedRalplanAdvisoryActivationInternal,
  prepareRalplanAdvisoryActivationInternal,
  readAuthorizedPendingRalplanActivation,
  readCurrentRalplanAdvisory,
  reconcileRalplanAdvisory,
  type AdvisoryActivation,
  type AdvisoryProjection,
} from './advisory.js';
import { describeAdvisoryActivationProjections, verifyPinnedJsonAndSync } from './advisory-activation-verifier.js';

export type AdvisoryActivationCheckpoint =
  | 'after_intent'
  | 'after_mode'
  | 'after_run_state'
  | 'after_session_skill'
  | 'after_root_skill'
  | 'before_mode_fsync'
  | 'before_commit'
  | 'intent_committed';

export interface ActivateOrResumeRalplanAdvisoryInput {
  cwd: string;
  sessionId: string;
  rootThreadId: string;
  activationTurnId: string;
  prompt: string;
  producer: 'native' | string;
  threadKind: 'root-or-drift' | string;
  generationId?: string;
  predecessorGenerationId?: string;
  maxIterations?: number;
  nowIso?: string;
  resumeOnly?: boolean;
  failpoint?: (checkpoint: AdvisoryActivationCheckpoint) => void | Promise<void>;
}

type AdvisoryActivationResult = { activation: AdvisoryActivation; projection: AdvisoryProjection };

function parseRecord(raw: string, path: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ralplan_advisory_activation_projection_invalid:${path}`);
  }
  return value as Record<string, unknown>;
}

async function readExistingRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { return parseRecord(await handle.readFile('utf8'), path); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Single activation owner for Ralplan Advisory. The durable intent remains in
 * place until every canonical runtime projection is present, verified, and
 * fsynced; retries repair those projections for the same generation.
 */
export function activateOrResumeRalplanAdvisory(
  input: ActivateOrResumeRalplanAdvisoryInput & { resumeOnly: true },
): Promise<AdvisoryActivationResult | null>;
export function activateOrResumeRalplanAdvisory(
  input: ActivateOrResumeRalplanAdvisoryInput & { resumeOnly?: false | undefined },
): Promise<AdvisoryActivationResult>;
export async function activateOrResumeRalplanAdvisory(
  input: ActivateOrResumeRalplanAdvisoryInput,
): Promise<AdvisoryActivationResult | null> {
  if (input.producer !== 'native' || input.threadKind !== 'root-or-drift') {
    if (input.resumeOnly) return null;
    throw new Error('ralplan_advisory_activation_authority_required');
  }
  const authority = {
    cwd: input.cwd, sessionId: input.sessionId, producer: input.producer, threadKind: input.threadKind,
    rootThreadId: input.rootThreadId, activationTurnId: input.activationTurnId, prompt: input.prompt,
  };
  let activation = await readAuthorizedPendingRalplanActivation(authority);
  if (!activation && input.resumeOnly) return null;
  if (!activation) {
    const committed = await readCurrentRalplanAdvisory(input.cwd, input.sessionId);
    if (committed?.activation) {
      const expectedPrompt = createHash('sha256').update(input.prompt).digest('hex');
      const sameIdentity = committed.activation.root_thread_id === input.rootThreadId
        && committed.activation.activation_turn_id === input.activationTurnId
        && committed.activation.activation_prompt_sha256 === expectedPrompt;
      const binding = await readExistingRecord(join(
        getBaseStateDir(input.cwd), 'sessions', input.sessionId, 'ralplan-state.json',
      ));
      if (sameIdentity && binding?.active === true && binding.workflow_variant === 'advisory'
        && binding.advisory_generation_id === committed.activation.generation_id) {
        return { activation: committed.activation, projection: committed };
      }
      if (binding?.active === true && binding.workflow_variant === 'advisory') {
        throw new Error('ralplan_advisory_committed_activation_authority_mismatch');
      }
    }
    const existingBinding = await readExistingRecord(join(
      getBaseStateDir(input.cwd), 'sessions', input.sessionId, 'ralplan-state.json',
    ));
    if (existingBinding?.active === true) throw new Error('ralplan_advisory_start_binding_conflict');
    activation = await prepareRalplanAdvisoryActivationInternal({
      cwd: input.cwd, sessionId: input.sessionId, rootThreadId: input.rootThreadId,
      activationTurnId: input.activationTurnId, activationPrompt: input.prompt,
      ...(input.generationId ? { generationId: input.generationId } : {}),
      ...(input.predecessorGenerationId ? { predecessorGenerationId: input.predecessorGenerationId } : {}),
      ...(input.nowIso ? { nowIso: input.nowIso } : {}),
    });
    await input.failpoint?.('after_intent');
  }

  await startMode('ralplan', input.prompt, input.maxIterations ?? 50, input.cwd, input.sessionId, {
    kind: 'ralplan-advisory', sessionId: input.sessionId, generationId: activation.generation_id,
    rootThreadId: input.rootThreadId, activationTurnId: input.activationTurnId,
    activationPrompt: input.prompt,
  });
  await syncExplicitSessionModeState('ralplan', input.cwd, input.sessionId);

  const stateDir = getBaseStateDir(input.cwd);
  const skillPaths = getSkillActiveStatePathsForStateDir(stateDir, input.sessionId);
  if (!skillPaths.sessionPath) throw new Error('ralplan_advisory_activation_session_skill_path_missing');
  const sessionSkill = await verifyPinnedJsonAndSync(skillPaths.sessionPath, () => true);
  const advisorySkill = {
    ...sessionSkill,
    workflow_variant: 'advisory',
    advisory_generation_id: activation.generation_id,
    active_skills: listActiveSkills(sessionSkill).map((entry) => entry.skill === 'ralplan'
      ? { ...entry, workflow_variant: 'advisory' as const, advisory_generation_id: activation!.generation_id }
      : entry),
  };
  await writeSkillActiveStateCopiesForStateDir(stateDir, advisorySkill, input.sessionId, null);
  await updateRootSkillActiveStateForStateDir(
    stateDir,
    (currentRoot) => mergeRootSkillStateForExactSession(currentRoot, advisorySkill, input.sessionId),
  );
  const projections = describeAdvisoryActivationProjections(stateDir, input.sessionId, activation.generation_id);
  const verifyMode = (beforeSync?: () => void | Promise<void>) => verifyPinnedJsonAndSync(
    projections.mode.path, projections.mode.predicate, beforeSync,
  );
  const verifyRun = () => verifyPinnedJsonAndSync(projections.run.path, projections.run.predicate);
  const verifySessionSkill = () => verifyPinnedJsonAndSync(projections.sessionSkill.path, projections.sessionSkill.predicate);
  const verifyRootSkill = () => verifyPinnedJsonAndSync(projections.rootSkill.path, projections.rootSkill.predicate);

  await verifyMode(() => input.failpoint?.('before_mode_fsync'));
  await input.failpoint?.('after_mode');
  await verifyRun();
  await input.failpoint?.('after_run_state');

  await verifySessionSkill();
  await input.failpoint?.('after_session_skill');
  await verifyRootSkill();
  await input.failpoint?.('after_root_skill');
  await input.failpoint?.('before_commit');

  await commitPreparedRalplanAdvisoryActivationInternal({
    cwd: input.cwd, sessionId: input.sessionId,
    producer: input.producer, threadKind: input.threadKind, rootThreadId: input.rootThreadId,
    activationTurnId: input.activationTurnId,
    failpoint: (name) => name === 'intent_committed' ? input.failpoint?.('intent_committed') : undefined,
  });
  const projection = await reconcileRalplanAdvisory(input.cwd, input.sessionId);
  if (!projection || projection.corruption) {
    throw new Error(`ralplan_advisory_activation_commit_failed:${projection?.corruption ?? 'missing'}`);
  }
  return { activation, projection };
}
