import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  activateOrResumeRalplanAdvisory as activateRalplanAdvisoryWithProvenance,
  type ActivateOrResumeRalplanAdvisoryInput,
  type AdvisoryActivationCheckpoint,
} from '../advisory-activation.js';
import { listActiveSkills, listTransitionActiveSkills, writeSkillActiveStateCopiesForStateDir } from '../../state/skill-active.js';
import {
  administrativelyAbandonRalplanAdvisory,
  commitPreparedRalplanAdvisoryActivationInternal,
  prepareAdvisoryCloseout,
} from '../advisory.js';

const roots: string[] = [];
const activateOrResumeRalplanAdvisory = (
  input: Omit<ActivateOrResumeRalplanAdvisoryInput, 'producer' | 'threadKind' | 'resumeOnly'>,
) => activateRalplanAdvisoryWithProvenance({ ...input, producer: 'native', threadKind: 'root-or-drift' });
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('central Ralplan Advisory activation owner', () => {
  it('keeps activation preparation and commit imports behind the central owner boundary', async () => {
    const advisorySource = await readFile(join(process.cwd(), 'src', 'ralplan', 'advisory.ts'), 'utf8');
    assert.doesNotMatch(advisorySource, /export async function activateRalplanAdvisory\b/);
    assert.doesNotMatch(advisorySource, /consumeActivationIntent|beforeActivationCommit/);
    for (const relative of [
      ['src', 'ralplan', 'runtime.ts'],
      ['src', 'hooks', 'keyword-detector.ts'],
      ['src', 'scripts', 'codex-native-hook.ts'],
    ]) {
      const source = await readFile(join(process.cwd(), ...relative), 'utf8');
      assert.doesNotMatch(source, /prepareRalplanAdvisoryActivationInternal|readAuthorizedPendingRalplanActivation|commitPreparedRalplanAdvisoryActivationInternal/);
    }
  });

  it('keeps one generation recoverable across every publication checkpoint', async () => {
    const checkpoints: AdvisoryActivationCheckpoint[] = [
      'after_intent', 'after_mode', 'after_run_state',
      'before_skill_mirror_commit', 'after_skill_mirror_transaction',
      'after_session_skill', 'after_root_skill', 'before_mode_fsync', 'before_commit',
    ];
    for (const checkpoint of checkpoints) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-${checkpoint}-`));
      roots.push(cwd);
      const input = {
        cwd, sessionId: 'session-a', rootThreadId: 'root-a',
        activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá',
      };
      await assert.rejects(activateOrResumeRalplanAdvisory({
        ...input,
        failpoint: (name) => { if (name === checkpoint) throw new Error(`crash:${name}`); },
      }), /crash/);
      const root = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory');
      const intent = JSON.parse(await readFile(join(root, 'rollover-intent.json'), 'utf8'));
      const recovered = await activateOrResumeRalplanAdvisory(input);
      assert.equal(recovered.activation.generation_id, intent.generation_id, checkpoint);
      assert.equal(recovered.projection.corruption, null, checkpoint);
      assert.equal(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')).generation_id, intent.generation_id, checkpoint);
      const binding = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
      assert.equal(binding.advisory_generation_id, intent.generation_id, checkpoint);
      assert.equal(binding.execution_handoff_authorized, false, checkpoint);
      assert.equal(binding.host_verified, false, checkpoint);
    }
  });

  it('recovers a crash intent from a later authenticated root turn only', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-later-turn-recovery-'));
    roots.push(cwd);
    const prompt = '$ralplan --advisory later turn recovery';
    await assert.rejects(activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt, generationId: 'generation-a',
      failpoint: (checkpoint) => { if (checkpoint === 'after_intent') throw new Error('crash:after_intent'); },
    }), /crash:after_intent/);

    await assert.rejects(activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-foreign', activationTurnId: 'turn-b', prompt,
    }), /pending_activation_authority_mismatch/);
    const recovered = await activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-b', prompt,
    });
    assert.equal(recovered.activation.generation_id, 'generation-a');
    assert.equal(recovered.activation.activation_turn_id, 'turn-a');
    assert.equal(recovered.projection.corruption, null);
  });

  it('preserves foreign-session Team root state while repairing Advisory mirrors and retrying', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-root-merge-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    await mkdir(stateDir, { recursive: true });
    const foreignTeam = {
      version: 1, active: true, skill: 'ralplan', phase: 'architect-review', session_id: 'session-b',
      workflow_variant: 'standard', marker: 'foreign-top-level',
      active_skills: [
        { skill: 'team', active: true, phase: 'executing', session_id: 'session-b' },
        { skill: 'ralplan', active: true, phase: 'architect-review', session_id: 'session-b', workflow_variant: 'standard' },
      ],
    };
    await writeFile(join(stateDir, 'skill-active-state.json'), `${JSON.stringify(foreignTeam, null, 2)}\n`);
    const input = { cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá' };
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input, failpoint: (checkpoint) => { if (checkpoint === 'after_root_skill') throw new Error('crash:root'); },
    }), /crash:root/);
    for (const phase of ['failed activation', 'retry']) {
      const root = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf8'));
      assert.ok(root.active_skills.some((entry: Record<string, unknown>) => entry.skill === 'team' && entry.session_id === 'session-b'), phase);
      assert.equal(root.skill, foreignTeam.skill, phase);
      assert.equal(root.session_id, foreignTeam.session_id, phase);
      assert.equal(root.workflow_variant, foreignTeam.workflow_variant, phase);
      assert.equal(root.marker, foreignTeam.marker, phase);
      assert.deepEqual(
        listTransitionActiveSkills(root, 'session-b').map((entry) => [entry.skill, entry.workflow_variant]),
        [['team', undefined], ['ralplan', 'standard']],
        phase,
      );
      if (phase === 'failed activation') await activateOrResumeRalplanAdvisory(input);
    }
  });

  it('rejects a regular-file replacement between pinned validation and fsync without consuming the intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-pinned-replace-'));
    roots.push(cwd);
    const input = { cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá' };
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const replacement = `${bindingPath}.replacement`;
    const replacementBytes = '{"active":true,"mode":"ralplan","session_id":"session-a","workflow_variant":"standard"}\n';
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input,
      failpoint: async (checkpoint) => {
        if (checkpoint !== 'before_mode_fsync') return;
        await writeFile(replacement, replacementBytes);
        await rename(replacement, bindingPath);
      },
    }), /projection_(?:identity|content)_changed/);
    assert.equal(await readFile(bindingPath, 'utf8'), replacementBytes);
    await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json'));
  });

  it('rejects a same-inode overwrite after validation without consuming the intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-pinned-overwrite-'));
    roots.push(cwd);
    const input = { cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá' };
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input,
      failpoint: async (checkpoint) => {
        if (checkpoint === 'before_mode_fsync') await writeFile(bindingPath, '{"active":false}\n');
      },
    }), /projection_content_changed/);
    await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json'));
  });

  it('revalidates every runtime mirror under the activation lock immediately before consuming intent', async () => {
    for (const target of ['run-state.json', 'skill-active-state.json', 'root-skill'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-precommit-${target}-`));
      roots.push(cwd);
      const input = { cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá' };
      const stateDir = join(cwd, '.omx', 'state');
      const targetPath = target === 'root-skill'
        ? join(stateDir, 'skill-active-state.json')
        : join(stateDir, 'sessions', 'session-a', target);
      await assert.rejects(activateOrResumeRalplanAdvisory({
        ...input,
        failpoint: async (checkpoint) => {
          if (checkpoint === 'before_commit') await writeFile(targetPath, '{"active":false}\n');
        },
      }), /projection_mismatch/);
      await readFile(join(stateDir, 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json'));
      const recovered = await activateOrResumeRalplanAdvisory(input);
      assert.equal(recovered.projection.corruption, null, target);
    }
  });

  it('does not prepare or consume activation state without authenticated root provenance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-auth-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory authenticated activation',
    };
    await assert.rejects(activateRalplanAdvisoryWithProvenance({
      ...input, producer: 'native', threadKind: 'unknown',
    }), /activation_authority_required/);
    assert.equal(await activateRalplanAdvisoryWithProvenance({
      ...input, producer: 'native', threadKind: 'unknown', resumeOnly: true,
    }), null);
    assert.equal(existsSync(join(cwd, '.omx')), false);

    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input, failpoint: (checkpoint) => { if (checkpoint === 'after_intent') throw new Error('crash:intent'); },
    }), /crash:intent/);
    const intentPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json');
    const before = await readFile(intentPath, 'utf8');
    assert.equal(await activateRalplanAdvisoryWithProvenance({
      ...input, producer: 'native', threadKind: 'unknown', resumeOnly: true,
    }), null);
    assert.equal(await readFile(intentPath, 'utf8'), before);
  });

  it('returns the same committed generation after a crash at the post-commit boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-postcommit-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory idempotent activation', generationId: 'generation-a',
    };
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input, failpoint: (checkpoint) => { if (checkpoint === 'intent_committed') throw new Error('crash:committed'); },
    }), /crash:committed/);
    const retried = await activateOrResumeRalplanAdvisory(input);
    assert.equal(retried.activation.generation_id, 'generation-a');
    assert.equal(retried.projection.activation.generation_id, 'generation-a');
    const stateDir = join(cwd, '.omx', 'state');
    for (const path of [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ]) {
      const state = JSON.parse(await readFile(path, 'utf8'));
      state.active_skills = state.active_skills.map((entry: Record<string, unknown>) => entry.skill === 'ralplan'
        ? Object.fromEntries(Object.entries(entry).filter(([key]) => !['workflow_variant', 'advisory_generation_id'].includes(key)))
        : entry);
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    }
    const repaired = await activateOrResumeRalplanAdvisory(input);
    assert.equal(repaired.activation.generation_id, 'generation-a');
    for (const path of [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ]) {
      const entry = listActiveSkills(JSON.parse(await readFile(path, 'utf8')))
        .find((candidate) => candidate.skill === 'ralplan' && candidate.session_id === 'session-a');
      assert.equal(entry?.workflow_variant, 'advisory', path);
      assert.equal(entry?.advisory_generation_id, 'generation-a', path);
    }
    const sessionSkillPath = join(stateDir, 'sessions', 'session-a', 'skill-active-state.json');
    const conflicted = JSON.parse(await readFile(sessionSkillPath, 'utf8'));
    conflicted.active_skills = conflicted.active_skills.map((entry: Record<string, unknown>) => entry.skill === 'ralplan'
      ? { ...entry, advisory_generation_id: 'generation-foreign' }
      : entry);
    await writeFile(sessionSkillPath, `${JSON.stringify(conflicted, null, 2)}\n`);
    await assert.rejects(activateOrResumeRalplanAdvisory(input), /session_skill_binding_conflict/);
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input, prompt: '$ralplan --advisory different prompt',
    }), /committed_activation_authority_mismatch/);
  });

  it('rejects an exact-session foreign root generation without mutating root bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-root-conflict-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory root conflict', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    const rootPath = join(cwd, '.omx', 'state', 'skill-active-state.json');
    const root = JSON.parse(await readFile(rootPath, 'utf8'));
    root.active_skills = root.active_skills.map((entry: Record<string, unknown>) => (
      entry.skill === 'ralplan' && entry.session_id === 'session-a'
        ? { ...entry, advisory_generation_id: 'generation-foreign' }
        : entry
    ));
    const foreignBytes = `${JSON.stringify(root, null, 2)}\n`;
    await writeFile(rootPath, foreignBytes);

    await assert.rejects(activateOrResumeRalplanAdvisory(input), /root_skill_binding_conflict/);
    assert.equal(await readFile(rootPath, 'utf8'), foreignBytes);
  });

  it('rejects a contradictory same-session top-level root binding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-root-top-level-conflict-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory root top-level conflict', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    const rootPath = join(cwd, '.omx', 'state', 'skill-active-state.json');
    const root = JSON.parse(await readFile(rootPath, 'utf8'));
    const foreignBytes = `${JSON.stringify({
      ...root,
      session_id: 'session-a',
      workflow_variant: 'advisory',
      advisory_generation_id: 'generation-foreign',
    }, null, 2)}\n`;
    await writeFile(rootPath, foreignBytes);

    await assert.rejects(activateOrResumeRalplanAdvisory(input), /root_skill_binding_conflict/);
    assert.equal(await readFile(rootPath, 'utf8'), foreignBytes);
  });

  it('rejects a symlinked session mirror without modifying its target or root mirror', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-session-symlink-'));
    roots.push(cwd);
    const outside = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-session-symlink-target-'));
    roots.push(outside);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory session symlink', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    const stateDir = join(cwd, '.omx', 'state');
    const rootPath = join(stateDir, 'skill-active-state.json');
    const sessionPath = join(stateDir, 'sessions', 'session-a', 'skill-active-state.json');
    const targetPath = join(outside, 'target.json');
    const targetBytes = '{"sentinel":"unchanged"}\n';
    const rootBytes = await readFile(rootPath, 'utf8');
    await writeFile(targetPath, targetBytes);
    await rm(sessionPath);
    await symlink(targetPath, sessionPath);

    await assert.rejects(activateOrResumeRalplanAdvisory(input), /malformed-session|unreadable session/);
    assert.equal(await readFile(targetPath, 'utf8'), targetBytes);
    assert.equal(await readFile(rootPath, 'utf8'), rootBytes);
  });

  it('rejects a symlinked session mirror before first activation publishes any skill root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-initial-session-symlink-'));
    roots.push(cwd);
    const outside = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-initial-session-target-'));
    roots.push(outside);
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-a');
    const sessionPath = join(sessionDir, 'skill-active-state.json');
    const targetPath = join(outside, 'target.json');
    const targetBytes = '{"sentinel":"unchanged"}\n';
    await mkdir(sessionDir, { recursive: true });
    await writeFile(targetPath, targetBytes);
    await symlink(targetPath, sessionPath);

    await assert.rejects(activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory initial session symlink', generationId: 'generation-a',
    }), /malformed-session|unreadable session/);
    assert.equal(await readFile(targetPath, 'utf8'), targetBytes);
    assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);
  });

  it('rejects a symlinked session state authority before creating an activation intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-session-authority-symlink-'));
    roots.push(cwd);
    const outside = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-session-authority-target-'));
    roots.push(outside);
    const sessionsDir = join(cwd, '.omx', 'state', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await symlink(outside, join(sessionsDir, 'session-a'));

    await assert.rejects(activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory unsafe session authority', generationId: 'generation-a',
    }), /state_authority_unsafe/);
    assert.equal(existsSync(join(outside, 'ralplan-advisory')), false);
  });

  it('rejects symlinked .omx and sessions ancestors before recursive creation', async () => {
    for (const ancestor of ['omx', 'sessions'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-${ancestor}-ancestor-`));
      roots.push(cwd);
      const outside = await mkdtemp(join(tmpdir(), `omx-advisory-activation-${ancestor}-target-`));
      roots.push(outside);
      if (ancestor === 'omx') {
        await symlink(outside, join(cwd, '.omx'));
      } else {
        await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
        await symlink(outside, join(cwd, '.omx', 'state', 'sessions'));
      }

      await assert.rejects(activateOrResumeRalplanAdvisory({
        cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
        prompt: `$ralplan --advisory unsafe ${ancestor} ancestor`, generationId: `generation-${ancestor}`,
      }), /state_authority_unsafe/);
      assert.equal(existsSync(join(outside, 'state', 'sessions', 'session-a', 'ralplan-advisory')), false);
      assert.equal(existsSync(join(outside, 'session-a', 'ralplan-advisory')), false);
    }
  });

  it('keeps fast repair atomic when a Standard writer wins immediately after the mirror transaction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-fast-repair-race-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory repair race', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    const stateDir = join(cwd, '.omx', 'state');
    for (const path of [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ]) {
      const state = JSON.parse(await readFile(path, 'utf8'));
      state.active_skills = state.active_skills.map((entry: Record<string, unknown>) => entry.skill === 'ralplan'
        ? Object.fromEntries(Object.entries(entry).filter(([key]) => !['workflow_variant', 'advisory_generation_id'].includes(key)))
        : entry);
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    }
    const standardState = {
      version: 1, active: true, skill: 'ralplan', phase: 'planning', session_id: 'session-a',
      active_skills: [{ skill: 'ralplan', active: true, phase: 'planning', session_id: 'session-a' }],
    };
    let competitor: Promise<void> | undefined;
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input,
      failpoint: async (checkpoint) => {
        if (checkpoint === 'before_skill_mirror_commit') {
          competitor = writeSkillActiveStateCopiesForStateDir(stateDir, standardState, 'session-a');
        }
        if (checkpoint === 'after_skill_mirror_transaction') await competitor;
      },
    }), /projection_mismatch/);
    for (const path of [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ]) {
      const entries = listActiveSkills(JSON.parse(await readFile(path, 'utf8')));
      const entry = entries.find((candidate) => candidate.skill === 'ralplan' && candidate.session_id === 'session-a');
      assert.ok(entry, path);
      assert.equal(entry.workflow_variant, undefined, path);
      assert.equal(entry.advisory_generation_id, undefined, path);
    }
  });

  it('rejects a terminal generation behind a stale active binding without repairing skill mirrors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-terminal-stale-binding-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory terminal stale binding', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    await prepareAdvisoryCloseout({
      cwd, sessionId: 'session-a', generationId: 'generation-a', closingTurnId: 'turn-close', iteration: 1,
    });
    await administrativelyAbandonRalplanAdvisory({
      cwd, sessionId: 'session-a', generationId: 'generation-a', rootThreadId: 'root-a', turnId: 'turn-close',
    });
    const stateDir = join(cwd, '.omx', 'state');
    const skillPaths = [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ];
    const before = await Promise.all(skillPaths.map((path) => readFile(path, 'utf8')));
    await assert.rejects(activateOrResumeRalplanAdvisory(input), /not_precloseout/);
    assert.deepEqual(await Promise.all(skillPaths.map((path) => readFile(path, 'utf8'))), before);
  });

  it('rejects direct commit when any required mirror is missing and retains the intent', async () => {
    for (const target of ['ralplan-state.json', 'run-state.json', 'session-skill', 'root-skill'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-commit-bypass-${target}-`));
      roots.push(cwd);
      const input = {
        cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
        prompt: '$ralplan --advisory commit boundary',
      };
      await assert.rejects(activateOrResumeRalplanAdvisory({
        ...input, failpoint: (checkpoint) => { if (checkpoint === 'after_root_skill') throw new Error('crash:prepared'); },
      }), /crash:prepared/);
      const stateDir = join(cwd, '.omx', 'state');
      const targetPath = target === 'root-skill'
        ? join(stateDir, 'skill-active-state.json')
        : target === 'session-skill'
          ? join(stateDir, 'sessions', 'session-a', 'skill-active-state.json')
          : join(stateDir, 'sessions', 'session-a', target);
      await rm(targetPath);
      await assert.rejects(commitPreparedRalplanAdvisoryActivationInternal({
        cwd, sessionId: 'session-a', producer: 'native', threadKind: 'root-or-drift',
        rootThreadId: 'root-a', activationTurnId: 'turn-a',
      }), /binding_conflict|ENOENT|projection_/);
      await readFile(join(stateDir, 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json'));
    }
  });
});
