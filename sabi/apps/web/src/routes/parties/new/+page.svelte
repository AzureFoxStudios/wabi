<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { T } from '$lib/state.svelte.ts';
  import PartyForm from '$components/PartyForm.svelte';

  const role = page.url.searchParams.get('role') ?? 'customer';
  const back = page.url.searchParams.get('back');
</script>

<div class="page narrow">
  <header class="page-head"><h1>{role === 'supplier' ? T('New supplier', 'ผู้ขายใหม่') : T('New customer', 'ลูกค้าใหม่')}</h1></header>
  <PartyForm defaultRole={role} onsaved={(id) => goto(back ? `${back}${back.includes('?') ? '&' : '?'}partyId=${id}` : `/parties/${id}`, { replaceState: true })} oncancel={() => history.back()} />
</div>
