<!--
  RawFollowControl.svelte: Follow, Pause and Resume for the Raw logs tab, with
  the follow state beside them. Follow is an outline button: a filled lime one
  would read as going live. Unavailable, it stays visible and disabled next to
  its reason (DESIGN.md CT-2). Following is the info tone with a motion-safe
  pulse; every other state is neutral and still, so a dropped socket never
  looks live, and Resume appears only once the socket is back.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Pause, Play } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import type { FollowState, RawView } from '$lib/device-logs/raw-view.svelte';
import { cn } from '$lib/utils';

let { view }: { view: RawView } = $props();

const uid = $props.id();

const STATE_LABEL: Partial<Record<FollowState, () => string>> = {
	following: () => m['systemLogs.follow.following'](),
	paused: () => m['systemLogs.follow.paused'](),
	stopped: () => m['systemLogs.follow.stopped'](),
	disconnected: () => m['systemLogs.follow.disconnected'](),
};

const following = $derived(view.follow === 'following');
const resumable = $derived(view.follow === 'paused' || view.follow === 'disconnected');
const reason = $derived(
	view.followBlocked === 'anchor'
		? m['systemLogs.follow.unavailableAnchor']()
		: view.followBlocked === 'filter'
			? m['systemLogs.follow.unavailable']()
			: undefined,
);
const stateLabel = $derived(STATE_LABEL[view.follow]);
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="raw-follow">
	{#if view.connected}
		<!-- aria-disabled, not disabled, while the device answers: the pressed button keeps keyboard focus. -->
		<Button
			aria-busy={view.followBusy ? 'true' : undefined}
			aria-describedby={reason === undefined ? undefined : `${uid}-reason`}
			aria-disabled={view.followBusy ? 'true' : undefined}
			class="gap-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50"
			data-testid="raw-follow-button"
			disabled={reason !== undefined}
			onclick={() => (following ? view.pauseFollow() : view.startFollow())}
			size="sm"
			variant="outline"
		>
			{#if following}
				<Pause class="size-4" />
				{m['systemLogs.follow.pause']()}
			{:else}
				<Play class="size-4" />
				{resumable ? m['systemLogs.follow.resume']() : m['systemLogs.follow.start']()}
			{/if}
		</Button>
	{/if}
	{#if stateLabel}
		<span class="inline-flex items-center gap-1.5 text-xs font-medium" data-state={view.follow} data-testid="raw-follow-state">
			<span
				class={cn('size-2 rounded-full', following ? 'bg-status-info motion-safe:animate-pulse' : 'bg-status-neutral')}
				data-follow-dot
			></span>
			{stateLabel()}
		</span>
	{/if}
	{#if reason !== undefined}
		<p class="text-muted-foreground text-xs" data-testid="raw-follow-reason" id="{uid}-reason">{reason}</p>
	{/if}
</div>
