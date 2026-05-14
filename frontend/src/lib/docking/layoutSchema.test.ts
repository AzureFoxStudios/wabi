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

interface DockingTestResult {
	name: string;
	passed: boolean;
	error?: string;
}

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

export function runDockingLayoutSchemaTests(): DockingTestResult[] {
	const results: DockingTestResult[] = [];

	try {
		const state = createDefaultLayoutState();
		const encoded = serializeLayoutState(state);
		const decoded = deserializeLayoutState(encoded);
		assert(decoded.layoutVersion === 1, 'layoutVersion should remain 1 after deserialize');
		assert(decoded.workspaces.default !== undefined, 'default workspace should be present');
		results.push({ name: 'serialize/deserialize keeps schema v1 state', passed: true });
	} catch (error) {
		results.push({
			name: 'serialize/deserialize keeps schema v1 state',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const legacy = {
			navDock: 'right',
			channelSidebarWidth: 310,
			rightPanelWidth: 360,
			rightPanelView: 'users'
		};
		const migrated = migrateLayoutState(legacy);
		const workspace = migrated.workspaces.default;
		assert(workspace.navDock === 'right', 'legacy navDock should migrate');
		assert(getNavTabset(workspace).size === 310, 'legacy nav width should migrate');
		assert(getAuxTabset(workspace).collapsed === false, 'open right panel should not migrate as collapsed');
		results.push({ name: 'legacy shape migrates into v1 workspace model', passed: true });
	} catch (error) {
		results.push({
			name: 'legacy shape migrates into v1 workspace model',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const reset = createDefaultWorkspaceLayout('default');
		const nav = getNavTabset(reset);
		const aux = getAuxTabset(reset);
		assert(nav.size === 280, 'default nav size should be 280');
		assert(nav.collapsed === false, 'default nav should be expanded');
		assert(aux.size === 360, 'default auxiliary size should be 360');
		assert(aux.collapsed === false, 'default auxiliary panel should start open');
		assert(reset.panelDock.stacks[0].tabs.includes('users'), 'default panel dock should include users');
		results.push({ name: 'default workspace preset is reset-safe', passed: true });
	} catch (error) {
		results.push({
			name: 'default workspace preset is reset-safe',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
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
		assert(tabs.includes('addon:stocks-watch'), 'valid dynamic panel IDs should survive migration');
		assert(!tabs.includes(''), 'empty panel IDs should be removed');
		assert(!tabs.includes('__proto__'), 'reserved panel IDs should be removed');
		assert(migrated.workspaces.default.panelDock.stacks[0].activePanelId === 'addon:stocks-watch', 'dynamic active panel should survive');
		results.push({ name: 'dynamic panel ids migrate with invalid panel fallback', passed: true });
	} catch (error) {
		results.push({
			name: 'dynamic panel ids migrate with invalid panel fallback',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
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
		assert(normalized.stacks.length === 1, 'invalid stack should fall back to one stack');
		assert(normalized.stacks[0].activePanelId === 'users', 'invalid active panel should fall back to users');
		results.push({ name: 'invalid panel dock falls back to users', passed: true });
	} catch (error) {
		results.push({
			name: 'invalid panel dock falls back to users',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	return results;
}
