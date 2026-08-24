<!--
  ModemCapabilitiesDialog.svelte — the device-wide capability-module gates.

  These gates are the operator opt-in behind the seven capability modules
  (band-lock / SMS / 5G-pref / FCC-auto-unlock / GPS / USSD / eSIM). Every one is
  DEFAULT-ABSENT on the device, which is what the band-lock and GPS controls in
  ModemConfigDialog have been reporting all along — "Band locking is turned off on
  this device", "Turn on location for this device in settings first". Until this
  dialog existed those sentences pointed at a setting with no UI anywhere, so the
  controls were unreachable on every board no matter what the hardware could do.

  Three rules carry it:

  1. THE GATES ARE DEVICE-WIDE, so this is a Settings surface and NOT a section
     inside ModemConfigDialog. `config.modem_capabilities` is one object read by
     `resolveModemCapabilityClaims` for every modem, so a per-modem placement
     would tell an operator the switch is scoped to the row they are looking at
     while it silently arms the module on every other modem too.

  2. A GATE IS A PRECONDITION, NEVER A CLAIM. It is one of four inputs to
     `resolveSupportClaim`, so turning it on cannot promote a module past
     `enabled` on a modem whose probe has not positively answered, and `certified`
     is unreachable from here at all. That is why the copy says so out loud
     instead of implying the switch grants a capability — and it is why this
     bypasses no evidence gate, band-lock's stricter certification floor included.

  3. ONLY IMPLEMENTED MODULES GET A ROW (DESIGN.md CT-1). A module this build does
     not ship is positively unsupported, so it renders ZERO DOM nodes rather than
     a switch that would persist a key nothing reads. `implemented` therefore has
     to ride the wire: a modem row resolves "not built" and "this hardware lacks
     it" both to `unavailable`, and only the device can tell them apart.

  Each toggle is pessimistic in the NetworkIngestDialog shape: the switch position
  follows the `applied` record the device persisted, and only the spinner is
  optimistic. A `module_not_implemented` refusal renders a calm inline band, never
  an error toast.

  4. THE READ HAS A BOUND, AND EVERY WAY IT CAN END HAS A SCREEN. Until todo 28
     this dialog rendered NOTHING while `getCapabilities` was in flight, so
     "still reading" and "this build ships no cellular features" were the same
     blank surface — and a read that never answered stayed that way for as long
     as the dialog was open. The read now runs through `loadWithinBound`, so the
     wait ends at a declared bound in one of four named states: loaded-with-rows,
     loaded-and-empty, failed, or timed out. The last two carry a Retry, because
     a terminal an operator cannot act on is only half a terminal.

  5. AN ANSWER THAT HAS AGED SAYS SO. The read happens once per open and the
     gates are device-wide, so a dialog left open while somebody works on the
     device is showing a value as old as the session. Past
     `MODEM_READING_STALE_AFTER_MS` the surface marks itself rather than passing
     the reading off as current.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import {
	CAPABILITY_MODULES,
	type CapabilityGateStates,
	type CapabilityModule,
} from '@ceraui/rpc/schemas';
import { LoaderCircle, RadioTower, RotateCw } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import Badge from '$lib/components/custom/Badge.svelte';
import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import { Switch } from '$lib/components/ui/switch';
import {
	loadWithinBound,
	MODEM_ASYNC_SURFACES,
	readingFreshness,
	readingPresence,
	readingStaleDelay,
} from '$lib/modem/async-surface';
import { getOperationPhase, osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const t = resolveMessageKey;

/** Where the bounded read currently is. `loading` is the only non-terminal one. */
type ReadPhase = 'loading' | 'loaded' | 'failed' | 'timed-out';

let gates = $state<CapabilityGateStates | undefined>(undefined);
let implemented = $state<CapabilityModule[] | undefined>(undefined);
let readPhase = $state<ReadPhase>('loading');
let readAt = $state<number | undefined>(undefined);
let now = $state(Date.now());
let refused = $state(false);

// Every dispatch takes a generation. A read still in flight when the operator
// closes and reopens the dialog would otherwise land on top of the newer one and
// stamp the older answer as the current reading.
let readGeneration = 0;

const STALE_AFTER_MS = MODEM_ASYNC_SURFACES.getCapabilities.staleAfterMs;

// Read on every OPEN rather than once at mount: the dialog is permanently
// mounted by SettingsView, and the gates can be changed by another client (or by
// a direct RPC) between two openings.
$effect(() => {
	if (!open) return;
	void load();
});

// ONE armed deadline rather than a poll — the `gnssAcquirePollDelay` shape. It
// arms only while there is a reading that has not yet aged, and disarms itself
// the moment it has, so an open dialog costs nothing after the first minute.
$effect(() => {
	const delay = readingStaleDelay(readAt, now, STALE_AFTER_MS);
	if (delay === undefined) return;
	const handle = setTimeout(() => {
		now = Date.now();
	}, delay);
	return () => {
		clearTimeout(handle);
	};
});

async function load() {
	const generation = ++readGeneration;
	readPhase = 'loading';
	refused = false;
	const outcome = await loadWithinBound('getCapabilities', () =>
		rpc.modems.getCapabilities(),
	);
	if (generation !== readGeneration) return;
	if (outcome.phase === 'loaded') {
		gates = outcome.value.gates;
		implemented = outcome.value.implemented;
		readAt = Date.now();
		now = readAt;
		readPhase = 'loaded';
		return;
	}
	// A read that did not answer claims NOTHING about the device, so the previous
	// answer is dropped rather than left on screen under a fresh-looking surface.
	gates = undefined;
	implemented = undefined;
	readAt = undefined;
	readPhase = outcome.phase === 'timed-out' ? 'timed-out' : 'failed';
}

// `undefined` (never answered) / `[]` (answered, ships nothing) / a non-empty
// list are three different facts, resolved through the shared tri-state so no
// render site below has to re-decide which is which.
const presence = $derived(readingPresence(implemented));
const freshness = $derived(readingFreshness(readAt, now, STALE_AFTER_MS));

function keyOf(module: CapabilityModule): string {
	return `modem-capability-${module}`;
}
function busyOf(module: CapabilityModule): boolean {
	return getOperationPhase(keyOf(module)) === 'pending';
}
function enabledOf(module: CapabilityModule): boolean {
	return gates?.[module] === true;
}

async function toggle(module: CapabilityModule, next: boolean) {
	refused = false;
	const result = await osCommand({
		key: keyOf(module),
		target: next,
		rpc: () => rpc.modems.setCapabilities({ module, enabled: next }),
		// The refusal is a device FACT rather than a failure, so it stays `ok` and
		// surfaces the calm band below instead of the generic error toast.
		classify: () => ({ ok: true }),
		confirmOnResolve: true,
		failMessage: () => m['settings.modemCapabilities.saveFailed'](),
	});
	// undefined → re-entry no-op, or a thrown RPC osCommand already toasted.
	if (!result) return;
	if (!result.success) {
		refused = true;
		return;
	}
	// The switch moves only once the device says what it persisted.
	gates = result.applied;
}

// CT-1: a module this build does not ship renders nothing at all. The order is
// CAPABILITY_MODULES' own, filtered — never the arrival order of `implemented`,
// so two devices shipping the same set list them identically.
const rows = $derived(
	implemented === undefined ? [] : CAPABILITY_MODULES.filter((module) => implemented?.includes(module)),
);

// The skeleton stands in for the rows it is waiting on, so the surface does not
// jump height when the answer lands. Three is the shipped implemented count, not
// a claim about what this device will report.
const SKELETON_ROWS = [0, 1, 2];
</script>

<AppDialog
	bind:open
	description={m['settings.modemCapabilities.description']()}
	hideFooter
	icon={RadioTower}
	title={m['settings.modemCapabilities.title']()}
>
	<div class="space-y-5" data-testid="modem-capabilities">
		<!-- Two terminals, two sentences, one Retry. "The call failed" and "nothing
		     came back inside the bound" point at different things — a broken socket
		     versus a device that is busy or gone — so they never share copy. -->
		{#if readPhase === 'failed' || readPhase === 'timed-out'}
			<div
				class="border-status-warning/30 bg-status-warning/10 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
				data-read-phase={readPhase}
				data-testid={readPhase === 'timed-out'
					? 'modem-capabilities-load-timed-out'
					: 'modem-capabilities-load-failed'}
				role="status"
			>
				<span class="min-w-0"
					>{readPhase === 'timed-out'
						? m['settings.modemCapabilities.loadTimedOut']()
						: m['settings.modemCapabilities.loadFailed']()}</span
				>
				<Button
					data-testid="modem-capabilities-retry"
					onclick={() => void load()}
					size="sm"
					variant="outline"
				>
					<RotateCw class="size-3.5" aria-hidden="true" />
					{m['settings.modemCapabilities.retry']()}
				</Button>
			</div>
		{/if}

		{#if refused}
			<div
				class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
				data-testid="modem-capabilities-refused"
				role="status"
			>
				{m['settings.modemCapabilities.refused']()}
			</div>
		{/if}

		<p class="text-muted-foreground text-sm">{m['settings.modemCapabilities.explanation']()}</p>

		{#if readPhase === 'loading'}
			<!-- Named, not a bare spinner: the wait says what it is waiting for, and
			     it cannot outlast `MODEM_ASYNC_SURFACES.getCapabilities.boundMs`. -->
			<div
				class="divide-border overflow-hidden rounded-lg border"
				aria-busy="true"
				data-testid="modem-capabilities-loading"
				role="status"
			>
				<span class="sr-only">{m['settings.modemCapabilities.loading']()}</span>
				{#each SKELETON_ROWS as row (row)}
					<div class="flex items-center justify-between gap-4 border-b px-4 py-3.5 last:border-b-0">
						<div class="min-w-0 flex-1 space-y-2">
							<Skeleton class="h-3.5 w-32" />
							<Skeleton class="h-3 w-full max-w-64" />
						</div>
						<Skeleton class="h-5 w-9 shrink-0 rounded-full" />
					</div>
				{/each}
			</div>
		{:else if presence === 'empty'}
			<div
				class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
				data-testid="modem-capabilities-empty"
				role="status"
			>
				{m['settings.modemCapabilities.empty']()}
			</div>
		{:else if presence === 'present'}
			{#if freshness === 'stale'}
				<div data-testid="modem-capabilities-stale">
					<Badge variant="stale" />
				</div>
			{/if}
			<div class="divide-border overflow-hidden rounded-lg border">
				{#each rows as module (module)}
					{@const label = t(`settings.modemCapabilities.module.${module}`)}
					<div
						class="flex items-center justify-between gap-4 border-b px-4 py-3.5 last:border-b-0"
						data-module={module}
						data-testid={`modem-capability-row-${module}`}
					>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-semibold">{label}</p>
							<p class="text-muted-foreground mt-0.5 text-xs">
								{t(`settings.modemCapabilities.moduleDesc.${module}`)}
							</p>
						</div>
						<span class="flex shrink-0 items-center gap-2">
							{#if busyOf(module)}
								<LoaderCircle
									aria-hidden="true"
									class="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
								/>
							{/if}
							<Switch
								aria-label={label}
								bind:checked={() => enabledOf(module), (next) => void toggle(module, next)}
								data-testid={`modem-capability-toggle-${module}`}
								disabled={busyOf(module)}
							/>
						</span>
					</div>
				{/each}
			</div>

			<!-- The switch arms a precondition; it does not assert the hardware can do
			     it. Saying so here is what stops an enabled gate reading as a promise. -->
			<p class="text-muted-foreground text-xs" data-testid="modem-capabilities-honesty">
				{m['settings.modemCapabilities.honesty']()}
			</p>
		{/if}
	</div>
</AppDialog>
