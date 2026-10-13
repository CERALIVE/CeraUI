<!--
  UnconfirmedStreamBand.svelte — the operator's Stop while the device cannot
  confirm whether a stream is running.

  In `reconciling` or `stop_failed` the backend keeps stream protection: Start is
  refused, update Check/Install and reboot/power are refused, and nothing clears
  it except positive engine evidence or an acknowledged operator Stop. When the
  last confirmed `is_streaming` was false, the Live view showed the idle cockpit,
  which carries no Stop, so the operator was left with a power cycle. This band
  says what the device knows ("cannot confirm"), never that the stream is or is
  not live, and offers that Stop.

  The Stop dispatches the same `streaming.stop` RPC the cockpit's Stop ends in,
  through the shared async-operation helper so it has an honest pending/failed
  state. It does not go through the cockpit's notification-clearing wrapper: that
  wrapper is fire-and-forget, so it could not report a refusal, and it would
  wipe the recovery notice that explains why the band is here.

  Always mounted by LiveView; it renders nothing outside the unconfirmed set,
  except that it stays while the operator's Stop is unresolved: from the press
  until the device settles it (its idle commit delivered after the press over
  the current link, or an acknowledged `stopped`). A lost reply, a failed
  hydrate or a lapsed TTL is not settlement, so a `stopping` retained after a
  reset keeps the band, its feedback and an enabled Stop (FIX-16-FRONT3 R2).
  Local start optimism never hides it: the optimistic live cockpit shows a
  disabled "Starting...", which is not a Stop.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LifecycleState } from '@ceraui/rpc/schemas';
import { CircleHelp, Loader2, Square } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { confirmOperation, getOperationPhase, osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import {
	showUnconfirmedStreamStop,
	stopConfirmedByDevice,
	UNCONFIRMED_STOP_OPERATION,
} from '$lib/streaming/unconfirmed-stream';
import {
	claimOperatorStop,
	lifecycleSinceStopClaim,
	operatorStopUnresolved,
	settleOperatorStop,
} from '$lib/streaming/unresolved-stream-actions.svelte';

interface Props {
	lifecycle: LifecycleState | undefined;
	isStreaming: boolean;
	optimismState: StreamingOptimismState;
}

let { lifecycle, isStreaming, optimismState }: Props = $props();

const phase = $derived(getOperationPhase(UNCONFIRMED_STOP_OPERATION));
const pending = $derived(phase === 'pending');
const unresolved = $derived(operatorStopUnresolved());
const visible = $derived(
	showUnconfirmedStreamStop({
		lifecycle,
		isStreaming,
		optimismState,
		stopPending: pending,
		stopUnresolved: unresolved,
	}),
);

// Only the device's idle commit confirms the Stop. Not the band leaving the
// screen: the backend publishes `stopping` BEFORE the engine answers and then
// `stop_failed` if it never does, and a confirmed operation cannot fail. Not a
// `stopped` reply either: the backend can answer it without committing idle.
// Without that evidence the reply decides `failed`, or the shared TTL valve
// flips the operation to `timed_out` and the band says so. A pending operation
// lives on one link (a reset fails it, a reconnect clears it), so the idle it
// sees is that link's; once it is no longer pending, the claim needs an idle
// delivered after the press over the current link.
$effect(() => {
	if (!stopConfirmedByDevice({ lifecycle, isStreaming })) return;
	if (phase === 'pending') {
		confirmOperation(UNCONFIRMED_STOP_OPERATION);
		settleOperatorStop();
	} else if (unresolved && lifecycleSinceStopClaim()) {
		settleOperatorStop();
	}
});

function handleStop() {
	claimOperatorStop();
	void osCommand({
		key: UNCONFIRMED_STOP_OPERATION,
		rpc: () => rpc.streaming.stop(),
		classify: (r) =>
			r.result === 'stop_failed' ? { ok: false, reason: r.reason } : { ok: r.success },
		// D207: an acknowledged Stop is positive idle evidence for the claim. It
		// does not confirm the operation (the reconciling branch can answer it
		// while the lifecycle stays protected, and the band then stays anyway).
		onResult: (r) => {
			if (r.success && r.result === 'stopped') settleOperatorStop();
		},
		// The band renders the failure inline and keeps it on screen; a toast would
		// vanish while the device is still refusing Start.
		silent: true,
	});
}
</script>

{#if visible}
	<div
		aria-live="polite"
		class="border-status-warning/40 bg-status-warning/10 space-y-3 rounded-lg border px-4 py-3"
		data-lifecycle={lifecycle}
		data-phase={phase}
		data-testid="unconfirmed-stream-band"
		role="status"
	>
		<div class="flex items-start gap-2.5">
			<CircleHelp aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
			<div class="min-w-0 space-y-0.5">
				<p class="text-sm font-medium">{m['live.unconfirmedStream.title']()}</p>
				<p class="text-muted-foreground text-sm">{m['live.unconfirmedStream.body']()}</p>
				{#if phase === 'failed'}
					<p class="text-sm font-medium" data-testid="unconfirmed-stream-failed">
						{m['live.unconfirmedStream.stopFailed']()}
					</p>
				{:else if phase === 'timed_out'}
					<p class="text-sm font-medium" data-testid="unconfirmed-stream-timed-out">
						{m['live.unconfirmedStream.stopNotConfirmed']()}
					</p>
				{:else if unresolved && !pending}
					<p class="text-sm font-medium" data-testid="unconfirmed-stream-not-confirmed">
						{m['live.unconfirmedStream.stopNotConfirmed']()}
					</p>
				{/if}
			</div>
		</div>
		<Button
			aria-busy={pending}
			class="group min-h-[44px] w-full gap-2 sm:w-auto"
			data-testid="unconfirmed-stream-stop"
			disabled={pending}
			onclick={handleStop}
			size="lg"
			type="button"
			variant="secondary"
		>
			{#if pending}
				<Loader2 aria-hidden={true} class="size-4 animate-spin motion-reduce:animate-none" />
				{m['live.stopping']()}
			{:else}
				<Square aria-hidden={true} class="size-4" />
				{m['live.stopStream']()}
			{/if}
		</Button>
	</div>
{/if}
