export interface SketchfabSource { id: string; embedUrl: string; pageUrl: string; }
/** Only recognize Sketchfab's own model URLs; never render supplied embed HTML. */
export function sketchfabSource(raw: string): SketchfabSource | null {
 try {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || !['sketchfab.com', 'www.sketchfab.com'].includes(url.hostname) || url.port) return null;
  const match = url.pathname.match(/^\/(?:3d-models\/[^/]*-([a-f0-9]{32})|models\/([a-f0-9]{32})(?:\/embed)?|3d-models\/([a-f0-9]{32}))\/?$/i);
  const id = match?.[1] || match?.[2] || match?.[3];
  return id ? { id, embedUrl: `https://sketchfab.com/models/${id}/embed`, pageUrl: `https://sketchfab.com/models/${id}` } : null;
 } catch { return null; }
}
export function modelLinkError(raw: string): string | null {
 try {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'Use an HTTP or HTTPS link without embedded credentials.';
  if (sketchfabSource(raw)) return null;
  if (url.hostname === 'skfb.ly') return 'Open this short link on Sketchfab, then copy the full model page URL from the address bar.';
  if (!/\.(glb|gltf|obj|stl)$/i.test(url.pathname)) return 'This looks like a webpage. Open a downloaded model file, or paste a direct .glb, .gltf, .obj, .stl file link or a full Sketchfab model page URL.';
  return null;
 } catch { return 'Enter a complete model file URL or Sketchfab model page URL.'; }
}
