<script lang="ts">
  import { goto } from '$app/navigation';
  import { T } from '$lib/state.svelte.ts';
  import ItemForm from '$components/ItemForm.svelte';
</script>

<div class="page narrow">
  <header class="page-head"><h1>{T('New product or service', 'สินค้าหรือบริการใหม่')}</h1></header>
  <ItemForm onsaved={(id) => goto(`/items/${id}`, { replaceState: true })} oncancel={() => history.back()} />
</div>
