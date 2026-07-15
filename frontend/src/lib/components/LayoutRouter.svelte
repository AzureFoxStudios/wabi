<script lang="ts">
  import { homeLayout } from '$lib/layoutStoreStates';
  import MainLayout from './MainLayout.svelte';
</script>

<div class="layout-root" class:dm-pure={$homeLayout === 'dm-pure'} class:dm-focused={$homeLayout === 'dm-focused'} class:server-browser={$homeLayout === 'server-browser'}>
  <MainLayout {...$$props} />
</div>

<style>
  .layout-root {
    height: 100dvh;
    overflow: hidden;
  }


  /* dm-pure: hide server rail and channel sidebar, DMs take full space */
  .layout-root.dm-pure :global(.server-rail-container) {
    display: none !important;
  }
  .layout-root.dm-pure :global(.channel-sidebar-container) {
    display: none !important;
  }

  /* dm-focused: hide server rail, channel sidebar still accessible */
  .layout-root.dm-focused :global(.server-rail-container) {
    display: none !important;
  }
</style>
