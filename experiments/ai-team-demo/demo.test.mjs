import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEngine, Conflict } from './engine.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wabi-demo-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = await createEngine(directory);
  const send = (action, actor = 'human', extra = {}) => engine.dispatch({ action, actor, expectedRevision: engine.snapshot().revision, requestId: randomUUID(), ...extra });
  return { directory, engine, send };
}
async function proposed(t) {
  const context = await setup(t);
  await context.send('reproduce');
  await context.send('claim', 'worker-a');
  await context.send('propose', 'worker-a');
  return context;
}
test('competing claims have one winner; replay does not duplicate actions', async t => {
  const { engine, send } = await setup(t);
  await send('reproduce');
  const result = await Promise.all([send('claim', 'worker-a'), send('claim', 'worker-b')]);
  assert.deepEqual(result.map(r => r.outcome).sort(), ['conflict', 'ok']);
  assert.equal(engine.snapshot().owner, 'worker-a');
  assert.equal(engine.snapshot().claims.length, 2);
  const input = { action: 'comment', actor: 'human', requestId: randomUUID(), expectedRevision: engine.snapshot().revision, text: 'Inspect the proposed version.' };
  await engine.dispatch(input);
  const revision = engine.snapshot().revision;
  assert.equal((await engine.dispatch(input)).replayed, true);
  assert.equal(engine.snapshot().revision, revision);
  await assert.rejects(engine.dispatch({ ...input, text: 'Different content' }), Conflict);
});
test('non-owner cannot overwrite; stale edits and acceptance before checks are refused', async t => {
  const { engine, send } = await setup(t);
  await send('reproduce');
  await send('claim', 'worker-a');
  await assert.rejects(send('propose', 'worker-b'), Conflict);
  await assert.rejects(send('propose', 'worker-a', { expectedRevision: 0 }), Conflict);
  await send('propose', 'worker-a');
  await assert.rejects(send('accept', 'human', { candidateHash: engine.snapshot().candidate.hash }), Conflict);
  await assert.rejects(send('verify', 'worker-a'), Conflict);
});
test('real failing reproduction becomes passing independent check; saved handoff survives reload', async t => {
  const { engine, send, directory } = await proposed(t);
  assert.notEqual(engine.snapshot().baseline.exitCode, 0);
  await send('verify', 'worker-b');
  const checked = engine.snapshot();
  assert.equal(checked.verification.exitCode, 0);
  assert.match(checked.verification.stdout, /# pass 6/);
  assert.equal(checked.verification.sourceHash, checked.candidate.hash);
  await assert.rejects(send('accept', 'worker-a', { candidateHash: checked.candidate.hash }), Conflict);
  await assert.rejects(send('accept', 'human', { candidateHash: 'stale-source' }), Conflict);
  await send('comment', 'human', { text: 'Reviewed the current proposal.' });
  await assert.rejects(send('accept', 'human', { candidateHash: checked.candidate.hash, expectedRevision: checked.revision }), Conflict);
  await send('accept', 'human', { candidateHash: checked.candidate.hash });
  const restored = await createEngine(directory);
  assert.deepEqual(restored.snapshot(), engine.snapshot());
  assert.equal(restored.snapshot().phase, 'done');
  const acceptedRevision = engine.snapshot().revision;
  await send('new-run');
  assert.equal(engine.snapshot().phase, 'ready');
  assert.equal(engine.snapshot().revision, acceptedRevision + 1);
  assert.equal(JSON.parse(await readFile(join(directory, `completed-${acceptedRevision}.json`), 'utf8')).accepted.hash, checked.candidate.hash);
  await assert.rejects(send('new-run'), Conflict);
});
test('candidate tampering before verification is rejected before executing it', async t => {
  const { send, directory } = await proposed(t);
  await writeFile(join(directory, 'worker-a', 'candidate.mjs'), 'throw new Error("must never run");');
  await assert.rejects(send('verify', 'worker-b'), /Candidate changed/);
});
test('source changes after testing invalidate acceptance', async t => {
  const { engine, send, directory } = await proposed(t);
  await send('verify', 'worker-b');
  await writeFile(join(directory, 'worker-b', 'candidate.mjs'), '// changed after verification');
  await assert.rejects(send('accept', 'human', { candidateHash: engine.snapshot().candidate.hash }), /changed after verification/);
  assert.equal(engine.snapshot().accepted, null);
});
test('failed evidence cannot be accepted after restoration', async t => {
  const { send, directory } = await proposed(t);
  await send('verify', 'worker-b');
  const path = join(directory, 'state.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.verification.exitCode = 1;
  await writeFile(path, JSON.stringify(saved));
  const restored = await createEngine(directory);
  await assert.rejects(restored.dispatch({ action: 'accept', actor: 'human', expectedRevision: saved.revision, requestId: randomUUID(), candidateHash: saved.candidate.hash }), Conflict);
});
test('the earlier model-approved proposal fails the added regression', async t => {
  const { directory } = await setup(t);
  const prior = JSON.parse(await readFile(new URL('recording.rejected.json', import.meta.url), 'utf8'));
  await writeFile(join(directory, 'candidate.mjs'), prior.builder.output.source);
  await writeFile(join(directory, 'checks.mjs'), await readFile(new URL('fixtures/checks.mjs', import.meta.url)));
  await assert.rejects(promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', 'checks.mjs'], { cwd: directory, env: { PATH: process.env.PATH }, timeout: 10000 }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /not ok.*existing duplicates/);
    return true;
  });
});
