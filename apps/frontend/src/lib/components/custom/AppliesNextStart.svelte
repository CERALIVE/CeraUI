<!--
  AppliesNextStart.svelte — "applies on next start" field hint (Task 13).

  A calm, static glyph + label shown next to a restart-required field that the
  operator edits while a stream is LIVE. It communicates that the change is saved
  but cannot take effect until the next stream start — never a warning, never a
  blocker. The `show` gate is derived by the caller via `appliesOnNextStart`.

  Fully static (no animation) so the e-ink display freeze stills it cleanly.
-->
<script lang="ts">
import { RotateCw } from '@lucide/svelte';

import { cn } from '$lib/utils';

interface Props {
	show: boolean;
	label: string;
	class?: string;
	'data-testid'?: string;
}

const {
	show,
	label,
	class: className = undefined,
	'data-testid': testid = undefined,
}: Props = $props();
</script>

{#if show}
	<span
		class={cn(
			'text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium',
			className,
		)}
		data-testid={testid}
		role="status"
		aria-live="polite"
	>
		<RotateCw class="size-3.5 shrink-0" aria-hidden="true" />
		<span>{label}</span>
	</span>
{/if}
