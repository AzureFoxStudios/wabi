/** Build profiles exclude authoring chunks entirely from lean distributions. No remote executable imports. */
export const workspaceAddonLoaders:Record<string,()=>Promise<unknown>>={
 ...(import.meta.env.VITE_WABI_SHEETS==='1'?{sheets:()=>import('./sheets/entry')}:{}),
 ...(import.meta.env.VITE_WABI_PRESENT==='1'?{present:()=>import('./present/entry')}:{}),
};
export const workspaceAddonManifests={
 ...(import.meta.env.VITE_WABI_SHEETS==='1'?{sheets:{id:'sheets',name:'Sheets',version:'0.1.0',frontendEntry:'bundled:sheets',dependencies:[]}}:{}),
 ...(import.meta.env.VITE_WABI_PRESENT==='1'?{present:{id:'present',name:'Present',version:'0.1.0',frontendEntry:'bundled:present',dependencies:[]}}:{}),
};
