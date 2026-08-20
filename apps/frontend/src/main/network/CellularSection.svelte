<!--
  CellularSection — one calm summary row per cellular device, whatever it is.

  Ground Control language (`.impeccable.md`): the row is a DISPLAY, not a form.
  Status is primary — carrier, state dot, class band, lifecycle word, slot, a
  qualitative signal glyph — and every piece of configuration lives behind the
  row's focused dialog (Design Principle 3: no inline mega-forms).

  Three rules carry it, and all three are about honesty rather than layout:

  1. EVERY device renders a row. An MM-managed radio, a `router-ethernet`
     dongle running its own embedded router, and a transport this build does
     not recognise all appear. A device we cannot control is DIMMED and its
     controls are DISABLED WITH A VISIBLE REASON — never dropped from the list,
     which is how "my modem disappeared" becomes the way an operator finds out
     their dongle is router-managed.
  2. NO DISABLED CONTROL IS BARE. Every reason renders as an on-screen line as
     well as the control's accessible name, because the device ships with a
     kiosk touchscreen that cannot hover to reveal a tooltip (todo 19's
     `netif-dongle-blocked-hint` precedent, same rule, same styling).
  3. ABSENCE IS RENDERED AS ABSENCE. A router dongle reports no radio status at
     all — the backend deliberately omits the block rather than fabricating a
     zeroed one — so this row draws NO signal glyph for it. An empty meter would
     read as "no signal" on a dongle that is carrying traffic.

  Per-link TELEMETRY is still not here: `BondedLinksSection` remains the sole
  owner of RTT / NAK / weight / throughput on this destination, and the T20 pass
  removed this section's numeric signal readout for that reason. The glyph below
  is a qualitative tier with a word behind it and carries no `data-live-value` —
  it duplicates no number rendered anywhere else on the page.

  ────────────────────────────────────────────────────────────────────────────
  PRIMARY vs SECONDARY (todo 64)
  ────────────────────────────────────────────────────────────────────────────

  Ten todos deposited a fact each on this row and nobody ever removed one, so a
  seven-device bench rendered an 864px wall: a class band repeated verbatim on
  every row, a `·`-joined inventory strip carrying IMEI/serial/firmware, and a
  140-character sentence about a web interface the operator is not on. The one
  line that mattered — "The carrier doesn't allow service in this area for this
  SIM." — was the shortest thing on screen.

  So the row now answers exactly four questions inline, and files the rest:

    PRIMARY (always) — WHICH device (name, slot), WHAT is it doing (state,
      carrier, an outstanding lock, roaming when it is genuinely roaming), HOW
      IS THE RADIO (the signal glyph), and WHY IS THIS NOT WORKING (every
      reason line, unabridged).
    SECONDARY (one per-row "Details" disclosure) — the class band and its
      explanation, the hardware/technology detail line, the dongle's own admin
      readings, and where its web interface lives.

  Two of those placements are deliberate judgement calls rather than a rule:

  1. THE REASON LINES DO NOT FOLD. They are the "why isn't this working"
     content, and every one of them is also a DISABLED CONTROL'S reason — rule
     2 above requires those on screen, because the shipped kiosk touchscreen
     cannot hover to reveal a tooltip. Folding them would trade a real honesty
     invariant for a few pixels.
  2. THE ROAMING BADGE DOES NOT FOLD, but nothing else about roaming is inline.
     It renders only while the modem is ACTUALLY roaming, i.e. only while money
     is being spent — a conditional pill that appears solely under a real,
     costly condition is the definition of relevant. Its explanation still
     lives in the badge's own hint.

  NOTHING IS DELETED. Every fact the pre-todo-64 row rendered is still on this
  page, one tap away, and the disclosure body stays in the DOM (clipped +
  `inert`) so it is one paint away rather than one fetch away.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { Modem, NetifMessage } from '@ceraui/rpc/schemas';
import {
	Check,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	CircleHelp,
	CircleOff,
	Globe,
	Hourglass,
	Lock,
	Radio,
	RadioTower,
	Router,
	SignalHigh,
	SignalLow,
	SignalMedium,
	SignalZero,
} from '@lucide/svelte';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import { Button } from '$lib/components/ui/button';
import { cn } from '$lib/utils';
import type { ModemRowState, ModemRowTone, ModemSignalTier } from './cellular-row';
import {
	availabilityReasonKey,
	bondDisabledReasonKey,
	carrierLabel,
	classHintKey,
	classLabelKey,
	configureDisabledReasonKey,
	detailLine,
	isRoamingActive,
	lockBadgeLock,
	primaryLabel,
	registrationRejectionKey,
	resolveClassBand,
	resolveRowAction,
	resolveRowState,
	resolveSignalTier,
	routerAdminConnectionKey,
	routerAdminSignal,
	routerAdminSimKey,
	rowNoteKeys,
	signalLabelKey,
	slotBadgeLabel,
	stateLabelKey,
	stateTone,
} from './cellular-row';
import type { RouterSignalReadout } from './router-signal';
import {
	isStaleReadout,
	resolveRouterSignalReadout,
	routerSignalMetricRows,
	routerSignalStateKey,
} from './router-signal';

interface Props {
	modemEntries: [string, Modem][];
	/** Live per-interface telemetry; supplies bond state (`enabled`/`ip`). */
	netif: NetifMessage | undefined;
	/** Whole-app staleness latch: the WS has been down past the global threshold. */
	isFullyStale: boolean;
	/** ifnames whose own telemetry aged out while siblings stayed fresh (Task 22). */
	staleInterfaces: Set<string>;
	/**
	 * The cellular composition root has not committed a backend yet, so the modem
	 * list is legitimately empty and every `modems.*` procedure is refusing with
	 * `CELLULAR_STACK_INITIALIZING`. Default `false` keeps every existing mount
	 * (and every existing test) byte-identical.
	 */
	cellularInitializing?: boolean;
	/**
	 * Opens the row's destination. The row does NOT decide which dialog that is —
	 * `NetworkView` routes on the same lock the button was labelled from, so the
	 * label and the destination cannot drift apart.
	 */
	onConfigure: (id: string) => void;
}

const {
	modemEntries,
	netif,
	isFullyStale,
	staleInterfaces,
	cellularInitializing = false,
	onConfigure,
}: Props = $props();

const t = resolveMessageKey;

// Every state carries its own WORD and its own GLYPH; colour only reinforces
// them (the `EthernetSection` dongle-row rule). All static — no animation — so
// the e-ink freeze has nothing to still and the row reads on a paper display.
const STATE_ICON = {
	connected: Check,
	connecting: Hourglass,
	disconnecting: Hourglass,
	registered: Hourglass,
	searching: Hourglass,
	scanning: Hourglass,
	enabled: Radio,
	enabling: Hourglass,
	disabling: Hourglass,
	initializing: Hourglass,
	disabled: CircleOff,
	failed: CircleAlert,
	locked: Lock,
	'no-sim': CircleOff,
	'router-up': Check,
	'router-acquiring': Hourglass,
	'router-down': CircleAlert,
	unknown: CircleHelp,
} satisfies Record<ModemRowState, unknown>;

const TONE_BADGE: Record<ModemRowTone, 'success' | 'warning' | 'error' | 'neutral'> = {
	live: 'success',
	pending: 'warning',
	attention: 'warning',
	error: 'error',
	idle: 'neutral',
};

const TONE_DOT: Record<ModemRowTone, string> = {
	live: 'bg-primary',
	pending: 'bg-status-warning',
	attention: 'bg-status-warning',
	error: 'bg-status-error',
	idle: 'bg-muted-foreground/40',
};

const SIGNAL_ICON = {
	high: SignalHigh,
	medium: SignalMedium,
	low: SignalLow,
	none: SignalZero,
} satisfies Record<ModemSignalTier, unknown>;

const SIGNAL_COLOR: Record<ModemSignalTier, string> = {
	high: 'text-signal-good',
	medium: 'text-signal-fair',
	low: 'text-signal-weak',
	none: 'text-muted-foreground',
};

// A router dongle's reading comes from ITS OWN web admin API over a USB LAN
// link — a different instrument from ModemManager's radio stack, which is why
// todo 20's model carries `provenance` at all. The glyph a non-reading draws is
// therefore chosen to say WHICH kind of nothing it is: a refused session is a
// lock, an unanswered device is an alert, a blank field is a question, and a
// field this dialect cannot express at all is simply switched off.
const ROUTER_SIGNAL_STATE_ICON = {
	'no-sim': CircleOff,
	unsupported: CircleOff,
	'not-reported': CircleHelp,
	malformed: CircleAlert,
	'auth-expired': Lock,
	unreachable: CircleAlert,
} as const;

function routerSignalIcon(readout: RouterSignalReadout) {
	if (readout.kind === 'reading') return SIGNAL_ICON[readout.tier];
	if (readout.kind === 'no-sim') return ROUTER_SIGNAL_STATE_ICON['no-sim'];
	return ROUTER_SIGNAL_STATE_ICON[readout.reason];
}

/**
 * A carried-over reading is drawn WITHOUT its tier colour, and that is the
 * point rather than styling: todo 20 re-serves one cycle's last LIVE value so a
 * single missed 30 s poll does not blank the row, but a carried value is not a
 * measurement. Painting it phosphor-lime would present the past as the present.
 */
function routerSignalColor(readout: RouterSignalReadout): string {
	if (readout.kind !== 'reading' || readout.freshness !== 'live') {
		return 'text-muted-foreground';
	}
	return SIGNAL_COLOR[readout.tier];
}

// `size="micro"` cannot deliver its own font size on a COLOURED badge — `cn()`
// files the custom `text-micro` utility under text-COLOUR, where the
// `text-status-*` class that follows it wins. Passing the SAME design token as a
// typed arbitrary value lands it in the font-size group instead. The Badge-level
// defect is app-wide, not this section's (todo 19).
const MICRO_TEXT = 'text-(length:--text-micro)';

// One ordered fact strip for a router dongle's admin readings, so the separator
// belongs to the LIST rather than to each item — appending "·" per segment left
// a dangling one whenever the last optional field was absent, which is most
// rows. A segment exists only when the device actually reported its field.
type AdminSegment = { id: string; label: string; value?: string };

function buildAdminSegments(modem: Modem): AdminSegment[] {
	const segments: AdminSegment[] = [];
	const simKey = routerAdminSimKey(modem);
	if (simKey) segments.push({ id: 'router-admin-sim', label: t(simKey) });
	const connectionKey = routerAdminConnectionKey(modem);
	if (connectionKey)
		segments.push({ id: 'router-admin-connection', label: t(connectionKey) });
	// The legacy bar scalars are SUPERSEDED by todo 20's normalized model, never
	// shown beside it: they are the same probe's reading of the same two fields,
	// so rendering both prints one fact twice — and only the model can say
	// whether a missing bar count means "this API has no such field", "the device
	// said nothing", or "it never answered".
	const signal = modem.router_admin?.signal ? undefined : routerAdminSignal(modem);
	if (signal)
		segments.push({
			id: 'router-admin-signal',
			label: m["network.routerCellular.signalBars"]({
				bars: signal.bars,
				max: signal.max,
			}),
		});
	const apn = modem.router_admin?.apn;
	if (apn)
		segments.push({
			id: 'router-admin-apn',
			label: m["network.routerCellular.apnLabel"](),
			value: apn,
		});
	const firmware = modem.router_admin?.firmware;
	if (firmware)
		segments.push({
			id: 'router-admin-firmware',
			label: m["network.routerCellular.firmwareLabel"](),
			value: firmware,
		});
	// The fields that separate two units of the SAME model — this bench has such
	// a pair, and on every other surface they are the same word. The IMEI leads
	// because it is stamped on the hardware, so it is the one an operator can
	// match against the unit in their hand.
	const imei = modem.router_admin?.imei;
	if (imei)
		segments.push({
			id: 'router-admin-imei',
			label: m["network.routerCellular.imeiLabel"](),
			value: imei,
		});
	const serial = modem.router_admin?.serial;
	if (serial)
		segments.push({
			id: 'router-admin-serial',
			label: m["network.routerCellular.serialLabel"](),
			value: serial,
		});
	return segments;
}

// Per-row disclosure state, keyed on the roster id (unique by construction —
// `modemEntries` is an entry list). A row that leaves the roster simply stops
// being read; a stale `true` for an id that returns later is harmless and, if
// anything, correct (the operator asked to see that device's detail).
let openDetails = $state<Record<string, boolean>>({});

function toggleDetails(rowId: string): void {
	openDetails = { ...openDetails, [rowId]: !openDetails[rowId] };
}
</script>

<!-- ───────────── Cellular ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<Radio aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m["network.view.cellular"]()}</h2>
	</div>
	{#if cellularInitializing}
		<!-- Calm, not alarming: nothing is broken, the stack simply has not
		     committed a backend yet. It renders whatever the roster looks like —
		     an empty list during the window is expected, and a partially-populated
		     one must still be explained rather than left to read as complete. -->
		<div
			class="bg-muted/40 flex items-start gap-3 border-b px-4 py-3"
			data-testid="cellular-initializing"
			role="status"
		>
			<Hourglass class="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<div class="min-w-0">
				<p class="text-sm font-medium">{m["network.cellular.initializingTitle"]()}</p>
				<p class="text-muted-foreground mt-0.5 text-xs">
					{m["network.cellular.initializingBody"]()}
				</p>
			</div>
		</div>
	{/if}
	<div class="divide-y">
		{#if modemEntries.length === 0}
			{#if !cellularInitializing}
				<p class="text-muted-foreground px-4 py-6 text-center text-sm">
					{m["network.view.noModems"]()}
				</p>
			{/if}
		{:else}
			{#each modemEntries as [id, modem], _i (modem.ifname || id + '-' + _i)}
				{@const band = resolveClassBand(modem.device_class)}
				{@const state = resolveRowState(modem, band)}
				{@const tone = stateTone(state)}
				{@const primary = primaryLabel(modem, id)}
				{@const detail = detailLine(modem, primary)}
				{@const slot = slotBadgeLabel(modem, primary)}
				{@const signal = resolveSignalTier(modem.status?.signal)}
				{@const reasonKey = availabilityReasonKey(modem.availability_reason)}
				{@const entry = netif?.[modem.ifname]}
				{@const bondBlockedKey = bondDisabledReasonKey(modem, band, state, Boolean(entry?.ip))}
				{@const configBlockedKey = configureDisabledReasonKey(band, modem)}
				{@const rowAction = resolveRowAction(modem, band)}
				{@const lockBadge = lockBadgeLock(modem, state)}
				{@const roaming = isRoamingActive(modem)}
				{@const carrier = carrierLabel(modem)}
				{@const rejectionKey = registrationRejectionKey(modem)}
				{@const notes = rowNoteKeys({
					rejection: rejectionKey,
					availability: reasonKey,
					bond: bondBlockedKey,
					configure: configBlockedKey,
				})}
				<!-- A device this stack does not control is DIMMED, never hidden. The
				     dimming lands on the identity text only — the note lines beneath
				     it are the one thing that must stay fully legible. -->
				{@const unavailable = configBlockedKey !== undefined}
				{@const ifaceStale = staleInterfaces.has(modem.ifname) || isFullyStale}
				{@const showStale = ifaceStale && state !== 'no-sim' && modem.status !== undefined}
				{@const StateIcon = STATE_ICON[state]}
				<!-- Single-line summary: identity + honest bands left; controls right. -->
				{@const admin = modem.router_admin}
				{@const adminSegments = buildAdminSegments(modem)}
				{@const routerSignal = resolveRouterSignalReadout(modem)}
				{@const routerSignalModel = admin?.signal}
				{@const detailsOpen = openDetails[id] === true}
				{@const detailsId = `modem-details-${id}`}
				<div
					class="px-4 py-2.5"
					data-testid="modem-row"
					data-modem-id={id}
					data-ifname={modem.ifname}
					data-class-band={band}
					data-modem-state={state}
					data-details-open={detailsOpen ? 'true' : 'false'}
					data-unavailable={unavailable ? 'true' : undefined}
				>
				<div class="flex flex-wrap items-center gap-3">
					<!-- Bound to the FIRST text line, not to the row's centre: a row with
					     note lines is tall, and a vertically-centred dot floats away from
					     the name it is reporting on. -->
					<span
						class={cn('mt-1.5 size-2 shrink-0 self-start rounded-full', TONE_DOT[tone])}
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						<p
							class={cn(
								'truncate text-sm font-medium',
								unavailable && 'text-muted-foreground',
							)}
							data-testid="modem-name"
						>
							{primary}
						</p>
						<!-- Which slot it is in, where it is in its lifecycle, and who it is
						     registered with. The CLASS band moved into the disclosure at
						     todo 64: it says the same word on nearly every row, an operator
						     cannot act on it, and it was the single most-repeated pill on a
						     seven-device bench. -->
						<div class="mt-0.5 flex flex-wrap items-center gap-1.5">
							{#if slot}
								<Badge
									variant="neutral"
									size="micro"
									class={MICRO_TEXT}
									data-testid="modem-slot-badge"
									label={slot}
								/>
							{/if}
							<Badge
								variant={TONE_BADGE[tone]}
								size="micro"
								class={MICRO_TEXT}
								data-testid="modem-state-badge"
								data-modem-state={state}
							>
								<StateIcon class="size-3" aria-hidden="true" />
								{t(stateLabelKey(state))}
							</Badge>
							<!-- A non-blocking lock no longer speaks over the radio's state, so
							     it gets its own pill: the row must stay the surface an operator
							     discovers an outstanding lock from (todo 46). -->
							{#if lockBadge}
								<Badge
									variant="warning"
									size="micro"
									class={MICRO_TEXT}
									data-testid="modem-lock-badge"
									data-sim-lock={lockBadge}
								>
									<Lock class="size-3" aria-hidden="true" />
									{t('network.cellular.state.locked')}
								</Badge>
							{/if}
							<!-- The carrier is a STATUS fact and lives with the other status
							     facts. It used to be the row's TITLE, which pushed the device
							     and its identifier out of the headline the moment a radio
							     registered — the operator could no longer tell which of two
							     identical units was the live one. As a pill it is beside the
							     state it belongs with, and it can never cover the name. -->
							{#if carrier}
								<Badge
									variant="neutral"
									size="micro"
									class={MICRO_TEXT}
									data-testid="modem-carrier-badge"
									data-carrier={carrier}
								>
									<RadioTower class="size-3" aria-hidden="true" />
									{carrier}
								</Badge>
							{/if}
							<!-- Roaming is a BILLING fact, not a fault: an `info` pill beside the
							     state, never a warning tone over it, and nothing about this row's
							     controls changes because of it. It retracts itself the moment the
							     modem reports it stopped roaming (todo 40). -->
							{#if roaming}
								<Badge
									variant="info"
									size="micro"
									class={MICRO_TEXT}
									data-testid="modem-roaming-badge"
									data-roaming="true"
									title={t('network.cellular.roaming.hint')}
								>
									<Globe class="size-3" aria-hidden="true" />
									{t('network.cellular.roaming.badge')}
								</Badge>
							{/if}
							<!-- A SECOND instrument, and it must never be mistaken for the
							     first. It lives HERE — inline with the other facts the DEVICE
							     reported — rather than beside the MM tier glyph in the control
							     cluster on the right, for two reasons. Most of its states carry
							     a WORD, and the control cluster does not wrap (`shrink-0`), so
							     at 390px a long one pushed Configure clean off the screen; and
							     the separation is itself the provenance distinction, since the
							     radio's own magnitude keeps the instrument column while this
							     second-hand reading sits with the reported facts.

							     `signal === undefined` states the exclusion rather than relying
							     on the two payloads never overlapping: an MM row has no
							     `router_admin` and a router row has no `status`, but one row
							     drawing two signal readings would be the exact conflation the
							     model's `provenance` field exists to prevent, so it is guarded
							     and covered in both directions by test.

							     The provenance is carried three ways, because a tooltip is
							     unreachable on the shipped kiosk touchscreen: a visible router
							     mark, a DASHED frame (the "this is not the primary instrument"
							     vocabulary the encoder rows already use for a leader), and
							     `data-provenance` for machines. A READING is glyph-only, exactly
							     like the MM glyph; every non-reading carries its word, because a
							     state behind a bare mark is a state nobody can read. There is no
							     spinner in either arm: a poll that has not answered yet is
							     `not-reported`, which is a fact rather than a wait. -->
							{#if signal === undefined && routerSignal}
								{@const RouterSignalIcon = routerSignalIcon(routerSignal)}
								{@const stale = isStaleReadout(routerSignal)}
								<span
									class={cn(
										'inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5',
										routerSignalColor(routerSignal),
									)}
									data-testid="modem-router-signal"
									data-provenance={routerSignal.provenance}
									data-signal-state={routerSignal.kind}
									data-freshness={routerSignal.freshness}
									data-signal-tier={routerSignal.kind === 'reading'
										? routerSignal.tier
										: undefined}
									data-unknown-reason={routerSignal.kind === 'unknown'
										? routerSignal.reason
										: undefined}
									data-live={routerSignal.kind === 'reading' &&
									routerSignal.freshness === 'live'
										? 'true'
										: 'false'}
									title={m["network.routerCellular.signal.provenanceNote"]()}
								>
									<Router class="size-3 shrink-0" aria-hidden="true" />
									<RouterSignalIcon class="size-3.5 shrink-0" aria-hidden="true" />
									<span
										class={routerSignal.kind === 'reading' ? 'sr-only' : MICRO_TEXT}
										data-testid="modem-router-signal-state"
									>
										{t(routerSignalStateKey(routerSignal))}
									</span>
									{#if stale}
										<span class={MICRO_TEXT} data-testid="modem-router-signal-stale">
											{m["network.routerCellular.signal.stale"]()}
										</span>
									{/if}
								</span>
							{/if}
						</div>
						<!-- Why this device's controls are what they are, on screen — a
						     machine token is never rendered raw, and a reason shared by two
						     controls is stated once. These stay INLINE at any density: each
						     one is a disabled control's reason, and the kiosk touchscreen
						     has no hover to reveal it anywhere else. -->
						{#each notes as noteKey (noteKey)}
							<p
								class="text-muted-foreground/80 mt-0.5 text-xs"
								data-testid="modem-note"
								data-note-key={noteKey}
							>
								{t(noteKey)}
							</p>
						{/each}
					</div>
					<div class="ms-auto flex shrink-0 items-center gap-2">
						{#if signal}
							{@const SignalIcon = SIGNAL_ICON[signal]}
							<!-- Qualitative tier with a word behind it — no digits, no
							     `data-live-value`, so it duplicates no BondedLinks number. -->
							<span
								class={cn('inline-flex items-center', SIGNAL_COLOR[signal])}
								data-testid="modem-signal"
								data-signal-tier={signal}
								role="img"
								aria-label={t(signalLabelKey(signal))}
								title={t(signalLabelKey(signal))}
							>
								<SignalIcon class="size-4" aria-hidden="true" />
							</span>
						{/if}
						{#if showStale}
							<Badge variant="stale" data-stale-interface={modem.ifname} />
						{/if}
						<!-- The SECOND button todo 64 asked for. It sits with the read
						     affordances rather than with the mutating ones, and it is
						     LABELLED rather than a bare chevron — the operator has to be
						     able to tell that there is more here, or "reorganised" is
						     indistinguishable from "deleted". -->
						<Button
							class="h-8 min-h-[var(--touch-target-min)] gap-1 px-2.5"
							aria-controls={detailsId}
							aria-expanded={detailsOpen}
							data-testid="modem-details-toggle"
							size="sm"
							variant="ghost"
							onclick={() => toggleDetails(id)}
						>
							{m["network.cellular.details.toggle"]()}
							<ChevronDown
								class={cn('size-3.5 transition-transform', detailsOpen && 'rotate-180')}
								aria-hidden="true"
							/>
						</Button>
						<!-- ALWAYS rendered, disabled-with-reason when it cannot be live.
						     An absent toggle makes "this link cannot bond" indistinguishable
						     from "this link is not a bonding candidate at all". -->
						<BondToggle
							name={modem.ifname}
							enabled={bondBlockedKey ? false : (entry?.enabled ?? false)}
							ip={entry?.ip}
							disabledReason={bondBlockedKey ? t(bondBlockedKey) : undefined}
						/>
						<!-- A blocking lock RENAMES this control rather than quietly
						     repurposing it: until the card is unlocked the radio cannot
						     register, so "Configure" would open a form that can apply
						     nothing. The testid follows the action so a spec cannot
						     assert one while the operator sees the other. -->
						<Button
							class="h-8 min-h-[var(--touch-target-min)] gap-1 px-2.5"
							data-testid={rowAction === 'unlock'
								? 'open-modem-unlock-dialog'
								: 'open-modem-config-dialog'}
							data-row-action={rowAction}
							size="sm"
							variant={rowAction === 'unlock' ? 'outline' : 'ghost'}
							disabled={configBlockedKey !== undefined}
							aria-label={configBlockedKey ? t(configBlockedKey) : undefined}
							title={configBlockedKey ? t(configBlockedKey) : undefined}
							onclick={() => onConfigure(id)}
						>
							{#if rowAction === 'unlock'}
								<Lock class="size-3.5" aria-hidden="true" />
								{m["network.cellular.unlockAction"]()}
							{:else}
								{m["network.view.configure"]()}
							{/if}
							<ChevronRight class="size-3.5 rtl:rotate-180" />
						</Button>
					</div>
				</div>

				<!-- Everything the row used to say inline and no longer needs to. Same
				     CSS `grid-template-rows: 0fr → 1fr` reveal the SMS card uses (todo
				     39): a JS transition compiles to the Web Animations API and escapes
				     both the reduced-motion and the e-ink freezes, so this is driven
				     from CSS. The body stays MOUNTED and goes `inert` while collapsed —
				     none of this is sensitive, so keeping it in the DOM makes it one
				     paint away instead of one fetch away, and `inert` is what stops a
				     keyboard operator falling into a panel they cannot see. -->
				<div
					class="grid transition-[grid-template-rows] duration-200 ease-out"
					data-testid="modem-details-body"
					data-open={detailsOpen ? 'true' : 'false'}
					id={detailsId}
					inert={!detailsOpen}
					style:grid-template-rows={detailsOpen ? '1fr' : '0fr'}
				>
					<div class="min-h-0 overflow-hidden">
						<div class="mt-2 space-y-1.5 border-t pt-2 ps-5">
							<!-- The class band's explanation was only ever a `title`, which
							     the shipped kiosk touchscreen can never reveal. Down here
							     there is room to simply print it. -->
							<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
								<Badge
									variant="info"
									size="micro"
									class={MICRO_TEXT}
									data-testid="modem-class-badge"
									data-class-band={band}
									label={t(classLabelKey(band))}
								/>
								<p class="text-muted-foreground/80 min-w-0 flex-1 text-xs">
									{t(classHintKey(band))}
								</p>
							</div>
							{#if detail}
								<p
									class={cn(
										'text-muted-foreground text-xs transition-opacity',
										ifaceStale && 'opacity-50',
									)}
									data-testid="modem-detail"
								>
									{detail}
								</p>
							{/if}
							<!-- What the dongle itself said. This row has no `status` block
							     by construction, so without it an operator cannot tell a
							     dongle with no SIM in it from one that is simply idle — the
							     two look identical from this side of the USB link. Every
							     segment is a real reading; an unread field renders nothing
							     rather than a placeholder. -->
							{#if adminSegments.length > 0}
								<p
									class="text-muted-foreground/80 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
									data-testid="router-admin-facts"
								>
									{#each adminSegments as segment, segmentIndex (segment.id)}
										{#if segmentIndex > 0}
											<span aria-hidden="true">·</span>
										{/if}
										<span data-testid={segment.id}>
											{segment.label}
											{#if segment.value}
												<code class="font-mono">{segment.value}</code>
											{/if}
										</span>
									{/each}
								</p>
							{/if}
							<!-- The full normalized reading, per metric, with its own unit.
							     `rsrp` is a received POWER (dBm) and the three ratios are dB —
							     folding them onto one unit is the same class of error as
							     folding `snr` into `sinr`, which the model refuses for the same
							     reason. A metric this DIALECT cannot express is ABSENT here,
							     not a dash: a dash reads as "the radio reported nothing" when
							     the truth is that the API has no such field at all. -->
							{#if routerSignalModel}
								{@const metricRows = routerSignalMetricRows(routerSignalModel)}
								<div
									class="space-y-1"
									data-testid="router-signal-detail"
									data-provenance={routerSignalModel.provenance}
									data-freshness={routerSignalModel.freshness}
								>
									<p class="text-xs font-medium">
										{m["network.routerCellular.signal.title"]()}
									</p>
									<p class="text-muted-foreground/80 text-xs">
										{m["network.routerCellular.signal.provenanceNote"]()}
									</p>
									{#if routerSignalModel.freshness === 'stale'}
										<p
											class="text-muted-foreground/80 text-xs"
											data-testid="router-signal-stale-note"
										>
											{m["network.routerCellular.signal.staleNote"]()}
										</p>
									{/if}
									{#if metricRows.length > 0}
										<dl
											class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs"
											data-testid="router-signal-metrics"
										>
											{#each metricRows as row (row.id)}
												<dt class="text-muted-foreground/80">{t(row.labelKey)}</dt>
												<dd
													class={cn(
														'min-w-0',
														row.state === 'known'
															? 'font-mono tabular-nums'
															: 'text-muted-foreground/80',
													)}
													data-testid={`router-signal-${row.id}`}
													data-metric-state={row.state}
												>
													{row.state === 'known' ? row.value : t(row.reasonKey)}
												</dd>
											{/each}
										</dl>
									{/if}
								</div>
							{/if}
							<!-- Stated, never linked: the address lives on the dongle's OWN
							     network, which the operator's browser is not on, so an anchor
							     here would be a control that cannot work — the exact defect
							     todo 47 removed from this device's other row. -->
							{#if admin}
								<p
									class="text-muted-foreground/80 text-xs"
									data-testid="router-admin-note"
									data-reachable={admin.reachable ? 'true' : 'false'}
								>
									{#if admin.reachable}
										{m["network.routerCellular.adminAt"]({ url: admin.admin_url })}
									{:else}
										{m["network.routerCellular.adminUnreachable"]()}
									{/if}
								</p>
							{/if}
						</div>
					</div>
				</div>
				</div>
			{/each}
		{/if}
	</div>
</section>
