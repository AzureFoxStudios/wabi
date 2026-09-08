import assert from 'node:assert/strict';
import { assertAdminTextContrast } from './admin-polish-checks.mjs';

// Called only by the headful workspace harness, with its throwaway local server.
// No live account, provider payment, host restart, or production data is involved.
export async function runAdminActionsChecks(page, scratch, { backend, account, member, adminChannels }) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(backend).hostname), 'Admin action fixtures require a loopback backend');
  assert.equal(account.user.username, 'workspace_fixture', 'Only the isolated owner fixture may administer this server');
  assert.equal(member.user.username, 'admin_member_fixture');
  assert.ok(typeof member.password === 'string' && typeof member.accessToken === 'string', 'Member fixture includes its local credentials');
  const ownerToken = account.accessToken;
  const oldMemberToken = member.accessToken;
  const originalPassword = member.password;
  const replacementPassword = 'Local-reset-fixture-only-6739!';
  const paymentPath = '/api/admin/policies/payments_access';
  const brandingPath = '/api/admin/policies/frontend_app_metadata';
  const resetPath = '/api/admin/users/reset-password';
  const originalViewport = page.viewportSize();
  const originalTheme = await page.evaluate(async () => {
    const get = store => { let value; const unsubscribe = store.subscribe(next => { value = next; }); unsubscribe(); return value; };
    const { themeStore } = await import('/src/lib/theme/themeStore.ts');
    const theme = get(themeStore);
    return { themeId: theme.themeId, customTheme: theme.customTheme };
  });

  async function api(path, { token = ownerToken, method = 'GET', body, status = 200 } = {}) {
    const response = await fetch(backend + path, { method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    // Never include response bodies/request headers in assertions: login bodies
    // contain credentials, even though these are disposable test accounts.
    assert.equal(response.status, status, `${method} ${path}: expected HTTP ${status}`);
    return response.json();
  }
  const originalPayment = (await api(paymentPath)).config;
  const originalBranding = (await api(brandingPath)).config;
  const admin = page.locator('.admin-center-stage');
  const payment = admin.locator('.payment-access');
  const branding = admin.locator('.branding-editor');
  const row = name => admin.locator('.admin-user-item').filter({ has: page.getByText(name, { exact: true }) });
  const resetOpener = () => row(member.user.username).getByRole('button', { name: `Reset password for ${member.user.username}`, exact: true });
  const resetDialog = page.getByRole('dialog', { name: `Reset password for ${member.user.username}`, exact: true });
  const responseFor = (path, method = 'POST') => response => response.request().method() === method && new URL(response.url()).pathname === path;
  async function navigate(name) {
    await admin.getByRole('navigation', { name: 'Admin sections', exact: true }).getByRole('button', { name, exact: true }).click();
    await admin.getByRole('heading', { name, level: 1, exact: true }).waitFor();
  }
  async function openAdmin(name) {
    if (!await admin.isVisible()) {
      await page.getByTitle('User Settings', { exact: true }).filter({ visible: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('button', { name: 'Admin', exact: true }).click();
      await settings.getByRole('button', { name: 'Open administration', exact: true }).click();
      await settings.waitFor({ state: 'hidden' });
      await admin.waitFor();
    }
    await navigate(name);
  }
  async function fillReset(password, confirmation = password) {
    await resetDialog.getByLabel('New password', { exact: true }).fill(password);
    await resetDialog.getByLabel('Confirm password', { exact: true }).fill(confirmation);
  }
  async function assertDialogLayout() {
    await resetDialog.evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {})));
    });
    const panel = resetDialog.locator('.modal-content');
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Account recovery has no horizontal clipping');
    const controls = await resetDialog.locator('input, .password-reset-actions button').all();
    const rectangles = [];
    for (const control of controls) {
      await control.scrollIntoViewIfNeeded();
      const rect = await control.boundingBox();
      assert.ok(rect && rect.height >= 44, 'Recovery fields/actions have at least 44px hit height');
      assert.ok(await control.evaluate(node => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), 'Recovery controls receive pointer hits above Administration');
      // Document-relative positions remain comparable when the modal scrolls.
      rectangles.push(await control.evaluate(node => {
        const r = node.getBoundingClientRect();
        const panel = node.closest('.modal-content');
        return { left: r.left, right: r.right, top: r.top + panel.scrollTop, bottom: r.bottom + panel.scrollTop };
      }));
    }
    for (let a = 0; a < rectangles.length; a++) for (let b = a + 1; b < rectangles.length; b++) {
      const x = rectangles[a], y = rectangles[b];
      assert.ok(x.right <= y.left + 1 || y.right <= x.left + 1 || x.bottom <= y.top + 1 || y.bottom <= x.top + 1,
        'Recovery inputs and action buttons do not overlap');
    }
  }
  async function layoutSnapshot() {
    return page.evaluate(async () => {
      const get = store => { let value; const unsubscribe = store.subscribe(next => { value = next; }); unsubscribe(); return value; };
      const layout = await import('/src/lib/layoutStoreStates.ts');
      const channel = await import('/src/lib/channelStore.ts');
      return { selectedDm: get(layout.selectedDmChannelId), otherUserId: get(layout.dmOtherUser)?.dbUserId ?? null,
        centerDm: get(layout.centerDmChannelId), centerView: get(layout.centerPanelView), currentChannel: get(channel.currentChannel),
        panelMode: get(layout.rightPanelMode), pinnedPanel: get(layout.pinnedPanelId), activePanel: get(layout.activeRightTab),
        workspace: document.querySelector('.workspace-current')?.textContent ?? null,
        dmIds: get(channel.channels).filter(row => row.type === 'dm').map(row => row.id) };
    });
  }

  let resetRequests = 0;
  const countReset = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === resetPath) resetRequests++; };
  page.on('request', countReset);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAdmin('People');
    await row(account.user.username).waitFor();
    await row(member.user.username).waitFor();
    assert.equal(await row(account.user.username).getByRole('button', { name: /Reset password/ }).count(), 0,
      'The owner/self account has no reset action');
    assert.ok(await row(account.user.username).getByRole('combobox', { name: 'Role for ' + account.user.username, exact: true }).isDisabled(), 'Owner/self role cannot be changed here');
    await resetOpener().click();
    await resetDialog.waitFor();
    await resetDialog.getByLabel('New password', { exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.ok(await resetDialog.getByRole('button', { name: 'Reset password', exact: true }).evaluate(node => node === document.activeElement), 'Shift+Tab wraps within the reset dialog');
    await page.keyboard.press('Tab');
    assert.ok(await resetDialog.getByLabel('New password', { exact: true }).evaluate(node => node === document.activeElement));
    await fillReset('short');
    await resetDialog.getByRole('button', { name: 'Reset password', exact: true }).click();
    assert.ok(await resetDialog.getByLabel('New password', { exact: true }).evaluate(node => !node.checkValidity()), 'Minimum password length is enforced before a request');
    await fillReset(replacementPassword, replacementPassword + 'different');
    await resetDialog.getByRole('button', { name: 'Reset password', exact: true }).click();
    await resetDialog.getByRole('alert').filter({ hasText: 'The passwords do not match.' }).waitFor();
    assert.equal(resetRequests, 0, 'Invalid inputs never reach password mutation');
    await page.keyboard.press('Escape');
    await resetDialog.waitFor({ state: 'hidden' });
    assert.ok(await resetOpener().evaluate(node => node === document.activeElement), 'Escape restores the People action focus');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => (await import('/src/lib/theme/themeStore.ts')).themeStore.setThemeId('light'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await resetOpener().click();
    await resetDialog.waitFor();
    await assertDialogLayout();
    await page.screenshot({ path: `${scratch}/admin-reset-mobile-light.png` });
    const failReset = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated reset failure fixture' }) })
      : route.continue();
    const resetRoute = /\/api\/admin\/users\/reset-password$/;
    await page.route(resetRoute, failReset);
    try {
      await fillReset(replacementPassword);
      const [failed] = await Promise.all([page.waitForResponse(responseFor(resetPath)), page.keyboard.press('Enter')]);
      assert.equal(failed.status(), 503);
      await resetDialog.getByRole('alert').filter({ hasText: 'could not be confirmed' }).waitFor();
      assert.equal(await resetDialog.locator('.password-reset-success').count(), 0, 'HTTP failure is not a password reset success');
      assert.equal(await resetDialog.getByLabel('New password', { exact: true }).inputValue(), '', 'Submitted secrets are cleared even on failure');
      await page.screenshot({ path: `${scratch}/admin-reset-failure-mobile-light.png` });
    } finally {
      await page.unroute(resetRoute, failReset);
    }
    // The routed failure performed no server write: the original login is valid.
    await api('/api/auth/login', { token: null, method: 'POST', body: { username: member.user.username, password: originalPassword } });
    await fillReset(replacementPassword);
    const [resetResponse] = await Promise.all([page.waitForResponse(responseFor(resetPath)), page.keyboard.press('Enter')]);
    assert.equal(resetResponse.status(), 200);
    const resetBody = resetResponse.request().postDataJSON();
    assert.equal(resetBody.targetUserId, member.user.id);
    assert.equal(resetBody.temporary, false, 'UI requests a real permanent reset, not unsupported forced rotation');
    assert.ok(resetBody.newPassword === replacementPassword, 'The intended password reached the fixture server');
    await resetDialog.locator('.password-reset-success').waitFor();
    await api('/api/auth/login', { token: null, method: 'POST', body: { username: member.user.username, password: originalPassword }, status: 401 });
    const renewed = await api('/api/auth/login', { token: null, method: 'POST', body: { username: member.user.username, password: replacementPassword } });
    await api('/api/user/me', { token: oldMemberToken, status: 401 });
    await api('/api/user/me', { token: renewed.accessToken });
    // Keep the caller's disposable fixture credentials truthful for later checks.
    member.password = replacementPassword;
    member.accessToken = renewed.accessToken;
    member.refreshToken = renewed.refreshToken;
    await page.screenshot({ path: `${scratch}/admin-reset-success-mobile-light.png` });
    await resetDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await resetDialog.waitFor({ state: 'hidden' });

    // A brand-new People conversation must open the chosen account in the dock,
    // not displace the center channel/workspace. A second click must reuse it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await admin.locator('.admin-back-btn').click();
    await admin.waitFor({ state: 'hidden' });
    await page.locator('.workspace-current').waitFor();
    const beforeDm = await layoutSnapshot();
    let selectedDm;
    for (const attempt of ['new', 'existing']) {
      await openAdmin('People');
      await row(member.user.username).getByRole('button', { name: `Message ${member.user.username}`, exact: true }).click();
      await admin.waitFor({ state: 'hidden' });
      await page.waitForFunction(async expected => {
        const get = store => { let value; const unsubscribe = store.subscribe(next => { value = next; }); unsubscribe(); return value; };
        const layout = await import('/src/lib/layoutStoreStates.ts');
        return get(layout.selectedDmChannelId) && get(layout.dmOtherUser)?.dbUserId === expected && get(layout.centerPanelView) === 'chat';
      }, member.user.id);
      const after = await layoutSnapshot();
      assert.equal(after.otherUserId, member.user.id);
      assert.equal(after.currentChannel, beforeDm.currentChannel, 'People Message preserves the selected center channel');
      assert.equal(after.centerDm, beforeDm.centerDm, 'People Message preserves any center DM');
      assert.equal(after.workspace, beforeDm.workspace, 'People Message preserves the center workspace surface');
      if (attempt === 'new') {
        selectedDm = after.selectedDm;
        assert.ok(!beforeDm.dmIds.includes(selectedDm), 'New fixture account creates a new durable DM');
        await api('/api/channels/' + encodeURIComponent(selectedDm));
        await api('/api/channels/' + encodeURIComponent(selectedDm), { token: member.accessToken });
      } else {
        assert.equal(after.selectedDm, selectedDm, 'Existing conversation is reused for the same target');
        assert.equal(after.dmIds.length, beforeDm.dmIds.length + 1, 'Reopening does not create a duplicate DM');
      }
      await page.screenshot({ path: `${scratch}/admin-message-${attempt}-dm.png` });
    }

    await openAdmin('People');
    const roleControl = row(member.user.username).getByRole('combobox', { name: 'Role for ' + member.user.username, exact: true });
    for (const [value, label] of [['mod', 'Moderator'], ['member', 'Member']]) {
      await roleControl.selectOption(value);
      await admin.getByRole('status').filter({ hasText: member.user.username + ' is now ' + label + '.' }).waitFor();
    }
    const badges = row(member.user.username).locator('.admin-person-badges');
    await badges.locator('summary').click();
    const badgeSelect = badges.getByRole('combobox', { name: 'Add badge for ' + member.user.username, exact: true });
    const badgeId = await badgeSelect.locator('option').nth(1).getAttribute('value');
    assert.ok(badgeId, 'The real server supplies a usable badge choice');
    // Control only the outbound badge request. Mounted UI error handling and
    // retirement run against the real socket's listeners; no fixture mutation
    // is sent during these deliberately delayed-response scenarios.
    await page.evaluate(async () => {
      const { getSocket } = await import('/src/lib/socketConnection.ts');
      const socket = getSocket();
      const emit = socket.emit;
      window.__adminBadgeFixture = { socket, emit, requests: [] };
      socket.emit = function (event, ...args) {
        if (event === 'assign-badge') { window.__adminBadgeFixture.requests.push(args[0]); return this; }
        return emit.call(this, event, ...args);
      };
    });
    try {
      await badgeSelect.selectOption(badgeId);
      await admin.locator('.admin-badge-pending').waitFor();
      assert.ok(await badgeSelect.isDisabled(), 'A pending badge request cannot be duplicated');
      await navigate('Overview');
      await navigate('People');
      await badges.locator('summary').click();
      await badgeSelect.selectOption(badgeId);
      await admin.locator('.admin-badge-pending').waitFor();
      assert.equal(await page.evaluate(() => window.__adminBadgeFixture.requests.length), 2);
      await page.evaluate(() => {
        const { socket, requests } = window.__adminBadgeFixture;
        for (const listener of socket.listeners('assign-badge-error')) listener({ ...requests[0], error: 'Retired request failure' });
      });
      assert.ok(await admin.locator('.admin-badge-pending').isVisible(), 'A retired visit cannot settle the current badge request');
      assert.equal(await admin.locator('.admin-badge-feedback').count(), 0);
      await page.evaluate(() => {
        const { socket, requests } = window.__adminBadgeFixture;
        for (const listener of socket.listeners('assign-badge-error')) listener({ ...requests[1], error: 'Controlled badge rejection' });
      });
      await admin.locator('.admin-badge-feedback[role="alert"]').filter({ hasText: 'could not be confirmed' }).waitFor();
      await admin.locator('.admin-badge-pending').waitFor({ state: 'hidden' });
      assert.equal(await badges.locator('.admin-badge-chip').count(), 0, 'A rejected badge is never rendered optimistically');
      await page.screenshot({ path: scratch + '/admin-badge-rejection.png' });
    } finally {
      await page.evaluate(() => {
        const fixture = window.__adminBadgeFixture;
        fixture.socket.emit = fixture.emit;
        delete window.__adminBadgeFixture;
      });
    }
    await badgeSelect.selectOption(badgeId);
    const assignedBadge = badges.locator('.admin-badge-chip');
    await assignedBadge.waitFor();
    await assignedBadge.click();
    await assignedBadge.waitFor({ state: 'hidden' });
    await admin.locator('.admin-badge-pending').waitFor({ state: 'hidden' });

    await row(member.user.username).getByRole('button', { name: 'Restrict payments', exact: true }).click();
    await row(member.user.username).getByText('Payments restricted', { exact: true }).waitFor();
    const blockedActor = (await api('/api/payments/access', { token: member.accessToken })).actor;
    assert.equal(blockedActor.blocked, true);
    assert.equal(blockedActor.canCreate, false);
    await row(member.user.username).getByRole('button', { name: 'Allow payments', exact: true }).click();
    await row(member.user.username).getByText('Payments restricted', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await api('/api/payments/access', { token: member.accessToken })).actor.blocked, false);
    await navigate('Overview');
    await admin.locator('.admin-refresh').click();
    await admin.locator('.admin-recorded-activity li').filter({ hasText: 'Assigned Moderator role' }).waitFor();
    assert.ok((await api('/api/admin/stats')).recentAudit.some(entry => entry.targetUser === member.user.username && entry.details === 'Assigned Moderator role'),
      'Overview renders the real role command → audit projection readback');
    await assertAdminTextContrast(page);
    await page.screenshot({ path: scratch + '/admin-overview-recorded-activity.png' });

    await navigate('Roles');
    await admin.getByRole('button', { name: 'Manage people', exact: true }).click();
    await admin.getByRole('heading', { name: 'People', level: 1, exact: true }).waitFor();
    const viewingBefore = await page.evaluate(async () => {
      const get = store => { let value; const stop = store.subscribe(next => { value = next; }); stop(); return value; };
      const layout = await import('/src/lib/layoutStoreStates.ts');
      const { layoutStore } = await import('/src/lib/layoutStore.ts');
      // The visible label is People; the registry's stable panel ID is users.
      if (get(layout.rightPanelMode) !== 'pinned' || get(layout.pinnedPanelId) !== 'users') layoutStore.pinPanel('users');
      const { callSessions } = await import('/src/lib/callSessionManager.ts');
      const capture = navigator.mediaDevices.getUserMedia;
      window.__adminViewingCapture = { capture, count: 0 };
      navigator.mediaDevices.getUserMedia = function (...args) { window.__adminViewingCapture.count++; return capture.apply(this, args); };
      return { dm: get(layout.selectedDmChannelId), pin: get(layout.pinnedPanelId), sessions: [...get(callSessions).keys()] };
    });
    try {
      for (const channel of adminChannels) {
        await openAdmin('Channels');
        await admin.getByRole('button', { name: 'Open channel ' + channel.name, exact: true }).click();
        await admin.waitFor({ state: 'hidden' });
        await page.waitForFunction(async id => {
          const { currentChannel } = await import('/src/lib/channelStore.ts');
          let selected; const stop = currentChannel.subscribe(value => { selected = value; }); stop();
          return selected === id;
        }, channel.id);
        if (channel.type === 'wiki') await page.locator('.chat-surface .wiki-channel').waitFor();
        if (channel.type === 'forum') await page.locator('.chat-surface .forum-channel').waitFor();
        const after = await layoutSnapshot();
        assert.equal(after.centerView, 'chat');
        assert.equal(after.selectedDm, viewingBefore.dm, 'Opening a channel leaves the selected dock conversation intact');
        assert.equal(after.panelMode, 'pinned', 'Opening a channel does not close a pinned dock');
        assert.equal(after.pinnedPanel, viewingBefore.pin);
        assert.equal(after.activePanel, viewingBefore.pin);
        await page.locator('.right-panel.is-pinned').waitFor();
        const media = await page.evaluate(async () => {
          const { callSessions } = await import('/src/lib/callSessionManager.ts');
          let sessions; const stop = callSessions.subscribe(value => { sessions = [...value.keys()]; }); stop();
          return { sessions, acquisitions: window.__adminViewingCapture.count };
        });
        assert.deepEqual(media.sessions, viewingBefore.sessions, 'Viewing any channel does not start a call');
        assert.equal(media.acquisitions, 0, 'Viewing a voice channel does not request microphone access');
        await page.screenshot({ path: scratch + '/admin-open-' + channel.type + '-channel.png' });
      }
      await openAdmin('Channels');
      const textChannel = adminChannels.find(channel => channel.type === 'text');
      await admin.getByRole('button', { name: 'Open channel ' + textChannel.name, exact: true }).click();
      await admin.waitFor({ state: 'hidden' });
    } finally {
      await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__adminViewingCapture.capture; delete window.__adminViewingCapture; });
    }
    await openAdmin('People');
    const paymentRoute = /\/api\/admin\/policies\/payments_access$/;
    const failPolicyRead = route => route.request().method() === 'GET'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated initial policy failure' }) })
      : route.continue();
    await page.route(paymentRoute, failPolicyRead);
    try {
      await navigate('Payments');
      await payment.getByRole('alert').waitFor();
      assert.equal(await payment.locator('form, input').count(), 0, 'Failed initial read cannot expose guessed payment defaults');
      assert.equal(await payment.getByRole('button', { name: 'Save changes', exact: true }).count(), 0);
      await page.screenshot({ path: `${scratch}/admin-payments-initial-failure.png` });
    } finally {
      await page.unroute(paymentRoute, failPolicyRead);
    }
    await payment.getByRole('button', { name: 'Retry loading policy', exact: true }).click();
    const master = payment.getByRole('checkbox', { name: /Allow new payment requests/ });
    const memberRole = payment.getByRole('checkbox', { name: 'Member', exact: true });
    await master.waitFor();
    async function savePayment() {
      const [response] = await Promise.all([page.waitForResponse(responseFor(paymentPath)), payment.getByRole('button', { name: 'Save changes', exact: true }).click()]);
      assert.equal(response.status(), 200);
      await payment.getByRole('status').filter({ hasText: 'Saved payment access policy.' }).waitFor();
      return (await api('/api/payments/access', { token: member.accessToken }));
    }
    // First ensure Member is selected so the master switch is the only denial.
    await memberRole.setChecked(true);
    await master.setChecked(false);
    if (await payment.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()) {
      await master.setChecked(true); await savePayment(); await master.setChecked(false);
    }
    const beforeFailedSave = (await api(paymentPath)).config;
    const failPaymentSave = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated payment save failure' }) })
      : route.continue();
    await page.route(paymentRoute, failPaymentSave);
    try {
      const [failed] = await Promise.all([page.waitForResponse(responseFor(paymentPath)), payment.getByRole('button', { name: 'Save changes', exact: true }).click()]);
      assert.equal(failed.status(), 503);
      await payment.getByRole('alert').filter({ hasText: 'Isolated payment save failure' }).waitFor();
      assert.equal(await master.isChecked(), false, 'A failed payment save preserves the draft');
      assert.deepEqual((await api(paymentPath)).config, beforeFailedSave, 'A rejected save does not change the published policy');
      await payment.getByRole('status').filter({ hasText: 'Unsaved changes' }).waitFor();
      assert.ok(await payment.getByRole('button', { name: 'Save changes', exact: true }).isEnabled(), 'The same draft can be retried');
      await page.screenshot({ path: scratch + '/admin-payments-save-failure.png' });
    } finally {
      await page.unroute(paymentRoute, failPaymentSave);
    }
    const disabled = await savePayment();
    assert.equal(disabled.policy.enabled, false);
    assert.equal(disabled.actor.authenticated, true);
    assert.equal(disabled.actor.canCreate, false);
    assert.equal(disabled.actor.reasonCode, 'disabled', 'Actual member admission follows the published disabled policy');
    await master.setChecked(true);
    const enabled = await savePayment();
    assert.equal(enabled.policy.enabled, true);
    assert.equal(enabled.actor.canCreate, true, 'Re-enabling the selected Member role restores actual admission');
    await memberRole.setChecked(false);
    const excluded = await savePayment();
    assert.equal(excluded.actor.canCreate, false);
    assert.equal(excluded.actor.reasonCode, 'role', 'Role checkbox changes enforce the real member boundary');
    await page.screenshot({ path: `${scratch}/admin-payments-published-role-denial.png` });

    await navigate('People');
    const retainedPolicy = { enabled: true, allowGuest: false, allowedRoleNames: ['Moderator', 'OWNER', 'custom_role'] };
    const legacyNames = route => route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ config: retainedPolicy }) })
      : route.continue();
    await page.route(paymentRoute, legacyNames);
    try {
      await navigate('Payments');
      await payment.getByText('Nobody can currently create payment requests.', { exact: true }).waitFor();
      assert.equal(await payment.locator('.payment-access-roles input:checked').count(), 0, 'Inactive saved aliases are not treated as permission grants');
      const save = payment.getByRole('button', { name: 'Save changes', exact: true });
      await payment.getByRole('button', { name: 'Use Moderator role', exact: true }).click();
      assert.ok(await payment.getByRole('checkbox', { name: 'Moderator', exact: true }).isChecked());
      assert.ok(await save.isDisabled(), 'An unreviewed uppercase name cannot gain access through an unrelated save');
      await payment.getByRole('button', { name: 'Remove saved role name OWNER', exact: true }).click();
      assert.ok(await save.isEnabled());
      await payment.locator('.payment-access-retained-role').filter({ hasText: 'custom_role' }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await payment.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await payment.locator('.payment-access-retained-role').scrollIntoViewIfNeeded();
      await page.screenshot({ path: scratch + '/admin-payments-legacy-name-review-390.png' });
      await payment.getByRole('button', { name: 'Discard', exact: true }).click();
      assert.equal(await payment.locator('.payment-access-roles input:checked').count(), 0, 'Discard restores exact saved access, not normalized aliases');
      assert.equal(await payment.locator('.payment-access-retained-role').count(), 3);
    } finally {
      await page.unroute(paymentRoute, legacyNames);
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    await navigate('Branding');
    const name = branding.getByLabel('Server name', { exact: true });
    await name.waitFor();
    const accent = branding.getByLabel(/^Accent color/);
    await accent.fill('#12');
    await name.fill('Unpublished name while typing a color');
    assert.equal(await accent.inputValue(), '#12', 'Editing another field does not erase a partially typed color');
    assert.equal(await accent.getAttribute('aria-invalid'), 'true');
    assert.ok(await branding.getByRole('button', { name: 'Publish changes', exact: true }).isDisabled(), 'An invalid color draft cannot be published');
    await branding.getByRole('button', { name: 'Discard changes', exact: true }).click();
    assert.equal(await name.inputValue(), originalBranding.displayName ?? '');
    assert.match(await branding.locator('.branding-notice').textContent(), /Discarded/);
    assert.doesNotMatch(await branding.locator('.branding-notice').textContent(), /published/i, 'Discard does not claim a publication');
    let filePickers = 0;
    const sawFilePicker = () => { filePickers++; };
    page.on('filechooser', sawFilePicker);
    try {
      const [upload] = await Promise.all([
        page.waitForResponse(responseFor('/api/upload')),
        branding.getByRole('button', { name: 'Upload server icon', exact: true }).evaluate(node => {
          const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), character => character.charCodeAt(0));
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], 'admin-dropped-icon.png', { type: 'image/png' }));
          node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }),
      ]);
      assert.equal(upload.status(), 200);
      const uploaded = await upload.json();
      assert.ok(typeof uploaded.fileUrl === 'string' && uploaded.fileUrl.length > 0);
      await branding.locator('.branding-asset-preview:not(.banner) img').waitFor();
      assert.equal(filePickers, 0, 'A real file drop does not reopen the native picker');
      assert.equal((await api(brandingPath)).config.iconUrl, originalBranding.iconUrl, 'Uploaded artwork remains a draft until publication');
      await branding.getByRole('button', { name: 'Discard changes', exact: true }).click();
    } finally {
      page.off('filechooser', sawFilePicker);
    }
    const publishedName = 'Admin browser fixture community';
    await name.fill(publishedName);
    assert.equal((await api(brandingPath)).config.displayName, originalBranding.displayName, 'Branding draft is not prematurely published');
    const brandingRoute = /\/api\/admin\/policies\/frontend_app_metadata$/;
    const failBrandingSave = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated branding publish failure' }) })
      : route.continue();
    await page.route(brandingRoute, failBrandingSave);
    try {
      const [failed] = await Promise.all([page.waitForResponse(responseFor(brandingPath)), branding.getByRole('button', { name: 'Publish changes', exact: true }).click()]);
      assert.equal(failed.status(), 503);
      await branding.getByRole('alert').filter({ hasText: 'Isolated branding publish failure' }).waitFor();
      assert.equal(await name.inputValue(), publishedName, 'A failed publication preserves the identity draft');
      assert.deepEqual((await api(brandingPath)).config, originalBranding, 'The published identity remains unchanged after rejection');
      assert.match(await branding.locator('.branding-notice').textContent(), /unpublished changes/);
      assert.ok(await branding.getByRole('button', { name: 'Publish changes', exact: true }).isEnabled());
      await page.screenshot({ path: scratch + '/admin-branding-save-failure.png' });
    } finally {
      await page.unroute(brandingRoute, failBrandingSave);
    }
    const [published] = await Promise.all([page.waitForResponse(responseFor(brandingPath)), branding.getByRole('button', { name: 'Publish changes', exact: true }).click()]);
    assert.equal(published.status(), 200);
    await branding.locator('.branding-notice').filter({ hasText: 'Server identity published.' }).waitFor();
    assert.equal((await api(brandingPath)).config.displayName, publishedName);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.workspace-trigger').waitFor({ timeout: 60_000 });
    await openAdmin('Branding');
    await name.waitFor();
    assert.equal(await name.inputValue(), publishedName, 'Published server name survives a real application reload');
    await assertAdminTextContrast(page);
    await page.screenshot({ path: `${scratch}/admin-branding-reloaded.png` });

    // Exercise the production retry wrapper, not only an outer UI callback.
    // Every matching mutation is intercepted, including an incorrect retry:
    // a regression must never reset even the disposable member accidentally.
    let releaseOld401;
    let markHeld;
    const held401 = new Promise(resolve => { markHeld = resolve; });
    let retiredRequests = 0;
    const retireRoute = /\/api\/admin\/users\/reset-password$/;
    const retireMutation = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      retiredRequests++;
      if (retiredRequests === 1) await new Promise(resolve => { releaseOld401 = resolve; markHeld(); });
      await route.fulfill({ status: retiredRequests === 1 ? 401 : 200, contentType: 'application/json', body: JSON.stringify({ success: retiredRequests > 1 }) }).catch(() => {});
    };
    await page.route(retireRoute, retireMutation);
    try {
      await page.evaluate(async backend => {
        const { fetchWithTimeout } = await import('/src/lib/api/utils.ts');
        const { getAuthToken } = await import('/src/lib/authSession.ts');
        window.__adminRetiredMutation = fetchWithTimeout(backend + '/api/admin/users/reset-password', {
          method: 'POST', headers: { Authorization: 'Bearer ' + getAuthToken(backend), 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUserId: -1, newPassword: 'Never-delivered-fixture-only', temporary: false })
        }).then(response => response.status, () => 'cancelled');
      }, backend);
      let heldTimeout;
      try {
        await Promise.race([held401, new Promise((_, reject) => {
          heldTimeout = setTimeout(() => reject(new Error('Admin fixture did not reach its held request')), 5000);
        })]);
      } finally { clearTimeout(heldTimeout); }
      assert.ok(releaseOld401, 'The old privileged request is held at its 401 boundary');
      await page.evaluate(async ({ backend, token, refreshToken }) => {
        const auth = await import('/src/lib/authSession.ts');
        auth.clearAuthSession(backend);
        auth.setAuthToken(token, backend);
        (await import('/src/lib/api/authRefresh.ts')).setRefreshToken(refreshToken, backend);
      }, { backend, token: member.accessToken, refreshToken: member.refreshToken });
      releaseOld401();
      const outcome = await page.evaluate(() => window.__adminRetiredMutation);
      assert.ok(outcome === 401 || outcome === 'cancelled');
      assert.equal(retiredRequests, 1, 'A retired Admin mutation is never retried as the replacement account');
      await admin.waitFor({ state: 'hidden' });
    } finally {
      releaseOld401?.();
      await page.unroute(retireRoute, retireMutation);
      await page.evaluate(async ({ backend, token, refreshToken }) => {
        const auth = await import('/src/lib/authSession.ts');
        auth.clearAuthSession(backend);
        auth.setAuthToken(token, backend);
        (await import('/src/lib/api/authRefresh.ts')).setRefreshToken(refreshToken, backend);
        delete window.__adminRetiredMutation;
      }, { backend, token: account.accessToken, refreshToken: account.refreshToken });
    }
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.workspace-trigger').waitFor({ timeout: 60_000 });
    await openAdmin('Overview');
    await admin.locator('.admin-back-btn').click();
    await admin.waitFor({ state: 'hidden' });
    console.log('PASS: real account reset/revocation, keyboard+mobile/light recovery, new/reused People DM, role and badge updates, individual payment restrictions, pinned-dock channel navigation without capture, payment policy enforcement and exact saved-name review, branding publish/reload, retired-account retry fencing');
  } finally {
    page.off('request', countReset);
    // Cleanup is limited to the confirmed throwaway backend and exact saved
    // policy objects. A failing assertion must not leave a changed policy behind.
    const cleanup = await Promise.allSettled([
      api(paymentPath, { method: 'POST', body: originalPayment }),
      api(brandingPath, { method: 'POST', body: originalBranding }),
    ]);
    await page.evaluate(async original => {
      const { themeStore } = await import('/src/lib/theme/themeStore.ts');
      if (original.themeId === 'custom') themeStore.setCustomTheme(original.customTheme);
      else themeStore.setThemeId(original.themeId);
      (await import('/src/lib/layoutStore.ts')).layoutStore.closeRightPanel();
    }, originalTheme);
    if (originalViewport) await page.setViewportSize(originalViewport);
    assert.ok(cleanup.every(result => result.status === 'fulfilled'), 'Isolated payment/branding fixture policies were restored');
  }
}
