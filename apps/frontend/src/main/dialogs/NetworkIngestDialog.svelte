<!--
  NetworkIngestDialog.svelte — LAN RTMP/SRT ingest enable/disable (Task 8).

  The operator's desired-state control for the two image-baked LAN ingest gateways
  (RTMP :1935 / SRT :4001). A phone or hardware encoder on the SAME local network
  publishes directly into the device without going through the cloud relay. This
  dialog explains what that is (same-LAN/WiFi requirement) and exposes a
  per-protocol enable/disable toggle.

  Each toggle is a G4 status op — it routes through the keyed async-operation
  machine (`osCommand`, key `ingest-toggle-{rtmp|srt}`) for the re-entry guard and
  the in-flight `pending` phase, but it does NOT confirm on the RPC resolve. The
  authoritative confirmation is the `status.network_ingest` broadcast: the toggle
  reflects the CONFIRMED state (`!operator_disabled`), and only the in-flight
  spinner is optimistic (G4 — status-domain optimistic-release rule). An
  emulated-mode refusal surfaces the calm `role="status"` band (kiosk precedent),
  never an error toast.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	NETWORK_INGEST_UNAVAILABLE_ERROR,
	type NetworkIngestProtocol,
} from '@ceraui/rpc/schemas';
import { LoaderCircle, Radio } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Switch } from '$lib/components/ui/switch';
import {
	clearOperation,
	confirmOperation,
	getOperationPhase,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getConfig, getStatus } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const t = $derived($LL.settings.networkIngest);
const sources = $derived($LL.settings.dialogs.sources);

type Protocol = 'rtmp' | 'srt';
const PROTOCOLS: readonly Protocol[] = ['rtmp', 'srt'];

// The per-protocol entry off the authoritative status broadcast. `null` → the
// board's capability source kinds exclude this protocol; `undefined` → no
// snapshot yet. Both fall through to the "stopped" (service not running) state.
const ingest = $derived(getStatus()?.network_ingest ?? null);
function entryOf(p: Protocol): NetworkIngestProtocol | null | undefined {
	return ingest?.[p];
}

// Desired-enabled state = NOT operator_disabled. The backend defaults a missing
// key to enabled (`?? true`), so an absent `operator_disabled` reads as ON.
function enabledOf(p: Protocol): boolean {
	return !(entryOf(p)?.operator_disabled === true);
}

type IngestStatus = 'running' | 'stopped' | 'disabled';
function statusOf(p: Protocol): IngestStatus {
	const e = entryOf(p);
	if (e?.operator_disabled === true) return 'disabled';
	if (e?.service_active === true) return 'running';
	return 'stopped';
}

function keyOf(p: Protocol): string {
	return `ingest-toggle-${p}`;
}
function busyOf(p: Protocol): boolean {
	return getOperationPhase(keyOf(p)) === 'pending';
}

// The intended target per protocol, held while the op is `pending` so the confirm
// $effect knows which broadcast value ends the wait. Reset to `null` the moment
// the broadcast confirms, a refusal clears the op, or the RPC throws.
let targets = $state<Record<Protocol, boolean | null>>({ rtmp: null, srt: null });

// Set when the backend refuses the toggle in dev/emulated mode: a calm banner
// (never an error toast). Cleared on the next successful dispatch.
let unavailable = $state(false);

async function toggle(protocol: Protocol, next: boolean) {
	const key = keyOf(protocol);
	targets[protocol] = next;
	const result = await osCommand({
		key,
		target: next,
		rpc: () => rpc.network.setIngestEnabled({ protocol, enabled: next }),
		// A genuine failure (non-emulated) becomes a `failed` op + toast; the
		// emulated-mode refusal is kept `ok` so it surfaces the calm band instead.
		classify: (r) =>
			!r.success && r.error !== NETWORK_INGEST_UNAVAILABLE_ERROR
				? { ok: false, reason: r.error }
				: { ok: true },
		failMessage: () => $LL.network.os.operationFailed(),
	});
	// undefined → re-entry no-op or a thrown RPC (osCommand already toasted).
	if (!result) {
		targets[protocol] = null;
		return;
	}
	if (!result.success) {
		// The only ok-but-unsuccessful path is the emulated-mode refusal: calm band,
		// drop the pending op so it never reads as a real success, revert the target.
		if (result.error === NETWORK_INGEST_UNAVAILABLE_ERROR) {
			unavailable = true;
			clearOperation(key);
		}
		targets[protocol] = null;
		return;
	}
	// Success: stay `pending`. The confirm $effect resolves it once the
	// authoritative status.network_ingest broadcast reflects the target (G4).
	unavailable = false;
}

// Confirm each pending toggle once the authoritative broadcast reflects its
// target. The spinner clears here — never on the RPC resolve — so the toggle's
// final position always waits for the device's own truth.
$effect(() => {
	for (const p of PROTOCOLS) {
		const key = keyOf(p);
		if (getOperationPhase(key) !== 'pending') continue;
		const target = targets[p];
		if (target === null) continue;
		if (enabledOf(p) === target) {
			targets[p] = null;
			confirmOperation(key);
		}
	}
});

// ── Test-pattern visibility (Sources) ──────────────────────────────────────
// A THIRD toggle beside rtmp/srt. The switch reads "Show test pattern": ON =
// visible, so `checked = !hide_test_pattern` (default checked when the key is
// absent). Unlike the protocol toggles this op is `silent` — a genuine failure
// never toasts; the calm inline band below (driven by the `failed` phase) is the
// sole feedback. The switch position is pessimistic: it reflects the CONFIRMED
// config (`config.sources_visibility.hide_test_pattern`) and only moves once the
// authoritative `config` broadcast lands, never on the RPC resolve.
const TEST_PATTERN_KEY = 'sources:test-pattern';
const showTestPattern = $derived(
	getConfig()?.sources_visibility?.hide_test_pattern !== true,
);
function testPatternBusy(): boolean {
	return getOperationPhase(TEST_PATTERN_KEY) === 'pending';
}
function testPatternFailed(): boolean {
	return getOperationPhase(TEST_PATTERN_KEY) === 'failed';
}

// The intended "show" target, held while the op is `pending` so the confirm
// $effect knows which config broadcast ends the wait. Reset the moment the
// broadcast confirms, or the RPC rejects/refuses.
let testPatternTarget = $state<boolean | null>(null);

async function toggleTestPattern(nextShow: boolean) {
	testPatternTarget = nextShow;
	const result = await osCommand({
		key: TEST_PATTERN_KEY,
		target: nextShow,
		// `silent`: no toast on failure — the inline band renders off the `failed`
		// phase instead (unlike the non-silent rtmp/srt toggles).
		silent: true,
		rpc: () =>
			rpc.streaming.setSourceVisibility({ hide_test_pattern: !nextShow }),
	});
	// undefined → re-entry no-op or a thrown RPC (already `failed`, no toast).
	// A structured `success:false` is also already `failed` via defaultClassify.
	if (!result?.success) {
		testPatternTarget = null;
		return;
	}
	// Success: stay `pending`. The confirm $effect resolves it once the
	// authoritative `config` broadcast reflects the target.
}

// Confirm the pending test-pattern toggle once the config broadcast reflects its
// target — the switch's final position always waits for the device's own truth.
$effect(() => {
	if (getOperationPhase(TEST_PATTERN_KEY) !== 'pending') return;
	if (testPatternTarget === null) return;
	if (showTestPattern === testPatternTarget) {
		testPatternTarget = null;
		confirmOperation(TEST_PATTERN_KEY);
	}
});

const STATUS_META = {
	running: { dot: 'bg-status-success motion-safe:animate-pulse' },
	stopped: { dot: 'bg-muted-foreground/50' },
	disabled: { dot: 'bg-muted-foreground/40' },
} as const satisfies Record<IngestStatus, { dot: string }>;

const statusLabels = $derived({
	running: t.statusRunning(),
	stopped: t.statusStopped(),
	disabled: t.statusDisabled(),
} satisfies Record<IngestStatus, string>);

const toggleLabels = $derived({
	rtmp: t.toggleRtmp(),
	srt: t.toggleSrt(),
} satisfies Record<Protocol, string>);
</script>

<AppDialog bind:open description={sources.description()} hideFooter icon={Radio} title={sources.title()}>
	<div class="space-y-5">
		{#if unavailable}
			<div
				class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
				data-testid="network-ingest-unavailable"
				role="status"
			>
				{t.unavailable()}
			</div>
		{/if}

		<!-- What LAN ingest is + the same-network requirement. -->
		<p class="text-muted-foreground text-sm">{t.explanation()}</p>

		<!-- Per-protocol enable/disable rows. -->
		<div class="divide-border overflow-hidden rounded-lg border">
			{#each PROTOCOLS as protocol (protocol)}
				{@const state = statusOf(protocol)}
				<div
					class="flex items-center justify-between gap-4 border-b px-4 py-3.5 last:border-b-0"
					data-protocol={protocol}
					data-testid={`network-ingest-row-${protocol}`}
				>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-semibold">{toggleLabels[protocol]}</p>
						<span
							class="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs"
							data-testid={`network-ingest-status-${protocol}`}
						>
							<span class={cn('size-2 shrink-0 rounded-full', STATUS_META[state].dot)}></span>
							{statusLabels[state]}
						</span>
					</div>
					<span class="flex shrink-0 items-center gap-2">
						{#if busyOf(protocol)}
							<LoaderCircle
								aria-hidden="true"
								class="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
							/>
						{/if}
						<Switch
							aria-label={toggleLabels[protocol]}
							bind:checked={() => enabledOf(protocol), (next) => void toggle(protocol, next)}
							data-testid={`network-ingest-toggle-${protocol}`}
							disabled={busyOf(protocol)}
						/>
					</span>
				</div>
			{/each}
		</div>

		<!-- Test-pattern visibility (Sources). Pessimistic + silent op: the calm
		     band below is the sole failure feedback (no toast). -->
		<div class="space-y-2">
			<div class="overflow-hidden rounded-lg border">
				<div
					class="flex items-center justify-between gap-4 px-4 py-3.5"
					data-testid="sources-test-pattern-row"
				>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-semibold">{sources.testPatternToggle()}</p>
						<p class="text-muted-foreground mt-0.5 text-xs">{sources.testPatternHint()}</p>
					</div>
					<span class="flex shrink-0 items-center gap-2">
						{#if testPatternBusy()}
							<LoaderCircle
								aria-hidden="true"
								class="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
							/>
						{/if}
						<Switch
							aria-label={sources.testPatternToggle()}
							bind:checked={() => showTestPattern, (next) => void toggleTestPattern(next)}
							data-testid="sources-test-pattern-toggle"
							disabled={testPatternBusy()}
						/>
					</span>
				</div>
			</div>
			{#if testPatternFailed()}
				<div
					class="border-status-warning/30 bg-status-warning/10 rounded-lg border px-4 py-3 text-sm"
					data-testid="sources-test-pattern-error"
					role="status"
				>
					{$LL.network.os.operationFailed()}
				</div>
			{/if}
		</div>
	</div>
</AppDialog>
