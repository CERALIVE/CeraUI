<!--
  ModemConfigDialog.svelte — per-modem cellular configuration AND advanced detail.

  Opened from NetworkView's per-modem "Configure" trigger. One instance drives
  one modem (passed by `modem` + `deviceId`). Composes the shared AppDialog
  chrome (responsive Dialog/Sheet, RTL-safe, focus-trapped).

  This is the ADVANCED surface: `CellularSection`'s row is the calm glance, and
  everything it deliberately keeps off that row lives here — serving-cell
  telemetry, firmware, the read-only eSIM facts, the data-usage meter, and the
  USB-composition switch. Layout order follows Ground Control's dialog rule: the
  thing the operator opened it for (configuration) is reachable without
  scrolling, the read-only instrument panels sit under it, and the one
  destructive action (a mode switch that drops the link) is last.

  ...AND IT HAS ITS OWN FLOOR (todo 64)
  -------------------------------------
  "Reachable without scrolling" stopped being true. Measured on the bench board
  at the 1024x600 kiosk viewport, this dialog's body was 783px of content in a
  363px window — the operator scrolled past four instrument panels to reach a
  Save button for the APN they came to change. So the dialog now splits the same
  way the row does:

    PRIMARY — the status strip, any band that is currently true (a refused save,
      an outstanding lock, no SIM), and the settings an operator actually opens
      this dialog to change: roaming, the operator scan that follows from it,
      Automatic APN, and the manual APN + credentials behind it.
    SECONDARY — ONE "Advanced" disclosure holding the network-type lock, the
      data-usage meter and its policy, the serving-cell/firmware detail and the
      SIM identity group beside it (presence, ICCID, own number, eSIM), the SMS
      inbox, and the USB-composition switch.

  Network type is in there on purpose and it is the only CONFIGURATION control
  that moved: it is a radio-technology lock an operator sets once for a site, not
  a field they revisit — unlike the APN, which is the reason this dialog exists.

  The SMS card keeps its OWN inner fold inside the disclosure, and that nesting
  is load-bearing rather than redundant: this outer disclosure keeps its body
  MOUNTED (clipped + `inert`), while the SMS fold is `{#if}`-gated because it
  gates an expensive per-message mmcli read AND keeps one-time codes out of the
  DOM entirely. Collapsing the two into one would silently undo both.

  ADDITIVE-TOLERANT RENDERING, THROUGH ONE SHARED PRIMITIVE
  ---------------------------------------------------------
  Every card below `Save` is driven by a Phase-B additive-optional wire field.
  An older backend, and the mmcli path on ANY backend, reports none of them —
  so each card is absent ENTIRELY when its field is absent. Never an empty
  frame, never a zero, never a dash standing in for a reading: an empty framed
  section reads as a load failure, and a fabricated `0 B` tells the operator
  they used no data. `modem-detail.ts` owns those decisions so the markup below
  only has to ask "is there a view".

  Each of those cards is a `CapabilitySection` (`$lib/modem/sections`), so
  "absent" is the primitive's ZERO-NODE state rather than a per-card `{#if}`,
  and the four-state ladder — absent / unknown / blocked / available, and what
  each one may render — is stated ONCE, in a module the router dialog shares,
  instead of once per card here. Read the ladder there; the comments below state
  only what is specific to the card they sit on. The two claim-gated modules
  (location, FCC unlock) resolve their own state in their own components and
  route through the same primitive.

  No-SIM safety — ONE PREDICATE, SHARED WITH THE ROW
  --------------------------------------------------
  The banner and the disabled fieldset are driven by `isSimlessModem`
  (`main/network/cellular-row.ts`), which is the SAME function the Cellular row
  reads and which delegates to `@ceraui/rpc`'s `isSimlessForBond` — the rule the
  DEVICE's own bond gate applies. Do NOT re-derive it here.

  It used to be a second copy: `no_sim === true || status.signal == null`. Both
  halves were wrong in a different direction. The missing half is
  `router_admin.sim`, the ONLY field a `router-ethernet` dongle reports its slot
  through, so this surface could not see a SIM-less dongle at all. The extra half
  is worse: a signal reading is a fact about the RADIO, not about the slot, so a
  modem holding a perfectly good SIM that had not reported a signal yet — one
  searching, or refused by the network — had its whole configuration form
  disabled, including the APN field that is the reason an operator opens this
  dialog. A missing `status` still cannot crash the render: the shared rule reads
  `no_sim`/`router_admin.sim` optionally and answers `false` on absence, which is
  the positive-evidence-only posture the bond gate requires.

  ...AND THE BANNER IS NOT THE WHOLE STATE
  ----------------------------------------
  That predicate is BINARY because bonding is binary — a link either may join
  the pool or may not. SIM PRESENCE is not: `deriveSim` resolves four states,
  and the two the banner cannot express are the ones an operator needs most.
  `present` and `unknown` both render no banner, so a healthy slot and a slot
  nothing could read looked identical here, and the only surface that showed a
  SIM state at all was a warning that fires for one of the four.

  The SIM identity group inside the Advanced disclosure now leads with the
  SHARED `SimBlock` — the same component `RouterDongleDialog` renders — so both
  families state presence in one vocabulary, `unknown` renders as its own
  visibly distinct line rather than as a pill, and absence is claimed ONLY where
  the device positively claimed it. The banner is unchanged and still owns the
  `absent` case in the primary column, where an operator meets it first.

  APN-required-when-manual
  ------------------------
  Mirrors the backend zod refine (modems.schema.ts):
    autoconfig !== false || apn.length > 0
  When Automatic APN is off and the APN is empty, an inline error is shown and
  the primary (Save) action is disabled.
-->
<script lang="ts">
import { formatBytes, formatRelativeTime } from '@ceraui/i18n/formatters';
import {
	bandSelectionChanged,
	deriveBandOffer,
	initialBandSelection,
	toggleBand,
} from './modem-bands';
import { fiveGFailureKey, fiveGViewForModem } from './modem-five-g';
import {
	bandCapabilityView,
	fiveGCapabilityView,
	networkModeCapabilityView,
	USB_MODE_OPTIONS_UNKNOWN_KEY,
} from './modem-radio-selectors';
import {
	CYCLE_DAY_OPTIONS,
	diffUsagePolicyWireFields,
	isThresholdInvalid,
	readUsagePolicyForm,
	type UsagePolicyForm,
} from './modem-usage-policy';
import { getLocale, m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { toast } from 'svelte-sonner';
import MutationOutcomeBand from '$lib/components/custom/MutationOutcomeBand.svelte';
import ModemFccUnlockSection from './ModemFccUnlockSection.svelte';
import { fccUnlockErrorKey } from './modem-fcc-unlock';
import ModemGpsSection from './ModemGpsSection.svelte';
import ModemUssdSection from './ModemUssdSection.svelte';
import type {
	FccUnlockState,
	FiveGPreference,
	Modem,
	ModemConfigRefusal,
	ModemScanFailure,
	ModemSmsRefusal,
	SmsMessage,
	ModemBandsOutput,
	UsbCompositionMode,
	UsbModeOptionsOutput,
} from '@ceraui/rpc/schemas';
import {
	BAND_ANY,
	diffModemConnectionFields,
	normalizeModemConnectionFields,
	SMS_INBOX_CAP,
} from '@ceraui/rpc/schemas';
import {
	ChevronDown,
	Clock,
	Copy,
	Eye,
	EyeOff,
	Gauge,
	Globe,
	Inbox,
	Loader2,
	MessageSquare,
	Network as NetworkIcon,
	Power,
	Radio,
	RadioTower,
	RefreshCw,
	ShieldAlert,
	Antenna,
	Usb,
	Wrench,
	Zap,
} from '@lucide/svelte';
import { einkGatedSlide as slide } from '$lib/transitions';

import Badge from '$lib/components/custom/Badge.svelte';
import CollapsibleSection from '$lib/components/custom/CollapsibleSection.svelte';
import NoSimBadge from '$lib/components/custom/NoSimBadge.svelte';
import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import SimpleAlertDialog from '$lib/components/custom/simple-alert-dialog.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { copyToClipboard } from '$lib/helpers/clipboard';
import { modemSignal } from '$lib/helpers/signal';
import { rpc } from '$lib/rpc';
import {
	confirmOperation,
	failOperation,
	getOperationPhase,
	isOperationPending,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import {
	type ModemConfigSent,
	modemConfigEchoMatches,
} from '$lib/rpc/modem-config-echo';
import { getConfig, getIsConnected, getModems } from '$lib/rpc/subscriptions.svelte';
import {
	beginUsbModeFlow,
	canTrackUsbModeSwitch,
	displayedUsbMode,
	failUsbModeFlow,
	isUsbModeFlowBusy,
	observeUsbModeSnapshot,
	resolveUsbModeFlow,
	tickUsbModeFlow,
	type UsbModeFlow,
} from '$lib/rpc/usb-mode-flow';
import {
	deriveUsbModeOffer,
	resolveUsbModeTarget,
	usbOfferSuppressionBodyKey,
	usbOfferSuppressionKey,
} from '$lib/rpc/usb-mode-offer';
import {
	type MutationOutcome,
	type MutationOutcomeDetail,
	mutationOutcome,
} from '$lib/modem/mutation-outcome';
import { loadWithinBound, modemBoundMs } from '$lib/modem/async-surface';
import { modemRefusalCopyKey } from '$lib/modem/refusal-taxonomy';
import {
	hasNormalizedReading,
	type ModemMetricRow,
	qualityRecency,
	registrationRows,
	signalDetailRows,
	simPresenceEvidenceHint,
	SUPERSEDED_CELL_METRIC_KEYS,
} from '$lib/modem/signal-detail';
import {
	CapabilitySection,
	type CapabilityView,
	ConnectionStateBlock,
	deriveConnection,
	deriveSim,
	DiagnosticsBlock,
	readingView,
	SimBlock,
} from '$lib/modem/sections';
import { modemDiagnosticRows } from './modem-diagnostics';
import {
	accessTechnologyDisplay,
	bandDiagnosticTokens,
	bandListOperatorLabel,
	bandOperatorLabel,
	isMappedBandToken,
	MODEM_OPERATION_RECONCILIATION_KEY,
	modemWriteBand,
	networkModeOperatorLabel,
	usbModeOperatorLabel,
} from '$lib/modem/operator-labels';
import { cn } from '$lib/utils';
import {
	isSimlessModem,
	resolveClassBand,
	resolveRowState,
} from '../network/cellular-row';
import {
	cellMetricRows,
	cellObservedAtMs,
	defaultAutoApn,
	esimView,
	firmwareRevision,
	hasModemDetail,
	isStandingUsbRefusal,
	OWN_NUMBER_MASK,
	ownNumbers,
	simIccid,
	usageView,
} from './modem-detail';
import {
	POWER_UNAVAILABLE_OPERATIONS,
	radioPowerReading,
} from './modem-power-recovery';
import {
	isWithdrawingSmsRefusal,
	smsRefusalKey,
	smsWallClock,
} from './modem-sms';

interface Props {
	open?: boolean;
	modem: Modem;
	deviceId: string | number;
}

let { open = $bindable(false), modem, deviceId }: Props = $props();

// Keyed async-operation domains. Scan and configure are tracked SEPARATELY so an
// in-flight scan never gates a save and vice-versa. The `osCommand` re-entry
// guard on each key is the local anti-double-dispatch protection; a second client
// is still answered with the device's visible `already_scanning` refusal.
const scanKey = $derived(`modem-scan:${deviceId}`);
const configKey = $derived(`modem-config:${deviceId}`);

// ── No-SIM detection — the ROW's predicate, not a second one ──────────────────
// `isSimlessModem` is the one answer every cellular surface reads, and it
// delegates to `@ceraui/rpc`'s `isSimlessForBond` — the SAME rule the device's
// own bond gate applies. See the header note above for why the copy that used
// to live here (`no_sim === true || status.signal == null`) was wrong.
const noSim = $derived(isSimlessModem(modem));
const signalValue = $derived(modemSignal(modem));
// §2 tier 1. The strip used to lead with the carrier name and never state the
// connection at all, so the dialog an operator opens FROM a row badged
// "Registration denied" answered a different question than the row did — and
// the rejection sentence explaining it existed only on the row behind. This is
// the SAME derivation and the SAME component `RouterDongleDialog` renders, so
// the two families cannot describe one state in two registers.
const connectionModel = $derived(
	deriveConnection(modem, resolveRowState(modem, resolveClassBand(modem.device_class))),
);
// OL-1 again, on the status strip: `mmConvertAccessTech` passes an access
// technology it could not fold through VERBATIM, so this field is "4G" on one
// modem and `hspa-plus` on the next. A token states nothing an operator can act
// on, so the strip renders no second line at all and the raw value is relocated
// to the diagnostics block below (OL-3).
const activeNetworkType = $derived(
	accessTechnologyDisplay(modem.status?.network_type) ?? '',
);

const supportedNetworkModes = $derived(modem.network_type?.supported ?? []);

function networkModeLabel(mode: string): string {
	return networkModeOperatorLabel(
		mode,
		supportedNetworkModes.indexOf(mode),
		resolveMessageKey,
	);
}

// ── Form state ────────────────────────────────────────────────────────────────
function readModemConfig() {
	return {
		selectedNetwork: modem.network_type?.active ?? modem.network_type?.supported?.[0] ?? '',
		autoconfig: defaultAutoApn(modem.config),
		apn: modem.config?.apn ?? '',
		username: modem.config?.username ?? '',
		password: modem.config?.password ?? '',
		roaming: Boolean(modem.config?.roaming),
		network:
			!modem.config?.network || modem.config.network === ''
				? '-1'
				: String(modem.config.network),
		...readUsagePolicyForm(modem.data_usage_policy),
	};
}

/** The seed baseline the tri-state save diffs against — never a second read. */
function usagePolicyOf(form: UsagePolicyForm): UsagePolicyForm {
	return { cycleDay: form.cycleDay, thresholdGb: form.thresholdGb };
}

// `formData` is a one-shot SNAPSHOT seeded on the open edge — it is NOT live-
// synced from the `modem` prop, so an incremental `mergeModemList` broadcast can
// never clobber an in-progress edit (the configure-echo confirm below reads the
// live `modem` directly; the form keeps the operator's typed values). This is
// the save-time form guard: the snapshot of what we sent (`saveExpected`) is
// captured at dispatch, so the confirm compares against intent, not a later edit.
let formData = $state(readModemConfig());
// The usage-policy half of that snapshot, kept separately because the SAVE needs
// to know which of the two bounds the operator actually touched. A field still
// holding its seeded value is one nobody answered, and it must reach the wire as
// `undefined` (leave it alone) rather than as the `null` that clears it — the
// dialog is seeded once on the open edge, so an empty field routinely means "the
// policy block had not arrived yet", not "no limit".
let usagePolicySeed = $state<UsagePolicyForm>(usagePolicyOf(readModemConfig()));
// The config we dispatched, captured at save time; drives the echo confirm and
// is cleared once the op settles. Absent ⇒ no save in flight.
let saveExpected = $state<ModemConfigSent | undefined>(undefined);
// The latest scan generation visible when this attempt was dispatched. Only a
// newer lifecycle marker may settle it, even when the operator list is unchanged.
let scanGenerationBaseline = $state(0);

const scanning = $derived(isOperationPending(scanKey));
const scanError = $derived(getOperationPhase(scanKey) === 'failed');
const scanUnconfirmed = $derived(getOperationPhase(scanKey) === 'timed_out');
// The device's OWN typed answer, held beside the phase. The band used to print
// one generic "the scan failed" for all three: "the radio was still sweeping"
// (retry), "one is already running" (wait) and "it could not be run at all" are
// three different next steps, and collapsing them cost the operator the
// difference.
let scanFailure = $state<ModemScanFailure | undefined>(undefined);
const scanFailureKey = $derived(
	scanFailure === undefined
		? 'network.modem.scanFailed'
		: modemRefusalCopyKey(scanFailure),
);
const savePending = $derived(isOperationPending(configKey));

// The secondary surface is COLLAPSED on every open, never remembered. An
// operator who expanded it once to read a cell metric is not asking to reopen
// every future modem on the diagnostics panel.
let advancedOpen = $state(false);

// Re-seed the form from the live modem each time the dialog opens. Guarded off
// while a save is in flight so a close/reopen race can't drop the snapshot.
let prevOpen = false;
$effect(() => {
	if (open && !prevOpen && !savePending) {
		formData = readModemConfig();
		usagePolicySeed = usagePolicyOf(formData);
		saveExpected = undefined;
		scanGenerationBaseline = modem.network_scan?.generation ?? 0;
		scanFailure = undefined;
		saveRefusal = undefined;
		saveUnconfirmed = false;
		unconfirmedExpectation = undefined;
		reconcileUnresolved = false;
		advancedOpen = false;
		resetSmsInbox();
		void loadUsbModeOptions();
		bandOutcomeKey = undefined;
		bandReconciliation = undefined;
		void loadBands();
		void loadFccUnlock();
	}
	prevOpen = open;
});

// APN required when Automatic APN is disabled (mirrors backend zod refine).
const apnError = $derived(!formData.autoconfig && formData.apn.trim().length === 0);
const thresholdInvalid = $derived(isThresholdInvalid(formData.thresholdGb));
const primaryDisabled = $derived(noSim || apnError || thresholdInvalid);

// Whether the DEVICE can honour Automatic APN at all. It is a tristate and the
// arms are not interchangeable: `false` is the device saying it cannot, so the
// switch is disabled WITH ITS REASON rather than accepting a choice it would
// then discard (board-measured: the switch was turned on, the dialog reported
// success and closed, and reopening it showed the switch off again). ABSENT is
// a backend that predates the field — we were told nothing, so the control
// stays offered exactly as before.
const autoApnUnsupported = $derived(modem.config?.autoconfig_supported === false);

// Which connect-time values the pending edit would change, by the SAME rule the
// device applies (`@ceraui/rpc`) — a second copy here would let the dialog
// promise no interruption while the device causes one.
const pendingConnectChanges = $derived(
	diffModemConnectionFields(
		normalizeModemConnectionFields(modem.config ?? {}, !autoApnUnsupported),
		normalizeModemConnectionFields(
			{
				autoconfig: formData.autoconfig,
				apn: formData.apn,
				username: formData.username,
				password: formData.password,
				roaming: formData.roaming,
				network: formData.network === '-1' ? '' : formData.network,
			},
			!autoApnUnsupported,
		),
	),
);

// NetworkManager cannot hand a live bearer new gsm values (measured on the board
// against NM 1.42.4 — reapply refuses every property outside its allowlist, and
// no gsm one is on it), so a real edit on a CONNECTED modem costs a reconnect.
// Say so before the operator commits rather than letting the link drop unasked;
// with no bearer up there is nothing to interrupt and no warning to give.
const reconnectExpected = $derived(
	pendingConnectChanges.length > 0 && modem.status?.connection === 'connected',
);

// The typed refusal from the last save, held here rather than read off the
// async-op phase: that phase decays to `idle` on its own, which is how a refused
// save used to vanish before an operator could read it (the UpdatesDialog
// precedent). Cleared on the next dispatch and on the open edge.
let saveRefusal = $state<ModemConfigRefusal | undefined>(undefined);
// Resolved through the SHARED refusal taxonomy rather than interpolated into
// `saveRefused.<token>`: a seventeenth `modemConfigRefusalSchema` member used to
// render its own dotted path at the operator, and now fails the build instead.
const saveRefusalKey = $derived(
	saveRefusal === undefined ? undefined : modemRefusalCopyKey(saveRefusal),
);

// Available operators for manual selection (populated by a scan).
const availableNetworks = $derived(
	Object.entries(modem.available_networks ?? {}).filter(
		([, net]) => net.availability === 'available',
	),
);

$effect(() => {
	if (getOperationPhase(scanKey) !== 'pending') return;
	const lifecycle = modem.network_scan;
	if (lifecycle === undefined || lifecycle.generation <= scanGenerationBaseline) return;
	if (lifecycle.phase === 'completed') {
		confirmOperation(scanKey);
	} else if (lifecycle.phase === 'failed') {
		scanFailure = lifecycle.failure ?? 'failed';
		failOperation(scanKey, scanFailure);
	}
});

// The device ACCEPTED the write but never echoed it back inside the async-op
// TTL. Distinct from `saveRefusal` in both directions: nothing was refused, so
// calling it an error would be a lie, and nothing was confirmed, so closing on
// success would be the other one. It is the honest third answer, and rendering
// it is what bounds the spinner — the TTL always fires, but the phase it lands
// in used to render NOTHING, so the operator watched the spinner stop and had
// no way to tell a save that landed from one that vanished.
let saveUnconfirmed = $state(false);
// A refusal OUTRANKS it, and the guard has to be derived rather than a branch in
// the effect: `osCommand`'s await lets Svelte flush between the op failing and
// `handleSave` naming the reason, so an effect that read `saveRefusal` would
// read it one microtask too early and band the same save twice.
const showSaveUnconfirmed = $derived(saveUnconfirmed && saveRefusal === undefined);

// The echo baseline RETAINED past the unconfirmed edge, which `saveExpected`
// cannot be: that slot is released the moment the phase goes terminal, and
// reconciling needs to know what we were waiting for. Without it the band could
// only ever say "unknown" and never resolve, which is a reconcile state with no
// way out of it.
let unconfirmedExpectation = $state<ModemConfigSent | undefined>(undefined);
// Set only when a re-check ran and the device STILL had not echoed. Absent means
// nobody has asked yet — a different fact, and rendering the two the same way
// would tell an operator their check failed before they made one.
let reconcileUnresolved = $state(false);

// Confirm a configure once a broadcast `modem` echo proves the device stored
// what we sent (configure-echo predicate). A `connecting → connected` cycle on
// any re-attach must NOT confirm — only a matching stored config does. Closes
// the dialog on confirm; releases the snapshot on any terminal phase.
$effect(() => {
	const expected = saveExpected;
	if (!expected) return;
	const phase = getOperationPhase(configKey);
	if (phase === 'confirmed') {
		saveExpected = undefined;
		open = false;
		return;
	}
	if (phase === 'timed_out' || phase === 'failed' || phase === 'idle') {
		// A terminal phase that named no refusal is the unconfirmed case: the TTL
		// lapsed with no echo, or `osCommand` swallowed a thrown dispatch. Both
		// leave the write's fate genuinely unknown, and both used to render
		// nothing at all. A refusal already has its own band and outranks this.
		// The baseline is RETAINED here rather than dropped with `saveExpected`:
		// it is the only record of what we were waiting for, and the reconcile
		// affordance has nothing to compare against without it.
		unconfirmedExpectation = expected;
		reconcileUnresolved = false;
		saveExpected = undefined;
		saveUnconfirmed = true;
		return;
	}
	if (
		phase === 'pending' &&
		modemConfigEchoMatches(expected, {
			networkTypeActive: modem.network_type?.active ?? null,
			config: modem.config,
		})
	) {
		confirmOperation(configKey);
	}
});

/**
 * Re-check an unconfirmed save against the device's own latest reading.
 *
 * The subscription keeps `modem` current, so this compares the SAME echo
 * predicate the confirm path uses against whatever the device has said since
 * the TTL lapsed — a broadcast that arrived one tick too late resolves the band
 * here instead of leaving it standing for the rest of the session. It dispatches
 * NOTHING: re-sending the write would be a second mutation on a bearer whose
 * state nobody knows, which is the one thing an unknown outcome must not do.
 */
function reconcileSave() {
	const expected = unconfirmedExpectation;
	if (!expected) return;
	if (
		modemConfigEchoMatches(expected, {
			networkTypeActive: modem.network_type?.active ?? null,
			config: modem.config,
		})
	) {
		saveUnconfirmed = false;
		unconfirmedExpectation = undefined;
		reconcileUnresolved = false;
		return;
	}
	reconcileUnresolved = true;
}

async function handleSave() {
	if (primaryDisabled || isOperationPending(configKey)) return;
	saveRefusal = undefined;
	saveUnconfirmed = false;
	unconfirmedExpectation = undefined;
	reconcileUnresolved = false;
	const input = {
		device: String(deviceId),
		network_type: formData.selectedNetwork,
		roaming: formData.roaming,
		network: !formData.roaming || formData.network === '-1' ? '' : formData.network,
		autoconfig: formData.autoconfig,
		apn: formData.apn,
		username: formData.username,
		password: formData.password,
		...(usagePolicyWritable
			? (diffUsagePolicyWireFields(usagePolicySeed, formData) ?? {})
			: {}),
	};
	// Capture the dispatched config as the echo baseline BEFORE the broadcast can
	// land, so the confirm compares against what we sent — never a later edit.
	saveExpected = {
		network_type: input.network_type,
		roaming: input.roaming,
		network: input.network,
		autoconfig: input.autoconfig,
		apn: input.apn,
		username: input.username,
		password: input.password,
	};
	const result = await osCommand({
		key: configKey,
		rpc: () => rpc.modems.configure(input),
		// A REFUSAL resolves — it never throws — so without this the operation
		// would settle as a success and the dialog would wait forever for an echo
		// the device is never going to send.
		classify: (r) => (r.success ? { ok: true } : { ok: false, reason: 'error' }),
		silent: true,
		busyMessage: () => m["network.os.deviceBusy"](),
		failMessage: () => m["network.os.operationFailed"](),
	});
	if (result && result.success === false) {
		saveExpected = undefined;
		saveRefusal = result.error ?? 'write_failed';
		return;
	}
	// Release the echo baseline to the server-APPLIED (post-clamp) config, never
	// the intended draft, so the configure-echo confirm matches what the device
	// stored (T9-envelope convention).
	if (result?.applied) {
		const a = result.applied;
		saveExpected = {
			network_type: a.network_type,
			roaming: a.roaming,
			network: a.network,
			autoconfig: a.autoconfig,
			apn: a.apn,
			username: a.username,
			password: a.password,
		};
		formData = {
			selectedNetwork: a.network_type,
			roaming: a.roaming,
			autoconfig: a.autoconfig,
			apn: a.apn,
			username: a.username,
			password: a.password,
			network: a.network === '' ? '-1' : String(a.network),
			...readUsagePolicyForm({
				...(a.data_usage_cycle_day !== undefined
					? { cycle_day: a.data_usage_cycle_day }
					: {}),
				...(a.data_usage_threshold_bytes !== undefined
					? { threshold_bytes: a.data_usage_threshold_bytes }
					: {}),
			}),
		};
		// The applied echo is the device's own post-write policy, so it becomes the
		// new baseline: without this, a second save would re-send the first save's
		// edit as if the operator had just made it.
		usagePolicySeed = usagePolicyOf(formData);
	}
}

async function handleScan() {
	if (noSim || isOperationPending(scanKey)) return;
	scanGenerationBaseline = modem.network_scan?.generation ?? 0;
	scanFailure = undefined;
	await osCommand({
		key: scanKey,
		pendingTtlMs: modemBoundMs('scan'),
		rpc: () => rpc.modems.scan({ device: Number(deviceId) }),
		busyMessage: () => m["network.os.deviceBusy"](),
		failMessage: () => m["network.os.operationFailed"](),
		onResult: (result) => {
			scanFailure = result.success ? undefined : result.scanFailure;
		},
	});
}

// ── USB composition mode ─────────────────────────────────────────────────────
// The switch re-enumerates the modem, so NOTHING here keys on `deviceId` (an MM
// index the transition re-issues) or on `ifname` (which the composition changes).
// `stable_key` is the only identifier that survives, and a modem without one
// cannot be honestly confirmed — so it is not offered the switch at all.
const stableKey = $derived(modem.stable_key ?? '');
const usbSwitchTrackable = $derived(canTrackUsbModeSwitch(modem));

let usbFlow = $state<UsbModeFlow | undefined>(undefined);

const activeUsbMode = $derived(
	displayedUsbMode(getModems(), stableKey, usbFlow) ?? modem.usb_mode,
);
const recommendedUsbMode = $derived(modem.recommended_usb_mode);
const showUsbModeCard = $derived(
	activeUsbMode !== undefined || recommendedUsbMode !== undefined,
);
const usbSwitching = $derived(isUsbModeFlowBusy(usbFlow));

// WHICH modes may be offered is the DEVICE's answer, read once per open from the
// same certified catalog `setUsbMode` gates on — never inferred from
// `recommended_usb_mode`, which is an advisory about stability and carries no
// certification claim at all. Absent (never asked, in flight, or the read threw)
// renders NO control: a set we could not establish is not a set we may offer.
let usbOptions = $state<UsbModeOptionsOutput | undefined>(undefined);
let usbSelected = $state<UsbCompositionMode | undefined>(undefined);

async function loadUsbModeOptions(): Promise<void> {
	usbOptions = undefined;
	usbSelected = undefined;
	const requested = deviceId;
	// A read that outruns its bound leaves `usbOptions` undefined, which
	// `deriveUsbModeOffer` already reports as the `unknown` phase — "we could not
	// establish the set", which is a terminal state and NOT `uncertified`.
	const outcome = await loadWithinBound('getUsbModeOptions', () =>
		rpc.modems.getUsbModeOptions({ device: String(deviceId) }),
	);
	// A close/reopen onto another modem while this was in flight must not adopt
	// the previous device's certified set.
	if (requested !== deviceId) return;
	usbOptions = outcome.phase === 'loaded' ? outcome.value : undefined;
}

// ── FCC auto-unlock ──────────────────────────────────────────────────────────
// Read on every open, for the same reason the USB-mode set is: the coverage
// answer is a property of the thing in the port right now, and the persisted
// opt-in is a property of THIS DEVICE that another surface can have changed.
// `undefined` renders nothing rather than a guess.
let fccState = $state<FccUnlockState | undefined>(undefined);
let fccBusy = $state(false);
// The outcome PERSISTS until the next dispatch or the next open, and it carries
// the success as well as the refusal — a toggle that moved with no word anywhere
// is an outcome an operator using a screen reader never receives (§8 LR-5/LR-6).
let fccOutcome = $state<MutationOutcome | undefined>(undefined);
let fccDetail = $state<MutationOutcomeDetail | undefined>(undefined);

const fccClaim = $derived(modem.capability_modules?.["fcc-auto-unlock"]);

async function loadFccUnlock(): Promise<void> {
	fccState = undefined;
	fccOutcome = undefined;
	fccDetail = undefined;
	const requested = deviceId;
	const outcome = await loadWithinBound('getFccUnlock', () =>
		rpc.modems.getFccUnlock({ device: String(deviceId) }),
	);
	// A close/reopen onto another modem while this was in flight must not adopt
	// the previous device's answer.
	if (requested !== deviceId) return;
	fccState =
		outcome.phase === 'loaded' && outcome.value.success ? outcome.value.state : undefined;
}

async function toggleFccUnlock(enabled: boolean): Promise<void> {
	fccBusy = true;
	fccOutcome = undefined;
	fccDetail = undefined;
	try {
		const result = await rpc.modems.setFccUnlock({
			device: String(deviceId),
			enabled,
			confirm: true,
		});
		if (result.success) {
			// The reply CARRIES the device's own re-read state, so success here is
			// already confirmed — there is nothing left to bound and no window to
			// open, unlike a router write whose proof arrives on a later broadcast.
			fccState = result.state;
			fccOutcome = mutationOutcome(
				"applied",
				enabled
					? m["network.modem.fccUnlock.outcome.enabled"]()
					: m["network.modem.fccUnlock.outcome.disabled"](),
			);
		} else {
			// The KIND is the CLASSIFICATION's, never this site's: an FCC write that
			// ended `unknown-outcome` must reach the reconciliation band, not the
			// refusal one, and `modemWriteBand` is what makes that structural.
			// The refusal arm of this union carries no classification by contract —
			// a gate refusal is a CeraUI-side decision the daemon never saw — so the
			// field is read narrowly rather than assumed onto every arm.
			const band = modemWriteBand(
				"operation" in result ? result.operation : undefined,
				t(fccUnlockErrorKey("error" in result ? result.error : result.refusal)),
				t,
			);
			fccOutcome = band.outcome;
			fccDetail = band.detail;
		}
	} catch {
		fccOutcome = mutationOutcome(
			"refused",
			t(fccUnlockErrorKey("write_failed")),
		);
	} finally {
		fccBusy = false;
	}
}

// ── GPS / location ───────────────────────────────────────────────────────────
// The claim is all this dialog owns. The section holds its own state, its own
// RPC and the coordinate itself, so the fix is dropped when `AppDialog` unmounts
// it rather than parked in a dialog the view keeps mounted forever — and so the
// router family can mount the same surface without a second copy of the rules.
const gpsClaim = $derived(modem.capability_modules?.gps);
const ussdClaim = $derived(modem.capability_modules?.ussd);

// ── Band lock ────────────────────────────────────────────────────────────────
// Read on every open, like the USB-mode option set and for the same reason: the
// certification, the advertised set and the current lock are all properties of
// the thing in the port right now, and the thing in the port can change between
// opens. `undefined` stays `unknown` — a read that has not answered claims
// nothing about the device (`deriveBandOffer`).
let bandResult = $state<ModemBandsOutput | undefined>(undefined);
let bandSelection = $state<readonly string[]>([BAND_ANY]);
let bandApplying = $state(false);
let bandOutcomeKey = $state<string | undefined>(undefined);
let bandReconciliation = $state<string | undefined>(undefined);

const bandOffer = $derived(deriveBandOffer(bandResult));
const bandDirty = $derived(bandSelectionChanged(bandOffer.current, bandSelection));

// THE FOUR-STATE VERDICT, and the fix for the defect this card carried: a read
// that threw left `bandResult` undefined, which the retired two-state helper
// rendered as `absent` — no control AND no message, indistinguishable from a
// modem that positively has no bands. It is `unknown` with its reason now, and
// an `uncertified` SKU is `blocked` rather than hidden, because the modem DID
// advertise bands and it is the certification catalog that refuses the write.
const bandView = $derived(bandCapabilityView(bandResult));

// The band grammar is deliberately OPEN (`bandNameSchema` is a shape check, so
// the modem stays the authority on what it advertises), which makes an
// unrecognised token an expected case rather than a defect. It resolves to
// honest generic copy, and these are what the diagnostics pointer is for.
const unmappedOfferedBands = $derived(
	[...bandOffer.offerable, ...bandOffer.current].filter(
		(band) => !isMappedBandToken(band),
	),
);
const bandDiagnostics = $derived(
	bandDiagnosticTokens([
		...new Set([...bandOffer.current, ...bandOffer.offerable]),
	]),
);

// Deliberately does NOT clear `bandOutcomeKey`: this runs as the CONFIRMING
// re-read immediately after an apply, and clearing there would erase the outcome
// the operator has to read — including `auto_restored`, the one that says their
// request did not take effect. The open edge clears it instead.
async function loadBands(): Promise<void> {
	bandResult = undefined;
	const requested = deviceId;
	const outcome = await loadWithinBound('getBands', () =>
		rpc.modems.getBands({ device: String(deviceId) }),
	);
	if (requested !== deviceId) return;
	if (outcome.phase !== 'loaded') {
		// Neither a failed nor an expired read has established a catalog, and the
		// band card's absent state is what says so. Seeding a selection from a
		// catalog nobody read is how a lock gets offered for bands the radio may
		// not have.
		bandResult = undefined;
		return;
	}
	bandResult = outcome.value;
	bandSelection = initialBandSelection(deriveBandOffer(outcome.value));
}

async function applyBandLock(): Promise<void> {
	bandApplying = true;
	bandOutcomeKey = undefined;
	bandReconciliation = undefined;
	try {
		const result = await rpc.modems.setBands({
			device: String(deviceId),
			bands: [...bandSelection],
			confirm: true,
		});
		// The outcome is the DEVICE's, never the request's: `auto_restored` and
		// `readback_failed` both mean the operator's selection is NOT in force, and
		// reporting either as a success would be the one lie this whole path exists
		// to prevent.
		bandOutcomeKey =
			result.status === undefined
				? 'network.modem.bands.outcome.refused'
				: `network.modem.bands.outcome.${result.status}`;
		// `restore_failed` is the one band terminal that is NEITHER a success nor
		// a plain refusal: the write landed, the rollback did not, and the device
		// is held fail-closed until an operator confirms what it is actually
		// locked to. That is the mutation-block surface, said in its own words —
		// the same routing `unknown-outcome` takes, because it is the same state.
		bandReconciliation =
			result.status === 'restore_failed'
				? t(MODEM_OPERATION_RECONCILIATION_KEY)
				: undefined;
	} catch {
		bandOutcomeKey = 'network.modem.bands.outcome.refused';
		bandReconciliation = undefined;
	} finally {
		bandApplying = false;
		// Re-read rather than trusting the reply — the modem is the authority on
		// what it is locked to, including after an automatic restore.
		await loadBands();
	}
}

// ── 5G preference ────────────────────────────────────────────────────────────
// The device publishes the block ONLY where the capability ladder says the
// control may be offered, so the gate is never re-derived here — a second
// derivation could disagree with the backend's, and every way it could disagree
// is a lie to the operator.
const fiveG = $derived(fiveGViewForModem(modem));
// The section's own gate is its `CapabilitySection` view, so the markup can no
// longer narrow the union with an `{#if}`. These two read the offered arm and
// answer empty otherwise; neither is reachable while the section is `absent`.
const fiveGOptions = $derived(fiveG.kind === 'offered' ? fiveG.options : []);
const fiveGNrModeKey = $derived(fiveG.kind === 'offered' ? fiveG.nrModeReasonKey : '');
// A published block wins outright; with none, the CLAIM is what separates "this
// radio advertised no posture" (absent — the FM350's honest answer) from "the
// gate is off" or "nobody has probed it" (unknown, with the reason on screen).
const fiveGView = $derived(
	fiveGCapabilityView(fiveG, modem.capability_modules?.["five-g-pref"], noSim),
);
let fiveGApplying = $state(false);
let fiveGFailure = $state<string | undefined>(undefined);

async function applyFiveG(preference: FiveGPreference): Promise<void> {
	fiveGApplying = true;
	fiveGFailure = undefined;
	try {
		const result = await rpc.modems.setFiveGPreference({
			device: String(deviceId),
			preference,
			confirm: true,
		});
		// PESSIMISTIC: nothing is assigned to a local selection on resolve. The
		// rendered "In use" marker follows `modem.five_g_preference.active`, which
		// is the device's own LIVE read arriving on the next broadcast — so a
		// refused or clamped write leaves the previous posture marked, which is
		// where the radio actually still is.
		if (!result.success) {
			fiveGFailure = fiveGFailureKey(result.refusal ?? result.error);
		}
	} catch {
		fiveGFailure = fiveGFailureKey(undefined);
	} finally {
		fiveGApplying = false;
	}
}

const usbOffer = $derived(
	deriveUsbModeOffer({
		options: usbOptions,
		activeMode: activeUsbMode,
		recommendedMode: recommendedUsbMode,
	}),
);
const usbSwitchTarget = $derived(resolveUsbModeTarget(usbOffer, usbSelected));

// The same `catch { options = undefined }` collapse the band card carried: the
// certified set could not be established, which is NOT "this device has no
// switch". The active mode above still renders; only the offer is unknown, and
// it says so instead of leaving the card silently short of a control.
const usbOptionsUnknown = $derived(usbOffer.phase === 'unknown');

// The confirming snapshot may arrive at ANY point after dispatch — including
// while the RPC is still pending, because the backend's post-success
// re-discovery can legally beat the reply. A pre-resolution match is buffered
// here and consumed at resolution.
$effect(() => {
	const flow = usbFlow;
	if (!isUsbModeFlowBusy(flow) || !flow) return;
	const next = observeUsbModeSnapshot(flow, getModems());
	if (next !== flow) usbFlow = next;
});

// The 20 s bound covers re-discovery + broadcast latency only, so it is armed at
// RPC RESOLUTION (`resolveUsbModeFlow`), never at dispatch — the RPC itself
// awaits the whole server-side transaction.
$effect(() => {
	if (usbFlow?.phase !== 'awaiting' || usbFlow.deadlineAt === undefined) return;
	const timer = setTimeout(
		() => {
			if (usbFlow) usbFlow = tickUsbModeFlow(usbFlow, Date.now());
		},
		Math.max(0, usbFlow.deadlineAt - Date.now()),
	);
	return () => clearTimeout(timer);
});

// OL-1: the WIRE token (`rndis`, `qmi`, …) never reaches operator copy. It names
// a USB protocol, which is not something an operator can act on; the label names
// the BEHAVIOUR instead, and the token itself is relocated to the diagnostics
// block below (OL-3) rather than deleted.
function usbModeLabel(mode: UsbCompositionMode | undefined): string {
	return usbModeOperatorLabel(mode, resolveMessageKey);
}

// OL-2: same rule for a band. `eutran-3` is a 3GPP table row; "4G band 3" is the
// same fact in a vocabulary an operator shares with their carrier.
function bandLabel(band: string): string {
	return bandOperatorLabel(band, resolveMessageKey);
}

const usbFailureText = $derived.by(() => {
	const flow = usbFlow;
	if (flow?.phase !== 'refused') return undefined;
	const head = flow.refusal
		? resolveMessageKey(`network.modem.usbMode.error.${flow.refusal}`)
		: m["network.modem.usbMode.error.transition_failed"]();
	const detail = flow.reason
		? resolveMessageKey(`network.modem.usbMode.reason.${flow.reason}`)
		: undefined;
	return detail ? `${head} ${detail}` : head;
});

async function handleUsbModeSwitch() {
	const target = usbSwitchTarget;
	if (!target || !usbSwitchTrackable || usbSwitching) return;

	// BASELINE BEFORE DISPATCH: the feed is read now, so the confirmation
	// compares against what was true when the operator acted.
	usbFlow = beginUsbModeFlow({ stableKey, target, modems: getModems() });

	try {
		const result = await rpc.modems.setUsbMode({
			device: String(deviceId),
			mode: target,
			confirm: true,
		});
		if (usbFlow) usbFlow = resolveUsbModeFlow(usbFlow, result, Date.now());
	} catch {
		if (usbFlow) usbFlow = failUsbModeFlow(usbFlow);
	}
}

// A refusal the device will repeat verbatim on every retry (`uncertified`,
// `provisioning_disabled`) is a STANDING PROPERTY, not a failure: the switch
// control is withdrawn and the state renders calmly, because a retry button
// beside it would be a lie about what pressing it does.
const usbStandingRefusal = $derived(
	usbFlow?.phase === 'refused' && isStandingUsbRefusal(usbFlow.refusal)
		? usbFlow.refusal
		: undefined,
);
const usbStandingBodyKey = $derived(
	usbStandingRefusal === 'uncertified'
		? 'network.modem.usbMode.uncertifiedBody'
		: 'network.modem.usbMode.provisioningBody',
);

/*
  The CLASSIFIED outcome behind a refused switch, when the reply carried one.

  A USB-mode transaction whose reply never arrived is `unknown-outcome`, and the
  red `role="alert"` band below states that the switch FAILED — which is a claim
  nobody is entitled to make about a transition that may well have landed. The
  classification therefore picks the band, and the reconciliation arm is
  separated out so it can never be found as an error.
*/
const usbBand = $derived.by(() => {
	const operation = usbFlow?.phase === 'refused' ? usbFlow.operation : undefined;
	if (operation === undefined || usbFailureText === undefined) return undefined;
	return modemWriteBand(operation, usbFailureText, t);
});
const usbUnknownBand = $derived(
	usbBand?.outcome?.kind === 'unknown' ? usbBand : undefined,
);
const offerUsbSwitch = $derived(usbOffer.phase === 'offered' && !usbStandingRefusal);

// The device answered that no mode may be offered, and said why. It is the calm
// muted band, never the destructive one: nothing failed — this device simply has
// no transition to offer, and the mode it is in keeps working.
const usbWithheldReason = $derived(
	usbOffer.phase === 'withheld' && !usbStandingRefusal ? usbOffer.reason : undefined,
);

// …and the OTHER half of that answer: a condition the operator can lift. It gets
// the amber disabled-with-reason treatment instead, because a control that is
// merely blocked and a capability this device does not have are different facts,
// and rendering both as the same calm band is what made every real modem read as
// "your model was never reviewed".
const usbBlockedReason = $derived(
	usbOffer.phase === 'blocked' && !usbStandingRefusal ? usbOffer.reason : undefined,
);
const usbSuppressionBodyKey = $derived.by(() => {
	const reason = usbWithheldReason ?? usbBlockedReason;
	return reason === undefined ? undefined : usbOfferSuppressionBodyKey(reason);
});

// The provisioning gate is a DEVICE setting, echoed read-only on the config wire
// as a tristate. `false` is the only arm that gates anything: the device has said
// the mutation is off, so the switch renders disabled-with-reason instead of
// making the operator discover it by dispatching one and reading the refusal.
// ABSENT is not `false` — it is a backend that never published the key, and
// treating it as off would hide a working control on every such device.
const provisioningBlocked = $derived(getConfig()?.modem_provisioning === false);

const selectedNetworkLabel = $derived(
	formData.network === '-1'
		? m["network.modem.automaticRoamingNetwork"]()
		: (modem.available_networks?.[formData.network]?.name ?? formData.network),
);

// ── Read-only advanced detail ────────────────────────────────────────────────
const t = resolveMessageKey;
const locale = $derived(getLocale());
const bytes = $derived(formatBytes(locale));

// THE NORMALIZED BLOCK SUPERSEDES THE LEGACY STRIP'S QUALITY ROWS. Both can
// express RSRP/RSRQ/SNR/SINR, and two rows under one label carrying different
// numbers is worse than either alone — so when the ModemManager reading is
// present it wins, because it is the only one of the two that can say WHY a
// value is missing. This is the precedence `router-signal` already applies to
// the legacy `signal_bars` scalars; `tech`, `band` and the legacy `cell_id` are
// untouched, and a modem with no normalized block renders exactly as before.
const signalDetail = $derived(modem.signal_detail);
const cellRows = $derived(
	cellMetricRows(modem.cell_info).filter(
		(row) =>
			signalDetail === undefined || !SUPERSEDED_CELL_METRIC_KEYS.includes(row.key),
	),
);
const observedAt = $derived(cellObservedAtMs(modem.cell_info));
const firmware = $derived(firmwareRevision(modem.firmware_revision));
const esim = $derived(esimView(modem.esim));

// The four extended measurements, the modem's own measurement recency, and the
// network/cell it registered on. Each is a metric — a value, or a TYPED reason —
// so an absent reading renders its own word rather than a dash that would make
// "this modem cannot report it", "nobody primed the read" and "the dict was
// there and the member was not" look identical.
const signalRows = $derived(signalDetailRows(signalDetail));
const signalRecency = $derived(qualityRecency(signalDetail));
const registrationMetrics = $derived(registrationRows(modem.registration_context));

// WHICH FACT decided the SIM verdict. The banner above is BINARY because the
// bond gate it renders is binary, so on its own it cannot separate a slot the
// modem positively reported empty from a slot nothing could read — and those
// two ask opposite things of an operator.
const simEvidence = $derived(simPresenceEvidenceHint(modem.sim_presence_evidence));

// WHETHER THERE IS A CARD IN THE SLOT — the stack's EVIDENCE model, rendered
// through the SAME primitive the router dialog draws, so the two families state
// one fact in one vocabulary.
//
// It is four-valued on purpose, and the fourth value is the point. `deriveSim`
// resolves `absent` ONLY from a device that positively said so — ModemManager's
// `sim-missing` failure reason, carried on the wire as `no_sim`, or a dongle's
// own `router_admin.sim` — and everything else that is not positively `present`
// resolves `unknown`. A blank SIM object path is not an answer, so it must not
// become one on the last hop: "we could not tell" and "there is no card" call
// for opposite operator actions, and the dialog previously rendered neither
// (only the binary banner), so an operator could not tell a healthy slot from
// an unread one.
const simIdentity = $derived(deriveSim(modem));

// A POSITIVELY-STATED SIM is worth the card even when the modem reported
// nothing else. `absent` is deliberately NOT in that set — it already has its
// own primary banner above, and a second, otherwise-empty card restating it is
// the density regression todo 64 removed. `unknown` is not in it either: on its
// own it has nothing to add, and the card would say only that it knows nothing.
// A PUBLISHED READING is worth the card on the same terms a positively-stated
// SIM is: the backend observed the radio interface and answered, so the card has
// something to say even on a modem that reported no cell info, no eSIM and no
// firmware. The mmcli path publishes none of these blocks at all, so it is
// unaffected — an absent block means "this backend did not observe it".
const showDetailCard = $derived(
	hasModemDetail(modem) ||
		hasNormalizedReading(modem) ||
		simIdentity.presence === 'present' ||
		simIdentity.presence === 'locked',
);

// OL-3 is a RELOCATION rule, so the diagnostics block is gated on its OWN
// evidence — the presence of a suppressed token — rather than on the detail
// card's. A raw value hidden from a label while its diagnostics home is gated
// off by an unrelated reading is a value the field engineer simply lost.
//
// The two rows this dialog contributes are the ones the modem ROW cannot supply:
// the live composition (which follows an in-flight switch) and the band
// capability read's own token list (which is a separate RPC, not a wire field).
// Everything else comes from `modemDiagnosticRows`, already redacted.
const diagnosticRows = $derived([
	...(activeUsbMode === undefined
		? []
		: [{ id: 'usb-mode', label: 'usb_mode', value: activeUsbMode }]),
	...modemDiagnosticRows(modem),
	...(bandDiagnostics.length === 0
		? []
		: [{ id: 'bands', label: 'bands', value: bandDiagnostics.join(' ') }]),
	// The selector's own catalog, in the modem's spelling. The label above it is
	// positional for any entry this build cannot read (OL-2), so without this row
	// that entry would have no spelling left anywhere.
	...(supportedNetworkModes.length === 0
		? []
		: [
				{
					id: 'network-modes',
					label: 'network_type.supported',
					value: supportedNetworkModes.join(' '),
				},
			]),
]);
const hasRawDiagnostics = $derived(diagnosticRows.length > 0);
const NO_DERIVED_DIAGNOSTIC_ROWS = { rows: [] } as const;

// The SIM's own number is HIDDEN BY DEFAULT and revealed only on request — the
// same treatment `PasswordDialog`/`HotspotDialog` give a credential, for the same
// reason: it identifies the subscriber, and this dialog is routinely on screen
// while an operator screen-shares a stream. The reveal is per VIEWING, never
// persisted, so it re-hides on close and whenever the dialog is pointed at a
// different modem.
const simNumbers = $derived(ownNumbers(modem.own_numbers));

// The ICCID takes the OPPOSITE treatment: it is printed on the card and is what
// the operator reads to a carrier rep to activate a line, so it renders plainly
// and gains the copy affordance a 19-digit string needs.
const iccid = $derived(simIccid(modem.iccid));

async function copyIccid() {
	if (!iccid) return;
	if (await copyToClipboard(iccid)) {
		toast.success(m["network.clipboard.iccidCopied"]());
	} else {
		toast.error(m["network.clipboard.copyFailed"](), {
			description: m["network.clipboard.copyFailedDescription"](),
		});
	}
}

let revealOwnNumber = $state(false);
let lastRevealScope: string | undefined;
$effect(() => {
	const scope = open ? `${deviceId}` : undefined;
	if (scope !== lastRevealScope) {
		revealOwnNumber = false;
		lastRevealScope = scope;
	}
});

const usage = $derived(usageView(modem.data_usage));

// The usage POLICY is a SETTING, so it is published on every row whether or not
// anything has counted a byte — unlike `data_usage`, which no shipped device
// produces (the D-Bus backend that folds counters is not the default anywhere).
// Gating the controls on the counters would therefore hide them on every board
// in the field, which is the defect this replaced the roadmap pill to fix.
const usagePolicy = $derived(modem.data_usage_policy);
// Read STRICTLY `=== true`: absence means an older backend that was never asked,
// and a device we were told nothing about is not a device that said yes.
const usagePolicyWritable = $derived(usagePolicy?.supported === true);

// The usage counters carry no observation timestamp of their own on this wire,
// so the only honest freshness signal available is whether the socket that
// delivers them is still up. A dropped connection therefore dims the figures
// and says so, rather than presenting the last frame as a live reading
// (`.impeccable.md` Live-Data Discipline).
const usageStale = $derived(!getIsConnected());

// ── Read-only SMS inbox ──────────────────────────────────────────────────────
// FOLDED, AND THE FOLD DOES REAL WORK. Nothing is read until the operator opens
// the section: `modems.getSms` costs up to one mmcli invocation per stored
// message (bounded at SMS_INBOX_CAP, but not cheap — a full inbox is 50 of
// them), so probing it on every dialog open would tax every operator who came
// here to change an APN. Closed, the section holds no message text in the DOM
// at all, which is also the only version of "general users never see it" that
// survives a page-source read.
let smsOpen = $state(false);
let smsLoading = $state(false);
let smsLoaded = $state(false);
let smsMessages = $state<SmsMessage[]>([]);
let smsRefusal = $state<ModemSmsRefusal | undefined>(undefined);
// A read that outran its bound is NOT a refusal and NOT an empty inbox: the
// device never told us what it holds, so it gets its own terminal rather than
// borrowing `read_failed`'s sentence or rendering as zero messages.
let smsTimedOut = $state(false);

// `unsupported` is the one refusal that describes the DEVICE rather than the
// moment: this modem exposes no Messaging interface, so it can never have an
// inbox and the whole section leaves rather than standing there offering a
// refresh that would refuse identically forever (the `uncertified` USB-mode
// precedent below). The verdict is per dialog session — reopening asks again,
// because the thing in the USB port can change between opens.
const smsWithdrawn = $derived(isWithdrawingSmsRefusal(smsRefusal));
const smsRefusalCopyKey = $derived(smsRefusalKey(smsRefusal));
const smsCapped = $derived(smsMessages.length >= SMS_INBOX_CAP);

function resetSmsInbox(): void {
	smsOpen = false;
	smsLoading = false;
	smsLoaded = false;
	smsMessages = [];
	smsRefusal = undefined;
	smsTimedOut = false;
}

async function loadSms(): Promise<void> {
	if (smsLoading) return;
	smsLoading = true;
	smsRefusal = undefined;
	smsTimedOut = false;
	// The bound is the SMS read's OWN, and longer than every other read here,
	// because `getSms` spends up to one mmcli invocation per stored message. Its
	// `finally` used to be the only terminal, which is not a terminal at all: a
	// call that never settles never reaches one, and the spinner simply stayed.
	const outcome = await loadWithinBound('getSms', () =>
		rpc.modems.getSms({ device: String(deviceId) }),
	);
	if (outcome.phase === 'loaded' && outcome.value.success) {
		// Rendered in WIRE ORDER. Newest-first is the procedure's contract and
		// it sorts on the carrier timestamp with a tie-break this side cannot
		// reproduce (ModemManager reuses freed object indices, so index order
		// is not arrival order). Re-sorting here would be a second, worse
		// implementation of the same rule.
		smsMessages = outcome.value.messages ?? [];
	} else if (outcome.phase === 'loaded') {
		// A refusal is never flattened into an empty inbox: `[]` means this
		// modem HAS an inbox and it is empty, and nothing else.
		smsMessages = [];
		smsRefusal = outcome.value.error ?? 'read_failed';
	} else if (outcome.phase === 'timed-out') {
		smsMessages = [];
		smsTimedOut = true;
	} else {
		smsMessages = [];
		smsRefusal = 'read_failed';
	}
	smsLoaded = true;
	smsLoading = false;
}

function toggleSms(): void {
	smsOpen = !smsOpen;
	if (smsOpen && !smsLoaded && !smsLoading) void loadSms();
}

// The instrument cards are gated on the DEVICE having published a reading, not
// on a capability CLAIM, so they take `readingView`, the two-state form of the
// shared ladder. See its own header for the boundary it must not cross.
const CARD_FRAME = 'space-y-3 rounded-lg border p-3';

// The three RADIO selectors do NOT take that two-state form. Each of them can
// be in a state nobody has established — a read that threw, a gate that is off,
// a catalog the modem never published — and `absent` is a positive claim about
// the device. `modem-radio-selectors.ts` owns the full ladder for all three.
const networkTypeView = $derived(
	networkModeCapabilityView(modem.network_type, noSim),
);

// The radio's power state. A READING with no write under it — the control
// package publishes `power` as a read operation and no setter — so the card is
// rendered with no control of any kind, and the unavailability rows below it
// say so out loud rather than leaving an operator hunting for a switch.
const powerReading = $derived(radioPowerReading(modem.radio_power));
</script>

<AppDialog
	closeOnPrimary={false}
	description={m["network.modem.configureDescription"]()}
	icon={Radio}
	onPrimary={handleSave}
	primaryDisabled={primaryDisabled}
	primaryLabel={m["network.modem.save"]()}
	primaryLoading={savePending}
	title={modem.name}
	bind:open
>
	<div class="space-y-4">
		<!-- ── Status strip: state · carrier · network type · signal ─────────── -->
		<div class="bg-muted/40 flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
			<div class="min-w-0 space-y-1">
				<ConnectionStateBlock connection={connectionModel} />
				{#if !noSim && activeNetworkType}
					<p class="text-muted-foreground text-xs">{activeNetworkType}</p>
				{/if}
			</div>
			<LinkIndicator
				shape="icon"
				size="lg"
				type="modem"
				signal={signalValue}
				connectionState={noSim ? 'no_sim' : 'connected'}
				showPercent
			/>
		</div>

		{#if saveRefusalKey}
			<!-- The device REFUSED the write. It is an error band, not a toast:
			     the dialog is still open on the settings that did not land, and a
			     toast that decays leaves the operator reading a form they believe
			     was saved. The reason token is keyed copy, never rendered raw. -->
			<div
				class="border-status-error/40 bg-status-error/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="modem-save-refused"
				data-refusal={saveRefusal}
				role="alert"
			>
				<ShieldAlert class="text-status-error mt-0.5 size-5 shrink-0" aria-hidden="true" />
				<div class="min-w-0">
					<p class="text-sm font-semibold">{m["network.modem.saveRefusedTitle"]()}</p>
					<p
						class="text-muted-foreground mt-0.5 text-xs leading-relaxed"
						data-testid="modem-save-refused-reason"
					>
						{t(saveRefusalKey)}
					</p>
				</div>
			</div>
		{/if}

		{#if showSaveUnconfirmed}
			<!-- Neither "saved" nor "refused" — the device took the settings and
			     never echoed them back in time, so the only honest thing to
			     report is that we do not know. Amber, never the destructive
			     register: nothing is known to have failed. It also outlives the
			     spinner deliberately, because the spinner stopping is exactly
			     what used to leave the operator with no answer at all. -->
			<div
				class="border-status-warning/60 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="modem-save-unconfirmed"
				role="status"
			>
				<Clock class="text-status-warning mt-0.5 size-5 shrink-0" aria-hidden="true" />
				<div class="min-w-0 space-y-2">
					<div>
						<p class="text-sm font-semibold">{m["network.modem.saveUnconfirmedTitle"]()}</p>
						<p class="text-muted-foreground mt-0.5 text-xs leading-relaxed">
							{m["network.modem.saveUnconfirmedBody"]()}
						</p>
					</div>
					<!-- The reconcile. It re-reads the device's own latest broadcast
					     against the same echo predicate the confirm path uses, and
					     dispatches nothing — re-sending the write would be a second
					     mutation on a bearer whose state nobody knows. Without it the
					     band can only ever say "unknown" and never resolve. -->
					<Button
						class="h-8"
						data-testid="modem-save-reconcile"
						onclick={reconcileSave}
						size="sm"
						variant="outline"
					>
						{m["network.modem.saveReconcile"]()}
					</Button>
					{#if reconcileUnresolved}
						<p
							class="text-muted-foreground text-xs leading-relaxed"
							data-testid="modem-save-reconcile-unresolved"
							role="status"
						>
							{m["network.modem.saveReconcileUnresolved"]()}
						</p>
					{/if}
				</div>
			</div>
		{/if}

		{#if noSim}
			<!-- ── No-SIM banner ──────────────────────────────────────────────────
			     The TAG is the shared pill every cellular surface draws; only the
			     reasoning under it is dialog-specific. It used to lead with a third
			     glyph (`SignalZero`) that appeared nowhere else, so the same fact
			     wore a different face in the dialog than it did in the row behind
			     it. -->
			<div
				class="border-status-warning/40 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="modem-no-sim-banner"
				role="status"
			>
				<div class="min-w-0 space-y-1.5">
					<NoSimBadge size="sm" testid="modem-no-sim-banner-badge" />
					<p class="text-sm font-semibold">{m["network.modem.noSim"]()}</p>
					<p class="text-muted-foreground text-xs">{m["network.modem.noSimHint"]()}</p>
					<!-- WHICH FACT decided it. The badge above is the bond gate's binary
					     verdict, so on its own it cannot separate a slot the modem
					     positively reported empty from a slot nothing could read — and
					     an operator's next move differs completely between the two
					     (re-seat the card vs. the read never landed). The evidence KIND
					     is keyed copy; the raw object path and failure token it carries
					     stay in the marked diagnostics block, where relocation puts
					     them. -->
					{#if simEvidence}
						<p
							class="text-muted-foreground/80 text-xs leading-relaxed"
							data-evidence-kind={simEvidence.kind}
							data-states-empty-slot={simEvidence.statesEmptySlot}
							data-testid="modem-no-sim-evidence"
						>
							{t(simEvidence.key, simEvidence.params)}
						</p>
					{/if}
				</div>
			</div>
		{/if}

		<!-- All controls below are disabled when no SIM is present. -->
		<fieldset class="space-y-4 disabled:pointer-events-none" disabled={noSim}>
			<!-- ── Network type ────────────────────────────────────────────────────
			     PRIMARY, and first: it locks which radio technologies the modem may
			     use, so it is the coarsest of the three decisions this section makes
			     (radio → registration → data session) and every control below it is
			     read in its light. It spent a release inside the Advanced disclosure
			     on the theory that it is set once per site; operators reported
			     otherwise — pinning a modem to 4G is routine field work when 5G is
			     marginal, and it was the only configuration control down there among
			     read-only instruments and device surgery. -->
			<!-- The one radio selector whose offer is a SINGLE control, so `blocked`
			     renders it DISABLED beside its reason (CT-2). The retired bare
			     `<div>` opened onto "Scan to search for operators" when the catalog
			     was empty — copy about a different question, in a control that
			     could not act on either. -->
			<CapabilitySection
				name="modem-network-type"
				view={networkTypeView}
				title={m["network.modem.networkType"]()}
				controlId="modem-network-type-select">
				{#snippet control({ disabled, reasonId })}
					<Select.Root
						disabled={disabled || noSim}
						onValueChange={(val) => {
							if (val) formData.selectedNetwork = val;
						}}
						type="single"
						value={formData.selectedNetwork}
					>
						<Select.Trigger
							aria-describedby={reasonId}
							class="h-10 w-40 max-w-full text-sm"
							data-testid="modem-network-type-trigger"
							id="modem-network-type-select">
							{formData.selectedNetwork
								? networkModeLabel(formData.selectedNetwork)
								: '—'}
						</Select.Trigger>
						<Select.Content>
							<Select.Group>
								{#each supportedNetworkModes as networkType (networkType)}
									<Select.Item
										data-testid="modem-network-type-option-{networkType}"
										value={networkType}>
										{networkModeLabel(networkType)}
									</Select.Item>
								{/each}
							</Select.Group>
						</Select.Content>
					</Select.Root>
				{/snippet}
			</CapabilitySection>

			<!-- ── Roaming toggle ──────────────────────────────────────────────── -->
			<div class="bg-muted/40 flex items-center justify-between gap-3 rounded-lg border p-3">
				<div class="flex items-center gap-2.5">
					<Globe
						class={cn(
							'size-4 shrink-0',
							formData.roaming ? 'text-status-success' : 'text-muted-foreground',
						)}
						aria-hidden="true"
					/>
					<div class="min-w-0">
						<p class="text-sm font-medium">{m["network.modem.enableRoaming"]()}</p>
						<p class="text-muted-foreground text-xs">{m["network.modem.roamingDescription"]()}</p>
					</div>
				</div>
				<LabeledSwitch
					checked={formData.roaming}
					disabled={noSim}
					label={m["network.modem.enableRoaming"]()}
					onCheckedChange={(checked) => (formData.roaming = checked)}
				/>
			</div>

			<!-- ── Network scan / operator selection ───────────────────────────── -->
			{#if formData.roaming}
				<div class="space-y-2" transition:slide={{ duration: 150 }}>
					<div class="flex items-center justify-between gap-2">
						<Label class="text-muted-foreground text-xs">
							{m["network.modem.availableNetworks"]()}
						</Label>
						<Button
							class="h-8 gap-1.5 px-2.5 text-xs"
							data-testid="modem-scan-button"
							disabled={noSim || scanning}
							onclick={handleScan}
							size="sm"
							type="button"
							variant="outline"
						>
							{#if scanning}
								<Loader2 class="size-3.5 motion-safe:animate-spin" />
								{m["network.modem.scanning"]()}
							{:else}
								<RefreshCw class="size-3.5" />
								{m["network.modem.scanForNetworks"]()}
							{/if}
						</Button>
					</div>

					<Select.Root
						disabled={noSim}
						onValueChange={(val) => {
							if (val) formData.network = val;
						}}
						type="single"
						value={formData.network}
					>
						<Select.Trigger class="h-10 w-full text-sm" data-testid="modem-network-trigger">
							{selectedNetworkLabel}
						</Select.Trigger>
						<Select.Content>
							<Select.Group>
								<Select.Item
									label={m["network.modem.automaticRoamingNetwork"]()}
									value="-1"
								/>
								{#each availableNetworks as [key, net] (key)}
									<Select.Item data-testid="modem-network-option" label={net.name} value={key} />
								{/each}
							</Select.Group>
						</Select.Content>
					</Select.Root>

					{#if scanError}
						<p class="text-status-error text-xs" data-testid="modem-scan-error" role="alert" data-scan-failure={scanFailure}>
							{t(scanFailureKey)}
						</p>
					{:else if scanUnconfirmed}
						<p class="text-status-warning text-xs" data-testid="modem-scan-unconfirmed" role="alert">
							{t(modemRefusalCopyKey('timed_out'))}
						</p>
					{:else if scanning}
						<p class="text-muted-foreground text-xs" data-testid="modem-scanning-state">
							{m["network.modem.scanningForNetworks"]()}
						</p>
					{:else if availableNetworks.length === 0}
						<p class="text-muted-foreground text-xs">{m["network.modem.noNetworksFound"]()}</p>
					{/if}
				</div>
			{/if}

			<!-- ── Automatic APN toggle ────────────────────────────────────────── -->
			<div class="bg-muted/40 flex items-center justify-between gap-3 rounded-lg border p-3">
				<div class="flex items-center gap-2.5">
					<Zap
						class={cn(
							'size-4 shrink-0',
							formData.autoconfig ? 'text-status-success' : 'text-muted-foreground',
						)}
						aria-hidden="true"
					/>
					<div class="min-w-0">
						<div class="flex flex-wrap items-center gap-1.5">
							<p class="text-sm font-medium">{m["network.modem.autoapn"]()}</p>
							<Badge
								variant="info"
								size="micro"
								class="text-(length:--text-micro)"
								data-testid="modem-autoapn-recommended"
								label={m["network.modem.autoApnRecommended"]()}
							/>
						</div>
						<p class="text-muted-foreground text-xs">{m["network.modem.autoApnDescription"]()}</p>
						{#if autoApnUnsupported}
							<!-- On screen, not only in the accessible name: the shipped
							     kiosk touchscreen cannot hover to reveal a tooltip. -->
							<p
								class="text-status-warning mt-1 text-xs"
								data-testid="modem-autoapn-unsupported"
							>
								{m["network.modem.autoApnUnsupported"]()}
							</p>
						{/if}
					</div>
				</div>
				<LabeledSwitch
					checked={formData.autoconfig}
					disabled={noSim || autoApnUnsupported}
					label={m["network.modem.autoapn"]()}
					onCheckedChange={(checked) => (formData.autoconfig = checked)}
				/>
			</div>

			<!-- ── Manual APN + credentials (only when Automatic APN is off) ─────── -->
			{#if !formData.autoconfig}
				<div class="space-y-3 rounded-lg border p-3" transition:slide={{ duration: 150 }}>
					<div class="space-y-1.5">
						<Label class="text-muted-foreground flex items-center gap-1.5 text-xs" for="modem-apn">
							<NetworkIcon class="size-3.5" />
							{m["network.modem.apn"]()}
						</Label>
						<Input
							id="modem-apn"
							aria-invalid={apnError}
							class={cn('h-10 text-sm', apnError && 'border-status-error focus-visible:ring-status-error')}
						disabled={noSim}
						placeholder={m["network.modem.apnPlaceholder"]()}
							bind:value={formData.apn}
						/>
						{#if apnError}
							<p class="text-status-error text-xs">{m["network.modem.apnRequired"]()}</p>
						{/if}
					</div>

					<div class="space-y-1.5">
						<Label class="text-muted-foreground text-xs">{m["network.modem.credentials"]()}</Label>
						<div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
							<Input
								aria-label={m["network.modem.username"]()}
								class="h-10 text-sm"
								disabled={noSim}
								placeholder={m["network.modem.username"]()}
								bind:value={formData.username}
							/>
							<Input
								aria-label={m["network.modem.password"]()}
								class="h-10 text-sm"
								disabled={noSim}
								placeholder={m["network.modem.password"]()}
								type="password"
								bind:value={formData.password}
							/>
						</div>
					</div>
				</div>
			{/if}
		</fieldset>

		{#if reconnectExpected}
			<!-- Honest, not preventive: the change is worth making, it simply
			     cannot reach a bearer that is already up, so the operator is told
			     the cost BEFORE they pay it. Never shown for an unchanged form or
			     an idle modem — nothing is interrupted in either case. -->
			<div
				class="border-status-info/40 bg-status-info/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="modem-reconnect-notice"
				data-changed={pendingConnectChanges.join(',')}
				role="status"
			>
				<RefreshCw class="text-status-info mt-0.5 size-5 shrink-0" aria-hidden="true" />
				<div class="min-w-0">
					<p class="text-sm font-semibold">{m["network.modem.reconnectNoticeTitle"]()}</p>
					<p class="text-muted-foreground mt-0.5 text-xs leading-relaxed">
						{m["network.modem.reconnectNoticeBody"]()}
					</p>
				</div>
			</div>
		{/if}

		<!-- ── Band lock ────────────────────────────────────────────────────────
		     PRIMARY, by explicit product decision: an operator locking a band is
		     working a specific coverage problem at a specific site, and burying
		     that behind the diagnostics disclosure would make the fix harder to
		     reach than the symptom. It renders nothing unless the device answered
		     with a certified, offerable set. -->
		<CapabilitySection
			name="modem-bands-card" icon={Antenna} class={CARD_FRAME}
			view={bandView}
			title={m["network.modem.bands.title"]()}
			description={m["network.modem.bands.description"]()}>
				<p class="text-muted-foreground text-xs" data-testid="modem-bands-current">
					{bandOffer.unlocked
						? m["network.modem.bands.currentAny"]()
						: m["network.modem.bands.current"]({
								bands: bandListOperatorLabel(bandOffer.current, resolveMessageKey) ?? '',
							})}
				</p>

				<div
					class="flex flex-wrap gap-1.5"
					role="group"
					aria-label={m["network.modem.bands.title"]()}
					data-testid="modem-bands-options"
				>
					<!-- `any` is the release, and it is always offered: an operator who
					     locked a band they can no longer register on must be able to get
					     back without hunting for the right one. -->
					{#each [BAND_ANY, ...bandOffer.offerable] as band (band)}
						<button
							type="button"
							role="checkbox"
							aria-checked={bandSelection.includes(band)}
							class={cn(
								'min-h-[var(--touch-target-min)] rounded-md border px-2.5 py-1 text-xs',
								bandSelection.includes(band)
									? 'border-primary bg-primary/10 text-foreground'
									: 'text-muted-foreground hover:bg-muted/50',
							)}
							data-testid="modem-band-option-{band}"
							data-band={band}
							disabled={bandApplying}
							onclick={() => {
								bandSelection = toggleBand(bandSelection, band);
							}}
						>
							{bandLabel(band)}
						</button>
					{/each}
				</div>

				<!-- OL-5: an unmapped token is never printed raw as a fallback, so a
				     chip this build could not name reads "Unrecognised band" — which is
				     honest but not, on its own, actionable. The pointer is what makes it
				     so: the exact value is one disclosure away, verbatim. -->
				{#if unmappedOfferedBands.length > 0}
					<p class="text-muted-foreground/80 text-xs" data-testid="modem-bands-unmapped-hint">
						{m["network.modem.bands.unmappedHint"]()}
					</p>
				{/if}

				<!-- Offered only for a CHANGED selection: an Apply that would re-register
				     the radio onto the bands it is already on costs a connection drop and
				     buys nothing, so it is not a choice worth presenting. -->
				{#if bandDirty}
					<SimpleAlertDialog
						buttonClasses="w-full"
						buttonText={m["network.modem.bands.apply"]()}
						confirmButtonText={m["network.modem.bands.confirmAction"]()}
						confirmVariant="destructive"
						disabledConfirmButton={bandApplying}
						extraButtonClasses="min-h-[var(--touch-target-min)]"
						title={m["network.modem.bands.confirmTitle"]()}
						onconfirm={applyBandLock}
					>
						{#snippet dialogTitle()}
							{m["network.modem.bands.confirmTitle"]()}
						{/snippet}
						{#snippet description()}
							{m["network.modem.bands.confirmBody"]()}
						{/snippet}
					</SimpleAlertDialog>
				{/if}

				{#if bandApplying}
					<p
						class="text-muted-foreground flex items-center gap-2 text-xs"
						data-testid="modem-bands-applying"
						role="status"
					>
						<Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
						{m["network.modem.bands.applying"]()}
					</p>
				{:else if bandOutcomeKey}
					<p class="text-xs" data-testid="modem-bands-outcome" role="status">
						{resolveMessageKey(bandOutcomeKey)}
					</p>
					{#if bandReconciliation}
						<p
							class="text-status-warning text-xs"
							data-testid="modem-bands-outcome-reconciliation"
							role="status"
						>
							{bandReconciliation}
						</p>
					{/if}
				{/if}
		</CapabilitySection>



		<!-- ── Advanced ─────────────────────────────────────────────────────────
		     The single secondary surface. Everything inside it is either a
		     read-only instrument (usage, cell detail, the inbox), device surgery
		     (USB composition), or a ranking WITHIN a choice made above it (the 5G
		     preference refines the network type's allowed set) — none of it is
		     what an operator opened this dialog to change, and together they were
		     783px of a 363px kiosk window. Network type used to be here and was
		     promoted; it was the one control down here an operator sets in the
		     field. -->
		<CollapsibleSection
			bodyId="modem-advanced-body"
			bodyTestid="modem-advanced-body"
			class="bg-transparent"
			description={m["network.modem.advanced.description"]()}
			testid="modem-advanced"
			title={m["network.modem.advanced.title"]()}
			toggleTestid="modem-advanced-toggle"
			bind:open={advancedOpen}
		>
		<div class="space-y-4">
		<!-- ── 5G preference ────────────────────────────────────────────────────
		     The network-type selector above chooses the ALLOWED SET; this chooses
		     the RANKING within it. They are two different questions and the second
		     is the one the coarse selector structurally cannot express, which is
		     why both live here rather than folding into one control. The device
		     publishes the block only where the ladder says the control may be
		     offered, so the gate is never re-derived here. -->
		<CapabilitySection
			name="modem-five-g-card" class={CARD_FRAME} view={fiveGView}
			title={m["network.modem.fiveG.title"]()}
			description={m["network.modem.fiveG.intro"]()}>
				<div class="space-y-1.5" data-testid="modem-five-g-options" role="radiogroup"
					aria-label={m["network.modem.fiveG.title"]()}>
					{#each fiveGOptions as option (option.preference)}
						<button
							aria-checked={option.active}
							class="focus-visible:ring-ring flex w-full items-start gap-2.5 rounded-md border p-2.5 text-start focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
							data-active={option.active}
							data-testid="modem-five-g-option-{option.preference}"
							disabled={noSim || fiveGApplying || option.active}
							onclick={() => applyFiveG(option.preference)}
							role="radio"
							type="button"
						>
							<div class="min-w-0 flex-1">
								<p class="text-sm">{resolveMessageKey(option.labelKey)}</p>
								<p class="text-muted-foreground text-xs">
									{resolveMessageKey(option.descriptionKey)}
								</p>
							</div>
							{#if option.active}
								<span
									class="text-status-success shrink-0 text-xs"
									data-testid="modem-five-g-active-{option.preference}"
								>
									{m["network.modem.fiveG.active"]()}
								</span>
							{/if}
						</button>
					{/each}
				</div>

				<!-- A REFUSAL IS A READING. SA/NSA is not a control this device can
				     offer, and saying so is more useful than an absent row an
				     operator goes hunting for. -->
				<p class="text-muted-foreground text-xs" data-testid="modem-five-g-nr-mode">
					{resolveMessageKey(fiveGNrModeKey)}
				</p>

				{#if fiveGApplying}
					<p class="text-muted-foreground text-xs" data-testid="modem-five-g-applying" role="status">
						{m["network.modem.fiveG.apply"]()}…
					</p>
				{/if}
				{#if fiveGFailure}
					<p class="text-status-warning text-xs" data-testid="modem-five-g-error" role="status">
						{resolveMessageKey(fiveGFailure)}
					</p>
				{/if}
		</CapabilitySection>

		<!-- ── Data usage ───────────────────────────────────────────────────────
		     TWO HALVES WITH DIFFERENT PRESENCE, and that is why they are separately
		     gated. The COUNTERS are cumulative wire bytes the device itself counted
		     — never a rate, never the carrier's figure — so each states its own
		     scope on screen rather than leaving "12.4 GB" to read as a monthly bill;
		     they render only when the modem reports `data_usage`. The POLICY is the
		     operator's own two numbers, knowable before a single byte is counted, so
		     it renders whenever the device published one. Gating the controls on the
		     counters would hide them on every board in the field, since no shipped
		     device runs the backend that folds counters onto the wire. -->
		<CapabilitySection
			name="modem-usage-card" icon={Gauge} class={CARD_FRAME}
			view={readingView(usage !== undefined || usagePolicy !== undefined)}
			title={m["network.modem.usage.title"]()}
			description={m["network.modem.usage.description"]()}>
				{#if usage}
				<dl
					class={cn('grid grid-cols-2 gap-3', usageStale && 'opacity-50')}
					data-testid="modem-usage-figures"
					data-stale={usageStale ? 'true' : undefined}
				>
					<!-- Each scope hint lives INSIDE its <dd>, not beside it: a <dl>'s
					     grouping <div> may hold only <dt>/<dd>, and a sibling <p> there
					     is a serious axe `definition-list` violation. The hint describes
					     the same term, so the <dd> is where it belongs anyway. -->
					<div class="min-w-0">
						<dt class="text-muted-foreground text-xs">{m["network.modem.usage.session"]()}</dt>
						<dd data-testid="modem-usage-session">
							<span class="block font-mono text-sm tabular-nums">
								{bytes(usage.sessionBytes)}
							</span>
							<span class="text-muted-foreground/80 block text-xs">
								{m["network.modem.usage.sessionHint"]()}
							</span>
						</dd>
					</div>
					<div class="min-w-0">
						<dt class="text-muted-foreground text-xs">{m["network.modem.usage.cycle"]()}</dt>
						<dd data-testid="modem-usage-cycle">
							<span class="block font-mono text-sm tabular-nums">
								{bytes(usage.cycleBytes)}
							</span>
							<span class="text-muted-foreground/80 block text-xs">
								{m["network.modem.usage.cycleHint"]()}
							</span>
						</dd>
					</div>
				</dl>

				{#if usageStale}
					<p class="text-muted-foreground text-xs" data-testid="modem-usage-stale" role="status">
						{m["network.modem.usage.stale"]()}
					</p>
				{/if}

				{#if usage.cycleDay !== undefined}
					<p class="text-muted-foreground text-xs" data-testid="modem-usage-cycle-day">
						{m["network.modem.usage.cycleDay"]({ day: String(usage.cycleDay) })}
					</p>
				{/if}

				<!-- The limit is ADVISORY in both directions: the bar stops at full,
				     the over-limit verdict does not, and neither one gates anything. -->
				{#if usage.thresholdBytes !== undefined}
					<div class="space-y-1.5" data-testid="modem-usage-threshold">
						<div class="flex items-center justify-between gap-2">
							<span class="text-muted-foreground text-xs">
								{m["network.modem.usage.threshold"]()}
							</span>
							<span class="font-mono text-xs tabular-nums" data-testid="modem-usage-threshold-value">
								{m["network.modem.usage.thresholdOf"]({
									used: bytes(usage.cycleBytes),
									limit: bytes(usage.thresholdBytes),
								})}
							</span>
						</div>
						{#if usage.thresholdPercent !== undefined}
							<div class="bg-muted h-1.5 w-full overflow-hidden rounded-full" aria-hidden="true">
								<div
									class={cn(
										'h-full rounded-full',
										usage.overThreshold ? 'bg-status-warning' : 'bg-primary',
									)}
									data-testid="modem-usage-threshold-bar"
									data-percent={usage.thresholdPercent}
									style:inline-size={`${usage.thresholdPercent}%`}
								></div>
							</div>
						{/if}
						<p
							class={cn('text-xs', usage.overThreshold ? 'text-status-warning' : 'text-muted-foreground/80')}
							data-testid="modem-usage-threshold-note"
							role="status"
						>
							{usage.overThreshold
								? m["network.modem.usage.thresholdOver"]()
								: m["network.modem.usage.thresholdAdvisory"]()}
						</p>
					</div>
				{/if}
				{/if}

				<!-- The POLICY controls. A device whose pinned modem-control cannot
				     apply a policy gets the amber disabled-with-reason treatment, not
				     a hidden section and not a fake-interactive one: the capability is
				     a property of THIS build, so the honest thing is to show the
				     control and say why it cannot move right now. -->
				<CapabilitySection
					name="modem-usage-policy" class="space-y-3 border-t pt-2.5"
					view={readingView(usagePolicy !== undefined)}
					title={m["network.modem.usage.settings"]()}>
						{#if !usagePolicyWritable}
							<p
								class="text-status-warning text-xs"
								data-testid="modem-usage-policy-unsupported"
								role="status"
							>
								{m["network.modem.usage.policyUnsupported"]()}
							</p>
						{/if}

						<div class="grid gap-3 sm:grid-cols-2">
							<div class="space-y-1.5">
								<Label class="text-xs" for={`modem-${deviceId}-cycle-day`}>
									{m["network.modem.usage.cycleDayLabel"]()}
								</Label>
								<select
									id={`modem-${deviceId}-cycle-day`}
									class="border-input bg-background focus-visible:ring-ring flex h-11 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
									data-testid="modem-usage-cycle-day-select"
									disabled={!usagePolicyWritable || savePending}
									bind:value={formData.cycleDay}
								>
									<option value="">{m["network.modem.usage.cycleDayUnset"]()}</option>
									{#each CYCLE_DAY_OPTIONS as day (day)}
										<option value={String(day)}>{day}</option>
									{/each}
								</select>
								<p class="text-muted-foreground/80 text-xs">
									{m["network.modem.usage.cycleDayHelp"]()}
								</p>
							</div>

							<div class="space-y-1.5">
								<Label class="text-xs" for={`modem-${deviceId}-threshold`}>
									{m["network.modem.usage.thresholdLabel"]()}
								</Label>
								<Input
									id={`modem-${deviceId}-threshold`}
									class="h-11"
									data-testid="modem-usage-threshold-input"
									inputmode="decimal"
									aria-invalid={thresholdInvalid ? 'true' : undefined}
									disabled={!usagePolicyWritable || savePending}
									placeholder={m["network.modem.usage.thresholdUnset"]()}
									bind:value={formData.thresholdGb}
								/>
								<p
									class={cn('text-xs', thresholdInvalid ? 'text-status-warning' : 'text-muted-foreground/80')}
									data-testid="modem-usage-threshold-help"
									role={thresholdInvalid ? 'status' : undefined}
								>
									{thresholdInvalid
										? m["network.modem.usage.thresholdInvalid"]()
										: m["network.modem.usage.thresholdHelp"]()}
								</p>
							</div>
						</div>
				</CapabilitySection>
		</CapabilitySection>

		<!-- A reading is an instrument figure (mono, tabular, full contrast); a
		     reason is a WORD (proportional, muted, wrapping). The split is the
		     honesty rule made visual — a glance can never read "Not measured yet"
		     as a measurement, and the seven reasons stay seven sentences rather
		     than collapsing into one em-dash. `data-metric-*` carries the machine
		     verdict so a test names a reason class, never a translated string. -->
		{#snippet metricStrip(rows: ModemMetricRow<string>[], prefix: string, cols: string)}
			<dl class={cn('grid grid-cols-2 gap-x-3 gap-y-2.5', cols)} data-testid={`${prefix}-strip`}>
				{#each rows as row (row.id)}
					<div class="min-w-0">
						<dt class="text-muted-foreground text-xs">{t(row.labelKey)}</dt>
						<!-- WRAPS, never truncates: unlike the legacy strip's short hex
						     tokens, an operator name is the one string here a person must
						     read, and it rendered as "Test Carri…" before this. -->
						<dd
							class={row.state === 'known'
								? 'font-mono text-sm break-words tabular-nums'
								: 'text-muted-foreground/90 text-xs leading-snug'}
							data-metric-reason={row.state === 'unknown' ? row.reason : undefined}
							data-metric-state={row.state}
							data-testid={`${prefix}-${row.id}`}
							dir={row.state === 'known' ? 'ltr' : undefined}
						>
							{row.state === 'known' ? row.value : t(row.reasonKey)}
						</dd>
					</div>
				{/each}
			</dl>
		{/snippet}

		<!-- ── Serving-cell detail, firmware, and the SIM identity group ────────
		     Read-only throughout. The eSIM block carries NO management
		     affordance of any kind — no button, no click target, no editable
		     field — because profile management belongs to the carrier's own flow
		     and the EID is a redaction class that is not even on this wire. Data
		     values are set in the mono face (Ground Control: figures are
		     instrument readings, words are UI). -->
		<CapabilitySection
			name="modem-detail-card" icon={RadioTower} class={CARD_FRAME}
			view={readingView(showDetailCard)}
			title={m["network.modem.detail.title"]()}
			description={m["network.modem.detail.description"]()}>
				{#if cellRows.length > 0}
					<dl class="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3" data-testid="modem-cell-info">
						{#each cellRows as row (row.key)}
							<div class="min-w-0">
								<dt class="text-muted-foreground text-xs">{t(row.labelKey)}</dt>
								<dd
									class="truncate font-mono text-sm tabular-nums"
									data-testid={`modem-cell-${row.key}`}
									data-raw={row.format ? row.value : undefined}
								>
									{#if row.valueKey}{t(row.valueKey)}{:else if row.format === 'band' && row.value}{bandLabel(
											row.value,
										)}{:else}{row.value}{#if row.unit}&nbsp;{row.unit}{/if}{/if}
								</dd>
							</div>
						{/each}
					</dl>

					<p class="text-muted-foreground/80 text-xs" data-testid="modem-cell-observed">
						{observedAt === undefined
							? m["network.modem.detail.observedUnknown"]()
							: m["network.modem.detail.observedAt"]({
									when: formatRelativeTime(locale)(new Date(observedAt)),
								})}
					</p>
				{/if}

				{#if signalRows.length > 0}
					<div class="space-y-2" data-testid="modem-signal-detail">
						<p class="text-sm font-medium">{m["network.modem.detail.signalTitle"]()}</p>
						{@render metricStrip(signalRows, 'modem-signal', 'sm:grid-cols-4')}

						<!-- WHEN THE MODEM LAST MEASURED, which is a different question
						     from when WE last read — envelope staleness already answers
						     the second. Without it a cached 40% and a live 40% are the
						     same number on screen, and telling them apart is most of
						     what diagnosing a marginal link is. -->
						{#if signalRecency}
							<p
								class="text-muted-foreground/80 text-xs"
								data-recency={signalRecency.state}
								data-testid="modem-signal-recency"
							>
								{m["network.modem.detail.recencyLabel"]()}: {t(signalRecency.labelKey)}
							</p>
						{/if}
					</div>
				{/if}

				<!-- WHICH network and WHICH cell — never WHERE. These name an operator
				     and a cell inside that operator's network and carry no coordinate,
				     which is why they sit outside the GNSS privacy fence.

				     `cell_id` and `tac` read "Not measured yet" on every board today:
				     the cell property stays masked unless a location source is primed,
				     which this device deliberately never does. That is the fence
				     rendered honestly, not a gap — do not "fix" it here. -->
				{#if registrationMetrics.length > 0}
					<div class="space-y-2" data-testid="modem-registration-context">
						<p class="text-sm font-medium">
							{m["network.modem.detail.registrationTitle"]()}
						</p>
						<!-- TWO columns, not four: three of these four values are names or
						     identifiers rather than short figures, so the signal strip's
						     density is what cut the carrier name in half. -->
						{@render metricStrip(registrationMetrics, 'modem-registration', 'sm:grid-cols-2')}
					</div>
				{/if}

				{#if firmware}
					<div class="min-w-0">
						<p class="text-muted-foreground text-xs">{m["network.modem.detail.firmware"]()}</p>
						<p class="truncate font-mono text-sm" data-testid="modem-firmware">{firmware}</p>
					</div>
				{/if}

				<!-- ── SIM identity ─────────────────────────────────────────────
				     Presence first, then the two identifiers and the eSIM facts.
				     They are ONE group because they answer one question — which
				     card is in this modem — and presence is the only one of them
				     that is always answerable, so it leads.

				     The pill is the SHARED `SimBlock`, the same component the
				     router dialog renders, which is what makes the two families
				     say one thing in one register rather than two. It states
				     `unknown` as its own visibly distinct line rather than as a
				     pill: "the device did not say" is not a status the device
				     reported, so it must not wear the chrome of one. -->
				<SimBlock
					name="modem-sim"
					sim={simIdentity}
					title={m["network.modem.sections.sim.title"]()}
				/>

				<!-- The SIM's ICCID, rendered PLAINLY — the deliberate opposite of the
				     own-number field below. It is printed on the physical card and is
				     what a carrier asks for over the phone to activate a line, so
				     hiding it would obstruct the one job an operator opens this row
				     to do. It gets a copy button instead: 19 digits are read wrong
				     more often than not, and the value's destination is a phone call
				     or a carrier chat window.

				     Both identifiers sit inside the Advanced disclosure, which is
				     collapsed on EVERY open — so neither is on screen until the
				     operator asks for it, and the own number below needs a second,
				     explicit reveal on top of that. -->
				{#if iccid}
					<div class="min-w-0">
						<p class="text-muted-foreground text-xs">{m["network.modem.detail.iccid"]()}</p>
						<div class="flex items-center gap-1.5">
							<p
								class="min-w-0 truncate font-mono text-sm tabular-nums"
								data-testid="modem-iccid"
								dir="ltr"
							>
								{iccid}
							</p>
							<Button
								aria-label={m["network.modem.detail.iccidCopy"]()}
								class="size-6 shrink-0 rounded-md"
								data-testid="modem-iccid-copy"
								onclick={copyIccid}
								size="icon"
								type="button"
								variant="ghost"
							>
								<Copy class="size-3.5" />
							</Button>
						</div>
					</div>
				{/if}

				<!-- The SIM's own number. HIDDEN BY DEFAULT: it identifies the
				     subscriber, so it gets the credential treatment the password
				     fields already use — a mask of FIXED width (a mask that tracked
				     the real length would leak its digit count) and an explicit
				     reveal. A modem whose carrier published no number renders
				     NOTHING here: most SIMs carry none, so a placeholder would read
				     as a failed read on the majority of devices. -->
				{#if simNumbers}
					<div class="min-w-0 space-y-1" data-testid="modem-own-number">
						<div class="flex items-center gap-1.5">
							<p class="text-muted-foreground text-xs">
								{m["network.modem.detail.ownNumber"]()}
							</p>
							<Button
								aria-label={revealOwnNumber
									? m["network.modem.detail.ownNumberHide"]()
									: m["network.modem.detail.ownNumberShow"]()}
								aria-pressed={revealOwnNumber}
								class="size-6 rounded-md"
								data-testid="modem-own-number-toggle"
								onclick={() => (revealOwnNumber = !revealOwnNumber)}
								size="icon"
								type="button"
								variant="ghost"
							>
								{#if revealOwnNumber}
									<EyeOff class="size-3.5" />
								{:else}
									<Eye class="size-3.5" />
								{/if}
							</Button>
						</div>
						{#each simNumbers as number, index (number)}
							<p
								class="truncate font-mono text-sm"
								data-revealed={revealOwnNumber}
								data-testid={`modem-own-number-value-${index}`}
								dir="ltr"
							>
								{revealOwnNumber ? number : OWN_NUMBER_MASK}
							</p>
						{/each}
					</div>
				{/if}

				{#if esim}
					<div class="space-y-1" data-testid="modem-esim">
						<p class="text-muted-foreground text-xs">{m["network.modem.detail.simType"]()}</p>
						<div class="flex flex-wrap items-center gap-1.5">
							<Badge
								variant={esim.isEsim ? 'info' : 'neutral'}
								size="micro"
								class="text-(length:--text-micro)"
								data-testid="modem-esim-type"
								label={t(esim.typeKey)}
							/>
							{#if esim.statusKey}
								<Badge
									variant="neutral"
									size="micro"
									class="text-(length:--text-micro)"
									data-testid="modem-esim-status"
									label={t(esim.statusKey)}
								/>
							{/if}
						</div>
						<p class="text-muted-foreground/80 text-xs" data-testid="modem-esim-readonly">
							{m["network.modem.detail.esimReadOnly"]()}
						</p>
					</div>
				{/if}
		</CapabilitySection>

		<!-- ── Raw device values ────────────────────────────────────────────────
		     OL-3/OL-4: the exact tokens the operator-facing labels above replaced,
		     RELOCATED rather than deleted, in a block that names itself as
		     diagnostics. A field engineer comparing a composition or a band
		     against a vendor table loses nothing; an operator reading the cards
		     above never meets a protocol name.

		     IT IS BEHIND ITS OWN DISCLOSURE, and that is a second gate rather than
		     a duplicate one. Living inside Advanced made it "already collapsed"
		     only for as long as nothing else opens Advanced — and the operator who
		     opens Advanced is reaching for the usage counters or the composition
		     switch, not for a dump. The dongle dialog reached the same conclusion
		     (`dongle-diagnostics`), so both families now fold their raw values the
		     same way. `CollapsibleSection` rather than `CapabilitySection` for the
		     reason that dialog records: a header that IS its own control cannot be
		     split into heading-plus-control without either losing the chevron's
		     accessible name or printing the title twice.

		     It is its OWN section rather than a tail on the detail card, because
		     the two answer to different evidence: the detail card vanishes when
		     the modem reported no cell/eSIM/firmware, and folding this into it
		     would make a composition's raw value hostage to a reading that has
		     nothing to do with it.

		     The ROWS come from `modemDiagnosticRows`, which returns through the
		     shared redaction boundary — so the identifiers this modem published
		     are retained as rows and masked as values. -->
		{#if hasRawDiagnostics}
			<CollapsibleSection
				bodyId="modem-raw-diagnostics-body"
				bodyTestid="modem-raw-diagnostics-body"
				class="rounded-lg border"
				description={m["network.modem.detail.diagnosticsDescription"]()}
				testid="modem-raw-diagnostics"
				title={m["network.modem.detail.diagnosticsTitle"]()}
				toggleTestid="modem-raw-diagnostics-toggle"
			>
				{#snippet icon()}
					<Wrench class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				{/snippet}
				<div class="space-y-2">
					<DiagnosticsBlock
						diagnostics={NO_DERIVED_DIAGNOSTIC_ROWS}
						extra={diagnosticRows}
						name="modem-raw-diagnostic-readings"
						rowPrefix="modem-raw"
					/>
					<p class="text-muted-foreground/80 text-xs" data-testid="modem-raw-redaction-note">
						{m["network.modem.detail.diagnosticsRedacted"]()}
					</p>
				</div>
			</CollapsibleSection>
		{/if}

		<!-- ── Messages: the read-only SMS inbox ────────────────────────────────
		     PROGRESSIVE DISCLOSURE. This surface already carries three instrument
		     panels, and a stored inbox is the one thing here that is neither
		     telemetry nor configuration — so it stays folded, costs one calm
		     header row, and reads nothing until the operator asks for it.

		     READ-ONLY STRUCTURALLY, not by disabling. There is no compose field,
		     no reply, no delete, no forward — not greyed-out ones, none at all.
		     The procedure behind this is list + per-message read and the backend
		     grep-gates it that way; an affordance here would be a promise the
		     device cannot keep. `ModemConfigDialog.sms.test.ts` asserts the
		     absence against the real DOM rather than against this comment.

		     WITHDRAWS ENTIRELY on `unsupported` — see `smsWithdrawn`. -->
		{#if !smsWithdrawn}
			<section class="rounded-lg border" data-testid="modem-sms-card">
				<button
					type="button"
					aria-controls="modem-sms-body"
					aria-expanded={smsOpen}
					class="flex min-h-[var(--touch-target-min)] w-full items-start gap-2.5 rounded-lg p-3 text-start"
					data-testid="modem-sms-toggle"
					onclick={toggleSms}
				>
					<MessageSquare
						class="text-muted-foreground mt-0.5 size-4 shrink-0"
						aria-hidden="true"
					/>
					<span class="min-w-0 flex-1">
						<span class="block text-sm font-medium">{m["network.modem.sms.title"]()}</span>
						<span class="text-muted-foreground block text-xs">
							{m["network.modem.sms.description"]()}
						</span>
					</span>
					{#if smsLoaded && smsRefusal === undefined && !smsTimedOut}
						<!-- The count is an instrument reading, so it is set in the mono
						     face; the word it stands for is spoken, not printed. -->
						<span class="mt-0.5 shrink-0" data-testid="modem-sms-count">
							<!-- The digit is hidden from the accessible name, not merely
							     duplicated by it: this span sits INSIDE the toggle, so
							     name-from-content would otherwise concatenate both and a
							     screen reader would hear "37 37 messages stored". -->
							<span
								class="text-muted-foreground font-mono text-sm tabular-nums"
								aria-hidden="true"
								dir="ltr"
							>
								{smsMessages.length}
							</span>
							<span class="sr-only">
								{m["network.modem.sms.countLabel"]({ count: String(smsMessages.length) })}
							</span>
						</span>
					{/if}
					<ChevronDown
						class={cn(
							'text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform',
							smsOpen && 'rotate-180',
						)}
						aria-hidden="true"
					/>
				</button>

				<!-- CSS-DRIVEN REVEAL (`grid-template-rows: 0fr → 1fr`), never a JS
				     transition — the same rule `CollapsibleSection.svelte` states for
				     the same reason: a JS transition compiles to the Web Animations
				     API, which runs outside CSS and so escapes BOTH global motion
				     freezes (`prefers-reduced-motion` and the e-ink `transition:
				     none`). Driven from CSS, this disclosure is static-safe on
				     e-paper for free.

				     The CONTENT is still `{#if}`-gated inside the animated wrapper,
				     so a closed inbox holds no message text in the DOM at all. That
				     matters more here than a symmetric close animation: a real SIM's
				     inbox carries one-time codes, and "collapsed" must not mean
				     "present in the page, merely clipped". -->
				<div
					class="grid transition-[grid-template-rows] duration-200 ease-out"
					data-testid="modem-sms-body"
					style:grid-template-rows={smsOpen ? '1fr' : '0fr'}
				>
					<div class="min-h-0 overflow-hidden">
						{#if smsOpen}
							<div class="space-y-3 border-t p-3" id="modem-sms-body">
								<div class="flex items-center justify-end">
									<!-- The ONLY action in this section, and it is a re-read. The
									     inbox is not live — the device pushes no message events —
									     so a manual re-read is the honest alternative to a list
									     that silently ages while the operator looks at it. -->
									<Button
										class="h-8 min-h-[var(--touch-target-min)] gap-1.5 px-2.5 text-xs"
										data-testid="modem-sms-refresh"
										disabled={smsLoading}
										onclick={loadSms}
										size="sm"
										type="button"
										variant="outline"
									>
										{#if smsLoading}
											<Loader2 class="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
										{:else}
											<RefreshCw class="size-3.5" aria-hidden="true" />
										{/if}
										{m["network.modem.sms.refresh"]()}
									</Button>
								</div>

								{#if smsLoading && !smsLoaded}
									<p
										class="text-muted-foreground flex items-center gap-2 text-xs"
										data-testid="modem-sms-loading"
										role="status"
									>
										<Loader2 class="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
										{m["network.modem.sms.loading"]()}
									</p>
								{:else if smsTimedOut}
									<!-- Distinct from BOTH neighbours on purpose. A refusal is the
									     device answering no; an empty inbox is the device answering
									     nothing; this is the device not answering, so it may not
									     borrow either sentence. The refresh above is the repair. -->
									<div
										class="bg-muted/40 space-y-1 rounded-md border p-2.5"
										data-testid="modem-sms-timed-out"
										role="status"
									>
										<p class="text-sm font-medium">{m["network.modem.readTimedOutTitle"]()}</p>
										<p class="text-muted-foreground text-xs leading-relaxed">
											{m["network.modem.readTimedOut"]()}
										</p>
									</div>
								{:else if smsRefusalCopyKey}
									<!-- Calm status, never a red alert: none of the three refusals
									     that reach here means something broke on the operator's
									     side, and all three are states the device can leave — which
									     is exactly why the refresh above stays offered. -->
									<div
										class="bg-muted/40 space-y-1 rounded-md border p-2.5"
										data-testid="modem-sms-refused"
										data-sms-refusal={smsRefusal}
										role="status"
									>
										<p class="text-sm font-medium">{m["network.modem.sms.refusedTitle"]()}</p>
										<p class="text-muted-foreground text-xs leading-relaxed">
											{t(smsRefusalCopyKey)}
										</p>
									</div>
								{:else if smsMessages.length === 0}
									<div
										class="flex items-start gap-2.5"
										data-testid="modem-sms-empty"
										role="status"
									>
										<Inbox class="text-muted-foreground/60 mt-0.5 size-4 shrink-0" aria-hidden="true" />
										<div class="min-w-0">
											<p class="text-sm">{m["network.modem.sms.empty"]()}</p>
											<p class="text-muted-foreground text-xs">{m["network.modem.sms.emptyHint"]()}</p>
										</div>
									</div>
								{:else}
									<ul class="divide-y" data-testid="modem-sms-list">
										{#each smsMessages as message (message.id)}
											{@const when = smsWallClock(message.timestamp)}
											<li
												class="space-y-1 py-2.5 first:pt-0 last:pb-0"
												data-sms-id={message.id}
												data-testid="modem-sms-message"
											>
												<div class="flex items-baseline justify-between gap-3">
													<p class="min-w-0 truncate text-sm font-medium" data-testid="modem-sms-from">
														{message.from ?? m["network.modem.sms.unknownSender"]()}
													</p>
													{#if when}
														<!-- LTR-isolated: the reading is `YYYY-MM-DD HH:MM`
														     and an RTL locale would otherwise reorder its
														     runs around the separators. -->
														<p
															class="text-muted-foreground shrink-0 font-mono text-xs tabular-nums"
															data-testid="modem-sms-time"
															dir="ltr"
														>
															{when}
														</p>
													{:else}
														<p
															class="text-muted-foreground/70 shrink-0 text-xs"
															data-testid="modem-sms-no-time"
														>
															{m["network.modem.sms.noTimestamp"]()}
														</p>
													{/if}
												</div>
												{#if message.text.trim().length > 0}
													<p
														class="text-muted-foreground text-sm leading-relaxed break-words whitespace-pre-line"
														data-testid="modem-sms-text"
													>
														{message.text}
													</p>
												{:else}
													<!-- A data-only (WAP/PDU) message really has no text.
													     Saying so beats an empty row that reads as a
													     rendering fault. -->
													<p class="text-muted-foreground/70 text-xs" data-testid="modem-sms-no-text">
														{m["network.modem.sms.noText"]()}
													</p>
												{/if}
											</li>
										{/each}
									</ul>

									<div class="text-muted-foreground/80 space-y-1 border-t pt-2.5 text-xs">
										<p data-testid="modem-sms-hint">{m["network.modem.sms.hint"]()}</p>
										{#if smsCapped}
											<!-- At the cap the list is a WINDOW, not the inbox. Saying
											     so is the difference between "50 messages" and "the 50
											     most recent of however many the SIM holds". -->
											<p data-testid="modem-sms-capped">
												{m["network.modem.sms.capped"]({ count: String(SMS_INBOX_CAP) })}
											</p>
										{/if}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</section>
		{/if}

		<!-- ── USB composition mode ─────────────────────────────────────────────
		     Deliberately OUTSIDE the no-SIM fieldset: the composition is a property
		     of the USB device, not of the SIM, so a modem with no SIM can still be
		     switched. -->
		<CapabilitySection
			name="modem-usb-mode-card" icon={Usb} class={CARD_FRAME}
			view={readingView(showUsbModeCard)}
			title={m["network.modem.usbMode.title"]()}
			description={m["network.modem.usbMode.description"]()}>
				<dl class="grid grid-cols-2 gap-2 text-xs">
					<div>
						<dt class="text-muted-foreground">{m["network.modem.usbMode.active"]()}</dt>
						<dd
							class="text-sm"
							data-testid="modem-usb-mode-active"
							data-usb-mode={activeUsbMode}
						>
							{usbModeLabel(activeUsbMode)}
						</dd>
					</div>
					{#if recommendedUsbMode}
						<div>
							<dt class="text-muted-foreground">{m["network.modem.usbMode.recommended"]()}</dt>
							<dd
								class="text-sm"
								data-testid="modem-usb-mode-recommended"
								data-usb-mode={recommendedUsbMode}
							>
								{usbModeLabel(recommendedUsbMode)}
							</dd>
						</div>
					{/if}
				</dl>

				{#if usbOptionsUnknown}
					<!-- The ACTIVE mode above is still the device's own, so the card
					     stays; only the OFFER is unknown. Saying so is what stops it
					     reading as "this modem has no switch". -->
					<p
						class="text-muted-foreground text-xs"
						data-testid="modem-usb-mode-options-unknown"
						role="status"
					>
						{resolveMessageKey(USB_MODE_OPTIONS_UNKNOWN_KEY)}
					</p>
				{/if}

				{#if offerUsbSwitch && usbOffer.phase === 'offered' && !usbSwitchTrackable}
					<!-- Certified, but unconfirmable: without a `stable_key` the device
					     cannot be re-found after it re-enumerates, so every attempt would
					     end in the "still transitioning" band. The modes are not listed
					     either — an option that can never be acted on is not an option. -->
					<p class="text-muted-foreground text-xs" data-testid="modem-usb-mode-untrackable">
						{m["network.modem.usbMode.reason.identity_unresolved"]()}
					</p>
				{:else if offerUsbSwitch && usbOffer.phase === 'offered'}
					<!-- ONLY the certified transitions, and every one of them. The list
					     is the device's own answer for this exact model and firmware,
					     so what is on screen is exactly what a dispatch would accept. -->
					<div
						class="space-y-1.5"
						role="radiogroup"
						aria-label={m["network.modem.usbMode.certifiedTargets"]()}
						data-testid="modem-usb-mode-targets"
					>
						<p class="text-muted-foreground text-xs">
							{m["network.modem.usbMode.certifiedTargets"]()}
						</p>
						<div class="flex flex-wrap gap-1.5">
							{#each usbOffer.targets as target (target)}
								<button
									type="button"
									role="radio"
									aria-checked={target === usbSwitchTarget}
									class={cn(
										'min-h-[var(--touch-target-min)] rounded-md border px-2.5 py-1 text-xs',
										target === usbSwitchTarget
											? 'border-primary bg-primary/10 text-foreground'
											: 'text-muted-foreground hover:bg-muted/50',
									)}
									data-testid="modem-usb-mode-target-{target}"
									data-usb-mode={target}
									onclick={() => {
										usbSelected = target;
									}}
								>
									{usbModeLabel(target)}
									{#if target === recommendedUsbMode}
										<span class="text-muted-foreground ml-1 font-sans">
											{m["network.modem.usbMode.recommended"]()}
										</span>
									{/if}
								</button>
							{/each}
						</div>
					</div>

					{#if provisioningBlocked}
						<!-- Disabled-with-reason, and the reason is ON SCREEN as well as in
						     the accessible name: the device ships with a kiosk touchscreen
						     that cannot hover to reveal a tooltip (the `netif-dongle` rule).
						     Turning provisioning back on is something the operator can do,
						     which is why this is the amber blocked treatment rather than the
						     calm standing-refusal band a permanent refusal gets. -->
						<div class="space-y-1.5" data-usb-mode-gate="provisioning-disabled">
							<Button
								class="min-h-[var(--touch-target-min)] w-full"
								data-testid="modem-usb-mode-switch"
								disabled
								aria-label={m["network.modem.usbMode.provisioningDisabled"]()}
								title={m["network.modem.usbMode.provisioningDisabled"]()}
								variant="outline"
							>
								{m["network.modem.usbMode.switchTo"]({ mode: usbModeLabel(usbSwitchTarget) })}
							</Button>
							<p
								class="text-status-warning text-xs"
								data-testid="modem-usb-mode-provisioning-blocked"
							>
								{m["network.modem.usbMode.provisioningDisabled"]()}
							</p>
						</div>
					{:else}
						<SimpleAlertDialog
							buttonClasses="w-full"
							buttonText={m["network.modem.usbMode.switchTo"]({ mode: usbModeLabel(usbSwitchTarget) })}
							confirmButtonText={m["network.modem.usbMode.confirmAction"]()}
							confirmVariant="destructive"
							disabledConfirmButton={usbSwitching}
							extraButtonClasses="min-h-[var(--touch-target-min)]"
							title={m["network.modem.usbMode.confirmTitle"]()}
							onconfirm={handleUsbModeSwitch}
						>
							{#snippet dialogTitle()}
								{m["network.modem.usbMode.confirmTitle"]()}
							{/snippet}
							{#snippet description()}
								{m["network.modem.usbMode.confirmBody"]()}
							{/snippet}
						</SimpleAlertDialog>
					{/if}
				{/if}

				<!-- The spinner is the ONLY optimistic element: the active mode above
				     is read from the live feed, so an RPC success alone never moves it. -->
				{#if usbSwitching}
					<p
						class="text-muted-foreground flex items-center gap-2 text-xs"
						data-testid="modem-usb-mode-switching"
						role="status"
					>
						<Loader2 class="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
						{m["network.modem.usbMode.switching"]()}
					</p>
				{:else if usbFlow?.phase === 'confirmed'}
					<p
						class="text-status-success text-xs"
						data-testid="modem-usb-mode-confirmed"
						role="status"
					>
						{m["network.modem.usbMode.switched"]()}
					</p>
				{:else if usbFlow?.phase === 'unconfirmed'}
					<p
						class="border-status-warning/40 bg-status-warning/10 rounded-md border p-2 text-xs"
						data-testid="modem-usb-mode-pending"
						role="status"
					>
						{m["network.modem.usbMode.pending"]()}
					</p>
				{:else if usbUnknownBand}
					<!-- NOT `modem-usb-mode-error`: an outcome nobody can classify as a
					     failure must not be findable as one, by an operator or by a
					     gate. The band carries the reconciliation pointer and offers no
					     retry. -->
					<div data-testid="modem-usb-mode-unknown-outcome">
						<MutationOutcomeBand
							name="modem-usb-mode"
							outcome={usbUnknownBand.outcome}
							detail={usbUnknownBand.detail}
						/>
					</div>
				{:else if usbStandingRefusal}
					<!-- A refusal that will answer identically forever is a standing
					     property of this device, not an error. It gets the calm muted
					     treatment (never the destructive red), it says what still
					     works, and the switch control above is withdrawn — because a
					     retry button beside a permanent refusal misrepresents what
					     pressing it would do. `uncertified` reaches here only from a
					     DISPATCH: the offer read no longer answers it for a device it
					     can interrogate, so a modem that reaches this band asked for a
					     transition its catalog entry does not permit. -->
					<div
						class="bg-muted/40 space-y-1 rounded-md border p-2.5"
						data-testid="modem-usb-mode-error"
						data-usb-mode-refusal={usbStandingRefusal}
						role="status"
					>
						<p class="text-sm font-medium">{usbFailureText}</p>
						<p class="text-muted-foreground text-xs">{t(usbStandingBodyKey)}</p>
					</div>
				{:else if usbBand}
					<div data-testid="modem-usb-mode-error">
						<MutationOutcomeBand
							name="modem-usb-mode"
							outcome={usbBand.outcome}
							detail={usbBand.detail}
						/>
					</div>
				{:else if usbFailureText}
					<p
						class="text-status-error text-xs"
						data-testid="modem-usb-mode-error"
						role="alert"
					>
						{usbFailureText}
					</p>
				{:else if usbBlockedReason}
					<!-- A CONDITION, not a property of the device: provisioning is off,
					     or something live is holding this modem. The control area stays
					     visible and disabled and the reason is ON SCREEN rather than in
					     a `title` — the shipped kiosk touchscreen cannot hover — and it
					     is the amber blocked register rather than the calm withheld one,
					     because this is something the operator can go and lift. -->
					<div
						class="border-status-warning/40 bg-status-warning/10 space-y-1 rounded-md border p-2.5"
						data-testid="modem-usb-mode-blocked"
						data-usb-mode-gate={usbBlockedReason}
						role="status"
					>
						<p class="text-sm font-medium">
							{t(usbOfferSuppressionKey(usbBlockedReason))}
						</p>
						{#if usbSuppressionBodyKey}
							<p class="text-muted-foreground text-xs">{t(usbSuppressionBodyKey)}</p>
						{/if}
					</div>
				{:else if usbWithheldReason}
					<!-- No mode may be offered, and the device said why. There is no
					     control here at all — not a disabled one, which would imply a
					     capability being withheld when there is none to withhold: this
					     build cannot ask this device, or the device's own answer proves
					     no route back. The active mode above keeps working, which is
					     what the body says. -->
					<div
						class="bg-muted/40 space-y-1 rounded-md border p-2.5"
						data-testid="modem-usb-mode-unavailable"
						data-usb-mode-withheld={usbWithheldReason}
						role="status"
					>
						<p class="text-sm font-medium">
							{t(usbOfferSuppressionKey(usbWithheldReason))}
						</p>
						{#if usbSuppressionBodyKey}
							<p class="text-muted-foreground text-xs">{t(usbSuppressionBodyKey)}</p>
						{/if}
					</div>
				{/if}
		</CapabilitySection>

		<ModemFccUnlockSection
			claim={fccClaim}
			state={fccState}
			busy={fccBusy}
			outcome={fccOutcome}
			detail={fccDetail}
			onToggle={(next) => void toggleFccUnlock(next)}
		/>

		<!-- The GPS module's whole surface existed and was WIRED, but nothing ever
		     mounted it, so a `capable` receiver contributed exactly as many DOM
		     nodes as a modem with no GNSS at all: zero. Keep this mount — and keep
		     its twin in `RouterDongleDialog`, or the same claim is unreachable for
		     half the fleet. Like the USSD surface below it, this one owns its state
		     and its RPC: do not hoist them here for consistency, because unmounting
		     is what drops the coordinate. -->
		<ModemGpsSection claim={gpsClaim} deviceId={String(deviceId)} />

		<!-- Same shape, same reason: closing the dialog unmounts the component,
		     which is what drops the carrier's text. -->
		<ModemUssdSection claim={ussdClaim} deviceId={String(deviceId)} />

		<!-- ── Power & recovery ────────────────────────────────────────────────
		     READ-ONLY BY CONSTRUCTION. `@ceralive/modem-control` publishes `power`
		     as a read operation with no setter and no reset beside it, and ships
		     `UhubctlPort` with no adapter on any device — so this card renders the
		     state, states what it cannot do, and offers NOTHING pressable. It is
		     routed as available/absent rather than `blocked`, because `blocked`
		     renders a DISABLED control, and a disabled control claims a capability
		     is being withheld when in fact there is none to withhold. -->
		<CapabilitySection
			name="modem-power-card" icon={Power} class={CARD_FRAME}
			view={readingView(true)}
			title={m["network.modem.power.title"]()}
			description={m["network.modem.power.description"]()}>
				<div class="space-y-1" data-testid="modem-power-state">
					<p class="text-muted-foreground text-xs">
						{m["network.modem.power.stateLabel"]()}
					</p>
					{#if powerReading}
						<p class="text-sm" data-radio-power={powerReading.state}>
							{t(powerReading.labelKey)}
						</p>
						<p class="text-muted-foreground/80 text-xs leading-relaxed">
							{t(powerReading.provenanceKey)}
						</p>
					{:else}
						<p class="text-muted-foreground text-sm" data-testid="modem-power-unreported">
							{m["network.modem.power.unreported"]()}
						</p>
					{/if}
				</div>

				<!-- The ONE recovery this device performs. It is reached by SAVING a
				     connect-time setting, not by a button here, so this points at
				     that path rather than minting a second one that would need its
				     own confirmation and could disagree with the first. -->
				<div class="space-y-1" data-testid="modem-power-recovery">
					<p class="text-sm font-medium">
						{m["network.modem.power.recovery.title"]()}
					</p>
					<p class="text-muted-foreground text-xs leading-relaxed">
						{m["network.modem.power.recovery.body"]()}
					</p>
				</div>

				<ul class="space-y-2" data-testid="modem-power-unavailable">
					{#each POWER_UNAVAILABLE_OPERATIONS as op (op.id)}
						<li class="space-y-0.5" data-testid="modem-power-unavailable-{op.id}">
							<p class="text-sm">{t(op.titleKey)}</p>
							<p class="text-muted-foreground text-xs leading-relaxed">
								{t(op.reasonKey)}
							</p>
						</li>
					{/each}
				</ul>
		</CapabilitySection>
		</div>
		</CollapsibleSection>
	</div>
</AppDialog>
