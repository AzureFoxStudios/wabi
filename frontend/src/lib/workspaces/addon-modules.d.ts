declare module '@wabi/workspace-sheets' {
    export const available: boolean;
    export function onInit(): void | Promise<void>;
    export function onDisable(): Promise<void>;
    export function onUnload(): Promise<void>;
    export function loadWorkspace(): Promise<{default: import('svelte').Component}>;
}
declare module '@wabi/workspace-present' {
    export const available: boolean;
    export function onInit(): void | Promise<void>;
    export function onDisable(): Promise<void>;
    export function onUnload(): Promise<void>;
    export function loadWorkspace(): Promise<{default: import('svelte').Component}>;
}
