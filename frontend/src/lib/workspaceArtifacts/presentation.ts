/** Audience-only wire types. No dependency on either authoring addon. */
export interface Page {id:string;title:string;body:string;layout:'title'|'body'|'image'|'split';image:string|null;theme?:'paper'|'night'|'sage';aspect?:number}
export interface Presentation {v:1;id:string;channelId:string;ownerId:number;controllerId:number;generation:number;sequence:number;title:string;pages:Page[];slideId:string;blank:boolean;ended:boolean;updatedAt:number}
export interface PresentationView {presentation?:Presentation;unchanged?:boolean;controllerOnline:boolean;pointer?:{x:number;y:number}|null}
export function safeImage(value:unknown):value is string{return typeof value==='string'&&value.length<=4*1024*1024&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value);}
