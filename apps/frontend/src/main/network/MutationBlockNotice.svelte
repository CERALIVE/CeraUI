<!--
  MutationBlockNotice: one modem change the device could not confirm, on that
  modem's own row, or at the top of the Cellular card when it is not listed.

  • It renders the device's own list and decides nothing: `MutationRecovery` owns
    the answers, and `CellularSection` owns the confirmation and the focus, because
    both outlive this node when the modem leaves its row.
  • `MutationOutcomeBand` mounts with the notice, before any answer can land, and
    stays after the block is gone so a success is read where the block was.
  • A held action is `aria-disabled`, never `disabled`: it keeps the focus it has,
    and its reason is on screen and described.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { Loader2, TriangleAlert } from '@lucide/svelte';
import MutationOutcomeBand from '$lib/components/custom/MutationOutcomeBand.svelte';
import { Button } from '$lib/components/ui/button';
import { cn } from '$lib/utils';
import {
	changeLabelKey,
	goneLabelKey,
	offeredActions,
	portLabel,
	type RecoveryAction,
	type RecoveryNotice,
	recoveryView,
} from './mutation-recovery.svelte';

interface Props {
	notice: RecoveryNotice;
	/** The modem's own name, for assistive technology; its port stands in when not listed. */
	name?: string;
	/** An action on this block is waiting for the device. */
	working: boolean;
	/** An action on any block is waiting: the device is asked one thing at a time. */
	busy: boolean;
	isConnected: boolean;
	onAction: (action: RecoveryAction) => void;
}

const { notice, name, working, busy, isConnected, onAction }: Props = $props();

const uid = $props.id();
const t = resolveMessageKey;
const block = $derived(notice.block);
const view = $derived(block && recoveryView(block));
const port = $derived(name ? undefined : portLabel(notice.stableKey));
const actions = $derived(block ? offeredActions(block) : []);
const changeKey = $derived(block && changeLabelKey(block));
const outcome = $derived(
	notice.outcome && { kind: notice.outcome.kind, message: t(notice.outcome.messageKey) },
);

function label(action: RecoveryAction): string {
	if (action === 'check') return m["network.modem.saveReconcile"]();
	if (action === 'keep') return m["network.block.keep"]();
	return block ? t(goneLabelKey(block)) : '';
}
</script>

<fieldset
	class={cn(
		'focus-visible:ring-ring/50 my-1 min-w-0 rounded-md outline-none focus-visible:ring-3',
		view && 'border-status-warning/30 bg-status-warning/10 border p-2.5',
	)}
	aria-label={view ? undefined : (name ?? port)}
	aria-labelledby={view ? `${uid}-title` : undefined}
	data-block-state={block?.state}
	data-stable-key={notice.stableKey}
	data-testid="mutation-block"
	tabindex="-1"
>
	{#if block && view}
		<div class="flex items-start gap-2 text-xs">
			<TriangleAlert class="text-status-warning mt-px size-3.5 shrink-0" aria-hidden="true" />
			<div class="min-w-0 space-y-0.5">
				<p class="font-semibold" id="{uid}-title">
					{#if name}<span class="sr-only">{name}</span>{/if}
					{name ? m["network.block.title"]() : m["network.block.titleUnlisted"]()}
					{#if changeKey}<span class="font-normal">· {t(changeKey)}</span>{/if}
					{#if port}<span class="font-normal">· <bdi>{port}</bdi></span>{/if}
				</p>
				<p class="text-pretty" id="{uid}-body">{t(view.bodyKey)}</p>
				{#if actions.includes('check')}
					<p class="text-pretty" data-testid="mutation-block-check-hint" id="{uid}-check">
						{m["network.block.checkHint"]()}
					</p>
				{/if}
			</div>
		</div>
		{#if actions.length > 0}
			<div class="mt-2 flex flex-wrap gap-2">
				{#each actions as action (action)}
					{const held = $derived(busy || !isConnected)}
					<Button
						class="min-h-11 shrink px-3 whitespace-normal aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
						aria-describedby={!isConnected
							? `${uid}-offline`
							: action === 'check'
								? `${uid}-check`
								: `${uid}-body`}
						aria-disabled={held ? 'true' : undefined}
						data-testid="mutation-block-{action}"
						size="sm"
						variant="outline"
						onclick={() => {
							if (!held) onAction(action);
						}}
					>
						{label(action)}
					</Button>
				{/each}
			</div>
		{/if}
		{#if !isConnected}
			<p class="mt-2 text-xs" data-testid="mutation-block-offline" id="{uid}-offline">
				{m["connection.lost"]()}
			</p>
		{/if}
	{/if}
	{#if !view && port}<p class="mb-1 text-xs font-medium"><bdi>{port}</bdi></p>{/if}
	<div data-testid="mutation-block-working" role="status">
		{#if working}
			<p class="mt-2 flex items-center gap-1.5 text-xs">
				<Loader2 class="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
				{m["network.block.working"]()}
			</p>
		{/if}
	</div>
	<!-- The status inks are under 4.5:1 on these tints in the light theme; the icon keeps its tone. -->
	<div class={cn('[&_p>span]:text-foreground', view && outcome && 'mt-2')}>
		<MutationOutcomeBand name="mutation-block" {outcome} />
	</div>
</fieldset>
