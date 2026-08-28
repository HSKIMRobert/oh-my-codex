import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyKeywordInput, recordSkillActivation } from '../keyword-detector.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('ralplan advisory keyword activation', () => {
  it('activates only a direct literal standalone invocation with canonical identity', async () => {
    for (const [index, text] of ['$ralplan --advisory design issue #42', '$oh-my-codex:ralplan --advisory design issue #42'].entries()) {
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
    for (const text of ['$ralplan --advisory --execute task', '$ralplan --advisory $team task']) {
      assert.equal(await recordSkillActivation({ stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text), sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a' }), null);
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
});
