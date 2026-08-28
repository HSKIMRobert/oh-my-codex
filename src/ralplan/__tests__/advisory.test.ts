import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  advisoryIterationId,
  digestAdvisoryArtifacts,
  pinDirectory,
  projectAdvisoryReviewLifecycle,
} from '../advisory-evidence.js';
import {
  administrativelyAbandonRalplanAdvisory,
  activateRalplanAdvisory,
  advisoryFenceBlocksProductWrites,
  classifyAdvisoryPrompt,
  prepareAdvisoryCloseout,
  ralplanAdvisoryEventsPath,
  readCurrentRalplanAdvisory,
  reconcileRalplanAdvisory,
  releaseAdvisoryFence,
  terminalizeRalplanAdvisory,
  validateAdvisoryInactiveState,
} from '../advisory.js';
import { updateModeState } from '../../modes/base.js';

const roots: string[] = [];
async function fixture(): Promise<{ cwd: string; sessionId: string; lifecycle: Awaited<ReturnType<typeof projectAdvisoryReviewLifecycle>> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-'));
  roots.push(cwd);
  const sessionId = 'session-a';
  await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
  await mkdir(join(cwd, '.omx', 'artifacts'), { recursive: true });
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  await writeFile(join(cwd, '.omx', 'plans', 'plan.md'), '# exact plan\n');
  await writeFile(join(cwd, '.omx', 'artifacts', 'architect.md'), 'APPROVE architecture\n');
  await writeFile(join(cwd, '.omx', 'artifacts', 'critic.md'), 'APPROVE correctness\n');
  await writeFile(join(cwd, '.omx', 'state', 'subagent-tracking.json'), JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'root-a',
        updated_at: '2026-08-28T00:00:03.000Z',
        threads: {
          architect: { thread_id: 'architect', kind: 'subagent', role: 'architect', provenance_kind: 'native_subagent', direct_child_root_id: 'root-a', direct_child_parent_id: 'root-a', scope: 'ralplan-advisory:generation-a', first_seen_at: '2026-08-28T00:00:00.000Z', last_seen_at: '2026-08-28T00:00:01.000Z', completed_at: '2026-08-28T00:00:01.000Z', turn_count: 1 },
          critic: { thread_id: 'critic', kind: 'subagent', role: 'critic', provenance_kind: 'native_subagent', direct_child_root_id: 'root-a', direct_child_parent_id: 'root-a', scope: 'ralplan-advisory:generation-a', first_seen_at: '2026-08-28T00:00:02.000Z', last_seen_at: '2026-08-28T00:00:03.000Z', completed_at: '2026-08-28T00:00:03.000Z', turn_count: 1 },
        },
      },
    },
  }));
  const activation = await activateRalplanAdvisory({ cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a', nowIso: '2026-08-27T23:59:59.000Z' });
  await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
  await writeFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-state.json'), JSON.stringify({
    active: true, mode: 'ralplan', current_phase: 'draft', session_id: sessionId, thread_id: 'root-a', turn_id: 'turn-a',
    workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
  }));
  const committed = await reconcileRalplanAdvisory(cwd, sessionId, {
    producer: 'native', threadKind: 'root-or-drift', rootThreadId: 'root-a', activationTurnId: 'turn-a',
  });
  if (committed?.corruption) throw new Error(committed.corruption);
  const lifecycle = await projectAdvisoryReviewLifecycle({
    cwd, sessionId, generationId: activation.generation_id, activationTurnId: 'turn-a', activationCreatedAt: activation.created_at, rootThreadId: 'root-a', iteration: 1,
    planPaths: ['.omx/plans/plan.md'],
    architect: { threadId: 'architect', artifactPath: '.omx/artifacts/architect.md', verdict: 'approve' },
    critic: { threadId: 'critic', artifactPath: '.omx/artifacts/critic.md', verdict: 'approve' },
  });
  return { cwd, sessionId, lifecycle };
}

async function bindAndCommitActivation(
  cwd: string,
  sessionId: string,
  activation: { generation_id: string; root_thread_id: string; activation_turn_id: string },
): Promise<Awaited<ReturnType<typeof reconcileRalplanAdvisory>>> {
  const path = join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-state.json');
  await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(await readFile(path, 'utf8')); } catch {}
  await writeFile(path, JSON.stringify({ ...state, active: true, mode: 'ralplan', session_id: sessionId,
    thread_id: activation.root_thread_id, turn_id: activation.activation_turn_id,
    workflow_variant: 'advisory', advisory_generation_id: activation.generation_id }));
  return reconcileRalplanAdvisory(cwd, sessionId, {
    producer: 'native', threadKind: 'root-or-drift', rootThreadId: activation.root_thread_id,
    activationTurnId: activation.activation_turn_id,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ralplan advisory evidence', () => {
  it('binds exact bytes, path, generation, iteration, and architect digest', async () => {
    const { cwd, lifecycle } = await fixture();
    const same = await digestAdvisoryArtifacts(cwd, ['.omx/plans/plan.md']);
    assert.equal(lifecycle.complete, true);
    assert.equal(lifecycle.plan_manifest_sha256, same.sha256);
    assert.notEqual(
      advisoryIterationId({ generationId: 'generation-b', sessionId: 'session-a', activationTurnId: 'turn-a', iteration: 1, planManifestSha256: same.sha256 }),
      lifecycle.iteration_id,
    );
  });

  it('rejects symlinks and traversal and reads through a pinned directory descriptor', async () => {
    const { cwd } = await fixture();
    const pinned = await pinDirectory(join(cwd, '.omx', 'plans'));
    try { assert.equal((await pinned.readFile('plan.md')).toString(), '# exact plan\n'); } finally { await pinned.close(); }
    await symlink(join(cwd, '.omx', 'plans', 'plan.md'), join(cwd, '.omx', 'plans', 'link.md'));
    await assert.rejects(digestAdvisoryArtifacts(cwd, ['.omx/plans/link.md']), /symlink/);
    await assert.rejects(digestAdvisoryArtifacts(cwd, [join(cwd, '.omx', 'plans', 'link.md')]), /symlink/);
    await assert.rejects(digestAdvisoryArtifacts(cwd, ['../outside']), /outside/);
  });

  it('fails closed when an allowed directory is swapped after canonical validation', async () => {
    const { cwd } = await fixture();
    const plans = join(cwd, '.omx', 'plans');
    const originalPlans = join(cwd, '.omx', 'plans-original');
    const outside = join(cwd, 'outside-plans');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'plan.md'), '# outside attacker bytes\n');
    let swaps = 0;
    await assert.rejects(
      digestAdvisoryArtifacts(cwd, ['.omx/plans/plan.md'], {
        afterCanonicalArtifactPath: async ({ relative }) => {
          if (relative !== '.omx/plans/plan.md' || swaps > 0) return;
          swaps += 1;
          await rename(plans, originalPlans);
          await symlink(outside, plans);
        },
      }),
      /directory_(?:not_canonical|identity_changed)/,
    );
    assert.equal(swaps, 1);
  });

  it('rejects same-inode overwrites between the outer snapshot and pinned read', async () => {
    const { cwd } = await fixture();
    const plan = join(cwd, '.omx', 'plans', 'plan.md');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await writeFile(plan, '# exact plan\n');
      let overwroteSameInode = false;
      await assert.rejects(digestAdvisoryArtifacts(cwd, ['.omx/plans/plan.md'], {
        beforePinnedRead: async ({ absolute }) => {
          const before = await lstat(absolute, { bigint: true });
          await writeFile(absolute, '# evil plan!\n');
          const after = await lstat(absolute, { bigint: true });
          overwroteSameInode = before.dev === after.dev && before.ino === after.ino;
        },
      }), /artifact_(?:identity_changed|changed_during_read|read_failed)/);
      assert.equal(overwroteSameInode, true, `attempt ${attempt}`);
    }
  });

  it('enforces the documented Darwin 128 KiB pinned read ceiling', async () => {
    if (process.platform !== 'darwin') return;
    const { cwd } = await fixture();
    const pinned = await pinDirectory(join(cwd, '.omx', 'plans'));
    try { await assert.rejects(pinned.readFile('plan.md', 128 * 1024 + 1), /limit_unsupported/); }
    finally { await pinned.close(); }
  });

  it('rejects tracker role, ordering, and artifact changes', async () => {
    const { cwd, sessionId } = await fixture();
    const trackerPath = join(cwd, '.omx', 'state', 'subagent-tracking.json');
    const tracker = JSON.parse(await readFile(trackerPath, 'utf8'));
    tracker.sessions[sessionId].threads.critic.first_seen_at = '2026-08-27T00:00:00.000Z';
    await writeFile(trackerPath, JSON.stringify(tracker));
    await assert.rejects(projectAdvisoryReviewLifecycle({
      cwd, sessionId, generationId: 'generation-a', activationTurnId: 'turn-a', activationCreatedAt: '2026-08-27T23:59:59.000Z', rootThreadId: 'root-a', iteration: 1,
      planPaths: ['.omx/plans/plan.md'],
      architect: { threadId: 'architect', artifactPath: '.omx/artifacts/architect.md', verdict: 'approve' },
      critic: { threadId: 'critic', artifactPath: '.omx/artifacts/critic.md', verdict: 'approve' },
    }), /sequence/);
  });

  it('requires strict native direct-child evidence bound to root, session, activation, and generation', async () => {
    const { cwd, sessionId } = await fixture();
    const trackerPath = join(cwd, '.omx', 'state', 'subagent-tracking.json');
    const baseline = JSON.parse(await readFile(trackerPath, 'utf8'));
    const project = () => projectAdvisoryReviewLifecycle({
      cwd, sessionId, generationId: 'generation-a', activationTurnId: 'turn-a',
      activationCreatedAt: '2026-08-27T23:59:59.000Z', rootThreadId: 'root-a', iteration: 1,
      planPaths: ['.omx/plans/plan.md'],
      architect: { threadId: 'architect', artifactPath: '.omx/artifacts/architect.md', verdict: 'approve', sessionId },
      critic: { threadId: 'critic', artifactPath: '.omx/artifacts/critic.md', verdict: 'approve', sessionId },
    });
    const mutations: Array<(tracker: any) => void> = [
      (tracker) => { delete tracker.sessions[sessionId].threads.architect.provenance_kind; },
      (tracker) => { tracker.sessions[sessionId].threads.architect.direct_child_parent_id = 'nested-parent'; },
      (tracker) => { tracker.sessions[sessionId].leader_thread_id = 'foreign-root'; },
      (tracker) => { tracker.sessions[sessionId].threads.critic.first_seen_at = '2026-08-27T23:59:58.000Z'; },
      (tracker) => { tracker.sessions[sessionId].threads.critic.scope = 'ralplan-advisory:generation-b'; },
    ];
    for (const mutate of mutations) {
      const tracker = structuredClone(baseline);
      mutate(tracker);
      await writeFile(trackerPath, JSON.stringify(tracker));
      await assert.rejects(project(), /tracker_evidence_invalid|review_sequence_invalid/);
    }
  });
});

describe('ralplan advisory fence and journal', () => {
  it('persists pending before writes and converges after every retryable journal failpoint', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    let writes = 0;
    await assert.rejects(terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      applyStep: async () => { writes += 1; },
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
      failpoint: (name) => { if (name === 'session_mode') throw new Error('crash'); },
    }), /crash/);
    const pending = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(pending?.fence?.state, 'pending_closeout');
    assert.equal(advisoryFenceBlocksProductWrites(pending), true);
    const complete = await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      applyStep: async () => { writes += 1; },
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
    });
    assert.equal(complete.fence?.state, 'closed');
    assert.equal(complete.journal?.phase, 'committed');
    assert.equal(writes, 4);
  });

  it('moves to recovery_required when the post-write bundle digest changes', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    const result = await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      revalidateEvidence: async () => '0'.repeat(64),
    });
    assert.equal(result.fence?.state, 'recovery_required');
    assert.equal(result.journal?.phase, 'prepared');
  });

  it('rejects approved+proven without complete lifecycle digests and revalidation, while approved+unproven recovers', async () => {
    const first = await fixture();
    await assert.rejects(terminalizeRalplanAdvisory({
      cwd: first.cwd, sessionId: first.sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven',
    }), /requires_complete_lifecycle_and_revalidation/);
    await assert.rejects(terminalizeRalplanAdvisory({
      cwd: first.cwd, sessionId: first.sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle: first.lifecycle,
    }), /requires_complete_lifecycle_and_revalidation/);
    const second = await fixture();
    const recovery = await terminalizeRalplanAdvisory({
      cwd: second.cwd, sessionId: second.sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'unproven',
    });
    assert.equal(recovery.fence?.state, 'recovery_required');
    assert.equal(recovery.denyProductWrites, true);
  });

  it('durably abandons recovery state and leaves a canonically valid inactive boundary', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      revalidateEvidence: async () => '0'.repeat(64),
    });
    const journalPath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'generation-a', 'closeout-journal.json');
    const originalJournal = await readFile(journalPath, 'utf8');
    const abandoned = await releaseAdvisoryFence({
      cwd, sessionId, turnId: 'turn-b', threadId: 'root-a', prompt: 'abandoná el advisory',
      producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false,
    });
    assert.equal(abandoned.projection?.fence?.state, 'abandoned');
    assert.equal(await readFile(journalPath, 'utf8'), originalJournal);
    assert.equal(abandoned.projection?.journal?.phase, 'prepared');
    assert.equal(abandoned.projection?.journal?.outcome, 'approved');
    assert.equal(abandoned.projection?.admin_event?.action, 'abandon');
    assert.equal(validateAdvisoryInactiveState({
      mode: 'ralplan', workflow_variant: 'advisory', active: false, advisory_generation_id: 'generation-a',
      execution_handoff_authorized: false, host_verified: false, ralplan_consensus_gate: { complete: false },
    }, abandoned.projection), null);
  });

  it('idempotently finishes append-only admin abandonment after fence/admin failpoints for prepared and committed journals', async () => {
    for (const phase of ['prepared', 'committed'] as const) {
      for (const failpoint of ['after_fence_event', 'after_admin_event'] as const) {
        const { cwd, sessionId, lifecycle } = await fixture();
        await terminalizeRalplanAdvisory({
          cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
          outcome: 'approved', integrityStatus: 'proven', lifecycle,
          revalidateEvidence: async () => phase === 'prepared' ? '0'.repeat(64) : lifecycle.evidence_bundle_sha256,
        });
        const journalPath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'generation-a', 'closeout-journal.json');
        const originalJournal = await readFile(journalPath, 'utf8');
        await assert.rejects(administrativelyAbandonRalplanAdvisory({
          cwd, sessionId, generationId: 'generation-a', rootThreadId: 'root-a', turnId: `turn-admin-${phase}-${failpoint}`,
          failpoint: (name) => { if (name === failpoint) throw new Error(`crash:${name}`); },
        }), /crash/);
        const recovered = await administrativelyAbandonRalplanAdvisory({
          cwd, sessionId, generationId: 'generation-a', rootThreadId: 'root-a', turnId: `turn-admin-${phase}-${failpoint}`,
        });
        assert.equal(recovered.fence?.state, 'abandoned');
        assert.equal(recovered.admin_event?.action, 'abandon');
        assert.equal(await readFile(journalPath, 'utf8'), originalJournal);
        const idempotent = await administrativelyAbandonRalplanAdvisory({
          cwd, sessionId, generationId: 'generation-a', rootThreadId: 'root-a', turnId: `turn-admin-${phase}-${failpoint}`,
        });
        assert.equal(idempotent.fence?.sequence, recovered.fence?.sequence);
      }
    }
  });

  it('reconciles a crash after journal commit without weakening the fence', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await assert.rejects(terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
      failpoint: (name) => { if (name === 'journal_commit') throw new Error('crash-after-commit'); },
    }), /crash-after-commit/);
    assert.equal((await readCurrentRalplanAdvisory(cwd, sessionId))?.fence?.state, 'pending_closeout');
    const reconciled = await reconcileRalplanAdvisory(cwd, sessionId);
    assert.equal(reconciled?.fence?.state, 'closed');
    assert.equal(reconciled?.journal?.steps.fence_terminal, 'applied');
  });

  it('reconciles only the missing abandoned journal tail without fabricating audit fields', async () => {
    const { cwd, sessionId } = await fixture();
    const result = await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'cancelled', integrityStatus: 'proven', nowIso: '2026-08-28T00:00:04.000Z',
    });
    const journalPath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'generation-a', 'closeout-journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.steps.fence_terminal = 'pending';
    await writeFile(journalPath, JSON.stringify(journal));
    const reconciled = await reconcileRalplanAdvisory(cwd, sessionId);
    assert.equal(reconciled?.fence?.state, 'abandoned');
    assert.equal(reconciled?.journal?.steps.fence_terminal, 'applied');
    assert.equal(reconciled?.journal?.outcome, 'cancelled');
    assert.equal(reconciled?.journal?.terminal_timestamp, '2026-08-28T00:00:04.000Z');
    assert.equal(result.fence?.sequence, reconciled?.fence?.sequence);
  });

  it('repairs drifted closeout mirrors even after the fence is terminal', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', sessionId);
    await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: join(cwd, '.omx', 'state') }));
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
      active: true, mode: 'ralplan', current_phase: 'critic-review', iteration: 1,
      session_id: sessionId, workflow_variant: 'advisory', advisory_generation_id: 'generation-a',
    }));
    const patch = { active: false, current_phase: 'complete', workflow_variant: 'advisory', advisory_generation_id: 'generation-a', execution_handoff_authorized: false, host_verified: false, ralplan_consensus_gate: { complete: false } };
    await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle, terminalModeUpdates: patch,
      applyStep: async (step, stored) => { if (step === 'session_mode') await updateModeState('ralplan', stored!, cwd, sessionId); },
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
    });
    const drifted = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    drifted.active = true;
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(drifted));
    const reconciled = await reconcileRalplanAdvisory(cwd, sessionId);
    assert.equal(reconciled?.fence?.state, 'closed');
    assert.equal(JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8')).active, false);
  });

  it('reconciles the exact stored patch across all four mirrors for closed and abandoned while preserving unrelated skills', async () => {
    for (const outcome of ['approved', 'cancelled'] as const) {
      const { cwd, sessionId, lifecycle } = await fixture();
      const stateDir = join(cwd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: stateDir }));
      const activeMode = {
        active: true, mode: 'ralplan', current_phase: 'critic-review', iteration: 1,
        session_id: sessionId, workflow_variant: 'advisory', advisory_generation_id: 'generation-a',
        unrelated_mode_field: 'preserve-me',
      };
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(activeMode));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify(activeMode));
      const activeSkills = {
        active: true, skill: 'ralplan', session_id: sessionId,
        active_skills: [
          { skill: 'team', active: true, phase: 'executing', session_id: sessionId, unrelated: 'keep' },
          { skill: 'ralplan', active: true, phase: 'critic-review', session_id: sessionId },
        ],
      };
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(activeSkills));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(activeSkills));
      const patch = {
        active: false, current_phase: outcome === 'approved' ? 'complete' : 'cancelled',
        completed_at: '2026-08-28T00:00:04.000Z', workflow_variant: 'advisory',
        advisory_generation_id: 'generation-a', execution_handoff_authorized: false, host_verified: false,
        ralplan_consensus_gate: { complete: false },
      };
      await terminalizeRalplanAdvisory({
        cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
        outcome, integrityStatus: 'proven', ...(outcome === 'approved' ? { lifecycle } : {}), terminalModeUpdates: patch,
        applyStep: async (step, stored) => { if (step === 'session_mode') await updateModeState('ralplan', stored!, cwd, sessionId); },
        ...(outcome === 'approved' ? { revalidateEvidence: async () => lifecycle.evidence_bundle_sha256 } : {}),
      });
      const storedSkillProjections = new Map<string, any>();
      for (const path of [join(sessionDir, 'skill-active-state.json'), join(stateDir, 'skill-active-state.json')]) {
        storedSkillProjections.set(path, JSON.parse(await readFile(path, 'utf8')));
      }
      for (const path of [join(sessionDir, 'ralplan-state.json'), join(stateDir, 'ralplan-state.json')]) {
        const drifted = JSON.parse(await readFile(path, 'utf8'));
        drifted.active = true;
        drifted.current_phase = 'draft';
        await writeFile(path, JSON.stringify(drifted));
      }
      for (const path of [join(sessionDir, 'skill-active-state.json'), join(stateDir, 'skill-active-state.json')]) {
        await writeFile(path, JSON.stringify({ ...activeSkills, drifted_field: 'remove-me', active_skills: activeSkills.active_skills.map((entry) => ({ ...entry, phase: 'drifted' })) }));
      }
      const reconciled = await reconcileRalplanAdvisory(cwd, sessionId);
      assert.equal(reconciled?.fence?.state, outcome === 'approved' ? 'closed' : 'abandoned');
      for (const path of [join(sessionDir, 'ralplan-state.json'), join(stateDir, 'ralplan-state.json')]) {
        const mode = JSON.parse(await readFile(path, 'utf8'));
        for (const [key, value] of Object.entries(patch)) assert.deepEqual(mode[key], value, `${outcome}:${path}:${key}`);
        assert.equal(mode.unrelated_mode_field, 'preserve-me');
      }
      for (const path of [join(sessionDir, 'skill-active-state.json'), join(stateDir, 'skill-active-state.json')]) {
        const skill = JSON.parse(await readFile(path, 'utf8'));
        assert.deepEqual(skill, storedSkillProjections.get(path));
        assert.equal(skill.active_skills.some((entry: any) => entry.skill === 'ralplan' && entry.active !== false), false);
        assert.equal(skill.active_skills.some((entry: any) => entry.skill === 'team' && entry.unrelated === 'keep'), true);
      }
    }
  });

  it('uses the journal-stored outcome, patch, and timestamp on terminalization retry', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', sessionId);
    await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: join(cwd, '.omx', 'state') }));
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({ active: true, mode: 'ralplan', session_id: sessionId, workflow_variant: 'advisory', advisory_generation_id: 'generation-a' }));
    const storedPatch = { active: false, current_phase: 'complete', completed_at: '2026-08-28T00:00:04.000Z', workflow_variant: 'advisory', advisory_generation_id: 'generation-a', execution_handoff_authorized: false, host_verified: false };
    await assert.rejects(terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle, terminalModeUpdates: storedPatch,
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
      nowIso: '2026-08-28T00:00:04.000Z', failpoint: (name) => { if (name === 'journal-prepare') throw new Error('crash'); },
    }), /crash/);
    const result = await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'cancelled', integrityStatus: 'unproven', lifecycle,
      terminalModeUpdates: { ...storedPatch, current_phase: 'cancelled', completed_at: '2099-01-01T00:00:00.000Z' },
      applyStep: async (step, stored) => { if (step === 'session_mode') await updateModeState('ralplan', stored!, cwd, sessionId); },
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
      nowIso: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(result.fence?.state, 'closed');
    assert.equal(result.fence?.outcome, 'approved');
    assert.equal(result.journal?.terminal_timestamp, '2026-08-28T00:00:04.000Z');
    assert.equal(JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8')).completed_at, '2026-08-28T00:00:04.000Z');
  });

  it('replays a stored terminal mode patch after a crash before canonical writes', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: stateDir }));
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
      active: true, mode: 'ralplan', current_phase: 'critic-review', iteration: 1, max_iterations: 1,
      started_at: new Date().toISOString(), session_id: sessionId,
      workflow_variant: 'advisory', advisory_generation_id: 'generation-a',
      latest_plan_path: join(cwd, '.omx', 'plans', 'plan.md'),
      review_history: [{
        draft: { planPath: join(cwd, '.omx', 'plans', 'plan.md') },
        architect_review: { verdict: 'approve', thread_id: 'architect', artifact_path: '.omx/artifacts/architect.md', session_id: sessionId },
        critic_review: { verdict: 'approve', thread_id: 'critic', artifact_path: '.omx/artifacts/critic.md', session_id: sessionId },
      }],
    }));
    const terminalModeUpdates = {
      active: false, current_phase: 'complete', planning_complete: true,
      workflow_variant: 'advisory', advisory_generation_id: 'generation-a',
      ralplan_review_lifecycle: lifecycle, execution_handoff_authorized: false, host_verified: false,
    };
    await assert.rejects(terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle, terminalModeUpdates,
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
      failpoint: (name) => { if (name === 'journal-prepare') throw new Error('crash-before-writes'); },
    }), /crash-before-writes/);
    const reconciled = await reconcileRalplanAdvisory(cwd, sessionId);
    assert.equal(reconciled?.fence?.state, 'closed');
    assert.equal(reconciled?.journal?.phase, 'committed');
    const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    assert.equal(state.active, false);
    assert.equal(state.advisory_generation_id, 'generation-a');
  });

  it('persists both expected skill projections before mirror steps and never learns later drift', async () => {
    const { cwd, sessionId } = await fixture();
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: stateDir }));
    const mode = { active: true, mode: 'ralplan', current_phase: 'draft', session_id: sessionId,
      workflow_variant: 'advisory', advisory_generation_id: 'generation-a' };
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(mode));
    await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify(mode));
    const initialSkills = { active: true, skill: 'ralplan', session_id: sessionId, marker: 'pre-journal', active_skills: [
      { skill: 'team', active: true, phase: 'working', session_id: sessionId, marker: 'preserve' },
      { skill: 'ralplan', active: true, phase: 'draft', session_id: sessionId },
    ] };
    await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(initialSkills));
    await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(initialSkills));
    const patch = { active: false, current_phase: 'cancelled', workflow_variant: 'advisory',
      advisory_generation_id: 'generation-a', execution_handoff_authorized: false, host_verified: false,
      ralplan_consensus_gate: { complete: false } };
    await assert.rejects(terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'cancelled', integrityStatus: 'proven', terminalModeUpdates: patch,
      failpoint: (name) => { if (name === 'journal-prepare') throw new Error('crash-before-mirrors'); },
    }), /crash-before-mirrors/);
    const journalPath = join(sessionDir, 'ralplan-advisory', 'generation-a', 'closeout-journal.json');
    const stored = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.ok(Object.prototype.hasOwnProperty.call(stored.terminal_skill_updates, 'session_skill'));
    assert.ok(Object.prototype.hasOwnProperty.call(stored.terminal_skill_updates, 'root_skill'));
    assert.equal(Object.values(stored.steps).some((value) => value === 'applied'), false);
    const drift = { active: true, skill: 'ralplan', session_id: sessionId, marker: 'attacker-drift',
      active_skills: [{ skill: 'ralplan', active: true, session_id: sessionId, marker: 'learn-me' }] };
    await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(drift));
    await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(drift));
    const reconciled = await reconcileRalplanAdvisory(cwd, sessionId);
    assert.equal(reconciled?.fence?.state, 'abandoned');
    assert.deepEqual(JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf8')), stored.terminal_skill_updates.session_skill);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf8')), stored.terminal_skill_updates.root_skill);
  });

  it('fails closed on current and fence corruption', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await prepareAdvisoryCloseout({ cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1, lifecycle });
    await writeFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'current.json'), '{bad');
    const result = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(result?.corruption, 'current_corrupt');
    assert.equal(advisoryFenceBlocksProductWrites(result), true);
  });

  it('fails closed on absent, unreadable, or mismatched active bindings before closeout', async () => {
    const mutations: Array<(path: string) => Promise<unknown>> = [
      (path) => rm(path),
      (path) => writeFile(path, '{'),
      (path) => writeFile(path, JSON.stringify({ active: true, workflow_variant: 'advisory', advisory_generation_id: 'generation-other' })),
    ];
    for (const [index, mutate] of mutations.entries()) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-binding-corrupt-${index}-`));
      roots.push(cwd);
      const sessionId = `session-${index}`;
      const activation = await activateRalplanAdvisory({
        cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: `generation-${index}`,
      });
      await bindAndCommitActivation(cwd, sessionId, activation);
      await mutate(join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-state.json'));
      const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
      assert.equal(projection?.denyProductWrites, true);
      assert.ok(projection?.corruption, String(index));
    }
  });

  it('rejects a forged approved+proven closed projection with incomplete lifecycle bindings', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    const closed = await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
    });
    const eventPath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'generation-a',
      `fence-event-${String(closed.fence!.sequence).padStart(4, '0')}.json`);
    const forged = JSON.parse(await readFile(eventPath, 'utf8'));
    delete forged.critic_review_sha256;
    await writeFile(eventPath, JSON.stringify(forged));
    const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(projection?.corruption, 'approved_proven_binding_invalid');
    assert.equal(projection?.denyProductWrites, true);
  });

  it('releases only from a later native root concrete anchored execution request', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
    });
    const vague = await releaseAdvisoryFence({ cwd, sessionId, turnId: 'turn-b', threadId: 'root-a', prompt: 'dale', producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false });
    assert.equal(vague.released, false);
    const child = await releaseAdvisoryFence({ cwd, sessionId, turnId: 'turn-c', threadId: 'child', prompt: 'implementá el plan .omx/plans/plan.md', producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: true });
    assert.equal(child.released, false);
    const released = await releaseAdvisoryFence({ cwd, sessionId, turnId: 'turn-c', threadId: 'root-a', prompt: 'implementá el plan .omx/plans/plan.md', producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false });
    assert.equal(released.released, true);
    assert.equal(released.projection?.fence?.authority_kind, 'new_root_user_execution_request');
  });

  it('rolls over with CAS and preserves the predecessor generation', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await terminalizeRalplanAdvisory({ cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1, outcome: 'approved', integrityStatus: 'proven', lifecycle, revalidateEvidence: async () => lifecycle.evidence_bundle_sha256 });
    const result = await releaseAdvisoryFence({ cwd, sessionId, turnId: 'turn-b', threadId: 'root-a', prompt: 'replanificá el plan', producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false });
    assert.equal(result.intent, 'replan');
    assert.equal(result.projection?.activation.predecessor_generation_id, 'generation-a');
    assert.equal(result.projection?.corruption, 'rollover_pending_admin');
    assert.equal((await bindAndCommitActivation(cwd, sessionId, result.projection!.activation))?.corruption, null);
    await assert.rejects(activateRalplanAdvisory({ cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-c', predecessorGenerationId: 'generation-a' }), /cas_mismatch/);
  });

  it('recovers the single-owner rollover intent after every durable checkpoint', async () => {
    for (const failpoint of ['rollover_intent', 'rollover_activation', 'rollover_pointer'] as const) {
      const { cwd, sessionId, lifecycle } = await fixture();
      await terminalizeRalplanAdvisory({ cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1, outcome: 'approved', integrityStatus: 'proven', lifecycle, revalidateEvidence: async () => lifecycle.evidence_bundle_sha256 });
      await assert.rejects(activateRalplanAdvisory({
        cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-b', predecessorGenerationId: 'generation-a',
        failpoint: (name) => { if (name === failpoint) throw new Error(`crash:${name}`); },
      }), /crash/);
      assert.equal(advisoryFenceBlocksProductWrites(await readCurrentRalplanAdvisory(cwd, sessionId)), true);
      const intent = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'rollover-intent.json'), 'utf8'));
      const recovered = await bindAndCommitActivation(cwd, sessionId, {
        generation_id: intent.generation_id, root_thread_id: intent.root_thread_id, activation_turn_id: intent.activation_turn_id,
      });
      assert.equal(recovered?.activation.predecessor_generation_id, 'generation-a');
      assert.equal(recovered?.corruption, null);
    }
  });

  it('never auto-authorizes a forged or unauthenticated pending rollover intent', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await terminalizeRalplanAdvisory({ cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1, outcome: 'approved', integrityStatus: 'proven', lifecycle, revalidateEvidence: async () => lifecycle.evidence_bundle_sha256 });
    await assert.rejects(activateRalplanAdvisory({
      cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-b', predecessorGenerationId: 'generation-a',
      failpoint: (name) => { if (name === 'rollover_activation') throw new Error('crash'); },
    }), /crash/);
    const intentPath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'rollover-intent.json');
    const forged = JSON.parse(await readFile(intentPath, 'utf8'));
    forged.root_thread_id = 'attacker-root';
    await writeFile(intentPath, JSON.stringify(forged));
    const reconciled = await reconcileRalplanAdvisory(cwd, sessionId);
    assert.equal(reconciled?.activation.generation_id, 'generation-a');
    assert.equal(reconciled?.corruption, 'rollover_pending_admin');
    assert.equal(reconciled?.denyProductWrites, true);
    const stillDenied = await reconcileRalplanAdvisory(cwd, sessionId, {
      producer: 'native', threadKind: 'root-or-drift', rootThreadId: 'attacker-root', activationTurnId: 'turn-b',
    });
    assert.equal(stillDenied?.corruption, 'rollover_pending_admin');
  });

  it('allows only one concurrent new-advisory root request to own G+1', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await terminalizeRalplanAdvisory({ cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1, outcome: 'approved', integrityStatus: 'proven', lifecycle, revalidateEvidence: async () => lifecycle.evidence_bundle_sha256 });
    const requests = await Promise.allSettled([
      releaseAdvisoryFence({ cwd, sessionId, turnId: 'turn-b', threadId: 'root-a', prompt: '$ralplan --advisory nuevo advisory', producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false }),
      releaseAdvisoryFence({ cwd, sessionId, turnId: 'turn-c', threadId: 'root-a', prompt: '$ralplan --advisory otro advisory', producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false }),
    ]);
    assert.equal(requests.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(requests.filter((result) => result.status === 'rejected').length, 1);
    const current = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(current?.activation.predecessor_generation_id, 'generation-a');
    assert.ok(current?.activation.activation_turn_id === 'turn-b' || current?.activation.activation_turn_id === 'turn-c');
  });

  it('creates a deny-first intent for generation one before activation publication', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-g1-intent-'));
    roots.push(cwd);
    await assert.rejects(activateRalplanAdvisory({
      cwd, sessionId: 'session-g1', rootThreadId: 'root-g1', activationTurnId: 'turn-g1', generationId: 'generation-g1',
      failpoint: (name) => { if (name === 'rollover_intent') throw new Error('crash-after-intent'); },
    }), /crash-after-intent/);
    const projection = await readCurrentRalplanAdvisory(cwd, 'session-g1');
    assert.equal(advisoryFenceBlocksProductWrites(projection), true);
    const recovered = await reconcileRalplanAdvisory(cwd, 'session-g1');
    assert.equal(recovered?.corruption, 'current_missing_with_advisory_state');
    assert.equal(recovered?.denyProductWrites, true);
  });

  it('keeps a published G+1 denied until the session mode is bound to that generation', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: stateDir }));
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
      active: true, mode: 'ralplan', session_id: sessionId, workflow_variant: 'advisory', advisory_generation_id: 'generation-a',
    }));
    await terminalizeRalplanAdvisory({ cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1, outcome: 'approved', integrityStatus: 'proven', lifecycle, revalidateEvidence: async () => lifecycle.evidence_bundle_sha256 });
    const next = await activateRalplanAdvisory({ cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-b', predecessorGenerationId: 'generation-a' });
    const denied = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(denied?.activation.generation_id, next.generation_id);
    assert.equal(denied?.corruption, 'rollover_pending_admin');
    assert.equal(denied?.denyProductWrites, true);
    const committed = await bindAndCommitActivation(cwd, sessionId, next);
    assert.equal(committed?.corruption, null);
  });

  it('does not roll over a pending closeout and recovers a dead-process lock', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await prepareAdvisoryCloseout({ cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1, lifecycle });
    const pending = await releaseAdvisoryFence({
      cwd, sessionId, turnId: 'turn-b', threadId: 'root-a', prompt: 'replanificá el plan',
      producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false,
    });
    assert.equal(pending.intent, 'unrelated');
    assert.equal(pending.projection?.activation.generation_id, 'generation-a');

    const deadSessionRoot = join(cwd, '.omx', 'state', 'sessions', 'session-dead', 'ralplan-advisory');
    await mkdir(deadSessionRoot, { recursive: true });
    await writeFile(join(deadSessionRoot, 'current.lock'), JSON.stringify({ schema_version: 1, pid: 2_147_483_647, created_at: new Date().toISOString() }));
    const activation = await activateRalplanAdvisory({
      cwd, sessionId: 'session-dead', rootThreadId: 'root-a', activationTurnId: 'turn-c', generationId: 'generation-dead',
    });
    assert.equal(activation.generation_id, 'generation-dead');
  });
});

describe('ralplan advisory release classifier', () => {
  it('rejects questions, conditionals, future intent, negations, docs/status, and vague continuations', () => {
    for (const prompt of [
      '¿podés implementar el plan?', 'si todo está bien implementá issue #12', 'más adelante ejecutá test foo',
      'no implementes el plan .omx/plans/a.md', 'explicá el status del plan', 'continue', 'dale',
      'podés implementar el plan .omx/plans/a.md', 'deberías ejecutar el test foo',
      'querés corregir issue #12', 'sería posible implementar el PRD .omx/plans/a.md',
      'no quiero implementar el plan .omx/plans/a.md', 'no vamos a ejecutar el test foo',
      'I do not want to implement the plan .omx/plans/a.md', 'can you implement issue #12',
      'could you execute test foo', 'would you fix issue #12',
      'I am asking whether you can implement the plan .omx/plans/a.md',
      'considerá implementar el plan .omx/plans/a.md', 'copiá la frase "implementá el plan .omx/plans/a.md"',
      'confirmá que implementar el plan .omx/plans/a.md es correcto',
      '> implementá el plan .omx/plans/a.md', '`implementá el plan .omx/plans/a.md`',
      'considerá replanificar el plan', 'copiá la frase "$ralplan --advisory nueva versión"',
      '¿nuevo advisory para esta tarea?', 'no replanifiques el plan',
      '¿podés abandonar el advisory?', 'no abandones el advisory',
    ]) assert.equal(classifyAdvisoryPrompt(prompt), 'unrelated', prompt);
  });

  it('requires explicit non-authority false fields on inactive projections', async () => {
    const { cwd, sessionId } = await fixture();
    const projection = await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'cancelled', integrityStatus: 'proven',
    });
    assert.match(validateAdvisoryInactiveState({
      mode: 'ralplan', workflow_variant: 'advisory', active: false, advisory_generation_id: 'generation-a',
    }, projection) ?? '', /explicit_false/);
  });

  it('accepts only affirmative execution with a concrete anchor', () => {
    assert.equal(classifyAdvisoryPrompt('implementá el plan .omx/plans/plan.md'), 'execute');
    assert.equal(classifyAdvisoryPrompt('fix issue #123'), 'execute');
    assert.equal(classifyAdvisoryPrompt('implementá esto'), 'unrelated');
    assert.equal(classifyAdvisoryPrompt('$ralplan --advisory nueva versión'), 'new_advisory');
    assert.equal(classifyAdvisoryPrompt('$oh-my-codex:ralplan --advisory nueva versión'), 'new_advisory');
    assert.equal(classifyAdvisoryPrompt('creá un nuevo advisory para esta tarea'), 'new_advisory');
    assert.equal(classifyAdvisoryPrompt('replanificá el plan'), 'replan');
    assert.equal(classifyAdvisoryPrompt('abandoná el advisory'), 'abandon');
  });

  it('emits content-safe structured lifecycle, reconciliation, denial, and release events', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    await assert.rejects(terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-close', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      revalidateEvidence: async () => lifecycle.evidence_bundle_sha256,
      failpoint: (name) => { if (name === 'journal_commit') throw new Error('crash-after-commit'); },
    }), /crash-after-commit/);
    await reconcileRalplanAdvisory(cwd, sessionId);
    await releaseAdvisoryFence({
      cwd, sessionId, turnId: 'turn-question', threadId: 'root-a', prompt: '¿podés implementarlo?',
      producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false,
    });
    await releaseAdvisoryFence({
      cwd, sessionId, turnId: 'turn-execute', threadId: 'root-a', prompt: 'implementá el plan .omx/plans/plan.md',
      producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false,
    });
    const raw = await readFile(ralplanAdvisoryEventsPath(cwd), 'utf8');
    const events = raw.trim().split('\n').map((line) => JSON.parse(line));
    const types = new Set(events.map((event) => event.type));
    for (const type of [
      'ralplan_advisory_fence_created', 'ralplan_advisory_closeout_step',
      'ralplan_advisory_closeout_committed', 'ralplan_advisory_fence_closed',
      'ralplan_advisory_closeout_reconciled', 'ralplan_advisory_release_denied',
      'ralplan_advisory_fence_released',
    ]) assert.equal(types.has(type), true, type);
    for (const event of events) {
      assert.equal(event.generation_id, 'generation-a');
      assert.equal(typeof event.state_transition, 'string');
      assert.equal(typeof event.checkpoint, 'string');
      assert.equal(typeof event.reason, 'string');
      assert.equal(event.relative_path.startsWith('/'), false);
      if (event.digest_prefix) assert.equal(event.digest_prefix.length <= 12, true);
    }
    assert.doesNotMatch(raw, /implementá|exact plan|\.omx\/plans\/plan\.md/);
    assert.doesNotMatch(raw, new RegExp(lifecycle.evidence_bundle_sha256));
  });

  it('emits only a digest prefix when evidence revalidation mismatches', async () => {
    const { cwd, sessionId, lifecycle } = await fixture();
    const changedDigest = 'f'.repeat(64);
    const result = await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: 'generation-a', closingTurnId: 'turn-close', iteration: 1,
      outcome: 'approved', integrityStatus: 'proven', lifecycle,
      revalidateEvidence: async () => changedDigest,
    });
    assert.equal(result.corruption, null);
    assert.equal(result.fence?.state, 'recovery_required');
    const raw = await readFile(ralplanAdvisoryEventsPath(cwd), 'utf8');
    const mismatch = raw.trim().split('\n').map((line) => JSON.parse(line))
      .find((event) => event.type === 'ralplan_advisory_digest_mismatch');
    assert.equal(mismatch.digest_prefix, changedDigest.slice(0, 12));
    assert.doesNotMatch(raw, new RegExp(changedDigest));
  });
});
