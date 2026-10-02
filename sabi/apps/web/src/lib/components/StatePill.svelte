<script lang="ts">
  import { L } from '$lib/format.ts';
  let { label, tone = 'neutral', plain = false }: { label: any; tone?: string | null; plain?: boolean } = $props();
</script>

<span class="pill tone-{tone ?? 'neutral'}" class:plain>{typeof label === 'string' ? label : L(label)}</span>
