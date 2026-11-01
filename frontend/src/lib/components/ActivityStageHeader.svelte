<!--
	Activity's row A (design contract §8.11): "Activity" and the filter segment All | Mentions |
	Follows, each with its count of what is new. Rendered inside StageBar's row A through
	setStageHeader `component`; the actions (Notification settings) are StageBar actions. On a phone
	the segment steps out of the 52px bar into the page (NotificationsCenter draws it there).
-->
<script module lang="ts">
	export type ActivityFilter = 'all' | 'mentions' | 'follows';
</script>

<script lang="ts">
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import { isMobile } from '$lib/layoutStoreStates';

	interface Props {
		value: ActivityFilter;
		counts: Record<ActivityFilter, number>;
		onchange: (value: ActivityFilter) => void;
	}
	let { value, counts, onchange }: Props = $props();
	const label = (name: string, count: number) => (count ? `${name} ${count}` : name);
</script>

<h2 class="stage-a__title"><span class="stage-a__name">Activity</span></h2>
{#if !$isMobile}
	<Segmented
		label="Show"
		class="activity-seg"
		{value}
		options={[
			{ value: 'all', label: label('All', counts.all) },
			{ value: 'mentions', label: label('Mentions', counts.mentions) },
			{ value: 'follows', label: label('Follows', counts.follows) }
		]}
		onchange={(next) => onchange(next as ActivityFilter)}
	/>
{/if}
