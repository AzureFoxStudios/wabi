<script lang="ts">
    import { onMount } from 'svelte';
    import { EditorState, Compartment } from '@codemirror/state';
    import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from '@codemirror/view';
    import { defaultKeymap } from '@codemirror/commands';
    import { markdown } from '@codemirror/lang-markdown';
    import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
    import type { ArtifactSession } from './session';
    let {session}:{session:ArtifactSession}=$props();
    const sessionState=session.state;
    let parent:HTMLDivElement;
    let view:EditorView|undefined;
    const permission=new Compartment();
    onMount(()=>{
        view=new EditorView({parent,state:EditorState.create({doc:session.body.toString(),extensions:[
            lineNumbers(),highlightActiveLineGutter(),EditorView.lineWrapping,markdown(),
            keymap.of([...yUndoManagerKeymap,...defaultKeymap]),
            yCollab(session.body,null,{undoManager:session.undo}),
            permission.of([EditorState.readOnly.of(!session.editable),EditorView.editable.of(session.editable)]),
            EditorView.contentAttributes.of({'aria-label':'Document content',spellcheck:session.record.format==='code'?'false':'true'}),
            EditorView.theme({'&':{height:'100%',color:'var(--text-primary,#eef0f8)',backgroundColor:'var(--surface-base,#161826)'},'.cm-content':{fontFamily:'var(--font-sans,system-ui)',fontSize:'16px',padding:'1rem'},'.cm-gutters':{backgroundColor:'var(--surface-raised,#24283d)',color:'var(--text-secondary,#b5bad0)',border:'none'},'.cm-cursor':{borderLeftColor:'currentColor'},'.cm-scroller':{overflow:'auto'}})
        ]})});
        return()=>{view?.destroy();view=undefined;};
    });
    $effect(()=>{const allowed=($sessionState.tick,session.editable);view?.dispatch({effects:permission.reconfigure([EditorState.readOnly.of(!allowed),EditorView.editable.of(allowed)])});});
</script>
<div class="workspace-editor" bind:this={parent}></div>
<style>.workspace-editor{height:100%;min-height:240px}</style>
