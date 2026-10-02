<script lang="ts">
	import { onMount } from 'svelte';
	import { isShowcaseMode } from '$lib/showcase/mode';
	import { scenes, sceneFrom, type Scene } from '$lib/showcase/fixtures';

	let Workspace: any = null;
	let error = '';
	let open = false;
	let hidden = false;
	let ready = false;
	const scene = typeof location === 'undefined' ? 'morning' : sceneFrom(new URL(location.href).searchParams.get('scene'));

	onMount(async () => {
		if (!isShowcaseMode()) return;
		try {
			await (await import('$lib/showcase/controller')).prepareScene(scene);
			Workspace = (await import('$lib/components/LayoutRouter.svelte')).default;
			ready = true;
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		}
	});

	async function changeScene(event: MouseEvent, next: Scene) {
		if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		// Finish local saves before reloading; the fixture reset follows on boot.
		await (await import('$lib/business/deviceStorage')).flushBusinessStorage();
		const { captureNotebookOwner } = await import('$lib/notes/scope');
		const { LocalNotebook } = await import('$lib/notes/db');
		const { retainedNoteEditors } = await import('$lib/notes/editor');
		const book = new LocalNotebook(await captureNotebookOwner());
		await Promise.all(retainedNoteEditors(book).map(editor => editor.save()));
		location.assign(`/showcase?scene=${next}`);
	}

	function keyboard(event: KeyboardEvent) {
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
			event.preventDefault(); hidden = !hidden;
		}
		if (event.key === 'Escape') open = false;
	}
</script>
<svelte:head><title>Wabi · Showcase</title></svelte:head>
<svelte:window onkeydown={keyboard}/>
{#if !isShowcaseMode()}<p class="notice">Showcase is available only through the dedicated local development command.</p>
{:else if error}<p class="notice" role="alert">{error}</p>
{:else if Workspace}<svelte:component this={Workspace}/>
{:else}<p class="notice" role="status">Preparing the demo community…</p>{/if}
{#if isShowcaseMode()}
 <div data-showcase-ready={ready} data-showcase-scene={scene} class="showcase" class:concealed={hidden}>
 {#if open}<div class="scene-menu" role="group" aria-label="Showcase scenes"><strong>Showcase</strong><p>Local fixtures · no live connection<br/>Voice participants are simulated.</p>
 {#each scenes as [id,label]}<a href={`/showcase?scene=${id}`} data-sveltekit-reload onclick={(event) => changeScene(event, id)} aria-current={scene===id?'page':undefined}>{label}</a>{/each}
 <button onclick={()=>{hidden=true;open=false;}}>Hide controls <kbd>Ctrl Shift S</kbd></button></div>{/if}
 <button class="trigger" aria-expanded={open} onclick={()=>open=!open}>Showcase <span aria-hidden="true">⌃</span></button></div>
{/if}
<style>
.notice{padding:3rem;color:var(--text-primary);font:inherit}.showcase{position:fixed;bottom:68px;left:12px;z-index:12000}.concealed{display:none}.trigger,.scene-menu button{font:inherit;color:var(--text-primary);background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;padding:8px 12px;cursor:pointer}.trigger{font-size:12px;box-shadow:0 3px 12px #0003}.trigger span{margin-left:14px}.scene-menu{width:258px;margin-bottom:8px;padding:12px;border:1px solid var(--border-color);border-radius:12px;background:var(--bg-secondary);box-shadow:0 8px 32px #0005}.scene-menu strong{font-size:14px}.scene-menu p{font-size:12px;line-height:1.6;color:var(--text-secondary);margin:6px 0 12px}.scene-menu a{display:block;color:var(--text-primary);text-decoration:none;padding:9px 10px;border-radius:6px;font-size:13px}.scene-menu a:hover,.scene-menu a[aria-current]{background:var(--bg-hover)}.scene-menu button{width:100%;margin-top:8px;font-size:12px}kbd{font:inherit;color:var(--text-secondary);margin-left:8px}
</style>
