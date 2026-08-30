import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMode } from '../../modes/base.js';
import { __setStateOperationTestHooksForTests, executeStateOperation, withStateFileWriteTransaction, writeStateFile } from '../operations.js';
import { __setCanonicalModeBindingLeaseTestHooksForTests, resolveValidatedCanonicalModeBinding } from '../mode-binding-lease.js';

const roots: string[] = [];
afterEach(async () => {
  __setStateOperationTestHooksForTests({});
  __setCanonicalModeBindingLeaseTestHooksForTests({});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('canonical mode binding lease', () => {
  it('keeps persistent namespace identity evidence out of git worktree status', async () => {
    const ignore = await readFile(join(process.cwd(), '.gitignore'), 'utf8');
    assert.match(ignore, /^\.omx-state-locks\/\s*$/mu);
    assert.match(ignore, /^\.omx-state-locks\.identity\.json\s*$/mu);
  });

  it('supports the authorized arbitrary OMX_TEAM_STATE_ROOT binding surface', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-team-cwd-'));
    const shared = await mkdtemp(join(tmpdir(), 'omx-mode-lease-team-root-'));
    roots.push(cwd, shared);
    const teamRoot = join(shared, 'team-state');
    await mkdir(teamRoot);
    const previous = [process.env.OMX_TEAM_STATE_ROOT, process.env.OMX_ROOT, process.env.OMX_STATE_ROOT];
    try {
      process.env.OMX_TEAM_STATE_ROOT = teamRoot;
      delete process.env.OMX_ROOT;
      delete process.env.OMX_STATE_ROOT;
      await startMode('ralplan', 'team-root', 10, cwd, 'session-a');
      const state = JSON.parse(await readFile(join(teamRoot, 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
      assert.equal(state.active, true);
    } finally {
      for (const [key, value] of [['OMX_TEAM_STATE_ROOT', previous[0]], ['OMX_ROOT', previous[1]], ['OMX_STATE_ROOT', previous[2]]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('derives one structural root/session lease when an authorized root itself contains sessions components', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'omx-mode-lease-structural-root-'));
    roots.push(parent);
    const stateRoot = join(parent, 'sessions', 'outer', 'sessions', 'team-state');
    await mkdir(stateRoot, { recursive: true });
    const rootPath = join(stateRoot, 'ralplan-state.json');
    const sessionPath = join(stateRoot, 'sessions', 'session-a', 'ralplan-state.json');
    const rootBinding = await resolveValidatedCanonicalModeBinding(rootPath, stateRoot);
    const sessionBinding = await resolveValidatedCanonicalModeBinding(sessionPath, stateRoot);
    assert.equal(rootBinding.leasePath, sessionBinding.leasePath);
    let concurrent = 0;
    let maximum = 0;
    const run = (path: string) => withStateFileWriteTransaction(path, async () => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      concurrent -= 1;
    }, stateRoot);
    await Promise.all([run(rootPath), run(sessionPath)]);
    assert.equal(maximum, 1);
  });

  it('supports authorized OMX_ROOT and OMX_STATE_ROOT boxed roots', async () => {
    for (const selector of ['OMX_ROOT', 'OMX_STATE_ROOT'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-mode-lease-${selector}-cwd-`));
      const boxed = await mkdtemp(join(tmpdir(), `omx-mode-lease-${selector}-root-`));
      roots.push(cwd, boxed);
      const previous = [process.env.OMX_TEAM_STATE_ROOT, process.env.OMX_ROOT, process.env.OMX_STATE_ROOT];
      try {
        delete process.env.OMX_TEAM_STATE_ROOT;
        delete process.env.OMX_ROOT;
        delete process.env.OMX_STATE_ROOT;
        process.env[selector] = boxed;
        await startMode('ralplan', selector, 10, cwd, 'session-a');
        const state = JSON.parse(await readFile(join(boxed, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
        assert.equal(state.active, true);
      } finally {
        for (const [key, value] of [['OMX_TEAM_STATE_ROOT', previous[0]], ['OMX_ROOT', previous[1]], ['OMX_STATE_ROOT', previous[2]]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    }
  });

  it('serializes symlink aliases under one canonical workspace identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-alias-'));
    const aliasRoot = await mkdtemp(join(tmpdir(), 'omx-mode-lease-alias-parent-'));
    roots.push(cwd, aliasRoot);
    const alias = join(aliasRoot, 'workspace');
    await symlink(cwd, alias);
    const direct = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const throughAlias = join(alias, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    let concurrent = 0;
    let maximum = 0;
    const run = (path: string) => withStateFileWriteTransaction(path, async () => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      concurrent -= 1;
    });
    await Promise.all([run(direct), run(throughAlias)]);
    assert.equal(maximum, 1);
  });

  it('rejects traversal before creating a lease namespace or running work', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-traversal-'));
    roots.push(cwd);
    const traversal = join(cwd, '.omx', 'state', 'sessions', '..', '..', 'foreign.json');
    let ran = false;
    await assert.rejects(withStateFileWriteTransaction(traversal, async () => { ran = true; }), /canonical \.omx\/state/);
    assert.equal(ran, false);
    assert.equal(existsSync(join(cwd, '.omx-state-locks')), false);
  });

  it('keeps standard sanctioned writers on the legacy local queue on unsupported platforms', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-unsupported-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    let ran = false;
    __setCanonicalModeBindingLeaseTestHooksForTests({ platform: 'win32' });
    await Promise.race([
      withStateFileWriteTransaction(path, async () => {
        await withStateFileWriteTransaction(path, async () => { ran = true; });
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('nested fallback timed out')), 500)),
    ]);
    assert.equal(ran, true);
    await startMode('team', 'win32 standard', 10, cwd, 'session-a');
    const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'team-state.json'), 'utf8'));
    assert.equal(state.active, true);
    assert.equal(existsSync(join(cwd, '.omx-state-locks')), false);
    assert.equal(existsSync(join(cwd, '.omx-state-locks.identity.json')), false);
  });

  it('never reclaims an ambiguous lock owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-ambiguous-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    await writeFile(join(lockPath, 'foreign-metadata'), 'do-not-delete');
    await assert.rejects(withStateFileWriteTransaction(path, async () => undefined), /timed out waiting/);
    assert.equal(await readFile(join(lockPath, 'foreign-metadata'), 'utf8'), 'do-not-delete');
  });

  it('recovers only aged partial owners and legacy live-PID owner records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-partial-owner-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    const partial = join(lockPath, 'owner-partial');
    await writeFile(partial, '');
    await assert.rejects(withStateFileWriteTransaction(path, async () => undefined), /timed out waiting/);
    const stalePartial = new Date(Date.now() - 60_000);
    await utimes(partial, stalePartial, stalePartial);
    await utimes(lockPath, stalePartial, stalePartial);
    await withStateFileWriteTransaction(path, async () => undefined);

    const legacyToken = `${process.pid}-legacy-owner`;
    await writeFile(join(lockPath, `owner-${legacyToken}`), legacyToken);
    await assert.rejects(withStateFileWriteTransaction(path, async () => undefined), /timed out waiting/);
    const beyondGrace = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await utimes(join(lockPath, `owner-${legacyToken}`), beyondGrace, beyondGrace);
    await utimes(lockPath, beyondGrace, beyondGrace);
    await withStateFileWriteTransaction(path, async () => undefined);
  });

  it('recovers an aged partial namespace identity marker but not a recent one', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-partial-marker-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const markerPath = join(cwd, '.omx-state-locks.identity.json');
    await writeFile(markerPath, '');
    await assert.rejects(withStateFileWriteTransaction(path, async () => undefined), /marker malformed/);
    const stale = new Date(Date.now() - 60_000);
    await utimes(markerPath, stale, stale);
    await withStateFileWriteTransaction(path, async () => undefined);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(markerPath, 'utf8'))).sort(), ['dev', 'ino']);
    const tempResidue = `${markerPath}.tmp-${process.pid}-residue`;
    await link(markerPath, tempResidue);
    await utimes(markerPath, stale, stale);
    await withStateFileWriteTransaction(path, async () => undefined);
    assert.equal(existsSync(tempResidue), false);
  });

  it('rejects a lock-directory symlink swap without dereferencing or deleting the external owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-lock-swap-'));
    const external = await mkdtemp(join(tmpdir(), 'omx-mode-lease-lock-external-'));
    roots.push(cwd, external);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    const displaced = `${lockPath}.displaced`;
    await writeFile(join(external, 'owner-external'), 'external');
    await assert.rejects(withStateFileWriteTransaction(path, async () => {
      await rename(lockPath, displaced);
      await symlink(external, lockPath);
    }), /lock ownership lost/);
    assert.equal(await readFile(join(external, 'owner-external'), 'utf8'), 'external');
    assert.equal((await readdir(displaced)).length, 1);
  });

  it('never follows a stale lock symlink while attempting reclaim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-stale-symlink-'));
    const external = await mkdtemp(join(tmpdir(), 'omx-mode-lease-stale-external-'));
    roots.push(cwd, external);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    await rm(lockPath, { recursive: true, force: true });
    await writeFile(join(external, 'owner-external'), 'external');
    await symlink(external, lockPath);
    let ran = false;
    await assert.rejects(withStateFileWriteTransaction(path, async () => { ran = true; }), /timed out waiting/);
    assert.equal(ran, false);
    assert.equal(await readFile(join(external, 'owner-external'), 'utf8'), 'external');
  });

  it('rejects a state-root swap before a nested sanctioned write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-root-swap-'));
    roots.push(cwd);
    const stateRoot = join(cwd, '.omx', 'state');
    const displaced = join(cwd, '.omx', 'state.displaced');
    const path = join(stateRoot, 'sessions', 'session-a', 'ralplan-state.json');
    await mkdir(join(stateRoot, 'sessions', 'session-a'), { recursive: true });
    await assert.rejects(withStateFileWriteTransaction(path, async () => {
      await rename(stateRoot, displaced);
      await mkdir(join(stateRoot, 'sessions', 'session-a'), { recursive: true });
      await writeStateFile(path, '{}');
    }), /state root identity changed/);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(displaced, 'sessions', 'session-a', 'ralplan-state.json')), false);
  });

  it('serializes a new session start until session clear finishes all mirrors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-clear-'));
    roots.push(cwd);
    await startMode('ralplan', 'old', 10, cwd, 'session-a');
    let successor: Promise<unknown> | undefined;
    __setStateOperationTestHooksForTests({
      afterStateClearPrimary: () => {
        successor ??= startMode('ralplan', 'successor', 10, cwd, 'session-a');
      },
    });
    const cleared = await executeStateOperation('state_clear', {
      workingDirectory: cwd, session_id: 'session-a', mode: 'ralplan',
    });
    assert.equal(cleared.isError, undefined);
    await successor;
    const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
    assert.equal(state.active, true);
    assert.equal(state.task_description, 'successor');
  });

  it('uses the root lease as an umbrella across every session during all-sessions clear', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-clear-all-'));
    roots.push(cwd);
    await startMode('ralplan', 'session-a', 10, cwd, 'session-a');
    await startMode('ralplan', 'session-b', 10, cwd, 'session-b');
    let successor: Promise<unknown> | undefined;
    __setStateOperationTestHooksForTests({
      afterStateClearPrimary: () => {
        successor ??= startMode('ralplan', 'session-b-successor', 10, cwd, 'session-b');
      },
    });
    const cleared = await executeStateOperation('state_clear', {
      workingDirectory: cwd, mode: 'ralplan', all_sessions: true,
    });
    assert.equal(cleared.isError, undefined);
    await successor;
    const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-b', 'ralplan-state.json'), 'utf8'));
    assert.equal(state.active, true);
    assert.equal(state.task_description, 'session-b-successor');
  });
});
