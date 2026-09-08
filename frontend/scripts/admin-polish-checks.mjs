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
  await settings.locator('.admin-open-dashboard-btn').click();
  const admin = page.locator('.admin-center-stage');
  assert.equal(await admin.getByText('System Online', { exact: true }).count(), 0, 'no unconditional system-health claim');
  const sections = ['Overview', 'Users', 'Roles', 'Channels', 'Role Gates', 'Runtime', 'Branding', 'Server Policy'];
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    for (const name of sections) {
      await admin.locator('.admin-sidebar-nav').getByRole('button', { name, exact: true }).click();
      await admin.locator('.admin-content-inner').waitFor();
      assert.ok(await admin.evaluate(node => node.scrollWidth <= node.clientWidth), `${name}: admin shell fits ${size.width}px`);
      assert.ok(await admin.locator('.admin-content').evaluate(node => node.scrollWidth <= node.clientWidth), `${name}: content fits ${size.width}px`);
      if (name === 'Roles') {
        await admin.getByText('Built-in role names are fixed.', { exact: false }).waitFor();
        assert.equal(await admin.locator('.role-catalog li').count(), 5, 'real backend provides builtin roles');
        assert.equal(await admin.locator('.role-reference input').count(), 0, 'no unsupported rename editor');
      }
      if (name === 'Role Gates') {
        assert.match(await admin.locator('.admin-content').textContent(), /not available|not supported|unavailable/i);
        assert.equal(await admin.locator('.admin-content input, .admin-content select').count(), 0, 'no dead automation setup controls');
      }
      if (['Overview', 'Roles', 'Role Gates', 'Server Policy'].includes(name)) {
        await finishFiniteAnimations(page);
        if (name === 'Overview') {
          for (const counter of await admin.locator('.admin-stat-value').all()) {
            assert.match((await counter.textContent()).trim(), /^(?:[\d,]+|—)$/, 'counts never animate through fractional users');
          }
        }
        await page.screenshot({ path: `${scratch}/admin-${name.toLowerCase().replaceAll(' ', '-')}-${size.width}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await admin.locator('.admin-back-btn').click();
  console.log('PASS: all9 addon accordion/filter reactivity and retained edits; human emoji search/keyboard/real preference, all8 admin sections desktop+mobile, honest role catalog and unavailable automation');
}
