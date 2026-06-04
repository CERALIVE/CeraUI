<script lang="ts" module>
import type { Cpu } from '@lucide/svelte';

import type { StreamSection } from '$lib/streaming/streamingLockPolicy';

export type ConfigRow = {
	icon: typeof Cpu;
	label: string;
	value: string;
	section: StreamSection;
	onEdit: () => void;
	// Stable hook for E2E: all 3 rows share the "Edit Settings" label (hidden on
	// mobile, Pencil icon aria-hidden), so the trigger needs a testid to target.
	testId: string;
	warn?: boolean;
};
</script>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ChevronRight, Lock, Pencil } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { isSectionLocked } from '$lib/streaming/streamingLockPolicy';

interface Props {
	configRows: ConfigRow[];
	isStreaming: boolean;
}

const { configRows, isStreaming }: Props = $props();
</script>

<!-- Configuration overview — one card, three trigger rows (no nested cards) -->
<Card.Root class="overflow-hidden">
	<Card.Header class="pb-3">
		<Card.Title class="text-sm font-semibold">{$LL.live.streamSettings()}</Card.Title>
	</Card.Header>
	<Card.Content class="divide-border divide-y py-0">
		{#each configRows as row (row.label)}
			{@const locked = isSectionLocked(row.section, isStreaming)}
			<div class="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
				<div class="flex min-w-0 items-start gap-3">
					<row.icon
						aria-hidden={true}
						class="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
					/>
					<div class="min-w-0">
					<p class="text-sm font-medium">{row.label}</p>
					<p
						class="truncate font-mono text-sm {row.warn ? 'font-medium' : 'text-muted-foreground'}"
						style={row.warn ? 'color: var(--status-warning);' : undefined}
					>
						{row.value}
					</p>
					</div>
				</div>
				{#if locked}
					<!-- Restart-required while live: stop the stream to change it -->
					<span
						class="text-muted-foreground inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium"
						title={$LL.live.stopToChange()}
					>
						<Lock aria-hidden={true} class="h-3.5 w-3.5" />
						<span class="hidden sm:inline">{$LL.live.stopToChange()}</span>
					</span>
				{:else}
					<Button
						class="min-h-[44px] shrink-0 gap-1.5"
						data-testid={row.testId}
						onclick={row.onEdit}
						size="sm"
						variant="ghost"
					>
						<Pencil aria-hidden={true} class="h-3.5 w-3.5" />
						<span class="hidden sm:inline">{$LL.live.editSettings()}</span>
						<ChevronRight aria-hidden={true} class="h-4 w-4 rtl:-scale-x-100" />
					</Button>
				{/if}
			</div>
		{/each}
	</Card.Content>
</Card.Root>
