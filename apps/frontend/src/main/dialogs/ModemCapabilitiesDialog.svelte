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
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import {
	CAPABILITY_MODULES,
	type CapabilityGateStates,
	type CapabilityModule,
} from '@ceraui/rpc/schemas';
import { LoaderCircle, RadioTower } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Switch } from '$lib/components/ui/switch';
import { getOperationPhase, osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const t = resolveMessageKey;

let gates = $state<CapabilityGateStates | undefined>(undefined);
let implemented = $state<CapabilityModule[] | undefined>(undefined);
let loadFailed = $state(false);
let refused = $state(false);

// Read on every OPEN rather than once at mount: the dialog is permanently
// mounted by SettingsView, and the gates can be changed by another client (or by
// a direct RPC) between two openings.
$effect(() => {
	if (!open) return;
	void load();
});

async function load() {
	loadFailed = false;
	refused = false;
	try {
		const result = await rpc.modems.getCapabilities();
		gates = result.gates;
		implemented = result.implemented;
	} catch {
		loadFailed = true;
	}
}

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
</script>

<AppDialog
	bind:open
	description={m['settings.modemCapabilities.description']()}
	hideFooter
	icon={RadioTower}
	title={m['settings.modemCapabilities.title']()}
>
	<div class="space-y-5" data-testid="modem-capabilities">
		{#if loadFailed}
			<div
				class="border-status-warning/30 bg-status-warning/10 rounded-lg border px-4 py-3 text-sm"
				data-testid="modem-capabilities-load-failed"
				role="status"
			>
				{m['settings.modemCapabilities.loadFailed']()}
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

		{#if implemented !== undefined && rows.length === 0}
			<div
				class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
				data-testid="modem-capabilities-empty"
				role="status"
			>
				{m['settings.modemCapabilities.empty']()}
			</div>
		{:else if rows.length > 0}
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
