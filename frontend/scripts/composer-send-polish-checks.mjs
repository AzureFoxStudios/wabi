import assert from 'node:assert/strict';

/** Real mounted composer, controlled offline-enqueue handoff boundary. This
 * verifies UI ownership, not server acknowledgments or queue durability. */
export async function runComposerSendChecks(page) {
  const first = 'A'.repeat(240), second = 'B'.repeat(240), third = 'C'.repeat(240);
  async function choose(label) {
    await page.locator('.workspace-trigger').click();
    await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(label => document.querySelector('.workspace-current')?.textContent === label, label);
  }
  await choose('Messages');
  await page.evaluate(async () => {
    const { getWabiDB, openWabiDB } = await import('/src/lib/wabidb/index.ts');
    const { connected } = await import('/src/lib/socketConnection.ts');
    const { composerEnhancementSettingsStore: settings } = await import('/src/lib/composerEnhancements.ts');
    const get = store => { let result; store.subscribe(value => result = value)(); return result; };
    const db = getWabiDB() || await openWabiDB();
    const state = window.__polishSend = { db, enqueue: db.enqueue, connected, wasConnected: get(connected), settings,
      previousSettings: get(settings), sent: [], release: null, rejectAt: -1, deferAt: 0,
      fetch: window.fetch, uploadInitFailure: false, uploadRequests: 0 };
    db.enqueue = async action => {
      const index = state.sent.length;
      state.sent.push(action.payload.text);
      if (index === state.deferAt) await new Promise(resolve => { state.release = resolve; });
      if (index === state.rejectAt) throw new Error('Fixture queue transaction aborted');
    };
    settings.update(current => ({ ...current, splitLargeMessagesEnabled: true, splitLargeMessagesChunkSize: 250, writeUpperCaseEnabled: false }));
    connected.set(false);
    // Exercise the mounted composer's real upload/orchestrator code without
    // storing fixture files on the server. Only upload HTTP is controlled.
    window.fetch = async (url, init) => {
      if (!String(url).includes('/api/upload/resumable/')) return state.fetch(url, init);
      state.uploadRequests++;
      if (!String(url).endsWith('/init')) throw new Error(`Unexpected fixture upload request: ${url}`);
      if (state.uploadInitFailure) return new Response('{}', { status: 503 });
      const file = JSON.parse(init.body);
      return new Response(JSON.stringify({ uploadId: 'polish-fixture', completed: true,
        fileUrl: `/uploads/polish-fixture/${file.fileName}` }), { status: 200 });
    };
  });
  const composer = page.locator('.chat-container textarea[rows="1"]');
  const send = page.locator('.chat-container .send-button');
  try {
    await composer.fill(`${first} ${second} ${third}`);
    await send.click();
    await page.waitForFunction(() => window.__polishSend.release !== null);
    await choose('Notes'); await choose('Messages');
    assert.ok(await send.isDisabled(), 'remounted editor cannot duplicate an in-flight handoff');
    await page.evaluate(() => window.__polishSend.release());
    await page.waitForFunction(expected => document.querySelector('.chat-container textarea[rows="1"]')?.value === expected, `${second}\n\n${third}`);
    assert.equal(await page.evaluate(() => window.__polishSend.sent.length), 1, 'retired editor never submits the next chunk');
    await page.waitForFunction(() => !document.querySelector('.chat-container .send-button')?.disabled);
    await page.evaluate(() => { window.__polishSend.rejectAt = 2; });
    await send.click();
    await page.waitForFunction(expected => document.querySelector('.chat-container textarea[rows="1"]')?.value === expected && !document.querySelector('.chat-container .send-button')?.disabled, third);
    assert.deepEqual(await page.evaluate(() => window.__polishSend.sent), [first, second, third], 'partial retry does not resend an accepted prefix');
    const failedRow = await page.evaluate(async text => {
      const { channelMessages } = await import('/src/lib/messageStore.ts');
      let messages; channelMessages.subscribe(value => messages = value)();
      const row = Object.values(messages).flat().find(message => message.text === text);
      return { state: row?.deliveryState, error: row?.deliveryError, stable: row?.id === row?.clientMessageId };
    }, third);
    assert.equal(failedRow.state, 'failed', 'queue abort does not leave a forever-sending optimistic row');
    assert.match(failedRow.error, /Not queued/);
    assert.equal(failedRow.stable, true, 'failed queue handoff preserves the optimistic message key');
    await page.evaluate(() => { window.__polishSend.rejectAt = -1; });
    await send.click();
    await page.waitForFunction(() => document.querySelector('.chat-container textarea[rows="1"]')?.value === '');
    assert.deepEqual(await page.evaluate(() => window.__polishSend.sent), [first, second, third, third], 'only the failed final chunk is retried');

    const files = page.locator('.chat-container input[type="file"].hidden');
    const preview = page.locator('.chat-container .gallery-file-name');
    async function prepareAttachment(caption, name = 'handoff-fixture.txt') {
      await composer.fill(caption);
      await files.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Disposable upload fixture') });
      await preview.filter({ hasText: name }).waitFor();
    }
    async function deferAttachment(reject = false) {
      await page.evaluate(reject => {
        const state = window.__polishSend;
        state.deferAt = state.sent.length; state.rejectAt = reject ? state.sent.length : -1; state.release = null;
      }, reject);
      await send.click();
      await page.waitForFunction(() => window.__polishSend.release !== null);
      await choose('Notes'); await choose('Messages');
      assert.ok(await send.isDisabled(), 'remounted attachment draft cannot duplicate an in-flight handoff');
    }
    async function finishAttachment() {
      await page.evaluate(() => window.__polishSend.release());
      await page.waitForFunction(() => {
        return !document.querySelector('.chat-container .upload-progress-bar') &&
          (!document.querySelector('.chat-container textarea[rows="1"]')?.value ||
          !document.querySelector('.chat-container .send-button')?.disabled);
      });
    }

    await prepareAttachment('Accepted attachment caption');
    const beforeAttachment = await page.evaluate(() => window.__polishSend.sent.length);
    await deferAttachment(); await finishAttachment();
    await preview.waitFor({ state: 'hidden' });
    assert.equal(await composer.inputValue(), '', 'accepted attachment consumes restored caption and File');
    assert.equal(await page.evaluate(() => window.__polishSend.sent.length), beforeAttachment + 1);
    await choose('Notes'); await choose('Messages');
    assert.equal(await preview.count(), 0, 'accepted attachment cannot resurrect on another remount');

    await prepareAttachment('Next accepted attachment');
    await deferAttachment();
    await prepareAttachment('Replacement caption', 'replacement-fixture.txt');
    await finishAttachment();
    assert.equal(await composer.inputValue(), 'Replacement caption', 'new caption survives old attachment settlement');
    assert.equal(await preview.textContent(), 'replacement-fixture.txt', 'new File survives old attachment settlement');
    await page.locator('.chat-container .cancel-gallery').click();

    await prepareAttachment('Rejected attachment caption');
    await deferAttachment(true); await finishAttachment();
    assert.equal(await composer.inputValue(), 'Rejected attachment caption');
    assert.equal(await preview.textContent(), 'handoff-fixture.txt', 'queue rejection retains the attachment for retry');
    await page.locator('.chat-container .cancel-gallery').click();

    await prepareAttachment('Upload failure caption');
    const beforeFailure = await page.evaluate(() => {
      window.__polishSend.uploadInitFailure = true;
      return { sent: window.__polishSend.sent.length, requests: window.__polishSend.uploadRequests };
    });
    await send.click();
    await page.waitForFunction(before => window.__polishSend.uploadRequests > before &&
      !document.querySelector('.chat-container .send-button')?.disabled, beforeFailure.requests);
    assert.equal(await composer.inputValue(), 'Upload failure caption');
    assert.equal(await preview.textContent(), 'handoff-fixture.txt', 'pre-send upload failure retains the attachment');
    assert.equal(await page.evaluate(() => window.__polishSend.sent.length), beforeFailure.sent, 'failed upload never hands off a message');
    await page.locator('.chat-container .cancel-gallery').click();
    await composer.fill('');

    // No composer or draft-memory operation observes the temporary logged-out
    // realm: the explicit signal must still retire the previous session.
    await composer.fill('Private draft from the previous session');
    await choose('Notes');
    await page.evaluate(async () => {
      const auth = await import('/src/lib/authSession.ts');
      const token = auth.getAuthToken();
      auth.clearAuthSession();
      auth.setAuthToken(token);
    });
    await choose('Messages');
    assert.equal(await composer.inputValue(), '', 'same-account relogin cannot resurrect an unmounted previous-session draft');
    console.log('PASS: text/upload handoff remount, newer attachment edits, partial/queue/upload failure retention, explicit session-clear ABA');
  } finally {
    await page.evaluate(() => {
      const state = window.__polishSend;
      state.db.enqueue = state.enqueue;
      state.settings.set(state.previousSettings);
      state.connected.set(state.wasConnected);
      window.fetch = state.fetch;
      delete window.__polishSend;
    });
  }
}
