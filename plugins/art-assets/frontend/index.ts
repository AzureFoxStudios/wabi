export const artAssetsPlugin = {
  id: 'art-assets',
  commands: ['/asset', '/scene'],
  modes: ['open', 'presenter'],
  features: ['movable-overlays', 'layer-order', 'scene-presets'],
  notes: 'Phase 1 scaffold: backend state sync is ready; UI panel/editor wiring is next.'
};

export default artAssetsPlugin;
