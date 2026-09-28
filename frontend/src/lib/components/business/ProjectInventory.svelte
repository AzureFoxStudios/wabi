<script lang="ts">
 import { projects, todos } from '$lib/business/store';
 import { projectTasks } from '$lib/business/projectHierarchy';
 import type { Project } from '$lib/business/types';
 let { onSelect, onCreate, isReadOnly = false }: { onSelect:(project:Project)=>void; onCreate:()=>void; isReadOnly?:boolean } = $props();
 let search = $state('');
 let results = $derived($projects.filter(project => search.trim() ? `${project.name} ${project.description || ''}`.toLowerCase().includes(search.toLowerCase().trim()) : !project.parentId));
</script>
<section class="inventory">
 <header><span class="eyebrow">MY PLANNER · ON THIS DEVICE</span><h1>Your projects</h1><p>Plan a convention, a collection, or a larger goal. Keep the smaller pieces together.</p></header>
 <label>Find a project<input bind:value={search} placeholder="Search projects…" /></label>
 <div class="grid">{#each results as project (project.id)}{@const tasks = projectTasks($projects,$todos,project.id)}
 <button class="card" onclick={() => onSelect(project)}><span class="status"><i style:background={project.color}></i>{project.status}</span><h2>{project.name}</h2><p>{project.description || 'Your next plan starts here.'}</p><footer><span>{tasks.filter(task=>task.status==='done').length} / {tasks.length} tasks</span><span>{project.targetEndDate ? new Date(project.targetEndDate).toLocaleDateString() : 'No target date'}</span></footer></button>
 {:else}<div class="empty"><h2>{search ? 'No matching projects' : 'From a big idea to a finished piece.'}</h2><p>{search ? 'Try another name or description.' : 'Start with a convention, collection, or goal. Add sub-projects as the plan grows.'}</p>{#if !search && !isReadOnly}<button class="create" onclick={onCreate}>Create your first project</button>{/if}</div>{/each}</div>
</section>
<style>
 .inventory{max-width:1120px;margin:0 auto;width:100%;box-sizing:border-box;padding:36px;display:grid;gap:28px;color:var(--text-primary)}.eyebrow{color:var(--text-muted);font-size:11px;letter-spacing:.1em;font-weight:700}h1{font-size:30px;line-height:1.25;margin:14px 0}p{color:var(--text-secondary);line-height:1.6;margin:0}label{display:grid;gap:8px;color:var(--text-muted);font-size:12px;max-width:420px}input{padding:12px 16px;border:1px solid var(--border-subtle);border-radius:var(--radius-lg);background:var(--surface-base);color:var(--text-primary)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}.card{text-align:left;padding:24px;border:1px solid var(--border-subtle);border-radius:var(--radius-xl);background:var(--surface-base);color:var(--text-primary);cursor:pointer;min-width:0}.card:hover{border-color:var(--accent-primary)}h2{font-size:21px;margin:18px 0 12px;overflow-wrap:anywhere}.card p{font-size:14px}.status{font-size:12px;color:var(--text-muted);text-transform:capitalize}i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px}footer{display:flex;justify-content:space-between;gap:12px;margin-top:28px;font-size:12px;color:var(--text-muted)}.empty{grid-column:1/-1;padding:36px;border:1px dashed var(--border-subtle);border-radius:var(--radius-xl)}.empty h2{margin:0 0 12px;font-size:22px}.create{margin-top:24px;padding:12px 18px;background:var(--accent-primary);border:0;border-radius:var(--radius-md);color:var(--text-on-accent,#fff);cursor:pointer}@media(max-width:720px){.inventory{padding:20px}h1{font-size:25px}.grid{grid-template-columns:1fr}}
</style>
