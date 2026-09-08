import assert from 'node:assert/strict';
import { verifyReactionEmojiPicker } from '../test/reaction-emoji-browser-checks.mjs';

async function finishFiniteAnimations(page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => {
      const timing = animation.effect?.getComputedTiming();
      return timing && Number.isFinite(Number(timing.endTime));
    }).map(animation => animation.finished.catch(() => {})));
  });
}

// Measure the actual rendered semantic colors, including translucent status
// backgrounds. Keep this scoped to Admin's new informational text, not a claim
// that every theme or every unrelated Wabi surface has been contrast-audited.
export async function assertAdminTextContrast(page) {
  const results = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function rgba(color) {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      const pixel = [...ctx.getImageData(0, 0, 1, 1).data];
      return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
    }
    const blend = (fg, bg) => fg.slice(0, 3).map((channel, i) => channel * fg[3] + bg[i] * (1 - fg[3]));
    const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const selectors = ['.admin-heading p', '.admin-snapshot-controls > span', '.admin-summary small', '.admin-home-description',
      '.admin-health-metrics dt', '.admin-recorded-meta > span', '.admin-home-destinations button span', '.admin-health-status',
      '.branding-heading p', '#branding-accent-help', '.branding-upload > span:last-child', '.branding-help', '.branding-preview-copy small'];
    return [...document.querySelectorAll(selectors.map(selector => '.admin-center-stage ' + selector).join(','))]
      .filter(node => node.getClientRects().length && !node.closest('fieldset:disabled, button:disabled'))
      .map(node => {
        const chain = []; for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor);
        const background = chain.reduce((color, ancestor) => blend(rgba(getComputedStyle(ancestor).backgroundColor), color), [255, 255, 255]);
        const color = blend(rgba(getComputedStyle(node).color), background);
        const l1 = luminance(color), l2 = luminance(background);
        return { label: node.className || node.id || node.parentElement.className, contrast: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) };
      });
  });
  assert.ok(results.length > 0, 'Admin contrast checks inspect actual informational text');
  for (const result of results) assert.ok(result.contrast >= 4.5, `${result.label}: small text contrast ${result.contrast.toFixed(2)} must be at least 4.5:1`);
}

export async function runAdminPolishChecks(page, scratch) {
  const settingsOpener = page.getByTitle('User Settings', { exact: true }).filter({ visible: true });
  await settingsOpener.click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Add-ons', exact: true }).click();
  const addonFilter = settings.getByPlaceholder('Filter add-ons…');
  const accordion = id => settings.locator(`.addon-accordion-trigger[aria-controls="addon-section-${id}"]`);
  const addonBody = id => settings.locator(`#addon-section-${id}`);
  await addonBody('chat').waitFor();
  // Actual mounted legacy sections must react to parent state; checking just
  // filter counts would miss stale callback props leaving their content closed.
  for (const id of ['spoilers', 'search', 'navigation', 'identity', 'notifications', 'media', 'appearance', 'utilities', 'chat']) {
    await accordion(id).click();
    await addonBody(id).waitFor();
    assert.equal(await accordion(id).getAttribute('aria-expanded'), 'true');
    assert.equal(await settings.locator('.addon-accordion-body').count(), 1, `${id}: only selected accordion expanded`);
    await accordion(id).click();
    await addonBody(id).waitFor({ state: 'hidden' });
    assert.equal(await accordion(id).getAttribute('aria-expanded'), 'false');
  }
  await accordion('utilities').click();
  await settings.getByPlaceholder('/shrug', { exact: true }).fill('/unfinished');
  await addonFilter.fill('MoreQuickReacts');
  await addonBody('media').waitFor();
  assert.equal(await settings.locator('.addon-accordion-section').count(), 1);
  assert.match(await settings.locator('.addons-search-meta').textContent(), /Showing 1 of \d+ local/);
  await addonFilter.fill('emoji');
  await addonBody('chat').waitFor();
  await addonBody('media').waitFor();
  assert.equal(await settings.locator('.addon-accordion-body').count(), 2, 'search expands matches across sections');
  for (const query of ['no-such-addon-fixture', 'LINE DM', 'PinDMs']) {
    await addonFilter.fill(query);
    await settings.locator('.addon-empty-state').waitFor();
    assert.equal(await settings.locator('.addon-accordion-section').count(), 0);
  }
  await settings.locator('.addons-search-meta').getByRole('button', { name: 'Clear Search', exact: true }).click();
  await addonBody('utilities').waitFor();
  assert.equal(await settings.getByPlaceholder('/shrug', { exact: true }).inputValue(), '/unfinished', 'filtering through zero matches preserves unfinished local edits');
  await addonFilter.fill('MoreQuickReacts');
  const picker = settings.getByRole('group', { name: 'Reaction emoji', exact: true });
  const trigger = picker.locator('.reaction-emoji-trigger');
  await trigger.click();
  const search = picker.getByRole('searchbox', { name: 'Search emoji', exact: true });
  assert.ok(await search.evaluate(node => node === document.activeElement));
  assert.equal(await picker.locator('[data-emoji-option]').count(), 40, 'initial emoji list is bounded');
  await search.fill('red heart');
  await page.keyboard.press('ArrowDown');
  assert.ok(await picker.locator('[data-emoji-option]').first().evaluate(node => node === document.activeElement));
  await picker.getByRole('button', { name: 'red heart', exact: true }).click();
  assert.ok(await trigger.evaluate(node => node === document.activeElement), 'emoji selection restores trigger focus');
  assert.match(await trigger.textContent(), /red heart/i);
  await settings.getByRole('button', { name: 'Add Emoji', exact: true }).click();
  assert.equal(await settings.locator('.quick-reaction-settings-row').count(), 1, 'real quick reaction preference updated');
  await verifyReactionEmojiPicker(page);
  await trigger.click();
  await page.keyboard.press('Escape');
  assert.ok(await settings.isVisible(), 'picker Escape does not dismiss Settings');
  await page.setViewportSize({ width: 390, height: 844 });
  await addonFilter.scrollIntoViewIfNeeded();
  assert.ok(await addonFilter.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node === document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }), 'mobile add-on search receives pointer hits, not clipped by an inner height cap');
  const field = await settings.locator('.addons-search-field').boundingBox();
  assert.ok(field.height < 120, 'desktop flex-basis must not become a 260px mobile filter height');
  assert.ok(await settings.locator('.addons-settings-window-body').evaluate(node => node.scrollHeight <= node.clientHeight + 1), 'mobile Settings owns scrolling instead of a clipped nested accordion');
  await trigger.click();
  assert.ok(await settings.evaluate(node => node.scrollWidth <= node.clientWidth), 'emoji/settings modal fits mobile');
  await trigger.scrollIntoViewIfNeeded();
  await finishFiniteAnimations(page);
  await page.screenshot({ path: `${scratch}/quick-reaction-mobile.png` });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await settings.getByRole('button', { name: 'Admin', exact: true }).click();
  const launcher = settings.locator('.admin-settings-launcher');
  async function assertCompactLauncher() {
    await launcher.waitFor();
    assert.equal(await settings.locator('.admin-user-list, .admin-center-stage').count(), 0,
      'Settings launches administration instead of mounting a duplicate users/workspace panel');
    assert.equal(await settings.getByRole('button', { name: /purge|wipe|clear all uploads|delete all uploads/i }).count(), 0,
      'Settings does not expose orphaned destructive purge controls');
    assert.equal(await launcher.locator('.admin-destination').count(), 4);
  }
  await assertCompactLauncher();
  const isStatsResponse = response => response.request().method() === 'GET' &&
    new URL(response.url()).pathname === '/api/admin/stats';
  const [initialResponse] = await Promise.all([
    page.waitForResponse(isStatsResponse),
    settings.locator('.admin-open-dashboard-btn').click(),
  ]);
  assert.equal(initialResponse.status(), 200, 'the actual isolated backend supplies the Admin snapshot');
  await initialResponse.json();
  await settings.waitFor({ state: 'hidden' });
  const admin = page.locator('.admin-center-stage');
  await admin.waitFor();
  assert.equal(await page.locator('.admin-center-stage').count(), 1);
  assert.equal(await admin.getByText('System Online', { exact: true }).count(), 0, 'no unconditional system-health claim');
  const sections = ['Overview', 'Server health', 'People', 'Roles', 'Channels', 'Branding', 'Payments'];
  const navigation = admin.getByRole('navigation', { name: 'Admin sections', exact: true });
  assert.deepEqual(await navigation.locator('.admin-nav-label').allTextContents(), sections);
  assert.equal(await navigation.getByRole('button', { name: /Role Gates|Server policy|Runtime|Users/ }).count(), 0,
    'obsolete or unsupported destinations are absent');

  async function selectSection(name) {
    const button = navigation.getByRole('button', { name, exact: true });
    await button.click();
    await admin.getByRole('heading', { name, level: 1, exact: true }).waitFor();
    assert.equal(await button.getAttribute('aria-current'), 'page', `${name}: navigation and content agree`);
    await admin.locator('.admin-content-inner').waitFor();
    await admin.locator('.admin-content').evaluate(node => { node.scrollTop = 0; });
    return button;
  }
  async function refreshSnapshot(expectedStatus = 200) {
    // Do not mistake an already-running initial/automatic poll for the manual
    // refresh whose result this check is about to inspect.
    await page.waitForFunction(() => document.querySelector('.admin-refresh')?.disabled === false);
    const [response] = await Promise.all([
      page.waitForResponse(isStatsResponse),
      admin.getByRole('button', { name: 'Refresh', exact: true }).click(),
    ]);
    assert.equal(response.status(), expectedStatus);
    const snapshot = await response.json();
    await page.waitForFunction(() => document.querySelector('.admin-refresh')?.disabled === false);
    return snapshot;
  }
  async function assertRenderedHealth(snapshot, expanded = false) {
    const health = snapshot.extra?.health;
    assert.ok(health, 'real backend supplies measured health; absence must not be labeled Ready');
    const ready = health.status === 'ready' && health.writerRunning && health.projectionHealthy;
    const label = ready ? 'Ready' : 'Needs attention';
    await admin.locator('.admin-health-status').filter({ hasText: new RegExp(`^${label}$`) }).waitFor();
    assert.equal(await admin.locator('.admin-health-status.ready').count(), ready ? 1 : 0,
      'Ready is derived from the actual backend writer/projection measurements');
    const metric = label => admin.locator('.admin-health-metrics > div').filter({ hasText: label }).locator('dd');
    assert.equal(await metric('Database writer').textContent(), health.writerRunning ? 'Running' : 'Stopped');
    assert.equal(await metric('Applying changes').textContent(), health.projectionHealthy ? 'Healthy' : 'Failed');
    const bytes = health.processMemoryBytes;
    const memory = bytes === null ? 'Not available' : bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
    assert.equal(await metric('Server process memory').textContent(), memory, 'memory comes from this server snapshot');
    assert.ok(health.uptimeSeconds === null || Number.isFinite(health.uptimeSeconds) && health.uptimeSeconds >= 0);
    assert.equal((await metric('Server uptime').textContent()) === 'Not available', health.uptimeSeconds === null);
    if (expanded) assert.equal(await admin.locator('.admin-health-details code').textContent(), health.appliedCommitSeq,
      'applied state is the actual full-width WabiDB sequence, not a guessed counter');
  }
  async function assertWholeCounts(snapshot) {
    const values = await admin.locator('.admin-stat-value').allTextContents();
    assert.deepEqual(values.map(value => Number(value.replaceAll(',', '').trim())), [
      snapshot.overview.totalUsers, snapshot.overview.onlineUsers, snapshot.overview.totalChannels,
    ], 'account/online/channel totals match the actual response');
    for (const value of [...values, ...await admin.locator('.admin-role-summary li > span:last-child').allTextContents()]) {
      assert.match(value.trim(), /^[\d,]+$/, 'counts never animate through fractional users');
    }
  }
  async function assertFits(name, width) {
    for (const [label, node] of [['shell', admin], ['content', admin.locator('.admin-content')],
      ['inner content', admin.locator('.admin-content-inner')]]) {
      assert.ok(await node.evaluate(node => node.scrollWidth <= node.clientWidth + 1),
        `${name}: ${label} has no horizontal overflow at ${width}px`);
    }
    const box = await admin.boundingBox();
    assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, `${name}: shell stays in the viewport`);
  }
  for (const size of [{ width: 1440, height: 900 }, { width: 1000, height: 900 },
    { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(size);
    for (const name of sections) {
      const button = await selectSection(name);
      if (size.width <= 390) {
        const target = await button.boundingBox();
        assert.ok(target && target.height >= 44, `${name}: navigation has a touch-sized target`);
      }
      if (name === 'Overview' || name === 'Server health') {
        const snapshot = await refreshSnapshot();
        await assertRenderedHealth(snapshot, name === 'Server health');
        if (name === 'Overview') await assertWholeCounts(snapshot);
      }
      if (name === 'People') {
        await admin.locator('.admin-user-list').waitFor();
        assert.equal(await admin.locator('.admin-user-list').count(), 1, 'People has one authoritative users panel');
        for (const control of await admin.locator('.admin-people input, .admin-person-action, .admin-user-role-select, .admin-person-badges summary').all()) {
          const box = await control.boundingBox();
          assert.ok(box && box.height >= 44, 'People controls have 44px hit heights');
        }
      }
      if (name === 'Branding') await admin.locator('.branding-fields').waitFor();
      if (name === 'Roles') {
        await admin.getByText('Built-in role names are fixed.', { exact: false }).waitFor();
        assert.equal(await admin.locator('.role-catalog li').count(), 5, 'real backend provides builtin roles');
        assert.equal(await admin.locator('.role-reference input').count(), 0, 'no unsupported rename editor');
      }
      await finishFiniteAnimations(page);
      await assertFits(name, size.width);
      if (['Overview', 'Server health', 'Branding'].includes(name)) await assertAdminTextContrast(page);
      await page.screenshot({ path: `${scratch}/admin-${name.toLowerCase().replaceAll(' ', '-')}-${size.width}.png` });
    }
  }

  // A failed read retains context, but it must visibly retire its healthy claim.
  // Override only this request and always remove our own handler afterwards.
  await selectSection('Overview');
  const beforeFailure = await refreshSnapshot();
  await assertRenderedHealth(beforeFailure);
  const routePattern = /\/api\/admin\/stats(?:\?.*)?$/;
  const failStats = route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: 'Isolated dashboard failure fixture' }) });
  await page.route(routePattern, failStats);
  try {
    await refreshSnapshot(503);
    await admin.getByRole('alert').filter({ hasText: 'Server status unavailable' }).waitFor();
    await admin.locator('.admin-health-status').filter({ hasText: /^Last known status$/ }).waitFor();
    assert.equal(await admin.locator('.admin-health-status.ready').count(), 0, 'stale snapshot cannot claim Ready');
    assert.match(await admin.locator('.admin-snapshot-controls .stale').textContent(), /Last snapshot/);
    await assertWholeCounts(beforeFailure);
    await assertFits('Overview with stale snapshot', 320);
    await page.screenshot({ path: `${scratch}/admin-overview-stale-320.png` });
  } finally {
    await page.unroute(routePattern, failStats);
  }
  const recovered = await refreshSnapshot();
  await assertRenderedHealth(recovered);
  await assertWholeCounts(recovered);
  assert.equal(await admin.locator('.admin-read-error, .admin-snapshot-controls .stale').count(), 0,
    'successful refresh retires the error and stale label');
  await page.screenshot({ path: `${scratch}/admin-overview-recovered-320.png` });

  await page.setViewportSize({ width: 1440, height: 900 });
  await admin.locator('.admin-back-btn').click();
  await admin.waitFor({ state: 'hidden' });
  for (const [title, destination] of [['People', 'People'], ['Server identity', 'Branding']]) {
    await settingsOpener.click();
    await settings.getByRole('button', { name: 'Admin', exact: true }).click();
    await assertCompactLauncher();
    await launcher.getByRole('button', { name: new RegExp('^' + title + '(?:$| )') }).click();
    await settings.waitFor({ state: 'hidden' });
    await admin.getByRole('heading', { name: destination, level: 1, exact: true }).waitFor();
    assert.equal(await navigation.getByRole('button', { name: destination, exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.admin-center-stage').count(), 1);
    await page.screenshot({ path: `${scratch}/admin-settings-shortcut-${destination.toLowerCase()}.png` });
    await admin.locator('.admin-back-btn').click();
    await admin.waitFor({ state: 'hidden' });
  }
  console.log('PASS: preserved all9 addon/emoji checks; all7 Admin sections at1440/1000/390/320px; real health and whole counts, stale503/recovery, compact Settings launchers to People/Branding');
}
