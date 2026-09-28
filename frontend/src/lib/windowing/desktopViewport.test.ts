import { expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

if (process.env.WABI_DESKTOP_VIEWPORT_FIXTURE !== '1') {
 test('desktop panel viewport regressions run in isolation', () => {
  const result = Bun.spawnSync([process.execPath, 'test', fileURLToPath(import.meta.url)], { env: { ...process.env, WABI_DESKTOP_VIEWPORT_FIXTURE: '1' }, stdout: 'pipe', stderr: 'pipe' });
  expect(new TextDecoder().decode(result.stderr)).not.toContain('(fail)');
  expect(result.exitCode).toBe(0);
 });
} else {
 mock.module('$app/environment', () => ({ browser: true }));
 const root = { dataset: { desktopShell: 'true' } };
 Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 1200, innerHeight: 800 } });
 Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
 Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => '44px' }) });
 const { floatingPanelStore, getViewportRect } = await import('./floatingPanelStore');
 test('maximized panels keep their restore and close controls below desktop chrome', () => {
  const id = floatingPanelStore.openFloatingPanel({ kind: 'workspace-panel', payload: { panelId: 'test' } });
  floatingPanelStore.snapFloatingPanel(id, 'maximize');
  expect(floatingPanelStore.getPanel(id)?.rect).toEqual({ x: 0, y: 44, width: 1200, height: 756 });
  floatingPanelStore.snapFloatingPanel(id, 'top-left');
  expect(floatingPanelStore.getPanel(id)?.rect).toEqual({ x: 0, y: 44, width: 600, height: 378 });
  floatingPanelStore.moveFloatingPanel(id, { x: 10, y: 0, width: 400, height: 300 });
  expect(floatingPanelStore.getPanel(id)?.rect.y).toBe(44);
  floatingPanelStore.closeFloatingPanel(id);
 });
 test('browser and mobile retain the whole viewport', () => {
  root.dataset.desktopShell = '';
  expect(getViewportRect()).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
 });
}
