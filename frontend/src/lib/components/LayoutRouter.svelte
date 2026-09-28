<script lang="ts">
  import { homeLayout } from '$lib/layoutStoreStates';
  import MainLayout from './MainLayout.svelte';
</script>

<div class="layout-root" class:dm-pure={$homeLayout === 'dm-pure'} class:dm-focused={$homeLayout === 'dm-focused'} class:server-browser={$homeLayout === 'server-browser'}>
  <MainLayout {...$$props} on:logout />
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

  /* The mobile Browse sheet remains usable in every conversation layout. */
  @media (max-width: 768px) {
    .layout-root.dm-pure :global(.channel-sidebar-container.mobile-visible),
    .layout-root.dm-pure :global(.channel-sidebar-container.preview-visible) {
      display: block !important;
    }
  }
</style>
