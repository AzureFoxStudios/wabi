import assert from 'node:assert/strict';

export async function runComposerSettingsChecks(page) {
  async function choose(label) {
    await page.locator('.workspace-trigger').click();
    await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(label => document.querySelector('.workspace-current')?.textContent === label, label);
  }
  await choose('Messages');
  const composer = page.locator('.chat-container textarea[rows="1"]');
  await composer.fill('Unsent draft survives workspace navigation');
  await page.locator('.chat-container input[type="file"].hidden').setInputFiles({ name: 'draft-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Local disposable draft') });
  await page.locator('.gallery-file-name').filter({ hasText: 'draft-fixture.txt' }).waitFor();
  for (const label of ['Planner', 'Notes', 'Files', 'Project', 'Whiteboard', 'Calls']) {
    await choose(label); await choose('Messages');
    assert.equal(await composer.inputValue(), 'Unsent draft survives workspace navigation', `${label}: draft preserved`);
    assert.equal(await page.locator('.gallery-file-name').textContent(), 'draft-fixture.txt', `${label}: selected File preserved`);
  }
  await page.locator('.cancel-gallery').click();
  await composer.fill('');
  // Real upload module, controlled delayed HTTP response: retire the editor
  // before init completes and prove no chunk/complete can follow it.
  const uploadFence = await page.evaluate(async () => {
    const { uploadFileResumable } = await import('/src/lib/components/chat/uploadResumable.ts');
    const fetchOriginal = window.fetch;
    let release, current = true;
    const requests = [];
    window.fetch = async (url, init) => {
      if (!String(url).includes('/api/upload/resumable/')) return fetchOriginal(url, init);
      requests.push(String(url));
      return new Promise(resolve => { release = resolve; });
    };
    try {
      const operation = uploadFileResumable(new File(['fixture'], 'fenced-upload.txt'), 'general', () => {}, false, undefined, () => current);
      current = false;
      release(new Response(JSON.stringify({ uploadId: 'fixture', uploadToken: 'fixture', uploadedBytes: 0 }), { status: 200 }));
      try { await operation; return { rejected: false, requests: requests.length }; }
      catch { return { rejected: true, requests: requests.length }; }
    } finally { window.fetch = fetchOriginal; }
  });
  assert.deepEqual(uploadFence, { rejected: true, requests: 1 }, 'retired upload cannot send a chunk or publish completion');
  const settingsOpener = page.getByTitle('User Settings', { exact: true }).filter({ visible: true });
  await settingsOpener.click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  assert.ok(await settings.evaluate(node => node === document.activeElement), 'Settings takes initial focus');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  assert.ok(await settingsOpener.evaluate(node => node === document.activeElement), 'Settings restores opener focus');
  await settingsOpener.click();
  await page.keyboard.press('Shift+Tab');
  assert.ok(await settings.evaluate(node => node.contains(document.activeElement)), 'Settings traps reverse Tab');
  await page.keyboard.press('Tab');
  assert.ok(await settings.evaluate(node => node.contains(document.activeElement)), 'Settings traps forward Tab');
  for (const tab of await settings.locator('.settings-tab:not(.logout-tab)').all()) {
    await tab.click();
    assert.ok(await settings.locator('.settings-content').isVisible(), 'settings tab reachable');
    const unnamed = await settings.locator('.settings-content button.toggle-btn').evaluateAll(nodes => nodes.filter(node =>
      !node.textContent.trim() && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby') && !node.getAttribute('title')).length);
    assert.equal(unnamed, 0, `${await tab.textContent()}: no unnamed switches`);
  }
  await settings.getByRole('button', { name: 'Audio and Video', exact: true }).click();
  const summary = settings.locator('.audio-settings details > summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  assert.ok(await summary.evaluate(node => node.parentElement.contains(document.activeElement) && document.activeElement !== node), 'Tab proceeds into native details instead of restarting modal focus');
  await settings.getByRole('button', { name: 'Admin', exact: true }).click();
  await settings.locator('.admin-open-dashboard-btn').click();
  await page.locator('.admin-center-stage').waitFor();
  await page.locator('.admin-back-btn').click();
  await page.locator('.admin-center-stage').waitFor({ state: 'hidden' });
  assert.equal(await settings.count(), 0, 'Dashboard Back returns to app, not hidden Settings');
  assert.ok(await page.locator('.workspace-trigger').evaluate(node => node === document.activeElement));
  console.log('PASS: workspace text/file drafts, Settings focus/escape/tab containment, all Settings entries, Admin Back');
}
