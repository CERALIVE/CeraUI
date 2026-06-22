<script lang="ts">
import { formatBytes } from "@ceraui/i18n/formatters";
import { LL, locale } from "@ceraui/i18n/svelte";
import DatabaseBackupIcon from "@lucide/svelte/icons/database-backup";

import type { BufferingState } from "$lib/stores/buffering.svelte";
import { cn } from "$lib/utils";

let { state, class: className }: { state: BufferingState | null; class?: string } = $props();

const loc = $derived($locale);
const active = $derived(state?.active === true);
const spooled = $derived(
	state?.spooledBytes != null ? formatBytes(loc)(state.spooledBytes) : null,
);
const label = $derived(`${$LL.hud.buffering()} — ${$LL.hud.bufferingStoreForward()}`);
const ariaLabel = $derived(spooled ? `${label}, ${spooled}` : label);
</script>

{#if active && state}
	<span
		data-testid="buffering-indicator"
		role="status"
		aria-label={ariaLabel}
		title={$LL.hud.bufferingHint()}
		class={cn(
			"bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-medium",
			className,
		)}
	>
		<DatabaseBackupIcon class="size-3.5 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />
		<span class="font-semibold">{$LL.hud.buffering()}</span>
		<span class="hidden sm:inline">· {$LL.hud.bufferingStoreForward()}</span>
		{#if spooled}
			<span class="font-mono tabular-nums" data-testid="buffering-spooled">{spooled}</span>
		{/if}
	</span>
{/if}
