<script lang="ts">
 import { projects, todos } from '$lib/business/store';
 import { projectTasks } from '$lib/business/projectHierarchy';
 import type { Project } from '$lib/business/types';
 let { project, onSelectProject = () => {} }: { project: Project; onSelectProject?: (project: Project) => void } = $props();
 let tasks = $derived(projectTasks($projects, $todos, project.id));
 let completed = $derived(tasks.filter(task => task.status === 'done').length);
 let children = $derived($projects.filter(child => child.parentId === project.id));
 let upcoming = $derived(tasks.filter(task => task.status !== 'done' && task.dueDate).sort((a,b) => a.dueDate! - b.dueDate!));
 let working = $derived(tasks.filter(task => task.status === 'in_progress'));
 const date = (value: number) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
</script>
<section class="overview" aria-label="Project overview">
 <div class="summary">
  <div><span class="eyebrow">THE BIG PICTURE</span><h2>{tasks.length ? `${completed} of ${tasks.length} tasks complete` : 'No tasks yet'}</h2><p>Includes this project and all its sub-projects. Archived and scrapped tasks are excluded.</p></div>
  <div class="target"><span>Target date</span><strong>{project.targetEndDate ? date(project.targetEndDate) : 'Not set yet'}</strong></div>
 </div>
 {#if tasks.length}<progress max={tasks.length} value={completed} aria-label="Completed project tasks"></progress>{/if}
 {#if tasks.length}<div class="sections">
  <section class="panel"><span class="eyebrow">COMING UP</span><h3>Next deadlines</h3>
   {#each upcoming.slice(0,5) as task (task.id)}<div class="task"><span>{task.title}</span><time datetime={new Date(task.dueDate!).toISOString()}>{date(task.dueDate!)}</time></div>{:else}<p class="quiet">No upcoming task deadlines. Add due dates on your Board when the timing matters.</p>{/each}
  </section>
  <section class="panel"><span class="eyebrow">IN MOTION</span><h3>Work in progress</h3>
   {#each working.slice(0,5) as task (task.id)}<div class="task"><span>{task.title}</span><small>{task.assignedTo || 'Unassigned'}</small></div>{:else}<p class="quiet">Nothing in progress yet. Your Board is where tasks move from ideas to finished work.</p>{/each}
  </section>
 </div>
 {/if}
 <section class="children"><span class="eyebrow">BREAK IT DOWN</span><h3>Sub-projects <span class="count">{children.length}</span></h3>
  {#if children.length}<div class="child-grid">{#each children as child (child.id)}{@const childTasks = projectTasks($projects,$todos,child.id)}<button onclick={() => onSelectProject(child)}><span class="dot" style:background={child.color}></span><strong>{child.name}</strong><p>{child.description || 'Open this part of the plan'}</p><small>{childTasks.filter(task=>task.status==='done').length} / {childTasks.length} tasks · {child.status}</small></button>{/each}</div>
  {:else}<p class="quiet">Organize a larger goal into smaller projects: a convention, a poster collection, or one finished piece.</p>{/if}
 </section>

</section>
<style>
 .overview{padding:28px;display:grid;gap:24px;max-width:1120px;margin:0 auto;width:100%;box-sizing:border-box;color:var(--text-primary)}
 .summary{display:flex;gap:24px;justify-content:space-between;align-items:start}.eyebrow{font-size:11px;letter-spacing:.1em;color:var(--text-muted);font-weight:700}h2{font-size:26px;margin:10px 0}h3{font-size:18px;margin:10px 0 18px}p{line-height:1.6;color:var(--text-secondary);margin:0}.target{display:grid;gap:10px;min-width:150px;padding:16px;border-left:2px solid var(--accent-primary)}.target span,.target strong{font-size:13px}
 progress{appearance:none;width:100%;height:6px;border:0;border-radius:var(--radius-full);overflow:hidden;background:var(--surface-raised);accent-color:var(--accent-primary)}progress::-webkit-progress-bar{background:var(--surface-raised)}progress::-webkit-progress-value{background:var(--accent-primary)}progress::-moz-progress-bar{background:var(--accent-primary)}.sections{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel{padding:24px;background:var(--surface-base);border:1px solid var(--border-subtle);border-radius:var(--radius-xl)}.task{padding:12px 0;display:flex;gap:16px;justify-content:space-between;border-top:1px solid var(--border-subtle);font-size:14px}.task span{overflow-wrap:anywhere}.task time,.task small{color:var(--text-muted);font-size:12px;flex-shrink:0}.quiet{font-size:14px}.count{color:var(--text-muted);font-size:13px}.child-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.child-grid button{padding:20px;text-align:left;background:var(--surface-base);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);color:var(--text-primary);cursor:pointer}.child-grid button:hover{border-color:var(--accent-primary)}.child-grid strong{overflow-wrap:anywhere}.child-grid p{margin:12px 0;font-size:13px}.child-grid small{color:var(--text-muted)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px}
 @media(max-width:720px){.overview{padding:20px}.sections{grid-template-columns:1fr}.summary{flex-direction:column}.target{padding:0 12px}h2{font-size:22px}}
</style>
