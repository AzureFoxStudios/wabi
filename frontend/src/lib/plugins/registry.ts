import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import { fetchPlugins, requestPluginReload, setPluginEnabled } from './api';
import type {
	PluginCommandExtension,
	PluginFrontendRuntimeModule,
	PluginListItem,
	PluginManifest,
	PluginStatus,
	ResolvedPluginExtension
} from './manifest';

export interface RegisteredPlugin {
	id: string;
	manifest: PluginManifest;
	enabled: boolean;
	status: PluginStatus;
	module?: PluginFrontendRuntimeModule;
	loadError?: string;
	lastLoadedAt?: number;
}

interface PluginRegistryState {
	plugins: Record<string, RegisteredPlugin>;
	loading: boolean;
	error?: string;
}

const initialState: PluginRegistryState = {
	plugins: {},
	loading: false
};

const state = writable<PluginRegistryState>(initialState);

async function loadFrontendModule(plugin: RegisteredPlugin): Promise<RegisteredPlugin> {
	if (!browser || !plugin.enabled || !plugin.manifest.frontend?.entry) {
		return plugin;
	}

	try {
		const imported = (await import(/* @vite-ignore */ plugin.manifest.frontend.entry)) as
			| PluginFrontendRuntimeModule
			| { default?: PluginFrontendRuntimeModule };
		const module = ('default' in imported && imported.default ? imported.default : imported) as PluginFrontendRuntimeModule;
		return {
			...plugin,
			status: 'enabled',
			module,
			loadError: undefined,
			lastLoadedAt: Date.now()
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown module load error';
		return {
			...plugin,
			status: 'error',
			module: undefined,
			loadError: message
		};
	}
}

function buildRegisteredPlugin(item: PluginListItem): RegisteredPlugin {
	return {
		id: item.id,
		manifest: item.manifest,
		enabled: item.manifest.enabled ?? true,
		status: item.manifest.enabled === false ? 'disabled' : 'loading'
	};
}

export const pluginRegistry = {
	subscribe: state.subscribe,

	plugins: derived(state, ($state) => Object.values($state.plugins)),

	async hydrateFromServer() {
		const snapshot = getState();
		if (snapshot.loading || Object.keys(snapshot.plugins).length > 0) return;

		state.update((current) => ({ ...current, loading: true, error: undefined }));
		try {
			const plugins = await fetchPlugins();
			for (const plugin of plugins) {
				await this.registerPlugin(plugin);
			}
			state.update((current) => ({ ...current, loading: false }));
		} catch (error) {
			state.update((current) => ({
				...current,
				loading: false,
				error: error instanceof Error ? error.message : 'Failed to hydrate plugins'
			}));
		}
	},

	async registerPlugin(item: PluginListItem) {
		let plugin = buildRegisteredPlugin(item);
		plugin = await loadFrontendModule(plugin);
		state.update((current) => ({
			...current,
			plugins: {
				...current.plugins,
				[plugin.id]: plugin
			}
		}));
	},

	unregisterPlugin(pluginId: string) {
		state.update((current) => {
			const next = { ...current.plugins };
			delete next[pluginId];
			return { ...current, plugins: next };
		});
	},

	async enablePlugin(pluginId: string) {
		const current = getPlugin(pluginId);
		if (!current) return;

		state.update((s) => ({
			...s,
			plugins: {
				...s.plugins,
				[pluginId]: { ...current, enabled: true, status: 'loading' }
			}
		}));

		try {
			await setPluginEnabled(pluginId, true);
			const loaded = await loadFrontendModule({ ...current, enabled: true });
			state.update((s) => ({
				...s,
				plugins: {
					...s.plugins,
					[pluginId]: loaded
				}
			}));
		} catch (error) {
			state.update((s) => ({
				...s,
				plugins: {
					...s.plugins,
					[pluginId]: {
						...current,
						loadError: error instanceof Error ? error.message : 'Failed to enable plugin',
						status: 'error'
					}
				}
			}));
		}
	},

	async disablePlugin(pluginId: string) {
		const current = getPlugin(pluginId);
		if (!current) return;
		try {
			await setPluginEnabled(pluginId, false);
			state.update((s) => ({
				...s,
				plugins: {
					...s.plugins,
					[pluginId]: { ...current, enabled: false, status: 'disabled', module: undefined }
				}
			}));
		} catch (error) {
			state.update((s) => ({
				...s,
				plugins: {
					...s.plugins,
					[pluginId]: {
						...current,
						loadError: error instanceof Error ? error.message : 'Failed to disable plugin',
						status: 'error'
					}
				}
			}));
		}
	},

	async reloadPlugin(pluginId: string) {
		const current = getPlugin(pluginId);
		if (!current) return;

		state.update((s) => ({
			...s,
			plugins: {
				...s.plugins,
				[pluginId]: { ...current, status: 'loading' }
			}
		}));

		try {
			await requestPluginReload(pluginId);
			const loaded = await loadFrontendModule({ ...current, enabled: true });
			state.update((s) => ({
				...s,
				plugins: {
					...s.plugins,
					[pluginId]: loaded
				}
			}));
		} catch (error) {
			state.update((s) => ({
				...s,
				plugins: {
					...s.plugins,
					[pluginId]: {
						...current,
						status: 'error',
						loadError: error instanceof Error ? error.message : 'Failed to reload plugin'
					}
				}
			}));
		}
	},

	resolveSidebarExtensions(): ResolvedPluginExtension<{ component: unknown }>[] {
		const resolved = Object.values(getState().plugins)
			.filter((plugin) => plugin.enabled && plugin.module?.sidebar)
			.map((plugin) => ({
				pluginId: plugin.id,
				pluginName: plugin.manifest.name,
				position: plugin.manifest.frontend?.extensions?.sidebar?.position ?? 100,
				extension: { component: plugin.module?.sidebar?.component },
				loadError: plugin.loadError
			}));
		return resolved.sort((a, b) => a.position - b.position);
	},

	resolveCommandExtensions(): ResolvedPluginExtension<PluginCommandExtension>[] {
		return Object.values(getState().plugins)
			.filter((plugin) => plugin.enabled && plugin.module?.commands?.length)
			.flatMap((plugin) =>
				(plugin.module?.commands || []).map((command) => ({
					pluginId: plugin.id,
					pluginName: plugin.manifest.name,
					position: 100,
					extension: command,
					loadError: plugin.loadError
				}))
			);
	},

	resolveChannelViews(channelType?: string): ResolvedPluginExtension<{ component: unknown }>[] {
		return Object.values(getState().plugins)
			.filter((plugin) => plugin.enabled && plugin.module?.channelViews?.length)
			.flatMap((plugin) =>
				(plugin.module?.channelViews || [])
					.filter((view) => !channelType || view.channelType === channelType)
					.map((view) => ({
						pluginId: plugin.id,
						pluginName: plugin.manifest.name,
						position: 100,
						extension: { component: view.component },
						loadError: plugin.loadError
					}))
			);
	}
};

function getState(): PluginRegistryState {
	return get(state);
}

function getPlugin(pluginId: string): RegisteredPlugin | undefined {
	return getState().plugins[pluginId];
}
