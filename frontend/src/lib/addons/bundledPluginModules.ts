/**
 * The bundled plugin components this build contains.
 *
 * `import.meta.glob` is a Vite transform, not a runtime function, so any module
 * that calls it directly cannot be imported by a `bun test` suite. Keeping the
 * glob alone in this file lets `addonInventory` — which decides whether an
 * add-on's UI may be shown — be unit-tested by stubbing this one module.
 *
 * ModelViewer3D (three.js) is intentionally excluded: on desktop Tauri builds
 * it is NOT bundled (the native wgpu viewer is the default) and is only loaded
 * at runtime when a server-provided `model-viewer` addon is present. On web it
 * is imported directly by ModelViewerLauncher.
 */
const frontendAddonModules = import.meta.glob([
	'../components/plugins/*.svelte',
	'!../components/plugins/ModelViewer3D.svelte'
]);

/** Source paths of every bundled plugin component in this build. */
export function bundledPluginComponentPaths(): string[] {
	return Object.keys(frontendAddonModules);
}
