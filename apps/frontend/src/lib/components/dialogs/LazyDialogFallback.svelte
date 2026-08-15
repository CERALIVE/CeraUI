<!--
  LazyDialogFallback.svelte — the chrome a lazily-chunked dialog wears while its
  chunk is in flight, and the honest band it wears when that fetch fails.

  It composes AppDialog like every other dialog, so the loading state carries the
  same responsive shell, the same close affordances, and the same accessible name
  contract as the dialog about to replace it. It renders only after
  LAZY_DIALOG_FALLBACK_DELAY_MS (see lazy-dialog.svelte.ts) — a fast chunk, which
  is every chunk on the device and in CI, never mounts it.

  It carries NO data-testid of its own: a test that waits for a dialog's real
  testid must resolve on the real dialog, never on this placeholder.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';

import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';

import AppDialog from './AppDialog.svelte';

interface Props {
	open?: boolean;
	/** The chunk could not be fetched — state it rather than spin forever. */
	failed?: boolean;
	onRetry?: () => void;
}

let { open = $bindable(false), failed = false, onRetry }: Props = $props();
</script>

<AppDialog
	bind:open
	hideFooter={!failed}
	title={failed ? m["errorBoundary.title"]() : m["common.loading"]()}
>
	{#if failed}
		<p class="text-muted-foreground text-sm leading-relaxed">
			{m["errorBoundary.description"]()}
		</p>
	{:else}
		<div class="flex flex-col gap-3 py-1" aria-hidden="true">
			<Skeleton class="h-4 w-2/3" />
			<Skeleton class="h-9 w-full" />
			<Skeleton class="h-4 w-1/2" />
			<Skeleton class="h-9 w-full" />
		</div>
	{/if}

	{#snippet actions()}
		<Button onclick={() => onRetry?.()} variant="outline">
			{m["errorBoundary.retry"]()}
		</Button>
	{/snippet}
</AppDialog>
