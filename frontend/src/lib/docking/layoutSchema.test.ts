import { describe, expect, test } from 'bun:test';
import {
	createDefaultLayoutState,
	createDefaultWorkspaceLayout,
	deserializeLayoutState,
	getAuxTabset,
	getNavTabset,
	migrateLayoutState,
	normalizePanelDock,
	serializeLayoutState
} from './layoutSchema';

describe('docking layoutSchema', () => {
	test('serialize/deserialize keeps schema v1 state', () => {
		const state = createDefaultLayoutState();
		const encoded = serializeLayoutState(state);
		const decoded = deserializeLayoutState(encoded);
		expect(decoded.layoutVersion).toBe(1);
		expect(decoded.workspaces.default).toBeDefined();
	});

	test('legacy shape migrates into v1 workspace model', () => {
		const legacy = {
			navDock: 'right',
			channelSidebarWidth: 310,
			rightPanelWidth: 360,
			rightPanelView: 'users'
		};
		const migrated = migrateLayoutState(legacy);
		const workspace = migrated.workspaces.default;
		expect(workspace.navDock).toBe('right');
		expect(getNavTabset(workspace).size).toBe(310);
		expect(getAuxTabset(workspace).collapsed).toBe(false);
	});

	test('default workspace preset is reset-safe', () => {
		const reset = createDefaultWorkspaceLayout('default');
		const nav = getNavTabset(reset);
		const aux = getAuxTabset(reset);
		expect(nav.size).toBe(280);
		expect(nav.collapsed).toBe(false);
		expect(aux.size).toBe(360);
		expect(aux.collapsed).toBe(false);
		expect(reset.panelDock.stacks[0].tabs.includes('users')).toBe(true);
	});

	test('dynamic panel ids migrate with invalid panel fallback', () => {
		const raw = {
			layoutVersion: 1,
			activeWorkspace: 'default',
			updatedAt: Date.now(),
			workspaces: {
				default: {
					name: 'default',
					navDock: 'left',
					root: createDefaultWorkspaceLayout('default').root,
					panelDock: {
						orientation: 'vertical',
						stacks: [
							{
								id: 'stack-primary',
								tabs: ['users', 'addon:stocks-watch', '', '__proto__'],
								activePanelId: 'addon:stocks-watch',
								size: 100,
								collapsed: false,
								pinned: true
							}
						]
					},
					updatedAt: Date.now()
				}
			}
		};
		const migrated = migrateLayoutState(raw);
		const tabs = migrated.workspaces.default.panelDock.stacks[0].tabs;
		expect(tabs.includes('addon:stocks-watch')).toBe(true);
		expect(tabs.includes('')).toBe(false);
		expect(tabs.includes('__proto__')).toBe(false);
		expect(migrated.workspaces.default.panelDock.stacks[0].activePanelId).toBe('addon:stocks-watch');
	});

	test('invalid panel dock falls back to users', () => {
		const normalized = normalizePanelDock({
			orientation: 'vertical',
			stacks: [
				{
					id: 'broken',
					tabs: ['', 'constructor'],
					activePanelId: 'missing',
					size: 0,
					collapsed: true,
					pinned: false
				}
			]
		});
		expect(normalized.stacks.length).toBe(1);
		expect(normalized.stacks[0].activePanelId).toBe('users');
	});
});
