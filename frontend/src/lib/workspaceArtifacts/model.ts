/** Wire v1. Metadata and permissions are Authority-owned, never editor fields. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Fields = Record<string, Json>;
export type ArtifactKind = 'document' | 'sheet' | 'deck';
export type Access = 'viewer' | 'commenter' | 'editor';
export type Review = {
  id: string; authorId: number; body: string; field: string | null;
  proposal: Json | null; baseFieldVersion: number; isSuggestion: boolean;
  status: 'open' | 'resolved' | 'accepted' | 'rejected'; at: number;
};
export interface Artifact {
  v: 1; id: string; kind: ArtifactKind; ownerId: number;
  channelId: string | null; channelAccess: Access; grants: Record<string, Access>;
  revision: number; generation: number; mode: 'snapshot' | 'live';
  fields: Fields; versions: Record<string, number>; reviews: Review[];
  updatedAt: number; deleted: boolean;
}
export type Change = { key: string; expected: number; value: Json | null; remove: boolean; textPatch?: {start:number;delete:number;insert:string} };
export type Conflict = { key: string; base: Json | undefined; mine: Json | undefined; theirs: Json | undefined };
export interface Draft {
  v: 1; key: string; scope: string; writer: string; id: string; kind: ArtifactKind;
  base: Artifact | null; fields: Fields; conflicts: Conflict[]; updatedAt: number;
  privateNotes: Record<string, string>; sourceId?: string; originalId?: string; lastAccess?: Access | 'owner'; resumeRequired?: boolean;
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
  const keys = Object.keys(aa);
  return keys.length === Object.keys(bb).length && keys.every(k => Object.hasOwn(bb, k) && equal(aa[k], bb[k]));
}
export function changes(base: Artifact, fields: Fields): Change[] {
  const result: Change[] = [];
  for (const key of new Set([...Object.keys(base.fields), ...Object.keys(fields)])) {
    if (!equal(base.fields[key], fields[key])) {
      if(base.kind==='document'&&key==='text'&&typeof base.fields[key]==='string'&&typeof fields[key]==='string'){
        const before=Array.from(base.fields[key] as string),after=Array.from(fields[key] as string);let start=0,end=before.length,to=after.length;
        while(start<Math.min(before.length,after.length)&&before[start]===after[start])start++;
        while(end>start&&to>start&&before[end-1]===after[to-1]){end--;to--;}
        result.push({key,expected:base.versions[key]||0,value:null,remove:false,textPatch:{start,delete:end-start,insert:after.slice(start,to).join('')}});
      }else result.push({key, expected: base.versions[key] || 0, value: fields[key] ?? null, remove: !Object.hasOwn(fields, key)});
    }
  }
  return result;
}
export function safeKey(key: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,191}$/.test(key) && !key.split(/[:./]/).some(k => ['__proto__', 'prototype', 'constructor'].includes(k));
}
export function newId(): string { return crypto.randomUUID(); }

/** Conservative three-way merge. Nonoverlapping single spans merge; ambiguous intent stays a conflict.
 * Unicode codepoints prevent splitting surrogate pairs. This is deliberately not labelled a CRDT.
 */
export function mergeText(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs || base === theirs) return mine;
  if (base === mine) return theirs;
  const b = Array.from(base), m = Array.from(mine), t = Array.from(theirs);
  const span = (x: string[]) => {
    let start = 0, end = b.length, xe = x.length;
    while (start < Math.min(b.length, x.length) && b[start] === x[start]) start++;
    while (end > start && xe > start && b[end - 1] === x[xe - 1]) { end--; xe--; }
    return {start, end, value: x.slice(start, xe)};
  };
  const a = span(m), c = span(t);
  // Simultaneous insertions at the same boundary have competing intent.
  if ((a.start === c.start) || !(a.end <= c.start || c.end <= a.start)) return null;
  let out = b.slice();
  for (const s of [a, c].sort((x, y) => y.start - x.start)) out = out.slice(0,s.start).concat(s.value,out.slice(s.end));
  return out.join('');
}
export function rebase(base: Fields, mine: Fields, theirs: Fields, kind: ArtifactKind): {fields: Fields; conflicts: Conflict[]} {
  const fields: Fields = Object.create(null), conflicts: Conflict[] = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const b = base[key], m = mine[key], t = theirs[key];
    let value = m;
    if (equal(m, b)) value = t;
    else if (equal(t, b) || equal(m, t)) value = m;
    else {
      const merged = kind === 'document' && key === 'text' && typeof b === 'string' && typeof m === 'string' && typeof t === 'string' ? mergeText(b, m, t) : null;
      if (merged !== null) value = merged;
      else conflicts.push({key, base: b, mine: m, theirs: t});
    }
    if (value !== undefined) fields[key] = structuredClone(value);
  }
  return {fields, conflicts};
}
export function accessFor(a: Artifact, userId: number, channelMember = false): Access | 'owner' | null {
  if (a.ownerId === userId) return 'owner';
  const direct = a.grants[String(userId)], inherited = channelMember ? a.channelAccess : undefined;
  const rank = {viewer: 1, commenter: 2, editor: 3};
  return direct && inherited ? (rank[direct] >= rank[inherited] ? direct : inherited) : direct || inherited || null;
}
export function titleOf(fields: Fields): string { return typeof fields.title === 'string' ? fields.title : 'Untitled'; }
