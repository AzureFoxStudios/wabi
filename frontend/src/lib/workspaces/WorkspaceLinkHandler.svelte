<script lang="ts">
    import { onMount } from 'svelte';
    import { openWorkspace, type Tool } from './bridge';
    onMount(()=>{
        const url=new URL(window.location.href);
        const session=url.searchParams.get('workspaceSession');
        const artifact=url.searchParams.get('workspaceArtifact');
        const kind=url.searchParams.get('workspaceKind');
        if(session&&/^[0-9a-f-]{36}$/i.test(session))openWorkspace('audience',{sessionId:session});
        else if(artifact&&/^[0-9a-f-]{36}$/i.test(artifact)&&['document','sheets','present'].includes(kind||''))openWorkspace(kind==='document'?'documents':kind as Tool,{id:artifact});
    });
</script>
