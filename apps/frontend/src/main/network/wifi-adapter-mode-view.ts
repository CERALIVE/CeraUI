/**
 * wifi-adapter-mode-view.ts — the ONE derivation behind the three-way adapter
 * mode control (todo 14).
 *
 * Before this module, three surfaces each answered "what mode is this radio in"
 * their own way: `WifiSection` from `isApRadio()` plus a separate concurrent-AP
 * badge, `HotspotSection` from `supports_ap_sta_concurrency`, and
 * `HotspotDialog` from `hotspotIsActive()` alone. Three renderings of one fact
 * is how they came to disagree — a hybrid radio read as "Active" on one card and
 * "WiFi + AP" on another, with no shared word for either.
 *
 * Every surface now routes through `deriveWifiAdapterModeView`, so the displayed
 * mode is identical by construction. Pure and rune-free: it takes the device's
 * own answer plus the interface snapshot, never a store.
 */

import type {
	WifiAdapterMode,
	WifiAdapterModeEntry,
	WifiAdapterModeOption,
	WifiAdapterModeUnavailableReason,
	WifiInterface,
} from "@ceraui/rpc/schemas";

import { isApRadio } from "$lib/helpers/wifi-mode-outcome";
import type { AsyncOpPhase } from "$lib/rpc/async-operation.svelte";
import { hotspotIsActive } from "$lib/rpc/os-toggle-predicates";

/** Display order. Fixed so two surfaces cannot list the same three modes differently. */
export const WIFI_ADAPTER_MODES: readonly WifiAdapterMode[] = [
	"station",
	"hotspot",
	"hybrid",
] as const;

const MODE_LABEL_KEY: Record<WifiAdapterMode, string> = {
	station: "network.wifiMode.station",
	hotspot: "network.wifiMode.hotspot",
	hybrid: "network.wifiMode.hybrid",
};

const MODE_DESCRIPTION_KEY: Record<WifiAdapterMode, string> = {
	station: "network.wifiMode.stationHint",
	hotspot: "network.wifiMode.hotspotHint",
	hybrid: "network.wifiMode.hybridHint",
};

const UNAVAILABLE_REASON_KEY: Record<WifiAdapterModeUnavailableReason, string> =
	{
		unsupported: "network.wifiMode.reason.unsupported",
		"capability-absent": "network.wifiMode.reason.capabilityAbsent",
		"capability-unknown": "network.wifiMode.reason.capabilityUnknown",
	};

const ERROR_KEY: Record<string, string> = {
	DEVICE_BUSY: "network.wifiMode.error.deviceBusy",
	"no-device": "network.wifiMode.error.noDevice",
	unsupported: "network.wifiMode.error.unsupported",
	"capability-unproven": "network.wifiMode.error.capabilityUnproven",
	"activation-failed": "network.wifiMode.error.activationFailed",
	"not-confirmed": "network.wifiMode.error.notConfirmed",
	"deactivation-failed": "network.wifiMode.error.deactivationFailed",
};

/** i18n dot-path for the mode's own name. */
export function wifiModeLabelKey(mode: WifiAdapterMode): string {
	return MODE_LABEL_KEY[mode];
}

/** Narrow the async-op store's opaque `target`; anything else is no target. */
export function wifiModeTarget(value: unknown): WifiAdapterMode | undefined {
	return WIFI_ADAPTER_MODES.includes(value as WifiAdapterMode)
		? (value as WifiAdapterMode)
		: undefined;
}

/** i18n dot-path for the one-line description of what the mode does. */
export function wifiModeDescriptionKey(mode: WifiAdapterMode): string {
	return MODE_DESCRIPTION_KEY[mode];
}

/**
 * i18n dot-path for a transition failure.
 *
 * An unrecognised token resolves to the generic sentence rather than being
 * rendered raw — a machine token is never operator copy.
 */
export function wifiModeErrorKey(reason: string | undefined): string {
	if (reason === undefined) return "network.wifiMode.error.generic";
	return ERROR_KEY[reason] ?? "network.wifiMode.error.generic";
}

/** What changing to a mode costs the operator, when it costs anything. */
export type WifiModeConsequence = "drops-uplink" | "drops-hotspot";

const CONSEQUENCE_KEY: Record<
	WifiModeConsequence,
	{ title: string; body: string; confirm: string }
> = {
	"drops-uplink": {
		title: "network.wifiMode.confirm.dropsUplinkTitle",
		body: "network.wifiMode.confirm.dropsUplinkBody",
		confirm: "network.wifiMode.confirm.dropsUplinkAction",
	},
	"drops-hotspot": {
		title: "network.wifiMode.confirm.dropsHotspotTitle",
		body: "network.wifiMode.confirm.dropsHotspotBody",
		confirm: "network.wifiMode.confirm.dropsHotspotAction",
	},
};

/** The three i18n dot-paths a destructive transition's confirm renders. */
export function wifiModeConsequenceKeys(consequence: WifiModeConsequence): {
	title: string;
	body: string;
	confirm: string;
} {
	return CONSEQUENCE_KEY[consequence];
}

/** What the radio is doing right now, from the operator's point of view. */
export interface WifiAdapterModeContext {
	/** The radio currently carries a station leg that can serve as an uplink. */
	stationLinkLive: boolean;
	/** The radio is currently broadcasting an access point. */
	hotspotLive: boolean;
}

/**
 * Whether moving `from` → `to` destroys something the operator is using.
 *
 * Only a LOSS is destructive. Adding an AP to a station (`hybrid`) takes nothing
 * away, and neither does restoring a station leg to a running AP — so neither
 * asks for a confirmation the operator would learn to click through.
 */
export function deriveWifiModeConsequence(
	from: WifiAdapterMode,
	to: WifiAdapterMode,
	ctx: WifiAdapterModeContext,
): WifiModeConsequence | undefined {
	if (from === to) return undefined;
	if (to === "hotspot" && ctx.stationLinkLive) return "drops-uplink";
	if (to === "station" && ctx.hotspotLive) return "drops-hotspot";
	return undefined;
}

/** One rendered rung of the segmented control. */
export interface WifiAdapterModeOptionView {
	mode: WifiAdapterMode;
	available: boolean;
	/** The mode the control shows as chosen. Exactly one option carries it. */
	selected: boolean;
	labelKey: string;
	/** Present iff `!available` — a withheld mode ALWAYS states why. */
	reasonKey?: string;
	/** The raw wire token, for a machine-readable assertion. */
	reason?: WifiAdapterModeUnavailableReason;
	/** Set while this option is the target of an in-flight transition. */
	pending: boolean;
}

/** Everything a surface needs to render one adapter's mode, derived once. */
export interface WifiAdapterModeView {
	device: string;
	/**
	 * The mode to DISPLAY. Held on the prior mode while a transition is pending,
	 * so a raw `wifi` broadcast cannot flip the control before the device has
	 * confirmed — and so a failed transition leaves the prior mode on screen.
	 */
	displayMode: WifiAdapterMode;
	/** The mode the device reports right now, unheld. */
	observedMode: WifiAdapterMode;
	/** The persisted operator preference, when the device reported one. */
	desiredMode?: WifiAdapterMode;
	/** All three modes, always, in {@link WIFI_ADAPTER_MODES} order. */
	options: WifiAdapterModeOptionView[];
	pending: boolean;
	pendingTarget?: WifiAdapterMode;
	/** Present on a TERMINAL failure; the control still shows `displayMode`. */
	errorKey?: string;
	/** The raw failure token, for a machine-readable assertion. */
	error?: string;
	/**
	 * True when the offering came from the device's own `getAdapterModes` answer
	 * rather than from the interface snapshot. A surface may use it to explain a
	 * degraded offering; it must never hide the control.
	 */
	deviceAnswered: boolean;
}

/**
 * The offering an adapter's own snapshot implies, for the window before
 * `getAdapterModes` answers (and for a device that never does).
 *
 * It reads the SAME two capability flags the device derives from, so it can only
 * be as generous as the device is — never more. `supports_ap_sta_concurrency`
 * is tri-state on purpose: an explicit `false` is a PROVEN negative
 * (`capability-absent`), while `undefined` is nobody having asked
 * (`capability-unknown`). Collapsing them would tell an operator their radio
 * cannot do something we never managed to check.
 */
function fallbackOptions(iface: WifiInterface): WifiAdapterModeOption[] {
	const hotspotCapable = iface.supports_hotspot === true;
	const concurrent = iface.supports_ap_sta_concurrency;
	return [
		{ mode: "station", available: true },
		hotspotCapable
			? { mode: "hotspot", available: true }
			: { mode: "hotspot", available: false, reason: "unsupported" },
		concurrent === true
			? { mode: "hybrid", available: true }
			: {
					mode: "hybrid",
					available: false,
					reason:
						concurrent === false ? "capability-absent" : "capability-unknown",
				},
	];
}

/**
 * The mode an adapter's own snapshot implies.
 *
 * `hybrid` is derived on the FRONTEND — the wire deliberately reports a
 * concurrent AP as `mode: "station"` (a pinned device assertion every bond and
 * telemetry rule depends on), so there is no fourth wire value to read.
 */
function fallbackMode(iface: WifiInterface): WifiAdapterMode {
	if (isApRadio(iface)) return "hotspot";
	if (iface.supports_ap_sta_concurrency === true && hotspotIsActive(iface)) {
		return "hybrid";
	}
	return "station";
}

/** The inputs a surface hands the derivation. */
export interface WifiAdapterModeInput {
	device: string;
	iface: WifiInterface;
	/** The device's own answer for this adapter, when `getAdapterModes` has landed. */
	entry?: WifiAdapterModeEntry;
	/** The `wifi-mode:<device>` async-op phase. */
	phase: AsyncOpPhase;
	/** The mode the in-flight transition is driving toward. */
	target?: WifiAdapterMode;
	/** The failure reason recorded on a terminal `failed` phase. */
	failureReason?: string;
}

export function deriveWifiAdapterModeView(
	input: WifiAdapterModeInput,
): WifiAdapterModeView {
	const deviceAnswered = input.entry !== undefined;
	const observedMode = input.entry?.mode ?? fallbackMode(input.iface);
	const wireOptions = input.entry?.options ?? fallbackOptions(input.iface);
	const pending = input.phase === "pending";

	// A pending transition holds the PRIOR mode, and so does a failed one: the
	// device kept its previous mode, so showing the requested one would report an
	// outcome that did not happen.
	const displayMode = pending
		? previousMode(input, observedMode)
		: observedMode;

	const byMode = new Map(wireOptions.map((o) => [o.mode, o]));
	const options = WIFI_ADAPTER_MODES.map<WifiAdapterModeOptionView>((mode) => {
		const wire = byMode.get(mode);
		// A mode the device did not enumerate is UNKNOWN, never unavailable-by-
		// omission: `options` is contractually total, so a gap is a read we could
		// not make rather than a capability the radio lacks.
		const available = wire?.available ?? false;
		const reason = wire === undefined ? "capability-unknown" : wire.reason;
		return {
			mode,
			available,
			selected: mode === displayMode,
			labelKey: MODE_LABEL_KEY[mode],
			pending: pending && input.target === mode,
			...(available ? {} : { reasonKey: reasonKeyFor(reason) }),
			...(available || reason === undefined ? {} : { reason }),
		};
	});

	const failed = input.phase === "failed" || input.phase === "timed_out";
	return {
		device: input.device,
		displayMode,
		observedMode,
		deviceAnswered,
		options,
		pending,
		...(input.entry?.desired !== undefined
			? { desiredMode: input.entry.desired }
			: {}),
		...(pending && input.target !== undefined
			? { pendingTarget: input.target }
			: {}),
		...(failed
			? {
					errorKey:
						input.phase === "timed_out"
							? "network.wifiMode.error.notConfirmed"
							: wifiModeErrorKey(input.failureReason),
					...(input.failureReason !== undefined
						? { error: input.failureReason }
						: {}),
				}
			: {}),
	};
}

/**
 * The mode to hold while a transition runs.
 *
 * The observed mode can legitimately have already moved to the target (the AP is
 * up, the confirming frame has not landed), so falling through to it would flip
 * the control early. Anything that already equals the target resolves to the
 * device's persisted preference, and only then to the observation.
 */
function previousMode(
	input: WifiAdapterModeInput,
	observedMode: WifiAdapterMode,
): WifiAdapterMode {
	if (input.target === undefined || observedMode !== input.target) {
		return observedMode;
	}
	if (
		input.entry?.desired !== undefined &&
		input.entry.desired !== input.target
	) {
		return input.entry.desired;
	}
	return observedMode;
}

function reasonKeyFor(
	reason: WifiAdapterModeUnavailableReason | undefined,
): string {
	if (reason === undefined) return UNAVAILABLE_REASON_KEY["capability-unknown"];
	return UNAVAILABLE_REASON_KEY[reason];
}
