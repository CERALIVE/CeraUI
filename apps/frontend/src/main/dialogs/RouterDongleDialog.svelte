<!--
  RouterDongleDialog.svelte — the settings a router-mode dongle actually has.

  A `router-ethernet` dongle runs its own embedded router, so ModemManager can
  say nothing about it and every mmcli-shaped control in ModemConfigDialog would
  be inert. What this dialog offers instead is the intersection of two things:
  what the vendor's own HTTP admin API exposes, and what a write to it was
  OBSERVED to change on real hardware.

  THAT INTERSECTION IS SMALL ON PURPOSE. The backend only publishes
  `router_admin.controls` for a device whose writes were proven by round-trip on
  a bench unit, so this dialog renders toggles for a Huawei HiLink and renders
  NONE for a ZTE MF79U whose firmware accepts every request and applies none of
  them. A device with nothing provably settable gets an honest sentence and the
  address of the vendor UI that does own its configuration — never a disabled
  switch, which would read as a setting the operator merely lacks permission for.

  THE NETWORK-MODE CHIPS ARE THE SAME BARGAIN, ONE LAYER UP. They are pressable
  only when the firmware NAMED its own mode catalog; a firmware that declines the
  question (the bench unit answers error 112008) renders its own refusal, with no
  control at all. The gate is the capability reading itself, never a firmware
  allowlist — and the device re-reads that same capability in the write's own
  cycle before it builds any request document, so the offer and the write cannot
  disagree about what this dongle will discuss.

  APPLY IS PESSIMISTIC, AND HERE THAT IS LITERAL. The switch does not move when
  the operator taps it. It moves when the backend has re-READ the dongle and
  reported the new value back, because the whole reason this surface exists is
  that a control which claims success and changes nothing is worse than no
  control at all. A refusal restores the switch to the device's last known truth
  and says which of the three things went wrong.

  …AND THE WAIT FOR THAT RE-READ IS BOUNDED, WITH THE OUTCOME LEFT ON SCREEN.
  Pessimism was the right posture and it had two holes, both of which this
  surface's own design made worse rather than better:

    · The outcome was a TOAST. On a surface where a refused write correctly
      leaves the control unmoved, the toast was the ONLY thing separating
      "refused" from "never attempted" — and it expired in seconds. Every write
      now lands in a PERSISTENT band that is also announced (§8), and the toasts
      for these two writes are gone so nothing is announced twice.
    · The wait had NO BOUND. If the confirming broadcast never arrived, the
      spinner simply stopped and the dialog looked untouched. `router-write-flow`
      bounds it and renders the honest third answer — not applied, not refused,
      NOT CONFIRMED — rather than silence.

  A STALE READING IS MARKED AS STALE. `router_admin.signal.freshness` already
  distinguishes a live reading from a carried-over one, and the Cellular row has
  rendered that distinction since todo 21 — this dialog printed the same numbers
  with no such marker at all, which is §2 IH-4's "staleness beats freshness
  theatre" failing in the one place an operator goes to act on them.

  Each control applies on its own — there is no Save. The write is a live HTTP
  round-trip to a device on the far side of a USB link, so batching two of them
  behind one button would only make a slow operation ambiguous about which half
  failed.

  ── AND IT RENDERS THE SAME SECTIONS EVERY OTHER MODEM DOES ─────────────────

  Identity, connection state, signal, SIM and diagnostics come from
  `$lib/modem/sections` — the SAME components, model and status vocabulary the
  Cellular row and `ModemConfigDialog` render. This surface used to answer those
  five questions in its own words or not at all: there was no lifecycle badge, no
  SIM verdict, and no signal reading anywhere in the dialog, so an operator who
  opened a dongle saw a strictly poorer instrument than the row they opened it
  from. What stays bespoke below is what is genuinely only true of this family —
  the vendor's own admin readings, its network-mode catalog, and the two toggles
  a write was PROVEN to land on.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { Modem, RouterAdminControls } from '@ceraui/rpc/schemas';
import {
	Ban,
	Clock,
	ExternalLink,
	Info,
	Router,
	Sliders,
	TriangleAlert,
	Wrench,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import CollapsibleSection from '$lib/components/custom/CollapsibleSection.svelte';
import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import MutationOutcomeBand from '$lib/components/custom/MutationOutcomeBand.svelte';
import { Button } from '$lib/components/ui/button';
import { AppDialog } from '$lib/components/dialogs';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import {
	CapabilitySection,
	type CapabilityView,
	ConnectionStateBlock,
	deriveModemSections,
	DiagnosticsBlock,
	IdentityBlock,
	SignalBlock,
	SimBlock,
} from '$lib/modem/sections';
import { deriveLockView, lockWithholdsCapabilities } from '$lib/modem/lock-state';
import { mutationOutcome } from '$lib/modem/mutation-outcome';
import { rpc } from '$lib/rpc';
import {
	beginRouterWrite,
	failRouterWrite,
	isRouterWriteBusy,
	observeRouterWrite,
	resolveRouterWrite,
	type RouterWriteFlow,
	tickRouterWrite,
} from '$lib/rpc/router-write-flow';

import {
	openRouterAdminUi,
	routerAdminOpenReasonKey,
} from '../network/router-admin-open';
import ModemGpsSection from './ModemGpsSection.svelte';
import ModemLockSection from './ModemLockSection.svelte';
import {
	isSubnetTargetValid,
	netModeSectionView,
	ROUTER_UNAVAILABLE_OPERATIONS,
	subnetOutcome,
	subnetRewriteRequest,
	subnetRewriteView,
} from './router-dongle-actions';
import {
	detailFields,
	diagnosticFields,
	identityFields,
	netModeCapability,
} from './router-dongle-fields';

interface Props {
	open?: boolean;
	deviceId: string;
	modem: Modem;
	/**
	 * Whether this dongle's interface currently holds an address — a TRISTATE.
	 *
	 * OMITTED means "we were not told", and the shared set then SKIPS the bond
	 * refusal entirely rather than defaulting it: a refusal is a claim about an
	 * address, and told nothing the card claims nothing. The Network view knows
	 * it from `netif` and passes it.
	 */
	hasAddress?: boolean;
}

let {
	open = $bindable(false),
	deviceId,
	modem,
	hasAddress,
}: Props = $props();

type ControlId = keyof RouterAdminControls;

const admin = $derived(modem.router_admin);
const controls = $derived(admin?.controls);

/**
 * A capability module is a property of the MODEM, not of the dialog that happens
 * to be rendering it. `capability_modules` is stamped onto every row the wire
 * producer emits — this family included — so reading it here is what stops the
 * choice of dialog silently deciding which claims an operator can ever reach.
 */
const gpsClaim = $derived(modem.capability_modules?.gps);

/** Every card on this dialog is the same bordered panel the MM dialog uses. */
const CARD_FRAME = 'space-y-3 rounded-lg border p-3';

/**
 * The two-state form of the shared ladder, copied VERBATIM from
 * `ModemConfigDialog`. A read-only block is gated on "did the device publish
 * this", which is available-or-absent and nothing else — there is no capability
 * claim behind it to be unknown about, and no control to withhold.
 */
const cardView = (present: boolean): CapabilityView =>
	present ? { mode: 'available' } : { mode: 'absent' };

const sections = $derived(
	deriveModemSections({
		modem,
		...(hasAddress === undefined ? {} : { hasAddress }),
	}),
);

// ONE flow for the whole dialog, because ONE write may be in flight against a
// dongle that issues single-use session tokens: two overlapping writes would
// each open their own session and race. It carries which target it is for, so
// the wait renders on the row that started it and locks out the siblings.
let flow = $state<RouterWriteFlow | undefined>(undefined);

const busy = $derived(isRouterWriteBusy(flow));
const pending = $derived(
	busy && flow?.target.kind === 'control' ? flow.target.control : undefined,
);
const pendingMode = $derived(
	busy && flow?.target.kind === 'net-mode' ? flow.target.mode : undefined,
);

/**
 * The value to render for a control.
 *
 * Always the DEVICE's value. There is no local editable copy to drift from it,
 * which is what makes the "switch only moves when the device moved" rule
 * structural rather than a discipline the next edit could forget.
 */
function deviceValue(id: ControlId): boolean {
	return controls?.[id] ?? false;
}

const identity = $derived(identityFields(admin));
const details = $derived(detailFields(admin));
const diagnostics = $derived(diagnosticFields(admin));
const netMode = $derived(netModeCapability(admin));

/**
 * The dongle's login, and whether it is why the two operation blocks are absent.
 *
 * Derived ONCE here and handed down, so the section that renders the lock and
 * the band that explains a missing control cannot disagree about which state
 * the device is in. `lockWithholdsCapabilities` is the device's own
 * `gateRouterAdminByLock` seen from this side: below `open`/`unlocked` the
 * backend withholds `capabilities` and `controls`, so "nothing here is provably
 * settable" would be a true sentence about the wrong device.
 */
const lock = $derived(deriveLockView(modem));
const controlsLocked = $derived(lockWithholdsCapabilities(lock));

/**
 * The net-mode capability as the shared four-state ladder sees it.
 *
 * `absent` when the read produced nothing at all (zero nodes — there is no
 * capability here to explain), `available` when the firmware named its catalog,
 * and `blocked` when it declined the question. `blocked` renders the refusal
 * with NO control, which is only true because this call site passes no `control`
 * snippet: the chips are `children`, and `children` render at `available` alone.
 *
 * The rule itself is `router-dongle-actions.ts`, so "a 112008 refusal renders
 * blocked-with-the-code rather than hiding the control" is assertable without
 * mounting this dialog.
 */
const netModeView = $derived(netModeSectionView(netMode));

/**
 * The LAN-subnet rewrite: offered ONLY for a dongle whose writes were proven,
 * and never as a switch.
 *
 * `absent` renders zero nodes, so a dialect this build performs no write for —
 * and a dongle whose login is still outstanding, which withholds `controls` —
 * is byte-unchanged by this surface.
 */
const subnetView = $derived(subnetRewriteView(admin));

/** The operator's target address. Local, never persisted, cleared on apply. */
let subnetTarget = $state('');
/**
 * The two-step confirmation, INLINE rather than a modal.
 *
 * The write can leave the dongle at an address nothing here can reach, so it
 * needs an explicit second act — but a modal inside an already-portalled dialog
 * puts the consequence on a layer the shipped kiosk touchscreen has to dismiss
 * before it can re-read the address it is confirming. The panel below states the
 * consequence beside the field that produced it.
 */
let subnetConfirming = $state(false);
let subnetBusy = $state(false);
let subnetResult = $state<
	{ readonly kind: 'applied' | 'refused' | 'unknown'; readonly message: string } | undefined
>(undefined);

const subnetTargetValid = $derived(isSubnetTargetValid(subnetTarget));

const subnetBand = $derived(
	subnetResult === undefined
		? undefined
		: mutationOutcome(subnetResult.kind, subnetResult.message),
);

// §2 IH-4. `unknown` is deliberately NOT marked: the device told us nothing
// about this reading's age, and a "stale" badge over that would be a claim we
// cannot make. Only a device-stated `stale` earns the marker.
const readingStale = $derived(admin?.signal?.freshness === 'stale');

// The confirming observation may arrive at ANY point after dispatch — the
// backend re-broadcasts the moment it has verified, and that frame can beat the
// RPC reply back. A pre-resolution match is buffered and consumed at resolution.
$effect(() => {
	const current = flow;
	if (!isRouterWriteBusy(current) || !current) return;
	const next = observeRouterWrite(current, modem.router_admin);
	if (next !== current) flow = next;
});

// The bound is armed at RPC RESOLUTION, never at dispatch: the call itself
// awaits a live HTTP round trip plus the backend's own read-back.
$effect(() => {
	const current = flow;
	if (current?.phase !== 'awaiting' || current.deadlineAt === undefined) return;
	const timer = setTimeout(
		() => {
			if (flow) flow = tickRouterWrite(flow, Date.now());
		},
		Math.max(0, current.deadlineAt - Date.now()),
	);
	return () => clearTimeout(timer);
});

async function openAdmin(): Promise<void> {
	const outcome = await openRouterAdminUi(deviceId);
	if (!outcome.ok) {
		toast.error(resolveMessageKey(routerAdminOpenReasonKey(outcome.reason)));
	}
}

function refusalMessage(error: string | undefined): string {
	if (error === 'not_applied') return m["network.routerCellular.control.notApplied"]();
	if (error === 'unreachable') return m["network.routerCellular.control.unreachable"]();
	return m["network.routerCellular.control.unsupported"]();
}

function netModeRefusalMessage(error: string | undefined, code?: string): string {
	if (error === 'capability_unavailable') {
		return code === undefined
			? m["network.routerCellular.netMode.refusedUnknown"]()
			: m["network.routerCellular.netMode.refused"]({ code });
	}
	if (error === 'not_offered') return m["network.routerCellular.netMode.notOffered"]();
	if (error === 'not_applied') return m["network.routerCellular.control.notApplied"]();
	if (error === 'unreachable') return m["network.routerCellular.control.unreachable"]();
	return m["network.routerCellular.control.unsupported"]();
}

/**
 * The terminal outcome of the last write, as the operator's own sentence.
 *
 * `undefined` while a write is still in flight, so the band never contradicts
 * the spinner beside it — and, crucially, never renders a stale outcome from the
 * PREVIOUS write while a new one runs.
 */
const outcome = $derived.by(() => {
	const current = flow;
	if (current === undefined || isRouterWriteBusy(current)) return undefined;
	const isNetMode = current.target.kind === 'net-mode';
	switch (current.phase) {
		case 'applied':
			return mutationOutcome('applied', m["network.routerCellular.outcome.applied"]());
		case 'refused':
			return mutationOutcome(
				'refused',
				isNetMode
					? netModeRefusalMessage(current.error, current.code)
					: refusalMessage(current.error),
			);
		case 'unconfirmed':
			return mutationOutcome(
				'unknown',
				m["network.routerCellular.outcome.unconfirmed"](),
			);
		default:
			return undefined;
	}
});

/** Which surface the outcome band belongs under — the one that started it. */
const outcomeOnNetMode = $derived(
	outcome !== undefined && flow?.target.kind === 'net-mode',
);

async function apply(control: ControlId, value: boolean) {
	if (busy) return;
	flow = beginRouterWrite({ kind: 'control', control, value });
	try {
		const result = await rpc.modems.setRouterControl({
			device: deviceId,
			control,
			value,
		});
		if (flow) flow = resolveRouterWrite(flow, result, Date.now());
	} catch {
		if (flow) flow = failRouterWrite(flow);
	}
}

async function applyNetMode(mode: string) {
	if (busy) return;
	flow = beginRouterWrite({ kind: 'net-mode', mode });
	try {
		const result = await rpc.modems.setRouterNetMode({ device: deviceId, mode });
		if (flow) flow = resolveRouterWrite(flow, result, Date.now());
	} catch {
		if (flow) flow = failRouterWrite(flow);
	}
}

/**
 * Move the dongle's LAN subnet — the ONE journaled write on this surface.
 *
 * It carries `confirm: true` because the device's own input schema is `.strict()`
 * with a `z.literal(true)` there: a request without it is rejected before the
 * handler runs, which is the write's TOCTOU boundary rather than a formality.
 * `subnetRewriteRequest` is the only shape this call site can build.
 *
 * Every terminal answer is rendered, `blocked` included. That outcome means the
 * dongle answered at NEITHER address, so it maps onto the outcome band's
 * `unknown` kind — claiming a refusal there would assert the old settings are
 * intact, and claiming success would assert the new ones are.
 */
async function applySubnet() {
	if (subnetBusy || !subnetTargetValid) return;
	subnetConfirming = false;
	subnetBusy = true;
	subnetResult = undefined;
	try {
		const result = await rpc.modems.setRouterSubnet(
			subnetRewriteRequest(deviceId, subnetTarget),
		);
		const outcome = subnetOutcome(result);
		subnetResult = {
			kind: outcome.kind,
			message:
				outcome.conflict === undefined
					? resolveMessageKey(outcome.key)
					: m['network.routerCellular.subnet.refused.subnet_conflict']({
							iface: outcome.conflict,
						}),
		};
		if (result.status === 'applied') subnetTarget = '';
	} catch {
		subnetResult = {
			kind: 'unknown',
			message: m['network.routerCellular.subnet.blocked'](),
		};
	} finally {
		subnetBusy = false;
	}
}
</script>

<AppDialog
	description={modem.ifname}
	hideFooter
	icon={Router}
	title={modem.name ?? m["network.view.cellular"]()}
	bind:open
>
	<div class="space-y-6">
		{#if admin === undefined}
			<!-- The read has produced nothing at all. That is a state, not an empty
			     dialog: with no band here the operator meets a blank panel and
			     cannot tell a dongle that answers nothing from a dialog that failed
			     to load. Never a spinner — there is no pending read to wait on. -->
			<div
				class="bg-status-warning/10 border-status-warning/30 flex items-start gap-3 rounded-lg border p-3"
				data-testid="dongle-unavailable"
				role="status"
			>
				<Info class="text-status-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<p class="text-muted-foreground text-xs">
					{m["network.routerCellular.readingUnavailable"]()}
				</p>
			</div>
		{:else if readingStale}
			<!-- §2 IH-4. The device stated this reading is carried over rather than
			     current, so it is MARKED — the values below still render (a blanked
			     panel would be worse), but nothing on this surface presents an aged
			     reading as a fresh one. -->
			<div
				class="bg-status-warning/10 border-status-warning/30 flex items-start gap-3 rounded-lg border p-3"
				data-testid="dongle-stale"
				data-freshness="stale"
				role="status"
			>
				<Clock class="text-status-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<p class="text-muted-foreground text-xs">
					{m["network.routerCellular.readingStale"]()}
				</p>
			</div>
		{/if}

		<!-- The five questions every device on this page answers, answered here by
		     the SAME components the Cellular row and the MM dialog render them
		     with. Nothing below asks what family this device belongs to. -->
		<div class={CARD_FRAME} data-testid="dongle-status">
			<IdentityBlock identity={sections.identity} name="dongle-identity" />
			<ConnectionStateBlock
				connection={sections.connection}
				name="dongle-connection"
				title={m["network.modem.sections.connection.title"]()}
				unavailability={sections.unavailability}
			/>
			<div class="grid gap-3 sm:grid-cols-2">
				<SignalBlock
					name="dongle-signal"
					signal={sections.signal}
					title={m["network.modem.sections.signal.title"]()}
				/>
				<SimBlock
					name="dongle-sim"
					sim={sections.sim}
					title={m["network.modem.sections.sim.title"]()}
				/>
			</div>
		</div>

		{#if details.length > 0}
			<!-- What its NETWORK is doing, in the operator's own terms. A field the
			     dongle did not state has no row at all rather than a dash that would
			     read like a reading. -->
			<div class="border-t pt-5">
				<DiagnosticsBlock
					diagnostics={{ rows: [] }}
					extra={details}
					name="dongle-details"
					rowPrefix="dongle-detail"
					title={m["network.routerCellular.detailTitle"]()}
				/>
			</div>
		{/if}

		{#if diagnostics.length > 0 || identity.length > 0}
			<!-- A header that IS its own control stays a `CollapsibleSection`:
			     `CapabilitySection` splits heading from control, and both ways out are
			     regressions (a chevron with no accessible name, or the title twice).

			     The GATE is the DONGLE's own raw readings, now including its unit
			     identifiers. The shared derived rows ride along inside but never
			     decide whether the block exists — every device has an interface name,
			     so gating on those would hang an always-open disclosure on a dongle
			     that reported nothing. -->
			<CollapsibleSection
				bodyId="dongle-diagnostics-body"
				bodyTestid="dongle-diagnostics-body"
				description={m["network.routerCellular.diagnosticsDescription"]()}
				testid="dongle-diagnostics"
				title={m["network.routerCellular.diagnosticsTitle"]()}
				toggleTestid="dongle-diagnostics-toggle"
			>
				{#snippet icon()}
					<Wrench class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				{/snippet}
				{#if identity.length > 0}
					<!-- Who this UNIT is — model, firmware, hardware revision, the
					     identifiers that separate two same-model twins. It is HARDWARE
					     TRIVIA, which §2 ranks below state, signal and actions, and it
					     used to sit in the status card above the network readings and
					     above every control: the first table an operator met on a dongle
					     whose mobile data was off was its firmware revision.

					     It is not a different KIND of surface from the block beneath it —
					     `identityFields` already crosses the same redaction boundary,
					     because the IMEI in it is subscriber-adjacent. Filing the two
					     together is what that shared boundary always implied. They stay
					     two BLOCKS because `firmware` is an id in both row sets and one
					     `{#each}` cannot key it twice.

					     It is `dongle-unit-*` and NOT `dongle-identity-*` so the shared
					     `IdentityBlock` above owns that vocabulary alone — one prefix
					     covering both would make "which block failed" unanswerable from
					     a selector. -->
					<DiagnosticsBlock
						diagnostics={{ rows: [] }}
						extra={identity}
						name="dongle-unit"
					/>
				{/if}
				{#if diagnostics.length > 0 || sections.diagnostics.rows.length > 0}
					<DiagnosticsBlock
						diagnostics={sections.diagnostics}
						extra={diagnostics}
						name="dongle-diagnostic-readings"
						rowPrefix="dongle-detail"
					/>
				{/if}
			</CollapsibleSection>
		{/if}

		<!-- The login, ABOVE the two blocks it gates — so the expansion reads as one
		     movement: sign in here, and the dongle's own capability and control
		     sections arrive below through the same uniform surface every other
		     reading on this dialog uses. `absent` renders zero nodes, so a device
		     with no admin-auth surface is byte-unchanged by this mount. -->
		<ModemLockSection {deviceId} {lock} />

		{#if netMode}
			<!-- Discovered FIRST, offered second, through the SHARED four-state
			     ladder. The refusal arm carries NO control of any kind — the chips are
			     `children`, which render at `available` alone — so a firmware that
			     declined to name its catalog (the bench unit's own 112008) says so in
			     its own words rather than being handed a chip that fails on click.
			     Only the reported arm is selectable, and even then the device
			     re-checks the same capability before it writes. -->
			<div class="space-y-3 border-t pt-5">
				<CapabilitySection
					name="dongle-net-mode"
					view={netModeView}
					title={m["network.routerCellular.netMode.title"]()}
					description={netMode.selectable
						? m["network.routerCellular.netMode.selectNote"]()
						: m["network.routerCellular.netMode.readOnlyNote"]()}
					reason={netMode.reason}>
						<ul class="flex flex-wrap gap-1.5" data-testid="dongle-net-mode-list">
							{#each netMode.modes as mode (mode.id)}
								<li>
									<button
										class="rounded-md border px-2 py-0.5 font-mono text-xs transition-colors disabled:opacity-60 {mode.current
											? 'border-primary/50 bg-primary/10 text-primary'
											: 'text-muted-foreground hover:border-primary/40 hover:text-foreground'}"
										data-current={mode.current ? 'true' : undefined}
										data-named={mode.named ? 'true' : 'false'}
										data-pending={pendingMode === mode.id ? 'true' : undefined}
										data-testid={`dongle-net-mode-${mode.id}`}
										disabled={mode.current || busy}
										onclick={() => applyNetMode(mode.id)}
										type="button"
									>
										{mode.label}{#if mode.current}<span class="ms-1.5 font-sans"
												>{m["network.routerCellular.netMode.current"]()}</span
											>{/if}
									</button>
								</li>
							{/each}
						</ul>
				</CapabilitySection>

				<!-- LR-1: mounted with the surface, not with the outcome — and OUTSIDE
				     the section, so the regions exist in the refusal arm too. A region
				     created when the answer arrives announces nothing. -->
				<MutationOutcomeBand
					name="dongle-mode-write"
					outcome={outcomeOnNetMode ? outcome : undefined}
				/>
			</div>
		{/if}

		{#if controls}
			<div class="space-y-5 border-t pt-5">
				<CapabilitySection
					name="dongle-controls" icon={Sliders} class="space-y-5"
					view={cardView(true)}
					title={m["network.routerCellular.control.title"]()}
					description={m["network.routerCellular.control.verifiedNote"]()}>
					<div
						class="flex items-start justify-between gap-4"
						data-testid="dongle-control-mobile_data"
						data-checked={deviceValue('mobile_data') ? 'true' : 'false'}
						data-pending={pending === 'mobile_data' ? 'true' : undefined}
					>
						<div class="min-w-0 space-y-0.5">
							<Label class="text-sm font-medium" for="dongle-mobile-data">
								{m["network.routerCellular.control.mobileData"]()}
							</Label>
							<p class="text-muted-foreground text-xs">
								{m["network.routerCellular.control.mobileDataDesc"]()}
							</p>
						</div>
						<LabeledSwitch
							checked={deviceValue('mobile_data')}
							disabled={busy}
							label={m["network.routerCellular.control.mobileData"]()}
							onCheckedChange={(v) => apply('mobile_data', v)}
						/>
					</div>

					<div
						class="flex items-start justify-between gap-4"
						data-testid="dongle-control-roaming_autoconnect"
						data-checked={deviceValue('roaming_autoconnect') ? 'true' : 'false'}
						data-pending={pending === 'roaming_autoconnect' ? 'true' : undefined}
					>
						<div class="min-w-0 space-y-0.5">
							<Label class="text-sm font-medium" for="dongle-roaming">
								{m["network.routerCellular.control.roaming"]()}
							</Label>
							<p class="text-muted-foreground text-xs">
								{m["network.routerCellular.control.roamingDesc"]()}
							</p>
						</div>
						<LabeledSwitch
							checked={deviceValue('roaming_autoconnect')}
							disabled={busy}
							label={m["network.routerCellular.control.roaming"]()}
							onCheckedChange={(v) => apply('roaming_autoconnect', v)}
						/>
					</div>
				</CapabilitySection>

				<!-- LR-1: mounted with the surface, not with the outcome. -->
				<MutationOutcomeBand
					name="dongle-control-write"
					outcome={outcomeOnNetMode ? undefined : outcome}
				/>
			</div>
		{:else}
			<!-- WHY there is no control here is TWO different facts, and they must not
			     share a sentence. A signed-out dongle withholds its operation blocks
			     (`gateRouterAdminByLock`), so "nothing here applies a setting we could
			     verify" would be a true statement about a device we have not asked
			     yet — and it would send the operator looking for a hardware
			     limitation instead of at the login directly above. -->
			<div
				class="bg-status-info/10 border-status-info/30 flex items-start gap-3 rounded-lg border p-3"
				data-testid="dongle-no-controls"
				data-locked={controlsLocked ? 'true' : undefined}
				role="status"
			>
				<Info class="text-status-info mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<p class="text-muted-foreground text-xs">
					{controlsLocked
						? m["network.routerCellular.lock.controlsWithheld"]()
						: m["network.routerCellular.control.none"]()}
				</p>
			</div>
		{/if}

		<!-- The SAME section the MM dialog mounts, not a router-flavoured copy of
		     it. A claim that only one family's dialog knows how to render is a
		     claim half the fleet can never act on, and `absent` renders zero nodes —
		     so a dongle that reports no receiver is byte-unchanged by this mount. -->
		<ModemGpsSection claim={gpsClaim} {deviceId} />

		{#if admin}
			<!-- Three operations, three different answers: a proven action, a
			     journaled one behind a confirmation, and two no provider ships at
			     all. The third is STATED rather than omitted — an operator who came
			     looking for the Wi-Fi switch the vendor's own page has needs to be
			     told this device will not offer one. -->
			<div class="space-y-4 border-t pt-5">
				<CapabilitySection
					name="dongle-actions" icon={Wrench} class="space-y-4"
					view={cardView(true)}
					title={m["network.routerCellular.actions.title"]()}
					description={m["network.routerCellular.actions.description"]()}>
					<!-- The address is stated, and the page it names is reachable through
					     CeraUI's own proxy rather than by linking to it: the operator's
					     browser is not on the dongle's network. The proxy is addressed by
					     `deviceId`, which resolves to an INTERFACE — an address would name
					     both units of an identical pair. -->
					<p class="text-muted-foreground/80 text-xs" data-testid="dongle-admin-note">
						{#if admin.reachable}
							{m["network.routerCellular.adminAt"]({ url: admin.admin_url })}
						{:else}
							{m["network.routerCellular.adminUnreachable"]()}
						{/if}
					</p>
					<Button
						class="w-fit gap-1"
						data-testid="dongle-open-admin"
						size="sm"
						variant="outline"
						onclick={openAdmin}
					>
						<ExternalLink class="size-3.5" aria-hidden="true" />
						{m["network.routerCellular.adminOpen"]()}
					</Button>

					<!-- The ONE journaled write here, and the only one that can cost the
					     path to the device receiving it — so it is deliberately not a
					     switch. The device re-checks everything this validates. -->
					<div class="border-t pt-4">
						<CapabilitySection
							name="dongle-subnet"
							view={subnetView}
							title={m["network.routerCellular.subnet.title"]()}
							description={m["network.routerCellular.subnet.description"]()}
							busy={subnetBusy}
							outcome={subnetBand}>
							<div class="space-y-3" data-testid="dongle-subnet-form">
								<div class="space-y-1.5">
									<Label class="text-xs" for="dongle-subnet-address">
										{m["network.routerCellular.subnet.addressLabel"]()}
									</Label>
									<Input
										autocomplete="off"
										class="font-mono"
										data-testid="dongle-subnet-address"
										disabled={subnetBusy}
										id="dongle-subnet-address"
										placeholder={m["network.routerCellular.subnet.addressPlaceholder"]()}
										bind:value={subnetTarget}
									/>
									{#if subnetTarget.trim() !== '' && !subnetTargetValid}
										<p class="text-status-warning text-xs" data-testid="dongle-subnet-invalid">
											{m["network.routerCellular.subnet.addressInvalid"]()}
										</p>
									{/if}
								</div>

								{#if subnetConfirming}
									<div
										aria-labelledby="dongle-subnet-confirm-title"
										class="bg-status-warning/10 border-status-warning/30 space-y-3 rounded-lg border p-3"
										data-testid="dongle-subnet-confirm"
										role="group"
									>
										<div class="flex items-start gap-2">
											<TriangleAlert
												class="text-status-warning mt-0.5 size-4 shrink-0"
												aria-hidden="true"
											/>
											<div class="min-w-0 space-y-1">
												<p class="text-sm font-medium" id="dongle-subnet-confirm-title">
													{m["network.routerCellular.subnet.confirmTitle"]({
														address: subnetTarget.trim(),
													})}
												</p>
												<p class="text-muted-foreground text-xs">
													{m["network.routerCellular.subnet.confirmBody"]()}
												</p>
											</div>
										</div>
										<div class="flex flex-wrap gap-2">
											<Button
												data-testid="dongle-subnet-apply"
												disabled={subnetBusy || !subnetTargetValid}
												onclick={applySubnet}
												size="sm"
												variant="destructive"
											>
												{m["network.routerCellular.subnet.confirmAction"]()}
											</Button>
											<Button
												data-testid="dongle-subnet-cancel"
												disabled={subnetBusy}
												onclick={() => (subnetConfirming = false)}
												size="sm"
												variant="outline"
											>
												{m["dialog.cancel"]()}
											</Button>
										</div>
									</div>
								{:else}
									<Button
										class="w-fit"
										data-testid="dongle-subnet-start"
										disabled={!subnetTargetValid || subnetBusy || busy}
										onclick={() => (subnetConfirming = true)}
										size="sm"
										variant="outline"
									>
										{m["network.routerCellular.subnet.action"]()}
									</Button>
								{/if}
							</div>
						</CapabilitySection>
					</div>

					<!-- No provider in the pinned control package exposes a Wi-Fi or a
					     restart operation for any router dialect, so there is no write to
					     gate — and READING the dongle's Wi-Fi name is not evidence that
					     name can be changed. -->
					<div class="space-y-2 border-t pt-4" data-testid="dongle-unavailable-operations">
						<p class="text-sm leading-none font-medium">
							{m["network.routerCellular.unavailable.title"]()}
						</p>
						<ul class="space-y-2">
							{#each ROUTER_UNAVAILABLE_OPERATIONS as operation (operation.id)}
								<li
									class="flex items-start gap-2"
									data-testid={`dongle-unavailable-${operation.id}`}
								>
									<Ban class="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
									<div class="min-w-0 space-y-0.5">
										<p class="text-xs font-medium">{resolveMessageKey(operation.titleKey)}</p>
										<p
											class="text-muted-foreground text-xs"
											data-testid={`dongle-unavailable-${operation.id}-reason`}
										>
											{resolveMessageKey(operation.reasonKey)}
										</p>
									</div>
								</li>
							{/each}
						</ul>
					</div>
				</CapabilitySection>
			</div>
		{/if}
	</div>
</AppDialog>
