import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activateRalplanAdvisory, readCurrentRalplanAdvisory, reconcileRalplanAdvisory, terminalizeRalplanAdvisory } from '../../ralplan/advisory.js';
import { buildRalplanAdvisoryFenceGuardOutput, dispatchCodexNativeHook } from '../codex-native-hook.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function closedDispatchFixture(prefix: string): Promise<{ cwd: string; sessionId: string; payload: Record<string, unknown> }> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  roots.push(cwd);
  const sessionId = 'session-a';
  const stateDir = join(cwd, '.omx', 'state');
  const sessionDir = join(stateDir, 'sessions', sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: sessionId, native_session_id: sessionId, owner_codex_session_id: sessionId,
    started_at: '2026-08-28T00:00:00.000Z', cwd, state_root: stateDir,
  }));
  const activation = await activateRalplanAdvisory({
    cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a',
  });
  await commitActivation(cwd, sessionId, activation);
  await terminalizeRalplanAdvisory({
    cwd, sessionId, generationId: activation.generation_id, closingTurnId: 'turn-close', iteration: 1,
    outcome: 'cancelled', integrityStatus: 'proven',
  });
  const inactiveMode = {
    active: false, mode: 'ralplan', current_phase: 'complete', iteration: 1,
    session_id: sessionId, owner_codex_session_id: sessionId, thread_id: 'root-a', turn_id: 'turn-close',
    workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
    execution_handoff_authorized: false, host_verified: false, ralplan_consensus_gate: { complete: false },
  };
  await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(inactiveMode));
  await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify(inactiveMode));
  return { cwd, sessionId, payload: {
    hook_event_name: 'UserPromptSubmit', cwd, session_id: sessionId,
    thread_id: 'root-a', turn_id: 'turn-new', prompt: 'creá un nuevo advisory para esta tarea',
  } };
}

async function commitActivation(cwd: string, sessionId: string, activation: Awaited<ReturnType<typeof activateRalplanAdvisory>>): Promise<void> {
  const dir = join(cwd, '.omx', 'state', 'sessions', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'ralplan-state.json'), JSON.stringify({
    active: true, mode: 'ralplan', session_id: sessionId, thread_id: activation.root_thread_id,
    turn_id: activation.activation_turn_id, workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
  }));
  const projection = await reconcileRalplanAdvisory(cwd, sessionId, {
    producer: 'native', threadKind: 'root-or-drift', rootThreadId: activation.root_thread_id, activationTurnId: activation.activation_turn_id,
  });
  assert.equal(projection?.corruption, null);
}

async function bindingWithoutCanonicalAdvisoryRoot(prefix: string, options: { advisory: boolean; symlinkLoop?: boolean } = { advisory: true }): Promise<{ cwd: string; sessionId: string }> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  roots.push(cwd);
  const sessionId = 'session-a';
  const stateDir = join(cwd, '.omx', 'state');
  const sessionDir = join(stateDir, 'sessions', sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: sessionId, native_session_id: sessionId, owner_codex_session_id: sessionId,
    started_at: '2026-08-28T00:00:00.000Z', cwd, state_root: stateDir,
  }));
  await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(options.advisory
    ? { active: false, mode: 'ralplan', workflow_variant: 'advisory', advisory_generation_id: 'generation-a' }
    : { active: false, mode: 'ralplan' }));
  if (options.symlinkLoop) await symlink('ralplan-advisory', join(sessionDir, 'ralplan-advisory'));
  return { cwd, sessionId };
}

describe('ralplan advisory native hook fence', () => {
  it('keeps inactive Advisory product writes and orchestration blocked while allowing reads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-hook-'));
    roots.push(cwd);
    const activation = await activateRalplanAdvisory({ cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a' });
    await commitActivation(cwd, 'session-a', activation);
    await terminalizeRalplanAdvisory({
      cwd, sessionId: 'session-a', generationId: 'generation-a', closingTurnId: 'turn-a', iteration: 1,
      outcome: 'cancelled', integrityStatus: 'proven',
    });
    const write = await buildRalplanAdvisoryFenceGuardOutput({
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, cwd, 'session-a');
    assert.equal(write?.decision, 'block');
    const orchestration = await buildRalplanAdvisoryFenceGuardOutput({
      hook_event_name: 'PreToolUse', tool_name: 'mcp__omx_goal__create_goal', tool_input: { objective: 'execute' },
    } as never, cwd, 'session-a');
    assert.equal(orchestration?.decision, 'block');
    const read = await buildRalplanAdvisoryFenceGuardOutput({
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(cwd, 'README.md') },
    } as never, cwd, 'session-a');
    assert.equal(read, null);
  });

  it('fails closed when current state is tampered', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-hook-tamper-'));
    roots.push(cwd);
    const activation = await activateRalplanAdvisory({ cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a' });
    await commitActivation(cwd, 'session-a', activation);
    await writeFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory', 'current.json'), '{');
    const result = await buildRalplanAdvisoryFenceGuardOutput({
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, cwd, 'session-a');
    assert.equal(result?.decision, 'block');
    assert.match(String(result?.reason), /CORRUPT/);
  });

  it('blocks Write after the generation-one activation intent is durable but before publication', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-hook-g1-intent-'));
    roots.push(cwd);
    await assert.rejects(activateRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a',
      failpoint: (name) => { if (name === 'rollover_intent') throw new Error('crash-after-intent'); },
    }), /crash-after-intent/);
    const result = await buildRalplanAdvisoryFenceGuardOutput({
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, cwd, 'session-a');
    assert.equal(result?.decision, 'block');
  });

  it('blocks Write when a published activation has an inactive binding but no closeout fence or journal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-hook-inactive-without-closeout-'));
    roots.push(cwd);
    const sessionId = 'session-a';
    const activation = await activateRalplanAdvisory({
      cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a',
    });
    await commitActivation(cwd, sessionId, activation);
    const modePath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-state.json');
    const mode = JSON.parse(await readFile(modePath, 'utf8'));
    await writeFile(modePath, JSON.stringify({ ...mode, active: false }));
    const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(projection?.corruption, 'inactive_without_closeout');
    assert.equal(projection?.denyProductWrites, true);
    const result = await buildRalplanAdvisoryFenceGuardOutput({
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, cwd, sessionId);
    assert.equal(result?.decision, 'block');
    assert.match(String(result?.reason), /inactive_without_closeout/);
  });

  it('blocks a real PreToolUse Write when an inactive Advisory binding has no state root', async () => {
    const { cwd, sessionId } = await bindingWithoutCanonicalAdvisoryRoot('omx-advisory-hook-missing-root-');
    const result = await dispatchCodexNativeHook({
      hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
      tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, { cwd });
    assert.equal(result.outputJson?.decision, 'block');
    assert.match(String(result.outputJson?.reason), /STATE_MISSING/);
    const read = await dispatchCodexNativeHook({
      hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
      tool_name: 'Read', tool_input: { file_path: join(cwd, 'README.md') },
    } as never, { cwd });
    assert.equal(read.outputJson, null);
    for (const toolName of ['create_goal', 'hostile_unknown_transport']) {
      const denied = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
        tool_name: toolName, tool_input: toolName === 'create_goal' ? { objective: 'execute' } : {},
      } as never, { cwd });
      assert.equal(denied.outputJson?.decision, 'block', toolName);
      assert.match(String(denied.outputJson?.reason), /STATE_MISSING/, toolName);
    }
  });

  it('blocks a real PreToolUse Write when the Advisory root realpath fails with ELOOP', async () => {
    const { cwd, sessionId } = await bindingWithoutCanonicalAdvisoryRoot('omx-advisory-hook-eloop-', { advisory: true, symlinkLoop: true });
    const result = await dispatchCodexNativeHook({
      hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
      tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, { cwd });
    assert.equal(result.outputJson?.decision, 'block');
    assert.match(String(result.outputJson?.reason), /STATE_UNREADABLE.*ELOOP/);
    const read = await dispatchCodexNativeHook({
      hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
      tool_name: 'Read', tool_input: { file_path: join(cwd, 'README.md') },
    } as never, { cwd });
    assert.equal(read.outputJson, null);
    for (const toolName of ['create_goal', 'hostile_unknown_transport']) {
      const denied = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
        tool_name: toolName, tool_input: toolName === 'create_goal' ? { objective: 'execute' } : {},
      } as never, { cwd });
      assert.equal(denied.outputJson?.decision, 'block', toolName);
      assert.match(String(denied.outputJson?.reason), /STATE_UNREADABLE/, toolName);
    }
  });

  it('fails closed when a canonical Advisory root disappears between detection and projection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-hook-detect-read-race-'));
    roots.push(cwd);
    const sessionId = 'session-a';
    const stateDir = join(cwd, '.omx', 'state');
    await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      session_id: sessionId, native_session_id: sessionId, owner_codex_session_id: sessionId,
      started_at: '2026-08-28T00:00:00.000Z', cwd, state_root: stateDir,
    }));
    const activation = await activateRalplanAdvisory({
      cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a',
    });
    await commitActivation(cwd, sessionId, activation);
    let seamCalls = 0;
    const result = await dispatchCodexNativeHook({
      hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
      tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, {
      cwd,
      ralplanAdvisoryAfterDetectionFn: async (detection) => {
        seamCalls += 1;
        assert.equal(detection.status, 'normal');
        await rm(detection.root, { recursive: true, force: true });
      },
    });
    assert.equal(seamCalls, 1);
    assert.equal(result.outputJson?.decision, 'block');
    assert.match(String(result.outputJson?.reason), /STATE_CHANGED_DURING_READ/);
  });

  it('treats absent Advisory root plus a non-Advisory binding as no Advisory state', async () => {
    const { cwd, sessionId } = await bindingWithoutCanonicalAdvisoryRoot('omx-advisory-hook-no-state-', { advisory: false });
    const result = await buildRalplanAdvisoryFenceGuardOutput({
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, cwd, sessionId);
    assert.equal(result, null);
  });

  it('suppresses global prompt, SessionStart, and Stop side effects when Advisory root lookup is unreadable', async () => {
    for (const eventName of ['UserPromptSubmit', 'SessionStart', 'Stop'] as const) {
      const { cwd, sessionId } = await bindingWithoutCanonicalAdvisoryRoot(`omx-advisory-hook-no-side-effects-${eventName}-`, { advisory: true, symlinkLoop: true });
      const hooksDir = join(cwd, '.omx', 'hooks');
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(hooksDir, 'record-lifecycle.mjs'), [
        "import { appendFileSync } from 'node:fs';",
        "export async function onHookEvent(event) { appendFileSync('hook-events.jsonl', JSON.stringify({ event: event.event }) + '\\n'); }",
      ].join('\n'));
      let hudCalls = 0;
      const result = await dispatchCodexNativeHook({
        hook_event_name: eventName, cwd, session_id: sessionId, thread_id: 'root-a', turn_id: 'turn-a',
        ...(eventName === 'UserPromptSubmit' ? { prompt: '$ralplan --advisory nueva versión' } : {}),
      } as never, { cwd, reconcileHudForPromptSubmitFn: async () => {
        hudCalls += 1;
        return { status: 'unchanged', paneId: '%1', desiredHeight: 3, duplicateCount: 0 };
      } });
      assert.equal(result.skillState, null, eventName);
      assert.equal(hudCalls, 0, eventName);
      await assert.rejects(access(join(cwd, 'hook-events.jsonl')), /ENOENT/, eventName);
      await assert.rejects(access(join(cwd, '.omx', 'state', 'skill-active-state.json')), /ENOENT/, eventName);
    }
  });

  it('allows only one concurrent native root UserPromptSubmit to own the new Advisory generation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-hook-new-generation-'));
    roots.push(cwd);
    const sessionId = 'session-a';
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      session_id: sessionId, native_session_id: sessionId, owner_codex_session_id: sessionId,
      started_at: '2026-08-28T00:00:00.000Z', cwd, state_root: stateDir,
    }));
    const activation = await activateRalplanAdvisory({
      cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a',
    });
    await commitActivation(cwd, sessionId, activation);
    await terminalizeRalplanAdvisory({
      cwd, sessionId, generationId: activation.generation_id, closingTurnId: 'turn-close', iteration: 1,
      outcome: 'cancelled', integrityStatus: 'proven',
    });
    const inactiveMode = {
      active: false, mode: 'ralplan', current_phase: 'complete', iteration: 1,
      session_id: sessionId, owner_codex_session_id: sessionId, thread_id: 'root-a', turn_id: 'turn-close',
      workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
      execution_handoff_authorized: false, host_verified: false, ralplan_consensus_gate: { complete: false },
    };
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(inactiveMode));
    await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify(inactiveMode));

    const submit = (turnId: string) => dispatchCodexNativeHook({
      hook_event_name: 'UserPromptSubmit', cwd, session_id: sessionId,
      thread_id: 'root-a', turn_id: turnId, prompt: 'creá un nuevo advisory para esta tarea',
    } as never, { cwd });
    const results = await Promise.all([submit('turn-new-a'), submit('turn-new-b')]);

    const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(projection?.activation.predecessor_generation_id, activation.generation_id);
    const generations = (await (await import('node:fs/promises')).readdir(join(sessionDir, 'ralplan-advisory'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    assert.equal(generations.length, 2, JSON.stringify({ results, projection }));
    const mode = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    assert.equal(mode.advisory_generation_id, projection?.activation.generation_id);
  });

  it('dispatches both canonical Advisory literals through the same terminal-fence rollover parser', async () => {
    for (const [index, literal] of ['$ralplan --advisory nueva versión', '$oh-my-codex:ralplan --advisory nueva versión'].entries()) {
      const { cwd, sessionId, payload } = await closedDispatchFixture(`omx-advisory-hook-literal-${index}-`);
      const result = await dispatchCodexNativeHook({ ...payload, prompt: literal } as never, { cwd });
      assert.doesNotMatch(JSON.stringify(result.outputJson), /error|mismatch|corrupt/i, literal);
      const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
      assert.equal(projection?.activation.predecessor_generation_id, 'generation-a', literal);
      assert.equal(projection?.corruption, null, literal);
    }
  });

  it('recovers every rollover publication failpoint by replaying the exact authenticated native-root UserPromptSubmit', async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorFailpoint = process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT;
    try {
      for (const failpoint of ['rollover_intent', 'rollover_activation', 'rollover_pointer'] as const) {
        const { cwd, sessionId, payload } = await closedDispatchFixture(`omx-advisory-hook-replay-${failpoint}-`);
        process.env.NODE_ENV = 'test';
        process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT = failpoint;
        const failed = await dispatchCodexNativeHook(payload as never, { cwd });
        assert.match(JSON.stringify(failed.outputJson), /test_failpoint/);
        delete process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT;
        await dispatchCodexNativeHook(payload as never, { cwd });
        const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
        assert.equal(projection?.activation.predecessor_generation_id, 'generation-a', failpoint);
        assert.equal(projection?.corruption, null, failpoint);
        await assert.rejects(access(join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'rollover-intent.json')), /ENOENT/);
      }
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
      if (priorFailpoint === undefined) delete process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT;
      else process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT = priorFailpoint;
    }
  });

  it('does not recover a pending rollover for a different turn, root, or literal prompt', async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorFailpoint = process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT;
    try {
      const { cwd, sessionId, payload } = await closedDispatchFixture('omx-advisory-hook-replay-negative-');
      process.env.NODE_ENV = 'test';
      process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT = 'rollover_intent';
      await dispatchCodexNativeHook(payload as never, { cwd });
      delete process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT;
      for (const changed of [
        { ...payload, turn_id: 'turn-other' },
        { ...payload, thread_id: 'root-other' },
        { ...payload, prompt: 'creá un nuevo advisory para otra tarea' },
      ]) {
        const denied = await dispatchCodexNativeHook(changed as never, { cwd });
        assert.match(JSON.stringify(denied.outputJson), /pending_activation_authority_mismatch/);
        assert.equal((await readCurrentRalplanAdvisory(cwd, sessionId))?.denyProductWrites, true);
      }
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
      if (priorFailpoint === undefined) delete process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT;
      else process.env.OMX_RALPLAN_ADVISORY_ACTIVATION_FAILPOINT = priorFailpoint;
    }
  });
});
