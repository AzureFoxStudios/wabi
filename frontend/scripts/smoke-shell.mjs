// Shared helpers for headful smokes that drive the signed-in application shell.
//
// The shell used to render a single `.workspace-trigger` button ("Workspace ▾") that
// opened a "Choose workspace" dialog. 86a7cffc hid that button at >= 900 px (the
// view tabs moved into the channel header) and ee9f7c34 ("wave 1a") removed it,
// replacing it with the StageBar masthead:
//   - desktop: a `nav.w-folio` tablist of `[role=tab][data-view=…]` buttons, with
//     the overflow in a "More" menu of `menuitemradio` rows;
//   - phone: a `.w-folio-trigger` button ("Chat ▾") that opens a "Workspaces" sheet.
// These helpers drive whichever form the current viewport shows, so smokes keep
// asserting the same things they asserted before without depending on one layout.

/**
 * Wait until the signed-in shell (MainLayout) has mounted. `.main-content` only exists once
 * `+page.svelte` has a signed-in session and has finished its initial load, which is what the
 * old `.workspace-trigger` wait proved. The StageBar is not used here: a fresh owner lands on
 * the server Welcome hub, which has its own header and no StageBar.
 */
export async function waitForAppShell(page, { timeout = 60000 } = {}) {
	await page.locator('.main-content .chat-surface').waitFor({ state: 'visible', timeout });
}

/** The control that opens workspace navigation in the current viewport. */
export function workspaceNavigation(page) {
	return page.locator('.stage-bar .w-folio-trigger:visible, .stage-bar .w-folio:visible').first();
}

/**
 * Open a center-stage workspace the way a person would.
 * @param {import('playwright').Page} page
 * @param {{ view: string, label: string }} target  view id (data-view) and its visible label
 */
export async function openWorkspace(page, { view, label, channel = 'general' }) {
	await waitForAppShell(page);
	// A fresh owner lands on the server Welcome hub, which has no StageBar; open a text channel
	// first, as a person would, so the workspace masthead is there to navigate from.
	if (!(await page.locator('.stage-bar').isVisible())) {
		const channels = page.locator('.mobile-bottom-nav .mnav-tab[data-nav="channels"]');
		if (await channels.isVisible()) await channels.click();
		await page.getByRole('button', { name: new RegExp(escape(channel)) }).first().click();
		await page.locator('.stage-bar').waitFor({ state: 'visible' });
	}
	const phoneTrigger = page.locator('.stage-bar .w-folio-trigger');
	if (await phoneTrigger.isVisible()) {
		await phoneTrigger.click();
		const sheet = page.getByRole('dialog', { name: 'Workspaces' });
		await sheet.locator('.w-folio-sheet__row').filter({ has: page.locator('.w-folio-sheet__label', { hasText: new RegExp(`^${escape(label)}`) }) }).first().click();
		await sheet.waitFor({ state: 'hidden' });
	} else {
		const tab = page.locator(`.stage-bar .w-folio [role="tab"][data-view="${view}"]`);
		if (await tab.isVisible()) {
			await tab.click();
		} else {
			await page.locator('.stage-bar .w-folio__more-wrap button').first().click();
			await page.getByRole('menuitemradio', { name: new RegExp(`^${escape(label)}`) }).click();
		}
	}
	await page.waitForFunction(
		(id) => document.querySelector('.stage-bar')?.getAttribute('data-view') === id,
		view,
		{ timeout: 15000 }
	);
}

function escape(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Open a DM or group conversation in center stage through the UI: the sidebar "DMs" row, then
 * the conversation's row in the DM hub. Smokes used to call `layoutStore.openCenterDm` directly;
 * since the server Welcome hub became the landing view (activeView 'server'), that store call
 * no longer changes what center stage shows, which is correct: only navigation does.
 */
export async function openDmConversation(page, channelId) {
	await waitForAppShell(page);
	await openDmHub(page);
	await page.locator(`.dm-hub-conversation[data-dm-channel-id="${channelId}"]`).click();
	await page.locator(`.dm-conversation`).waitFor({ state: 'visible' });
	await page.locator(`.dm-hub-conversation[data-dm-channel-id="${channelId}"][aria-current="page"]`).waitFor({ state: "attached" }); // the phone hides the list once a thread is open
}

/** Open the DM hub: the sidebar "DMs" row on desktop, the bottom-nav "DMs" tab on phones. */
export async function openDmHub(page) {
	await waitForAppShell(page);
	const sidebar = page.locator('.messages-hub-btn:visible').first();
	if (await sidebar.count()) await sidebar.click();
	else await page.locator('.mobile-bottom-nav .mnav-tab[data-nav="dms"]').click();
	await page.locator('.center-dm-layout').waitFor({ state: 'visible' });
}
