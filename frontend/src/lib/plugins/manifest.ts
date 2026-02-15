export type PluginStatus = 'enabled' | 'disabled' | 'error' | 'loading';

export interface PluginSidebarExtensionManifest {
	icon: string;
	label: string;
	component: string;
	position?: number;
}

export interface PluginFrontendExtensionsManifest {
	sidebar?: PluginSidebarExtensionManifest;
	commands?: string[];
	channelTypes?: string[];
}

export interface PluginFrontendManifest {
	entry: string;
	extensions?: PluginFrontendExtensionsManifest;
}

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	enabled?: boolean;
	frontend?: PluginFrontendManifest;
	permissions?: string[];
	dependencies?: string[];
}

export interface PluginListItem {
	id: string;
	manifest: PluginManifest;
}

export interface PluginExtensionComponentProps {
	pluginId: string;
	pluginName: string;
	channelType?: string;
}

export interface PluginCommandExtension {
	id: string;
	label: string;
	description?: string;
	execute: (...args: unknown[]) => void | Promise<void>;
}

export interface PluginChannelViewExtension {
	id: string;
	channelType: string;
	component: unknown;
}

export interface PluginFrontendRuntimeModule {
	sidebar?: {
		component: unknown;
	};
	commands?: PluginCommandExtension[];
	channelViews?: PluginChannelViewExtension[];
}

export interface ResolvedPluginExtension<T = unknown> {
	pluginId: string;
	pluginName: string;
	position: number;
	extension: T;
	loadError?: string;
}
