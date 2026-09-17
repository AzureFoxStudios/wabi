export const available = false;
export async function onInit(): Promise<never> { throw new Error('This optional addon is not included in this build. Use the corresponding expanded Wabi build; no runtime package installer is claimed.'); }
export async function onDisable() {}
export const onUnload = onDisable;
export async function loadWorkspace(): Promise<never> { return onInit(); }
