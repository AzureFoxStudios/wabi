// Call after opening Addons > MoreQuickReacts in the isolated full-app browser
// fixture. This module owns no server, account, browser, or settings persistence.
import assert from 'node:assert/strict';

export async function verifyReactionEmojiPicker(page) {
  const picker = page.locator('.reaction-emoji-select');
  const trigger = picker.getByRole('button', { name: /Reaction emoji/ });
  await trigger.click();
  const search = picker.getByRole('searchbox', { name: 'Search emoji' });
  assert.equal(await search.evaluate((node) => node === document.activeElement), true, 'opening focuses emoji search');
  await search.fill('');
  await page.waitForFunction(() => document.querySelectorAll('[data-emoji-option]').length === 40);
  assert.equal(await picker.locator('select option').count(), 3, 'no thousands-option native select');
  await picker.getByRole('button', { name: /Show more emoji/ }).click();
  assert.equal(await picker.locator('[data-emoji-option]').count(), 80, 'explicit bounded pagination');
  await search.fill('red heart');
  await picker.getByRole('button', { name: 'red heart', exact: true }).waitFor();
  await search.press('ArrowDown');
  assert.equal(await picker.locator('[data-emoji-option]').first().evaluate((node) => node === document.activeElement), true, 'ArrowDown reaches a native result button');
  await page.keyboard.press('Enter');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'selection closes picker');
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, 'selection restores focus');
  assert.match(await trigger.innerText(), /heart/i, 'selected emoji has a readable label');

  await trigger.click();
  await search.fill('this is not an emoji search result');
  await picker.getByText('No matching emoji. Try another name or source.').waitFor();
  assert.equal(await picker.locator('[data-emoji-option]').count(), 0);
  await search.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, 'Escape restores focus without closing Settings');

  await trigger.click();
  await search.fill('happy');
  await picker.getByRole('combobox', { name: 'Emoji source' }).selectOption('bundled');
  await page.waitForFunction(() => document.querySelectorAll('[data-emoji-option]').length > 0);
  for (const control of [trigger, search, picker.locator('[data-emoji-option]').first()]) {
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.height >= 44 && bounds.width >= 44, 'emoji controls have touch-sized hit targets');
  }
  const overflow = await picker.evaluate((node) => node.scrollWidth - node.clientWidth);
  assert.ok(overflow <= 1, `emoji picker fits its available width (${overflow}px overflow)`);
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
}
