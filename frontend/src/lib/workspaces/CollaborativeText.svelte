<script lang="ts">
    import { onMount } from 'svelte';
    import { EditorState, Compartment } from '@codemirror/state';
    import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from '@codemirror/view';
    import { defaultKeymap } from '@codemirror/commands';
    import { markdown } from '@codemirror/lang-markdown';
    import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
    import type { ArtifactSession } from './session';
    import { textAnchor, textPosition } from './anchors';
    let {session,onselection,focusAnchor}:{session:ArtifactSession;onselection?:(anchor:string|null)=>void;focusAnchor?:string|null}=$props();
    const sessionState=session.state;
    let parent:HTMLDivElement;let view:EditorView|undefined;let mounted=$state(false);
    const permission=new Compartment();
    onMount(()=>{
        view=new EditorView({parent,state:EditorState.create({doc:session.body.toString(),extensions:[
            lineNumbers(),highlightActiveLineGutter(),EditorView.lineWrapping,markdown(),
            keymap.of([...yUndoManagerKeymap,...defaultKeymap]),
            yCollab(session.body,null,{undoManager:session.undo}),
            permission.of([EditorState.readOnly.of(!session.editable),EditorView.editable.of(session.editable)]),
            EditorView.contentAttributes.of({'aria-label':'Document content',spellcheck:session.record.format==='code'?'false':'true'}),
            EditorView.updateListener.of(update=>{if(update.selectionSet){const selection=update.state.selection.main;onselection?.(textAnchor(session.body,selection.from,selection.to));}}),
            EditorView.theme({'&':{height:'100%',color:'var(--text-primary,#eef0f8)',backgroundColor:'var(--surface-base,#161826)'},'.cm-content':{fontFamily:'var(--font-sans,system-ui)',fontSize:'16px',padding:'1rem'},'.cm-gutters':{backgroundColor:'var(--surface-raised,#24283d)',color:'var(--text-secondary,#b5bad0)',border:'none'},'.cm-cursor':{borderLeftColor:'currentColor'}})
        ]})});mounted=true;
        return()=>{mounted=false;view?.destroy();view=undefined;};
    });
    $effect(()=>{const allowed=($sessionState.meta,$sessionState.tick,session.editable);if(mounted)view?.dispatch({effects:permission.reconfigure([EditorState.readOnly.of(!allowed),EditorView.editable.of(allowed)])});});
    $effect(()=>{const anchor=focusAnchor;if(mounted&&anchor&&view){const position=textPosition(session.doc,anchor);if(position){view.dispatch({selection:{anchor:position.from,head:position.to},effects:EditorView.scrollIntoView(position.from,{y:'center'})});view.focus();}}});
</script>
<div class="workspace-editor" bind:this={parent}></div>
<style>.workspace-editor{height:100%;min-height:240px}</style>
