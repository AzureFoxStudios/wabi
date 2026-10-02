import type { FeatureCollection, Feature, Polygon } from 'geojson';
export interface MapWaypoint { id: string; name: string; latitude: number; longitude: number; height: number }
export function normalizeWaypoints(value: unknown): MapWaypoint[] {
 if (!Array.isArray(value)) return [];
 return value.slice(0, 100).flatMap(pin => {
  if (!pin || typeof pin.id !== 'string' || typeof pin.name !== 'string' || !Number.isFinite(pin.latitude) || Math.abs(pin.latitude) > 85 || !Number.isFinite(pin.longitude) || Math.abs(pin.longitude) > 180 || !Number.isFinite(pin.height) || pin.height < 0 || pin.height > 500) return [];
  return [{ id: pin.id.slice(0,80), name: pin.name.slice(0,80), latitude: pin.latitude, longitude: pin.longitude, height: pin.height }];
 });
}
/** Real geographic volumes, with height in metres above the flat map surface. */
export function waypointVolumes(pins: MapWaypoint[]): FeatureCollection<Polygon> {
 const features: Feature<Polygon>[] = [];
 for (const pin of pins) {
  for (const head of [false,true]) {
   const radius = head ? 3 : 0.4;
   const dy = radius / 111320;
   const dx = dy / Math.cos(pin.latitude * Math.PI / 180);
   features.push({ type: 'Feature', properties: { name: pin.name, base: head ? pin.height : 0, top: head ? pin.height + 4 : pin.height, head }, geometry: { type: 'Polygon', coordinates: [[[pin.longitude-dx,pin.latitude-dy],[pin.longitude+dx,pin.latitude-dy],[pin.longitude+dx,pin.latitude+dy],[pin.longitude-dx,pin.latitude+dy],[pin.longitude-dx,pin.latitude-dy]]] } });
  }
 }
 return { type: 'FeatureCollection', features };
}
