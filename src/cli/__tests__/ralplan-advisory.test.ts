import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ralplanCommand } from '../ralplan.js';
import { cancelModesForTest } from '../index.js';
import { activateRalplanAdvisory, prepareAdvisoryCloseout, readCurrentRalplanAdvisory } from '../../ralplan/advisory.js';
import { reconcileRalplanAdvisory } from '../../ralplan/advisory.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function commitActivation(cwd: string, sessionId: string, activation: Awaited<ReturnType<typeof activateRalplanAdvisory>>): Promise<void> {
  const sessionDir = join(cwd, '.omx', 'state', 'sessions', sessionId);
  await mkdir(sessionDir, { recursive: true });
  const path = join(sessionDir, 'ralplan-state.json');
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')); } catch {}
  await writeFile(path, JSON.stringify({ ...existing, active: true, mode: 'ralplan', session_id: sessionId,
    thread_id: activation.root_thread_id, turn_id: activation.activation_turn_id,
    workflow_variant: 'advisory', advisory_generation_id: activation.generation_id }));
  const committed = await reconcileRalplanAdvisory(cwd, sessionId, {
    producer: 'native', threadKind: 'root-or-drift', rootThreadId: activation.root_thread_id, activationTurnId: activation.activation_turn_id,
  });
  assert.equal(committed?.corruption, null);
}

describe('ralplan advisory CLI', () => {
  it('accepts no caller evidence and reconstructs a closed non-authorizing result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-cli-'));
    roots.push(cwd);
    const sessionId = 'session-a';
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
    await mkdir(join(cwd, '.omx', 'artifacts'), { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(cwd, '.omx', 'plans', 'plan.md'), '# plan\n');
    await writeFile(join(cwd, '.omx', 'artifacts', 'architect.md'), 'APPROVE\n');
    await writeFile(join(cwd, '.omx', 'artifacts', 'critic.md'), 'APPROVE\n');
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: stateDir }));
    await writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
      schemaVersion: 1,
      sessions: { [sessionId]: { session_id: sessionId, leader_thread_id: 'root-a', updated_at: '2026-08-28T00:00:03.000Z', threads: {
        architect: { thread_id: 'architect', kind: 'subagent', role: 'architect', provenance_kind: 'native_subagent', direct_child_root_id: 'root-a', direct_child_parent_id: 'root-a', scope: 'ralplan-advisory:generation-a', first_seen_at: '2026-08-28T00:00:00.000Z', last_seen_at: '2026-08-28T00:00:01.000Z', completed_at: '2026-08-28T00:00:01.000Z', turn_count: 1 },
        critic: { thread_id: 'critic', kind: 'subagent', role: 'critic', provenance_kind: 'native_subagent', direct_child_root_id: 'root-a', direct_child_parent_id: 'root-a', scope: 'ralplan-advisory:generation-a', first_seen_at: '2026-08-28T00:00:02.000Z', last_seen_at: '2026-08-28T00:00:03.000Z', completed_at: '2026-08-28T00:00:03.000Z', turn_count: 1 },
      } } },
    }));
    const activation = await activateRalplanAdvisory({ cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a', nowIso: '2026-08-27T23:59:59.000Z' });
    await commitActivation(cwd, sessionId, activation);
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
      active: true, mode: 'ralplan', current_phase: 'critic-review', iteration: 1, max_iterations: 1,
      started_at: '2026-08-28T00:00:00.000Z', session_id: sessionId, thread_id: 'root-a', turn_id: 'turn-a',
      workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
      latest_plan_path: join(cwd, '.omx', 'plans', 'plan.md'),
      review_history: [{
        draft: { planPath: join(cwd, '.omx', 'plans', 'plan.md') },
        architect_review: { verdict: 'approve', thread_id: 'architect', artifact_path: '.omx/artifacts/architect.md', session_id: sessionId },
        critic_review: { verdict: 'approve', thread_id: 'critic', artifact_path: '.omx/artifacts/critic.md', session_id: sessionId },
      }],
    }));
    const lifecycle = await (await import('../../ralplan/advisory-evidence.js')).projectAdvisoryReviewLifecycle({
      cwd, sessionId, generationId: activation.generation_id, activationTurnId: activation.activation_turn_id,
      activationCreatedAt: activation.created_at, rootThreadId: activation.root_thread_id, iteration: 1,
      planPaths: ['.omx/plans/plan.md'],
      architect: { threadId: 'architect', artifactPath: '.omx/artifacts/architect.md', verdict: 'approve', sessionId },
      critic: { threadId: 'critic', artifactPath: '.omx/artifacts/critic.md', verdict: 'approve', sessionId },
    });
    await prepareAdvisoryCloseout({
      cwd, sessionId, generationId: activation.generation_id, closingTurnId: 'turn-closeout-original', iteration: 1, lifecycle,
    });
    const activeState = JSON.parse(await (await import('node:fs/promises')).readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    activeState.turn_id = 'turn-mutated-after-pending';
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(activeState));
    const output: string[] = [];
    await ralplanCommand(['advisory', 'complete', '--json'], { cwd: () => cwd, stdout: (line) => output.push(line) });
    const result = JSON.parse(output.at(-1)!);
    assert.deepEqual(result, {
      ok: true, status: 'closed', host_verified: false, consensus_gate_complete: false,
      execution_handoff_authorized: false, return_to_caller: true,
    });
    assert.equal((await readCurrentRalplanAdvisory(cwd, sessionId))?.fence?.state, 'closed');
    assert.equal((await readCurrentRalplanAdvisory(cwd, sessionId))?.fence?.closing_turn_id, 'turn-closeout-original');
    output.length = 0;
    await ralplanCommand(['advisory', 'complete'], { cwd: () => cwd, stdout: (line) => output.push(line) });
    assert.equal(output.at(-1), 'Ralplan Advisory complete. Control returned to the caller without an automatic execution handoff; later user instructions follow normal host rules.');
  });

  it('rejects all evidence and path arguments', async () => {
    await assert.rejects(ralplanCommand(['advisory', 'complete', '--plan', 'x']), /Unknown ralplan advisory complete argument/);
  });

  it('routes generic CLI cancellation through the Advisory fence-first terminalizer', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'omx-advisory-cancel-')));
    roots.push(cwd);
    const sessionId = 'session-cancel';
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: stateDir }));
    const activation = await activateRalplanAdvisory({
      cwd, sessionId, rootThreadId: 'root-cancel', activationTurnId: 'turn-cancel', generationId: 'generation-cancel',
    });
    await commitActivation(cwd, sessionId, activation);
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
      active: true, mode: 'ralplan', current_phase: 'draft', iteration: 1, max_iterations: 5,
      started_at: activation.created_at, session_id: sessionId, thread_id: 'root-cancel', turn_id: 'turn-cancel',
      workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
    }));
    await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
      active: true, mode: 'ralplan', current_phase: 'draft', iteration: 1, session_id: sessionId,
      workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
    }));
    const activeSkill = { active: true, skill: 'ralplan', session_id: sessionId, active_skills: [{ skill: 'ralplan', active: true, session_id: sessionId }] };
    await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(activeSkill));
    await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(activeSkill));
    const logs: string[] = [];
    const priorLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try { await cancelModesForTest(cwd, [], {}); } finally { console.log = priorLog; }
    const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
    const rootModeAfterCancel = JSON.parse(await (await import('node:fs/promises')).readFile(join(stateDir, 'ralplan-state.json'), 'utf8'));
    assert.equal(projection?.fence?.state, 'abandoned', JSON.stringify({ rootModeAfterCancel, projection }));
    assert.equal(projection?.journal?.outcome, 'cancelled');
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(join(sessionDir, 'ralplan-state.json'), 'utf8')).active, false);
    assert.equal(rootModeAfterCancel.active, false);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(join(sessionDir, 'skill-active-state.json'), 'utf8')).active, false);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(join(stateDir, 'skill-active-state.json'), 'utf8')).active, false);
    assert.deepEqual(logs, ['Cancelled: ralplan']);
  });

  it('administratively abandons an approved pending fence without inventing or rewriting a closeout journal', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'omx-advisory-cancel-pending-')));
    roots.push(cwd);
    const sessionId = 'session-pending';
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: stateDir }));
    const activation = await activateRalplanAdvisory({
      cwd, sessionId, rootThreadId: 'root-pending', activationTurnId: 'turn-activation', generationId: 'generation-pending',
    });
    await commitActivation(cwd, sessionId, activation);
    const lifecycle = {
      complete: true, sequence_valid: true, iteration: 1, iteration_id: 'iteration-id',
      plan_manifest_sha256: '1'.repeat(64), architect_review_sha256: '2'.repeat(64),
      critic_review_sha256: '3'.repeat(64), evidence_bundle_sha256: '4'.repeat(64),
      evidence_scope: 'local_runtime' as const, host_observable: false as const, host_verified: false as const,
    };
    await prepareAdvisoryCloseout({
      cwd, sessionId, generationId: activation.generation_id, closingTurnId: 'turn-approved-close', iteration: 1, lifecycle,
    });
    const generationDir = join(sessionDir, 'ralplan-advisory', activation.generation_id);
    const baseFenceBytes = await (await import('node:fs/promises')).readFile(join(generationDir, 'fence.json'), 'utf8');
    const mode = {
      active: true, mode: 'ralplan', current_phase: 'critic-review', iteration: 1, session_id: sessionId,
      thread_id: 'root-pending', turn_id: 'turn-mutated-after-close', workflow_variant: 'advisory',
      advisory_generation_id: activation.generation_id,
    };
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(mode));
    await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify(mode));
    const skills = { active: true, skill: 'ralplan', session_id: sessionId, active_skills: [{ skill: 'ralplan', active: true, session_id: sessionId }] };
    await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(skills));
    await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(skills));
    const priorLog = console.log;
    console.log = () => {};
    try { await cancelModesForTest(cwd, [], {}); } finally { console.log = priorLog; }
    const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(projection?.fence?.state, 'abandoned');
    assert.equal(projection?.fence?.closing_turn_id, 'turn-approved-close');
    assert.equal(projection?.fence?.evidence_bundle_sha256, lifecycle.evidence_bundle_sha256);
    assert.equal(projection?.admin_event?.prior_fence_sha256, createHash('sha256').update(baseFenceBytes).digest('hex'));
    assert.equal(projection?.journal, null);
    await assert.rejects((await import('node:fs/promises')).readFile(join(generationDir, 'closeout-journal.json'), 'utf8'), /ENOENT/);
    assert.equal(await (await import('node:fs/promises')).readFile(join(generationDir, 'fence.json'), 'utf8'), baseFenceBytes);
  });
});
