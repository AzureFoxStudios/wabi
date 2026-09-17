import {writable} from 'svelte/store';
import type {Component} from 'svelte';
import type {Fields} from './model';
export type WorkspaceTool={id:'sheets'|'present';label:string;load:()=>Promise<{default:Component<any>}>;create:()=>Promise<Fields>};
export const workspaceTools=writable<Record<string,WorkspaceTool>>({});
const closers=new Map<string,Set<()=>Promise<void>>>();
export function registerTool(tool:WorkspaceTool):void{workspaceTools.update(t=>({...t,[tool.id]:tool}));}
export function registerCloser(id:string,close:()=>Promise<void>):()=>void{const set=closers.get(id)||new Set();set.add(close);closers.set(id,set);return ()=>{set.delete(close);if(!set.size)closers.delete(id);};}
export async function unregisterTool(id:string):Promise<void>{for(const close of [...(closers.get(id)||[])])await close();workspaceTools.update(t=>{const next={...t};delete next[id];return next;});}
