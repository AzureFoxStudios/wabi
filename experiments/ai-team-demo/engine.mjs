import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
export const hash = text => createHash('sha256').update(text).digest('hex');
const root = new URL('./', import.meta.url);
export class Conflict extends Error { status = 409; }

export async function createEngine(directory) {
  await mkdir(directory, { recursive: true });
  const before = await readFile(new URL('fixtures/before.mjs', root), 'utf8');
  const after = await readFile(new URL('fixtures/after.mjs', root), 'utf8');
  const checks = await readFile(new URL('fixtures/checks.mjs', root), 'utf8');
  const recording = JSON.parse(await readFile(new URL('recording.json', root), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('approved.json', root), 'utf8'));
  if (manifest.source !== hash(after) || manifest.checks !== hash(checks)) throw new Error('Demo fixture differs from inspected, pinned source. Re-inspection required.');
  const stateFile = join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { schema: 1, revision: 0, phase: 'ready', owner: null, claims: [], comments: [], baseline: null, candidate: null, verification: null, accepted: null, requests: {} };
  }
  if (state.schema !== 1) throw new Error('Unsupported demo state.');
  const save = async next => {
    await writeFile(stateFile + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(stateFile + '.tmp', stateFile);
    state = next;
  };
  const snapshot = () => {
    const { requests, ...visible } = state;
    return structuredClone({ ...visible, source: { before, after }, manifest, recording, environment: { node: process.version, platform: process.platform, arch: process.arch } });
  };
  const comment = (next, actor, text, kind = 'discussion') => next.comments.push({ id: next.comments.length + 1, actor, text, kind, at: new Date().toISOString() });
  async function testFixture(folder, source) {
    const location = join(directory, folder);
    await mkdir(location, { recursive: true });
    await writeFile(join(location, 'candidate.mjs'), source);
    await writeFile(join(location, 'checks.mjs'), checks);
    let result;
    try { result = { ...(await run(process.execPath, ['--test', '--test-reporter=tap', 'checks.mjs'], { cwd: location, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, timeout: 10000, maxBuffer: 100000 })), exitCode: 0 }; }
    catch (error) {
      if (typeof error.code !== 'number') throw error;
      result = { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
    }
    const total = Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]);
    const passed = Number(result.stdout.match(/^# pass (\d+)$/m)?.[1]);
    if (total !== 6 || !Number.isInteger(passed) || (result.exitCode === 0 && passed !== total)) throw new Error('Complete test evidence was not captured. No verification was saved.');
    const evidence = { ...result, total, passed, sourceHash: hash(source), checksHash: hash(checks), node: process.version, command: 'node --test --test-reporter=tap checks.mjs', at: new Date().toISOString(), folder };
    await writeFile(join(location, 'evidence.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  }
  let queue = Promise.resolve();
  async function mutate(input) {
    if (!input || !['reproduce', 'claim', 'propose', 'verify', 'accept', 'comment', 'new-run'].includes(input.action)) throw new Error('Unknown action');
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId ?? '')) throw new Error('A request ID is required');
    if (!['worker-a', 'worker-b', 'human'].includes(input.actor)) throw new Error('Unknown demo role');
    const signature = hash(JSON.stringify(input));
    const prior = state.requests[input.requestId];
    if (prior) {
      if (prior.signature !== signature) throw new Conflict('Request ID was already used with a different action.');
      return { ...prior.result, state: snapshot(), replayed: true };
    }
    if (Object.keys(state.requests).length >= 500) throw new Error('Demo action limit reached. Start with a fresh state directory.');
    const next = structuredClone(state);
    let outcome = 'ok';
    // Claim intentionally uses ownership as its compare-and-set condition:
    // simultaneous clients do not acquire the same unowned card.
    if (input.action !== 'claim' && input.expectedRevision !== state.revision) throw new Conflict('The card changed. Reload and review the current revision.');
    switch (input.action) {
      case 'new-run': {
        if (input.actor !== 'human' || state.phase !== 'done') throw new Conflict('Finish this demonstration before starting another.');
        // Preserve the completed record and all embedded evidence. The fixed
        // disposable workspace files may be reused by the next demonstration.
        await writeFile(join(directory, `completed-${state.revision}.json`), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
        Object.assign(next, { phase: 'ready', owner: null, claims: [], comments: [], baseline: null, candidate: null, verification: null, accepted: null });
        break;
      }
      case 'reproduce': {
        if (state.phase !== 'ready' || input.actor !== 'human') throw new Conflict('Reproduction is already recorded or this role cannot start it.');
        next.baseline = await testFixture('reproduction', before);
        if (next.baseline.exitCode === 0) throw new Error('The example no longer reproduces a failure.');
        next.phase = 'open';
        comment(next, 'human', 'Reconnecting repeats events. Keep one event per ID, retain its original position, and use the latest value. The reproduction fails; claim this card before editing.', 'brief');
        break;
      }
      case 'claim': {
        if (!['worker-a', 'worker-b'].includes(input.actor) || !['open', 'working'].includes(state.phase)) throw new Conflict('This card is not accepting worker claims.');
        if (state.owner && state.owner !== input.actor) {
          outcome = 'conflict';
          comment(next, input.actor, 'The edit is already claimed. I will wait for a proposal and verify it in a separate folder; I will not overwrite the owner’s work.', 'coordination');
        } else {
          next.owner = input.actor;
          next.phase = 'working';
          comment(next, input.actor, 'Claimed the fix in candidate.mjs. I will propose a change with a pinned source version.', 'coordination');
        }
        next.claims.push({ actor: input.actor, outcome });
        break;
      }
      case 'propose': {
        if (state.phase !== 'working' || state.owner !== input.actor) throw new Conflict('Only the current owner can propose this fix.');
        const workspace = join(directory, input.actor);
        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, 'candidate.mjs'), after);
        next.candidate = { hash: hash(after), checksHash: hash(checks), owner: input.actor, folder: input.actor, at: new Date().toISOString() };
        next.phase = 'review';
        comment(next, input.actor, recording.builder.output.handoff || recording.builder.output.summary || 'Recorded model proposal is ready. Please check the source and run the regression fixture independently.', 'model-proposal');
        break;
      }
      case 'verify': {
        if (state.phase !== 'review' || input.actor === state.owner || input.actor === 'human') throw new Conflict('The other worker verifies the proposed version.');
        const source = await readFile(join(directory, state.candidate.folder, 'candidate.mjs'), 'utf8');
        if (hash(source) !== manifest.source || hash(source) !== state.candidate.hash) throw new Conflict('Candidate changed outside the review. Verification refused.');
        next.verification = { ...(await testFixture(input.actor, source)), reviewer: input.actor };
        comment(next, input.actor, recording.verifier.output.summary, 'model-review');
        comment(next, 'system', next.verification.exitCode === 0 ? 'Independent local checks passed on the proposed source hash. Human acceptance is still required.' : 'Independent checks failed. Acceptance is blocked.', 'evidence');
        break;
      }
      case 'accept': {
        if (input.actor !== 'human' || state.phase !== 'review' || !state.verification || state.verification.exitCode !== 0 || state.verification.sourceHash !== state.candidate.hash || state.verification.checksHash !== manifest.checks || input.candidateHash !== state.candidate.hash) throw new Conflict('Acceptance requires passing evidence for this exact candidate and a human demo role.');
        const current = await readFile(join(directory, state.candidate.folder, 'candidate.mjs'), 'utf8');
        const verified = await readFile(join(directory, state.verification.folder, 'candidate.mjs'), 'utf8');
        if (hash(current) !== state.candidate.hash || hash(verified) !== state.candidate.hash) throw new Conflict('A source file changed after verification. Acceptance refused.');
        next.phase = 'done';
        next.accepted = { hash: state.candidate.hash, at: new Date().toISOString(), actor: 'human' };
        comment(next, 'human', 'Accepted the tested version. Keep the reproduction, proposal and check results together for the next session.', 'decision');
        break;
      }
      case 'comment': {
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new Error('Write a comment of 1–2000 characters.');
        comment(next, input.actor, input.text.trim());
        break;
      }
    }
    next.revision++;
    next.requests[input.requestId] = { signature, result: { outcome } };
    await save(next);
    return { outcome, state: snapshot() };
  }
  return { snapshot, dispatch(input) {
    const result = queue.then(() => mutate(input));
    queue = result.catch(() => {});
    return result;
  } };
}
