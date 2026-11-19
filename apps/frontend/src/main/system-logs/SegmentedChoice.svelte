<!--
  SegmentedChoice.svelte: a single-choice group drawn as equal segments (Raw
  logs Level and Order); no segment is narrower than its longest word, so a long
  translation widens its own segment instead of running under the next, and under
  touch none is narrower than the 44 px target. One tab stop on the checked segment; arrow keys move
  the choice and wrap, Home and End jump, horizontal arrows follow the reading
  direction. The checked segment is a raised tonal surface, lighter than its
  track in both themes, never the primary colour.
-->
<script generics="T extends string" lang="ts">
import { cn } from '$lib/utils';

let {
	label,
	options,
	value,
	onSelect,
	testid,
	class: className,
}: {
	label: string;
	options: readonly { readonly value: T; readonly label: string }[];
	value: T;
	onSelect: (value: T) => void;
	testid: string;
	class?: string;
} = $props();

function choose(next: T): void {
	if (next !== value) onSelect(next);
}

function step(key: string, rtl: boolean): number {
	if (key === 'ArrowDown' || key === (rtl ? 'ArrowLeft' : 'ArrowRight')) return 1;
	if (key === 'ArrowUp' || key === (rtl ? 'ArrowRight' : 'ArrowLeft')) return -1;
	return 0;
}

function onkeydown(event: KeyboardEvent & { currentTarget: HTMLDivElement }): void {
	const count = options.length;
	const current = options.findIndex((option) => option.value === value);
	const rtl = event.currentTarget.closest('[dir]')?.getAttribute('dir') === 'rtl';
	const delta = step(event.key, rtl);
	const next =
		event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : delta === 0 ? -1 : (current + delta + count) % count;
	const option = options[next];
	if (option === undefined) return;
	event.preventDefault();
	choose(option.value);
	event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}
</script>

<div
	aria-label={label}
	class={cn('bg-muted grid auto-cols-[minmax(min-content,1fr)] grid-flow-col gap-0.5 rounded-lg p-0.5', className)}
	data-testid={testid}
	{onkeydown}
	role="radiogroup"
	tabindex="-1"
>
	{#each options as option (option.value)}
		<!-- biome-ignore lint/a11y/useSemanticElements: a segment is a pressable surface with roving focus; native radios would need a label wrapper per segment and lose the equal-width grid. -->
		<button
			aria-checked={option.value === value}
			class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 aria-checked:bg-background dark:aria-checked:bg-accent aria-checked:text-foreground min-h-[max(2rem,var(--touch-target-min))] min-w-(--touch-target-min) rounded-md px-2 py-1 text-xs leading-tight font-medium whitespace-normal outline-none transition-colors focus-visible:ring-3 aria-checked:shadow-sm"
			data-value={option.value}
			onclick={() => choose(option.value)}
			role="radio"
			tabindex={option.value === value ? 0 : -1}
			type="button"
		>
			{option.label}
		</button>
	{/each}
</div>
