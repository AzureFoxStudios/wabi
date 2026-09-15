import type { PointerFieldKind } from './pointerFields';
export const CONNECTED_POINTER_EFFECTS = [
    { id: 'lattice', name: 'Lattice', kind: 'field', description: 'Connected, irregular geometric mesh; vertices and edges catch the light.' },
    { id: 'climb-route', name: 'Climb Route', kind: 'field', description: 'Winding room paths that split and rejoin. Reshuffle changes the whole map.' },
    { id: 'water', name: 'Water Ripples', kind: 'shader', description: 'Motion leaves expanding rings and a soft wake; waves fade in place.' },
    { id: 'sand', name: 'Sand', kind: 'shader', description: 'Brush temporary grooves and raised edges into a grainy surface.' },
    { id: 'arcane-circle', name: 'Arcane Circle', kind: 'field', description: 'A large inscribed seal with nested rings, rune bands, spokes and chords.' },
    { id: 'rune-wall', name: 'Rune Wall', kind: 'field', description: 'Dense columns of invented script, arranged as an illuminated inscription.' },
    { id: 'maze', name: 'Maze', kind: 'field', description: 'A connected, solvable maze. Thin corridor guides glow along your wake.' }
] as const;
export type ConnectedPointerPattern = typeof CONNECTED_POINTER_EFFECTS[number]['id'];
export function isConnectedPointerPattern(value: unknown): value is ConnectedPointerPattern {
    return CONNECTED_POINTER_EFFECTS.some(effect => effect.id === value);
}
export interface PointerWorldOptions {
    pattern: ConnectedPointerPattern;
    radius: number;
    textureOpacity: number;
    patternScale: number;
    trailMs: number;
    trailStrength: number;
    seed: number;
    idleDelayMs?: number;
    fadeMs?: number;
    response?: number;
    fieldDensity?: number;
    materialDetail?: number;
    settleSpeed?: number;
    mazeCurve?: number;
}
export type ResolvedPointerWorldOptions = Required<PointerWorldOptions>;
const bounded = (value: number | undefined, fallback: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, typeof value === 'number' && Number.isFinite(value) ? value : fallback));
export function resolvePointerWorldOptions(options: PointerWorldOptions): ResolvedPointerWorldOptions {
    return { ...options,
        radius: bounded(options.radius, 190, 1, 440),
        textureOpacity: bounded(options.textureOpacity, .16, 0, 1),
        patternScale: bounded(options.patternScale, 1, .5, 2),
        trailMs: bounded(options.trailMs, 280, 0, 1200),
        trailStrength: bounded(options.trailStrength, .5, 0, 1),
        seed: bounded(options.seed, 601, 0, 0xffffffff) >>> 0,
        idleDelayMs: bounded(options.idleDelayMs, 90, 0, 300),
        fadeMs: bounded(options.fadeMs, 520, 0, 1200),
        response: bounded(options.response, .65, 0, 1),
        fieldDensity: bounded(options.fieldDensity, 1, .6, 1.5),
        materialDetail: bounded(options.materialDetail, 1, .5, 2),
        settleSpeed: bounded(options.settleSpeed, 1, .25, 4),
        mazeCurve: bounded(options.mazeCurve, .7, 0, 1)
    };
}
type PointerTimingOptions = Pick<PointerWorldOptions, 'pattern' | 'trailMs' | 'settleSpeed' | 'idleDelayMs' | 'fadeMs'>;
/** Motion history can settle independently from the idle/fade controls for the live reveal. */
export function pointerHistoryLifetime(options: PointerTimingOptions): number {
    const multiplier = options.pattern === 'water' ? 1.6 : options.pattern === 'sand' ? 2 : 1;
    return Math.min(1200, bounded(options.trailMs, 280, 0, 1200) * multiplier / bounded(options.settleSpeed, 1, .25, 4));
}
export function pointerHeadOpacity(ageMs: number, options: Pick<PointerWorldOptions, 'idleDelayMs' | 'fadeMs'>): number {
    const idle = bounded(options.idleDelayMs, 90, 0, 300), fade = bounded(options.fadeMs, 520, 0, 1200);
    const elapsed = Math.max(0, ageMs) - idle;
    return elapsed < 0 ? 1 : fade === 0 ? 0 : Math.max(0, 1 - elapsed / fade);
}
export function pointerTrailLifetime(options: PointerTimingOptions): number {
    // This is a retention/scheduling budget, not the opacity curve for old samples.
    return Math.max(1, pointerHistoryLifetime(options),
        bounded(options.idleDelayMs, 90, 0, 300) + bounded(options.fadeMs, 520, 0, 1200));
}
export function isPointerFieldPattern(pattern: ConnectedPointerPattern): pattern is PointerFieldKind {
    return pattern !== 'sand' && pattern !== 'water';
}
/** Analytic water/sand wakes. These are visual approximations, not a fluid solver. */
export const POINTER_MATERIAL_VERTEX = `attribute vec2 a_position;
void main(){ gl_Position=vec4(a_position,0.0,1.0); }`;
const MATERIAL_HEADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_resolution;
uniform vec2 u_origin;
uniform float u_scale;
uniform float u_lifetime;
uniform float u_radius;
uniform float u_response;
uniform float u_detail;
uniform float u_seed;
uniform float u_strength;
uniform float u_trail_strength;
uniform float u_head_alpha;
uniform vec3 u_accent;
uniform float u_time;
uniform int u_trail_count;
uniform vec4 u_trail[12];
float hash21(vec2 p){p=fract(p*vec2(.1031,.11369));p+=dot(p,p.yx+19.19+mod(u_seed,17.));return fract((p.x+p.y)*p.x);}
float ageFade(float age){float f=clamp(1.-age/u_lifetime,0.,1.);return f*f;}
float segmentDistance(vec2 p,vec2 a,vec2 b,out float t){vec2 v=b-a;t=clamp(dot(p-a,v)/max(dot(v,v),.001),0.,1.);return length(p-a-t*v);}
vec2 worldPosition(){return u_origin+vec2(gl_FragCoord.x,u_resolution.y-gl_FragCoord.y)/u_scale;}
void outputColor(vec3 rgb,float alpha){alpha=clamp(alpha*u_strength,0.,u_strength);gl_FragColor=vec4(rgb*alpha,alpha);}
`;
export const WATER_POINTER_SHADER = MATERIAL_HEADER + `
void main(){
 vec2 p=worldPosition();float crest=0.,trough=0.,reveal=0.,wake=0.;vec2 slope=vec2(0.);
 for(int i=0;i<12;i++){
  if(i>=u_trail_count)break;
  vec4 s=u_trail[i];vec2 delta=p-s.xy;float d=length(delta),fade=i==u_trail_count-1?u_head_alpha:ageFade(s.z)*u_trail_strength;
  float speed=s.w<0.?-s.w-1.:s.w;
  float front=8.+s.z*110.;float wave=sin((d-front)*(.17*u_detail));
  float band=exp(-pow((d-front)/24.,2.))*fade*(1.-smoothstep(u_radius*.75,u_radius,d));
  crest+=max(0.,wave)*band*(.36+speed*.32);
  trough+=max(0.,-wave)*band*.25;
  slope+=normalize(delta+vec2(.0001))*wave*band;
  reveal=max(reveal,(1.-smoothstep(0.,u_radius,d))*fade);
 }
 for(int i=1;i<12;i++){
  if(i>=u_trail_count)break;
  if(u_trail[i].w<0.)continue;
  float t;float d=segmentDistance(p,u_trail[i-1].xy,u_trail[i].xy,t);
  float f=ageFade(mix(u_trail[i-1].z,u_trail[i].z,t))*u_trail_strength;
  wake=max(wake,exp(-d*d/150.)*f);
 }
 vec2 q=p+slope*8.*u_response;
 float shimmer=pow(.5+.5*sin(q.x*.04+sin(q.y*.025+u_time*.8)),10.);
 float alpha=crest*.65*u_response+shimmer*reveal*.18+wake*.15*u_response;
 vec3 hue=mix(u_accent,vec3(.72,.92,1.),.72);
 hue*=1.-min(.35,trough)*u_response;
 outputColor(hue,alpha);
}`;
export const SAND_POINTER_SHADER = MATERIAL_HEADER + `
void main(){
 vec2 p=worldPosition();float groove=0.,rim=0.,reveal=0.;vec2 displaced=vec2(0.);
 for(int i=0;i<12;i++){
  if(i>=u_trail_count)break;
  vec4 s=u_trail[i];float d=length(p-s.xy),f=i==u_trail_count-1?u_head_alpha:ageFade(s.z)*u_trail_strength;
  reveal=max(reveal,(1.-smoothstep(0.,u_radius,d))*f);
  groove=max(groove,exp(-d*d/90.)*f);
 }
 for(int i=1;i<12;i++){
  if(i>=u_trail_count)break;
  if(u_trail[i].w<0.)continue;
  vec2 a=u_trail[i-1].xy,b=u_trail[i].xy;
  float t;float d=segmentDistance(p,a,b,t),age=mix(u_trail[i-1].z,u_trail[i].z,t),f=ageFade(age)*u_trail_strength;
  float width=7.+u_response*7.;
  groove=max(groove,exp(-d*d/(width*width))*f);
  rim=max(rim,exp(-pow((d-width*1.5)/3.,2.))*f);
  vec2 direction=normalize(b-a+vec2(.0001));vec2 normal=vec2(-direction.y,direction.x);
  displaced+=normal*sign(dot(p-mix(a,b,t),normal))*exp(-d*d/(width*width*4.))*f*5.;
 }
 vec2 q=p-displaced*u_response;
 float grain=hash21(floor(q*(.65+u_detail*.75)));
 float dunes=.5+.5*sin(q.y*.10+sin(q.x*.019)*2.6);
 float rake=pow(dunes,7.);
 float clean=1.-groove*.88*u_response;
 float alpha=reveal*(grain*.25+rake*.24)*clean+rim*(.3+u_response*.55)*u_response+groove*.035*u_response;
 vec3 hue=mix(u_accent,vec3(1.,.83,.54),.83);
 outputColor(hue,alpha);
}`;
