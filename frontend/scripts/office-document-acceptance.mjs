import assert from 'node:assert/strict';
import { waitForState } from './office-state-wait.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Doc, applyUpdate } from 'yjs';

async function backup(page, artifacts, name) {
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export backup', exact: true }).click();
    const download = await downloading;
    const output = path.join(artifacts, name + '.wabi.json');
    await download.saveAs(output);
    const record = JSON.parse(await readFile(output, 'utf8'));
    const doc = new Doc();
    try {
        applyUpdate(doc, new Uint8Array(Buffer.from(record.update, 'base64')));
        return { record, text: doc.getText('body').toString() };
    } finally { doc.destroy(); }
}

// Uses three independently authenticated browser profiles and the real editors,
// IndexedDB, access endpoint and durable outbox. Only storage failure is injected.
export async function documentRecoveryAcceptance(owner, editor, commenter, accounts, id, artifacts, engineName) {
    let checks = 0;
    const passed = label => { checks++; console.log(`${engineName}: ${label}`); };
    await owner.getByRole('button', { name: 'Share…', exact: true }).click();
    await owner.getByLabel('Person', { exact: true }).selectOption(String(accounts[2].id));
    await owner.getByLabel('Recipient permission', { exact: true }).selectOption('commenter');
    await owner.getByRole('button', { name: 'Add person', exact: true }).click();
    await owner.getByRole('button', { name: 'Publish and save sharing', exact: true }).click();
    await owner.locator('dialog[open]').waitFor({ state: 'hidden' });
    await commenter.evaluate(id => window.workspaceTest.open('documents', { id }), id);
    await commenter.locator('.cm-content').waitFor();
    assert.equal(await commenter.locator('.cm-content').getAttribute('contenteditable'), 'false');
    assert.equal(await commenter.getByRole('button', { name: 'Freeze live editing', exact: true }).count(), 0);
    passed('commenter cannot directly edit or freeze the shared document');

    await commenter.getByRole('button', { name: /^Review\b/ }).click();
    await commenter.getByLabel('Review comment', { exact: true }).fill('RECOVERABLE_COMMENT_DRAFT');
    await waitForState(commenter, async id => Object.values((await window.workspaceTest.record(id))?.drafts || {}).some(draft => draft.text === 'RECOVERABLE_COMMENT_DRAFT'), id);
    await commenter.reload();
    await commenter.waitForFunction(() => !!window.workspaceTest);
    await commenter.evaluate(id => window.workspaceTest.open('documents', { id }), id);
    await commenter.getByRole('button', { name: /^Private drafts\b/ }).click();
    await commenter.getByRole('button', { name: 'Restore review', exact: true }).click();
    assert.equal(await commenter.getByLabel('Review comment', { exact: true }).inputValue(), 'RECOVERABLE_COMMENT_DRAFT');
    await commenter.getByRole('button', { name: 'Submit review', exact: true }).click();
    await owner.getByRole('button', { name: /^Review\b/ }).click();
    await owner.locator('.workspace-reviews article').filter({ hasText: 'RECOVERABLE_COMMENT_DRAFT' }).waitFor();
    passed('unsubmitted comment survives reload and reaches the owner only after submission');

    await commenter.getByRole('button', { name: 'Suggest wording', exact: true }).click();
    const wording = await commenter.getByLabel('Proposed document text', { exact: true }).inputValue();
    await commenter.getByLabel('Proposed document text', { exact: true }).fill(wording + ' — ACCEPTED_REVIEW_WORDING');
    await commenter.getByLabel('Review comment', { exact: true }).fill('Suggestion for acceptance');
    await commenter.getByRole('button', { name: 'Submit review', exact: true }).click();
    const proposal = owner.locator('.workspace-reviews article').filter({ hasText: 'Suggestion for acceptance' });
    await proposal.waitFor();
    await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
    await owner.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('ACCEPTED_REVIEW_WORDING'));
    await editor.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('ACCEPTED_REVIEW_WORDING'));
    passed('owner applies a commenter suggestion and independent editors receive it');

    await waitForState(owner, async id => (await window.workspaceTest.record(id))?.pending === 0, id);
    await waitForState(editor, async id => (await window.workspaceTest.record(id))?.pending === 0, id);
    const beforeFreeze = (await owner.evaluate(id => window.workspaceTest.record(id), id)).meta;
    await editor.context().setOffline(true);
    await editor.locator('.cm-content').click();
    await editor.keyboard.press('Control+End');
    await editor.keyboard.insertText(' — PRIVATE_OFFLINE_RECOVERY');
    await waitForState(editor, async id => (await window.workspaceTest.record(id))?.pending > 0, id);
    owner.once('dialog', dialog => dialog.accept());
    await owner.getByRole('button', { name: 'Freeze live editing', exact: true }).click();
    await waitForState(owner, async id => (await window.workspaceTest.record(id))?.meta?.mode === 'snapshot', id);
    const frozen = (await owner.evaluate(id => window.workspaceTest.record(id), id)).meta;
    assert.equal(frozen.generation, beforeFreeze.generation + 1);
    assert.deepEqual(frozen.grants, beforeFreeze.grants);
    passed('freeze increments the server generation without removing access');

    const staleWrite = editor.waitForResponse(response => response.url().endsWith(`/artifacts/${id}/sync`) && response.status() === 409);
    await editor.context().setOffline(false);
    await staleWrite;
    const recovery = await backup(editor, artifacts, `${engineName}-frozen-editor-recovery`);
    assert(recovery.text.includes('PRIVATE_OFFLINE_RECOVERY'));
    assert(Object.keys(recovery.record.pending).length > 0);
    assert(!(await owner.locator('.cm-content').innerText()).includes('PRIVATE_OFFLINE_RECOVERY'));
    passed('late frozen-generation edits are rejected but remain in a portable recovery copy');

    await owner.getByRole('button', { name: 'Share…', exact: true }).click();
    await owner.locator('dialog[open] .workspace-toolbar').filter({ hasText: accounts[1].name }).getByRole('button', { name: 'Remove access', exact: true }).click();
    await owner.getByRole('button', { name: 'Publish and save sharing', exact: true }).click();
    await owner.locator('dialog[open]').waitFor({ state: 'hidden' });
    const denied = editor.waitForResponse(response => response.url().endsWith(`/artifacts/${id}/sync`) && response.status() === 404);
    await editor.getByRole('button', { name: 'Retry', exact: true }).click();
    await denied;
    const revoked = await backup(editor, artifacts, `${engineName}-revoked-editor-recovery`);
    assert.equal(revoked.text, recovery.text);
    assert(Object.keys(revoked.record.pending).length > 0);
    passed('revocation rejects retry without discarding the disconnected editor draft');

    await owner.getByRole('button', { name: 'Resume collaboration…', exact: true }).click();
    assert.equal(await owner.getByLabel('Working mode', { exact: true }).inputValue(), 'live');
    await owner.getByRole('button', { name: 'Publish and save sharing', exact: true }).click();
    await owner.locator('dialog[open]').waitFor({ state: 'hidden' });
    const resumed = (await owner.evaluate(id => window.workspaceTest.record(id), id)).meta;
    assert.equal(resumed.mode, 'live');
    assert.equal(resumed.generation, frozen.generation + 1);
    assert.equal(resumed.grants[String(accounts[1].id)], undefined);
    assert.equal(resumed.grants[String(accounts[2].id)], 'commenter');
    passed('explicit resume preserves current permissions and does not regrant a revoked account');

    const beforeCopy = await owner.evaluate(() => window.workspaceTest.records('document'));
    await owner.getByRole('button', { name: 'Make private copy', exact: true }).click();
    await owner.waitForFunction(() => document.querySelector('.workspace-privacy')?.textContent.includes('Private · this device'));
    const copies = await owner.evaluate(() => window.workspaceTest.records('document'));
    const copy = copies.find(item => !beforeCopy.some(old => old.id === item.id));
    assert(copy);
    assert.equal((await owner.evaluate(id => window.workspaceTest.record(id), copy.id)).meta, null);
    passed('private copy has a new identity and no inherited publication or grants');

    await owner.evaluate(() => {
        const previous = IDBObjectStore.prototype.put;
        window.restoreWorkspaceStorage = () => { IDBObjectStore.prototype.put = previous; };
        IDBObjectStore.prototype.put = function (...args) {
            if (this.name === 'artifacts') throw new DOMException('Injected workspace quota failure', 'QuotaExceededError');
            return previous.apply(this, args);
        };
    });
    try {
        await owner.locator('.cm-content').click();
        await owner.keyboard.press('Control+End');
        await owner.keyboard.insertText(' — QUOTA_RECOVERY_MUST_SURVIVE');
        await owner.waitForFunction(() => document.querySelector('.workspace-status')?.textContent === 'Needs attention');
        await owner.getByRole('button', { name: 'Library', exact: true }).click();
        assert((await owner.locator('.cm-content').innerText()).includes('QUOTA_RECOVERY_MUST_SURVIVE'));
        const quota = await backup(owner, artifacts, `${engineName}-quota-recovery`);
        assert(quota.text.includes('QUOTA_RECOVERY_MUST_SURVIVE'));
        assert.equal(quota.record.meta, null);
        passed('quota failure does not claim Saved or navigate away and recovery retains in-memory work');
    } finally {
        await owner.evaluate(() => window.restoreWorkspaceStorage());
    }
    await owner.getByRole('button', { name: 'Retry', exact: true }).click();
    await owner.waitForFunction(() => document.querySelector('.workspace-status')?.textContent === 'Saved on this device');
    await owner.reload();
    await owner.waitForFunction(() => !!window.workspaceTest);
    await owner.evaluate(id => window.workspaceTest.open('documents', { id }), copy.id);
    await owner.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('QUOTA_RECOVERY_MUST_SURVIVE'));
    passed('retry after storage recovery survives a full browser-page reload');

    await owner.getByRole('button', { name: 'Library', exact: true }).click();
    let uploads = 0;
    const track = request => { if (request.method() === 'POST' && /\/api\/workspace\/artifacts(?:\/|$)/.test(request.url())) uploads++; };
    owner.on('request', track);
    const original = Buffer.from('Unchanged source คน 🙂\n0012,=literal\n', 'utf8');
    try {
        await owner.locator('input[type="file"]').first().setInputFiles({ name: 'original-recovery.txt', mimeType: 'text/plain', buffer: original });
        await owner.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Unchanged source'));
        await owner.locator('.cm-content').click();
        await owner.keyboard.press('Control+End');
        await owner.keyboard.insertText('Private changed copy');
        const downloading = owner.waitForEvent('download');
        await owner.getByRole('button', { name: 'Original file', exact: true }).click();
        const download = await downloading, output = path.join(artifacts, `${engineName}-unchanged-original.txt`);
        await download.saveAs(output);
        assert.deepEqual(await readFile(output), original);
        assert.equal(uploads, 0, 'Opening and editing a file must not implicitly publish it');
        passed('editing an imported document preserves original bytes without an upload');
    } finally { owner.off('request', track); }
    return checks;
}
