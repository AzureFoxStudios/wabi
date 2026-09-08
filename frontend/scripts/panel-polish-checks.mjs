import assert from 'node:assert/strict';

async function readPanelPersistenceState(page) {
	return page.evaluate(async () => {
		const state = await import('/src/lib/layoutStoreStates.ts');
		const { getWorkspace, getAuxTabset } = await import('/src/lib/docking/layoutSchema.ts');
		const { getDockActivePanelId } = await import('/src/lib/layoutStoreUtils.ts');
		const { getApiBase } = await import('/src/lib/api.ts');
		const { getAuthToken } = await import('/src/lib/authSession.ts');
		const get = store => { let value; store.subscribe(next => value = next)(); return value; };
		const describe = layout => {
			if (!layout) return null;
			const workspace = getWorkspace(layout);
			return { workspace: layout.activeWorkspace, panel: getDockActivePanelId(workspace.panelDock), collapsed: getAuxTabset(workspace).collapsed };
		};
		const remote = await fetch(`${getApiBase()}/api/user/layout`, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
		const body = await remote.json();
		const container = body.layoutJson ? JSON.parse(body.layoutJson) : null;
		return {
			loaded: state.layoutLoaded,
			pin: get(state.pinnedPanelId),
			mode: get(state.rightPanelMode),
			mobile: get(state.isMobile),
			runtime: describe(get(state.layoutState)),
			local: describe(JSON.parse(localStorage.getItem('wabi:dock-layout:remote:v1') || 'null')?.state),
			serverStatus: remote.status,
			server: describe(container?.layout ?? container)
		};
	});
}

/** Call in the full-app isolated browser fixture, never against a live account. */
export async function probePanelPersistence(page) {
	await page.waitForFunction(async () => (await import('/src/lib/layoutStoreStates.ts')).layoutLoaded);
	return page.evaluate(async () => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		const state = await import('/src/lib/layoutStoreStates.ts');
		const get = store => { let value; store.subscribe(next => value = next)(); return value; };
		const { getWorkspace, getAuxTabset } = await import('/src/lib/docking/layoutSchema.ts');
		const { getDockActivePanelId } = await import('/src/lib/layoutStoreUtils.ts');
		layoutStore.closeRightPanel();
		layoutStore.pinPanel('notes');
		await Promise.resolve();
		const workspace = getWorkspace(get(state.layoutState));
		return { pin: get(state.pinnedPanelId), savedPanel: getDockActivePanelId(workspace.panelDock), collapsed: getAuxTabset(workspace).collapsed };
	});
}

export async function runPanelPolishChecks(page, scratch) {
	async function choose(label) {
		await page.locator('.workspace-trigger').click();
		await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: label, exact: true }).click();
		await page.waitForFunction(label => document.querySelector('.workspace-current')?.textContent === label, label);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await choose('Messages');
	await page.mouse.move(300, 600);
	await page.locator('.workspace-trigger').focus();
	await page.evaluate(async () => (await import('/src/lib/layoutStore.ts')).layoutStore.closeRightPanel());
	const add = page.getByRole('button', { name: 'Add or manage panels', exact: true });
	await add.focus();
	await page.keyboard.press('Enter');
	const drawer = page.getByRole('dialog', { name: 'Available panels' });
	await drawer.waitFor();
	assert.ok(await drawer.evaluate(node => node.contains(document.activeElement)), 'panel drawer takes focus');
	const actions = drawer.getByRole('button');
	assert.ok(await actions.first().evaluate(node => node === document.activeElement));
	await page.keyboard.press('ArrowDown');
	assert.ok(await actions.nth(1).evaluate(node => node === document.activeElement), 'ArrowDown moves between actions');
	await page.keyboard.press('End');
	assert.ok(await actions.last().evaluate(node => node === document.activeElement), 'End reaches strip settings');
	await page.keyboard.press('ArrowDown');
	assert.ok(await actions.first().evaluate(node => node === document.activeElement), 'ArrowDown wraps');
	await page.keyboard.press('Escape');
	await drawer.waitFor({ state: 'hidden' });
	assert.ok(await add.evaluate(node => node === document.activeElement), 'Escape returns to Add panels');
	await page.setViewportSize({ width: 1000, height: 360 });
	await add.focus();
	await page.keyboard.press('ArrowDown');
	await drawer.waitFor();
	// Portal mounting and ResizeObserver placement settle after initial visibility.
	// Assert the resulting geometry, not the pre-placement frame.
	await page.waitForFunction(() => {
		const box = document.querySelector('[role="dialog"][aria-label="Available panels"]')?.getBoundingClientRect();
		return box && box.y >= 7.5 && box.bottom <= window.innerHeight - 7.5;
	});
	let bounds = await drawer.boundingBox();
	assert.ok(bounds.y >= 7.5 && bounds.y + bounds.height <= 352.5, `drawer fits short window: ${JSON.stringify(bounds)}`);
	await page.keyboard.press('End');
	assert.ok(await actions.last().evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'footer remains hit-testable');
	if (scratch) await page.screenshot({ path: `${scratch}/panel-drawer-short.png` });
	await page.keyboard.press('Escape');
	await page.setViewportSize({ width: 1440, height: 900 });
	await choose('Notes');
	const workspace = page.locator('.chat-surface .notes-workspace');
	assert.equal(await workspace.getByRole('heading', { name: 'Notes', exact: true }).count(), 1);
	assert.equal(await workspace.getByText('Keep personal notes, links, and reminders on this device.', { exact: true }).count(), 1, 'one empty explanation');
	await workspace.getByRole('button', { name: 'Create your first note', exact: true }).click();
	const editor = page.locator('.chat-surface').getByRole('textbox', { name: 'Note text', exact: true });
	await editor.fill('Polish fixture note — narrow panels keep this editable.');
	assert.ok(await editor.evaluate(node => node === document.activeElement), 'creation enters editable note');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('.chat-surface .notes-compact').waitFor();
	assert.equal(await editor.inputValue(), 'Polish fixture note — narrow panels keep this editable.');
	assert.ok(await workspace.evaluate(node => node.scrollWidth <= node.clientWidth), 'narrow Notes has no horizontal overflow');
	await workspace.getByRole('button', { name: 'Back to notes', exact: true }).click();
	await workspace.getByRole('button').filter({ hasText: 'Polish fixture note' }).click();
	assert.equal(await editor.inputValue(), 'Polish fixture note — narrow panels keep this editable.');
	if (scratch) await page.screenshot({ path: `${scratch}/notes-editor-mobile.png` });
	await page.setViewportSize({ width: 1000, height: 800 });
	await page.getByRole('button', { name: 'People', exact: true }).click();
	await page.locator('.right-panel.is-pinned').waitFor();
	await page.locator('.chat-surface .notes-compact').waitFor();
	assert.ok(await workspace.evaluate(node => node.scrollWidth <= node.clientWidth), 'available pane width, not viewport, chooses compact Notes');
	await choose('Messages');
	await page.mouse.move(300, 600);
	await page.locator('.workspace-trigger').focus();
	const savedPin = page.waitForResponse(response => {
		if (!response.url().includes('/api/user/layout') || response.request().method() !== 'PUT' || !response.ok()) return false;
		try {
			const container = JSON.parse(response.request().postDataJSON().layoutJson);
			const layout = container.layout;
			return layout.workspaces[layout.activeWorkspace].panelDock.stacks.some(stack => stack.activePanelId === 'notes');
		} catch { return false; }
	});
	const persisted = await probePanelPersistence(page);
	assert.deepEqual(persisted, { pin: 'notes', savedPanel: 'notes', collapsed: false }, 'pin updates the actual persistence snapshot');
	await savedPin;
	const beforeReload = await readPanelPersistenceState(page);
	console.log('PIN RESTORE BEFORE', JSON.stringify(beforeReload));
	assert.equal(beforeReload.serverStatus, 200, 'acknowledged layout can be read from the server');
	assert.equal(beforeReload.server?.panel, 'notes', 'server returns the acknowledged Notes pin');
	assert.equal(beforeReload.server?.collapsed, false, 'acknowledged server panel remains expanded');
	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForFunction(async () => (await import('/src/lib/layoutStoreStates.ts')).layoutLoaded);
	const afterReload = await readPanelPersistenceState(page);
	console.log('PIN RESTORE AFTER', JSON.stringify(afterReload));
	assert.equal(afterReload.pin, 'notes', 'committed pin restores into the runtime after server acknowledgment');
	assert.equal(afterReload.mode, 'pinned', 'restored panel is pinned, not a transient peek');
	await page.getByRole('button', { name: 'Notes', exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor();
	const savedClosed = page.waitForResponse(response => {
		if (!response.url().includes('/api/user/layout') || response.request().method() !== 'PUT' || !response.ok()) return false;
		try {
			const { layout } = JSON.parse(response.request().postDataJSON().layoutJson);
			const findAux = node => node.id === 'tabset-aux' ? node : (node.children ?? []).map(findAux).find(Boolean);
			return findAux(layout.workspaces[layout.activeWorkspace].root)?.collapsed === true;
		} catch { return false; }
	});
	await page.evaluate(async () => (await import('/src/lib/layoutStore.ts')).layoutStore.closeRightPanel());
	await savedClosed;
	assert.equal((await readPanelPersistenceState(page)).server?.collapsed, true, 'closed panel is acknowledged too');
	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForFunction(async () => (await import('/src/lib/layoutStoreStates.ts')).layoutLoaded);
	const restoredClosed = await readPanelPersistenceState(page);
	console.log('PIN RESTORE CLOSED', JSON.stringify(restoredClosed));
	assert.equal(restoredClosed.pin, null, 'startup home preference does not re-pin an explicitly closed dock');
	assert.equal(restoredClosed.mode, 'none');
	await page.locator('.right-panel.is-pinned').waitFor({ state: 'hidden' });
	console.log('PASS: panel keyboard/viewport, Notes empty/editor/responsive, acknowledged pin and closed-dock restoration');
}
