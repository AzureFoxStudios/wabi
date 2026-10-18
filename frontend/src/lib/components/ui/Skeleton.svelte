<!--
	Skeleton rows (design contract §7.16), kit `.w-skel` / `.w-skel-row` / `.w-skel-stack`.
	Static 10px bars of 8% text (18% in High Contrast) and avatar discs, laid out like the rows
	they stand in for, so nothing jumps when the real content arrives. Never a spinner, never an
	empty message while loading. Pair with LoadLine under the masthead.

	  variant="message"  chat stream: time gutter 52 · disc 36 · name + body lines on the text column
	  variant="member"   People rows: 46px, disc 28, name + subline
	  variant="row"      list rows (sidebar, palette, menus): 32px, 20px glyph slot + label
	  variant="card"     library cards: 72px lift cards in a minmax(240px, 1fr) grid
	  variant="text"     prose paragraphs on the reading measure

	The region is a polite status with a hidden label ("Loading messages"); the bars are hidden
	from assistive tech.

	  <Skeleton variant="message" rows={2} label="Loading older messages" />
-->
<script lang="ts">
	type Variant = 'message' | 'member' | 'row' | 'card' | 'text';

	interface Props {
		variant?: Variant;
		/** Rows (paragraphs for `text`, cards for `card`). */
		rows?: number;
		/** Announced once while loading. */
		label?: string;
		id?: string;
		class?: string;
	}

	let { variant = 'row', rows = 3, label = 'Loading', id, class: className = '' }: Props = $props();

	// Fixed, uneven widths (percent) so the placeholder reads as text without random jitter.
	const NAME = [22, 30, 18, 26, 34];
	const LINE = [86, 64, 92, 48, 74, 58, 80];
	const SUB = [44, 30, 52, 36, 26];
	const LABEL = [62, 48, 74, 40, 56, 68];
	const PARAGRAPH = [100, 97, 99, 94, 100, 62];

	const pick = (list: number[], index: number) => list[index % list.length];
	const count = $derived(Math.max(1, Math.floor(rows)));
	const indexes = $derived(Array.from({ length: count }, (_, index) => index));
</script>

<div {id} class={['w-skeleton', `w-skeleton--${variant}`, className]} role="status">
	<span class="sr-only">{label}</span>
	{#each indexes as index (index)}
		{#if variant === 'message'}
			<div class="w-skel-row" aria-hidden="true">
				<span class="w-skel w-skel--disc"></span>
				<span class="w-skel-stack">
					<span class="w-skel" style:width="{pick(NAME, index)}%"></span>
					<span class="w-skel" style:width="{pick(LINE, index)}%"></span>
					{#if index % 3 !== 1}<span class="w-skel" style:width="{pick(LINE, index + 3)}%"></span>{/if}
				</span>
			</div>
		{:else if variant === 'member'}
			<div class="w-skel-row" aria-hidden="true">
				<span class="w-skel w-skel--disc"></span>
				<span class="w-skel-stack">
					<span class="w-skel" style:width="{pick(LABEL, index)}%"></span>
					<span class="w-skel" style:width="{pick(SUB, index)}%"></span>
				</span>
			</div>
		{:else if variant === 'card'}
			<div class="w-skeleton__card" aria-hidden="true">
				<span class="w-skel" style:width="{pick(LABEL, index)}%"></span>
				<span class="w-skel" style:width="{pick(SUB, index + 1) - 10}%"></span>
			</div>
		{:else if variant === 'text'}
			<div class="w-skeleton__para" aria-hidden="true">
				{#each PARAGRAPH as width, line (line)}
					<span class="w-skel" style:width="{line === PARAGRAPH.length - 1 ? pick(LINE, index) - 20 : width}%"></span>
				{/each}
			</div>
		{:else}
			<div class="w-skel-row" aria-hidden="true">
				<span class="w-skel w-skeleton__glyph"></span>
				<span class="w-skel" style:width="{pick(LABEL, index)}%"></span>
			</div>
		{/if}
	{/each}
</div>

<style>
	.w-skeleton {
		box-sizing: border-box;
		min-width: 0;
	}

	/* Chat stream: same columns as the message row (§7.18), group-start spacing, one bar per
	   text line (name line 20, body lines 24 at the current text size). */
	.w-skeleton--message .w-skel-row {
		grid-template-columns: 36px minmax(0, var(--w-measure, 600px));
		align-items: start;
		margin: 18px 0 0 66px;
		padding: 0;
	}
	.w-skeleton--message .w-skel-stack {
		gap: calc(24px * var(--w-fs, 1) - 10px);
		padding-top: calc(5px * var(--w-fs, 1));
	}

	/* People: 46px rows, 28px stamps (§4.3, §7.11). */
	.w-skeleton--member .w-skel-row {
		min-height: 46px;
		column-gap: 10px;
		padding: 0;
	}
	.w-skeleton--member .w-skel--disc {
		width: 28px;
		height: 28px;
	}
	.w-skeleton--member .w-skel-stack {
		gap: 6px;
	}

	/* List rows: 32px, 20px glyph column, gap 10 (§4.3). */
	.w-skeleton--row .w-skel-row {
		grid-template-columns: 20px minmax(0, 1fr);
		column-gap: 10px;
		min-height: 32px;
		padding: 0;
	}
	.w-skeleton__glyph {
		width: 14px;
		height: 14px;
		justify-self: center;
		border-radius: var(--radius-sm);
	}

	/* Library cards (§8.8): 72px objects in flow on --w-lift. */
	.w-skeleton--card {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 12px;
	}
	.w-skeleton__card {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 10px;
		box-sizing: border-box;
		min-height: 72px;
		padding: 14px 16px;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-md);
		background: var(--w-lift);
		box-shadow: var(--w-shadow-1);
	}

	/* Prose: 30px reading lines on the 68ch measure, paragraphs one line apart (§4.1). */
	.w-skeleton--text {
		display: flex;
		flex-direction: column;
		gap: calc(30px * var(--w-fs, 1));
		max-width: 68ch;
	}
	.w-skeleton__para {
		display: flex;
		flex-direction: column;
		gap: calc(30px * var(--w-fs, 1) - 10px);
	}

	@media (max-width: 599px) {
		/* Phone stream: no time gutter, 32px stamps (§8.12). */
		.w-skeleton--message .w-skel-row {
			grid-template-columns: 32px minmax(0, 1fr);
			margin-left: 0;
			margin-top: 22px;
		}
		.w-skeleton--message .w-skel--disc {
			width: 32px;
			height: 32px;
		}
	}
</style>
