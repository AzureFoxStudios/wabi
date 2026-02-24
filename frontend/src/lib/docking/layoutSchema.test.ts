import {
	createDefaultLayoutState,
	createDefaultWorkspaceLayout,
	deserializeLayoutState,
	getAuxTabset,
	getNavTabset,
	migrateLayoutState,
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
		assert(aux.size === 320, 'default auxiliary size should be 320');
		assert(aux.collapsed === true, 'default auxiliary panel should start collapsed');
		results.push({ name: 'default workspace preset is reset-safe', passed: true });
	} catch (error) {
		results.push({
			name: 'default workspace preset is reset-safe',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	return results;
}
