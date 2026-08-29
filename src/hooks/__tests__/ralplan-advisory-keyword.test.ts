import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyKeywordInput, recordSkillActivation } from '../keyword-detector.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('ralplan advisory keyword activation', () => {
  it('activates direct Advisory invocations case-insensitively with planning flags in either order', async () => {
    for (const [index, text] of [
      '$ralplan --advisory design issue #42',
      '$oh-my-codex:ralplan --advisory design issue #42',
      '$RALPLAN --ADVISORY design issue #42',
      '$ralplan --interactive --advisory design issue #42',
      '$ralplan --advisory --interactive design issue #42',
      '$ralplan --deliberate --advisory design issue #42',
      '$ralplan --advisory --deliberate design issue #42',
    ].entries()) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-keyword-${index}-`));
      roots.push(cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const result = await recordSkillActivation({
        stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
        sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
      });
      assert.equal(result?.workflow_variant, 'advisory', text);
      assert.ok(result?.advisory_generation_id, text);
      const mode = JSON.parse(await readFile(join(stateDir, 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
      assert.equal(mode.workflow_variant, 'advisory', text);
      assert.equal(mode.execution_handoff_authorized, false, text);
    }
  });

  it('rejects unknown flags, combined workflows, and missing canonical turn identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-deny-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    for (const text of [
      '$ralplan --advisory --execute task',
      '$ralplan --execute --advisory task',
      '$ralplan --advisory --unknown task',
      '$ralplan --advisory=true task',
      '$ralplan --advisory, task',
      '$ralplan --advisory-foo task',
      '$ralplan --advisory_mode task',
      '$RALPLAN --AdViSoRy=true task',
      '$RALPLAN --AdViSoRy_FOO task',
      '$ralplan --advisory $team task',
    ]) {
      assert.equal(await recordSkillActivation({ stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text), sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a' }), null);
      assert.equal(existsSync(join(stateDir, 'sessions', 'session-a', 'ralplan-state.json')), false, text);
    }
    await assert.rejects(recordSkillActivation({
      stateDir, sourceCwd: cwd, text: '$ralplan --advisory task',
      classification: classifyKeywordInput('$ralplan --advisory task'), sessionId: 'session-a', threadId: 'root-a',
    }), /canonical_turn_identity_required/);
  });

  it('keeps the activation intent durable through every hook checkpoint and commits only after authenticated binding', async () => {
    for (const checkpoint of ['rollover_intent', 'rollover_activation', 'rollover_pointer', 'after_mode_binding'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-keyword-${checkpoint}-`));
      roots.push(cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const text = '$ralplan --advisory design issue #42';
      await assert.rejects(recordSkillActivation({
        stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
        sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
      }, checkpoint === 'after_mode_binding'
        ? { advisoryAfterModeBindingFailpoint: () => { throw new Error(`crash:${checkpoint}`); } }
        : { advisoryActivationFailpoint: (name) => { if (name === checkpoint) throw new Error(`crash:${checkpoint}`); } }), /crash/);
      const root = join(stateDir, 'sessions', 'session-a', 'ralplan-advisory');
      const intentPath = join(root, 'rollover-intent.json');
      const intent = JSON.parse(await readFile(intentPath, 'utf8'));
      assert.ok(intent.generation_id);
      const recovered = await recordSkillActivation({
        stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
        sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
      });
      assert.equal(recovered?.advisory_generation_id, intent.generation_id, checkpoint);
      await assert.rejects(access(intentPath), /ENOENT/);
    }
  });

  it('rejects an active Standard binding before creating any Advisory lifecycle state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-standard-active-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-a');
    const bindingPath = join(sessionDir, 'ralplan-state.json');
    await mkdir(sessionDir, { recursive: true });
    const original = '{\n  "active": true,\n  "mode": "ralplan",\n  "session_id": "session-a",\n  "workflow_variant": "standard"\n}\n';
    await writeFile(bindingPath, original);

    const text = '$ralplan --advisory design issue #42';
    await assert.rejects(recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
    }), /ralplan_advisory_active_binding_conflict/);

    assert.equal(await readFile(bindingPath, 'utf8'), original);
    assert.equal(existsSync(join(sessionDir, 'ralplan-advisory')), false);
  });

  it('rejects an active foreign Advisory binding before creating rollover state or a new generation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-foreign-active-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-a');
    const bindingPath = join(sessionDir, 'ralplan-state.json');
    await mkdir(sessionDir, { recursive: true });
    const original = '{\n  "active": true,\n  "mode": "ralplan",\n  "session_id": "session-a",\n  "workflow_variant": "advisory",\n  "advisory_generation_id": "foreign-generation",\n  "execution_handoff_authorized": false,\n  "host_verified": false\n}\n';
    await writeFile(bindingPath, original);

    const text = '$RALPLAN --ADVISORY design issue #42';
    await assert.rejects(recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
    }), /ralplan_advisory_active_binding_conflict/);

    assert.equal(await readFile(bindingPath, 'utf8'), original);
    assert.equal(existsSync(join(sessionDir, 'ralplan-advisory')), false);
  });
});
