/**
 * sharing-section-view.ts — the ONE derivation behind the Internet-Sharing
 * surface (todo 13, REQ-USB-070…075). Pure and rune-free, so every band, every
 * per-uplink row and every honest non-state is testable without mounting.
 *
 * It reads FOUR wire inputs and gates NOTHING. Each of them is diagnostic or
 * informational by its own backend contract, so nothing derived here may
 * disable a control, exclude an interface or block a stream — the section's
 * whole job is to say what the device is doing and why.
 *
 * Every machine-stable token (`probe_failed`, `steering_unavailable`,
 * `firewall_backend_unpinned`, a shaper reason) is resolved to an i18n dot-path
 * HERE, so no render site can print one raw.
 */

import type {
	NetifMessage,
	SharingDiag,
	SharingDiagCheck,
	SharingDiagReason,
	UplinkHealthReason,
	UplinkHealthRecord,
	UplinkHealthState,
	UplinkKind,
	UplinkShaperStatus,
	UplinkSteeringStatus,
	UplinksMessage,
} from "@ceraui/rpc/schemas";

import { deriveHotspotClientsView } from "./hotspot-clients-view";

/** The spectral `--link-1..6` ramp has six rungs; a seventh row wraps onto it. */
export const SHARING_LINK_TOKENS = 6;

const STATE_LABEL_KEY: Record<UplinkHealthState, string> = {
	up: "network.sharing.state.up",
	degraded: "network.sharing.state.degraded",
	down: "network.sharing.state.down",
};

const KIND_LABEL_KEY: Record<UplinkKind, string> = {
	ethernet: "network.sharing.kind.ethernet",
	wifi: "network.sharing.kind.wifi",
	cellular: "network.sharing.kind.cellular",
	other: "network.sharing.kind.other",
};

const UPLINK_REASON_KEY: Record<UplinkHealthReason, string> = {
	probe_failed: "network.sharing.reason.probeFailed",
	captive_portal: "network.sharing.reason.captivePortal",
	passive_congestion: "network.sharing.reason.passiveCongestion",
	definitive_loss: "network.sharing.reason.definitiveLoss",
};

const STEERING_REASON_KEY: Record<string, string> = {
	bond_candidate_client_zone: "network.sharing.steeringReason.bondCandidate",
	mark_collision: "network.sharing.steeringReason.markCollision",
	overlapping_subnet: "network.sharing.steeringReason.overlappingSubnet",
	policy_route_missing: "network.sharing.steeringReason.policyRouteMissing",
	ruleset_publish_failed: "network.sharing.steeringReason.publishFailed",
	ruleset_reload_failed: "network.sharing.steeringReason.reloadFailed",
};

const SHAPER_REASON_KEY: Record<string, string> = {
	foreign_qdisc: "network.sharing.priority.reason.foreignQdisc",
	qdisc_inventory_failed: "network.sharing.priority.reason.inventoryFailed",
	tc_apply_failed: "network.sharing.priority.reason.applyFailed",
};

const DIAG_REASON_KEY: Record<SharingDiagReason, string> = {
	firewall_backend_unpinned: "network.sharing.diag.reason.backendUnpinned",
	firewall_backend_mismatch: "network.sharing.diag.reason.backendMismatch",
	steering_rule_shadows_source_route: "network.sharing.diag.reason.ruleShadows",
	steering_rule_priority_drift: "network.sharing.diag.reason.priorityDrift",
	shared_nat_missing: "network.sharing.diag.reason.natMissing",
	shared_nat_duplicated: "network.sharing.diag.reason.natDuplicated",
	foreign_table_modified: "network.sharing.diag.reason.foreignTable",
};

/**
 * A pre-pin image reads `firewall_backend_unpinned` on EVERY device until the
 * image ships the `firewall-backend=nftables` pin, so banding it amber would
 * warn the whole fleet about a state todo 11 calls the tri-state tolerance
 * working. Every other reason describes real drift and keeps the amber register.
 */
const DIAG_INFO_ONLY_REASONS: ReadonlySet<SharingDiagReason> = new Set([
	"firewall_backend_unpinned",
]);

export function uplinkStateLabelKey(state: UplinkHealthState): string {
	return STATE_LABEL_KEY[state];
}

export function uplinkKindLabelKey(kind: UplinkKind): string {
	return KIND_LABEL_KEY[kind];
}

/** i18n dot-path for a per-uplink health reason; `undefined` when none. */
export function uplinkReasonKey(
	reason: UplinkHealthReason | undefined,
): string | undefined {
	return reason === undefined ? undefined : UPLINK_REASON_KEY[reason];
}

// ─────────────────────────── per-uplink rows ───────────────────────────

export interface UplinkRowView {
	readonly iface: string;
	/**
	 * The device's own name, when the device resolved one. ABSENT is the honest
	 * common case (a PCIe modem, a plain wired port, an older backend), and the
	 * row then renders exactly what it always did: the raw `iface`.
	 */
	readonly displayName?: string;
	readonly kind: UplinkKind;
	readonly kindLabelKey: string;
	readonly state: UplinkHealthState;
	readonly stateLabelKey: string;
	readonly reason?: UplinkHealthReason;
	readonly reasonKey?: string;
	/** 0, 25 (degraded) or 100 (up) — the device's own selection weight. */
	readonly weight: number;
	/**
	 * Past `staleAt`. Values still render, dimmed and marked — blanking them
	 * would lose the last real reading, and showing them fresh would be a lie.
	 */
	readonly stale: boolean;
	/** 1-based spectral token index for `var(--link-N)`. */
	readonly linkIndex: number;
	readonly probes: { readonly successes: number; readonly failures: number };
}

function toRow(
	record: UplinkHealthRecord,
	position: number,
	now: number,
): UplinkRowView {
	const reasonKey = uplinkReasonKey(record.reason);
	return {
		iface: record.iface,
		...(record.displayName !== undefined
			? { displayName: record.displayName }
			: {}),
		kind: record.kind,
		kindLabelKey: KIND_LABEL_KEY[record.kind],
		state: record.state,
		stateLabelKey: STATE_LABEL_KEY[record.state],
		...(record.reason !== undefined ? { reason: record.reason } : {}),
		...(reasonKey !== undefined ? { reasonKey } : {}),
		weight: record.weight,
		stale: record.staleAt > 0 && now >= record.staleAt,
		linkIndex: (position % SHARING_LINK_TOKENS) + 1,
		probes: record.probes,
	};
}

// ─────────────────────────── client zones ───────────────────────────

export type SharedLanZoneState = "serving" | "starting";

export interface SharedLanZoneView {
	readonly ifname: string;
	readonly zone: SharedLanZoneState;
	readonly zoneLabelKey: string;
}

export interface ClientZoneSummary {
	/** Active AP interfaces. */
	readonly hotspots: number;
	/**
	 * Joined stations across every AP that REPORTED a roster. `undefined` when
	 * no AP reported one — a measured zero and an unread roster are different
	 * facts, and inventing "0 clients" asserts a count nobody took.
	 */
	readonly hotspotClients: number | undefined;
	readonly sharedLan: readonly SharedLanZoneView[];
	/** At least one client zone exists, so sharing is configured. */
	readonly active: boolean;
}

const ZONE_LABEL_KEY: Record<SharedLanZoneState, string> = {
	serving: "network.ethRole.zoneServing",
	starting: "network.ethRole.zoneStarting",
};

/**
 * The hotspot half reuses `deriveHotspotClientsView` — the SAME rule
 * `HotspotSection` renders from — so the two surfaces cannot disagree about how
 * many devices are joined, and there is no second roster derivation.
 */
export function deriveClientZones(
	hotspotInterfaces: readonly HotspotZoneInput[],
	netif: NetifMessage | undefined,
): ClientZoneSummary {
	let clients: number | undefined;
	for (const iface of hotspotInterfaces) {
		const roster = deriveHotspotClientsView(iface.hotspot);
		if (roster !== undefined) clients = (clients ?? 0) + roster.count;
	}

	const sharedLan: SharedLanZoneView[] = [];
	for (const [ifname, entry] of Object.entries(netif ?? {})) {
		if (entry?.ethRole !== "shared-lan") continue;
		const zone: SharedLanZoneState = entry.ip ? "serving" : "starting";
		sharedLan.push({ ifname, zone, zoneLabelKey: ZONE_LABEL_KEY[zone] });
	}

	return {
		hotspots: hotspotInterfaces.length,
		hotspotClients: clients,
		sharedLan,
		active: hotspotInterfaces.length > 0 || sharedLan.length > 0,
	};
}

/** Only the field the roster rule reads, so a caller passes its live interface. */
export interface HotspotZoneInput {
	readonly hotspot?: Parameters<typeof deriveHotspotClientsView>[0];
}

// ─────────────────────────── streaming priority ───────────────────────────

export type PriorityKind =
	| "adaptive-cap"
	| "fair-queue"
	| "degraded"
	| "unreported";

export interface PriorityView {
	readonly kind: PriorityKind;
	readonly labelKey: string;
	readonly bodyKey: string;
	readonly algorithmKey?: string;
	readonly reason?: string;
	readonly reasonKey?: string;
}

export function derivePriority(
	shaper: UplinkShaperStatus | undefined,
): PriorityView {
	if (shaper === undefined) {
		return {
			kind: "unreported",
			labelKey: "network.sharing.priority.unreported",
			bodyKey: "network.sharing.priority.unreportedBody",
		};
	}
	if (shaper.state === "shaper_unavailable") {
		return {
			kind: "degraded",
			labelKey: "network.sharing.priority.degraded",
			bodyKey: "network.sharing.priority.degradedBody",
			reason: shaper.reason,
			reasonKey:
				SHAPER_REASON_KEY[shaper.reason] ??
				"network.sharing.priority.reason.applyFailed",
		};
	}
	const algorithmKey =
		shaper.algorithm === "cake"
			? "network.sharing.priority.algorithmCake"
			: "network.sharing.priority.algorithmHtb";
	return shaper.mode === "streaming"
		? {
				kind: "adaptive-cap",
				labelKey: "network.sharing.priority.adaptiveCap",
				bodyKey: "network.sharing.priority.adaptiveCapBody",
				algorithmKey,
			}
		: {
				kind: "fair-queue",
				labelKey: "network.sharing.priority.fairQueue",
				bodyKey: "network.sharing.priority.fairQueueBody",
				algorithmKey,
			};
}

// ─────────────────────────── honest bands ───────────────────────────

export type SharingBandKind =
	| "steering-unavailable"
	| "sharing-off"
	| "no-healthy-uplink"
	| "uplinks-unreported";

export interface SharingBand {
	readonly kind: SharingBandKind;
	readonly tone: "info" | "warning";
	readonly titleKey: string;
	readonly bodyKey: string;
	readonly reason?: string;
	readonly reasonKey?: string;
}

function steeringBand(
	steering: UplinkSteeringStatus | undefined,
): SharingBand | undefined {
	if (steering === undefined || steering.state === "available")
		return undefined;
	return {
		kind: "steering-unavailable",
		tone: "warning",
		titleKey: "network.sharing.band.steeringUnavailableTitle",
		bodyKey: "network.sharing.band.steeringUnavailableBody",
		reason: steering.reason,
		reasonKey:
			STEERING_REASON_KEY[steering.reason] ??
			"network.sharing.steeringReason.generic",
	};
}

/**
 * The zone/uplink bands are MUTUALLY EXCLUSIVE by construction: sharing being
 * off already explains why nothing is steered, so restating "no healthy uplink"
 * underneath it would announce one fact twice and read as two faults.
 */
function reachabilityBand(
	uplinks: UplinksMessage | undefined,
	zones: ClientZoneSummary,
): SharingBand | undefined {
	if (!zones.active) {
		return {
			kind: "sharing-off",
			tone: "info",
			titleKey: "network.sharing.band.sharingOffTitle",
			bodyKey: "network.sharing.band.sharingOffBody",
		};
	}
	if (uplinks === undefined) {
		return {
			kind: "uplinks-unreported",
			tone: "info",
			titleKey: "network.sharing.band.uplinksUnreportedTitle",
			bodyKey: "network.sharing.band.uplinksUnreportedBody",
		};
	}
	const usable = uplinks.some((record) => record.state !== "down");
	if (usable) return undefined;
	return {
		kind: "no-healthy-uplink",
		tone: "warning",
		titleKey: "network.sharing.band.noHealthyUplinkTitle",
		bodyKey: "network.sharing.band.noHealthyUplinkBody",
	};
}

// ─────────────────────────── coexistence diagnostics ───────────────────────────

export interface SharingDiagFinding {
	readonly check:
		| "firewallBackend"
		| "steeringRules"
		| "sharedNat"
		| "foreignTables";
	readonly reason: SharingDiagReason;
	readonly reasonKey: string;
	readonly detail?: string;
}

export interface SharingDiagView {
	readonly tone: "info" | "warning";
	readonly findings: readonly SharingDiagFinding[];
}

const DIAG_CHECKS = [
	"firewallBackend",
	"steeringRules",
	"sharedNat",
	"foreignTables",
] as const;

/**
 * `degraded` is never a failure and `unknown` is never a finding — the verdict
 * withheld a check, which is a statement about the READ. Only a check the
 * device positively degraded, with a reason it named, reaches an operator.
 */
export function deriveSharingDiagView(
	diag: SharingDiag | undefined,
): SharingDiagView | undefined {
	if (diag === undefined) return undefined;
	const findings: SharingDiagFinding[] = [];
	for (const check of DIAG_CHECKS) {
		const value: SharingDiagCheck = diag[check];
		if (value.state !== "degraded" || value.reason === undefined) continue;
		findings.push({
			check,
			reason: value.reason,
			reasonKey: DIAG_REASON_KEY[value.reason],
			...(value.detail !== undefined ? { detail: value.detail } : {}),
		});
	}
	if (findings.length === 0) return undefined;
	const tone = findings.every((f) => DIAG_INFO_ONLY_REASONS.has(f.reason))
		? "info"
		: "warning";
	return { tone, findings };
}

// ─────────────────────── the ONE headline state line ───────────────────────

/**
 * The section's single state authority. It is DERIVED from the bands above —
 * never a second reading of the wire — so the headline and the bands can never
 * disagree about what the device said.
 *
 * Precedence is by SCOPE, not by tone: sharing being off makes every downstream
 * fact moot, and having nowhere to send client traffic makes a steering failure
 * invisible. `uplinks-unreported` sits LAST of the bands because it is the one
 * that says nothing definite; a steering refusal the device actually named
 * outranks a report that has not arrived.
 */
const HEADLINE_PRECEDENCE: readonly SharingBandKind[] = [
	"sharing-off",
	"no-healthy-uplink",
	"steering-unavailable",
	"uplinks-unreported",
];

export type SharingHeadlineKind = SharingBandKind | "sharing-active";

export interface SharingHeadlineView {
	readonly kind: SharingHeadlineKind;
	readonly tone: "ok" | "info" | "warning";
	readonly titleKey: string;
	readonly bodyKey: string;
	readonly reason?: string;
	readonly reasonKey?: string;
	/**
	 * TRUE when the headline ITSELF asserts the state every row would restate,
	 * so a render site mutes the per-row chips instead of repeating one alarm
	 * once per uplink. The WORD still renders — colour is only reinforcement —
	 * so muting removes the duplication without removing a fact.
	 */
	readonly restatesRowState: boolean;
	/** Uplinks not reported `down`, and the total — the healthy body's figures. */
	readonly usableUplinks: number;
	readonly totalUplinks: number;
}

export function deriveSharingHeadline(
	bands: readonly SharingBand[],
	rows: readonly UplinkRowView[],
): SharingHeadlineView {
	const governing = HEADLINE_PRECEDENCE.map((kind) =>
		bands.find((band) => band.kind === kind),
	).find((band): band is SharingBand => band !== undefined);

	const counts = {
		usableUplinks: rows.filter((row) => row.state !== "down").length,
		totalUplinks: rows.length,
	};

	if (governing === undefined) {
		return {
			kind: "sharing-active",
			tone: "ok",
			titleKey: "network.sharing.headline.activeTitle",
			bodyKey: "network.sharing.headline.activeBody",
			restatesRowState: false,
			...counts,
		};
	}

	return {
		kind: governing.kind,
		tone: governing.tone,
		titleKey: governing.titleKey,
		bodyKey: governing.bodyKey,
		...(governing.reason !== undefined ? { reason: governing.reason } : {}),
		...(governing.reasonKey !== undefined
			? { reasonKey: governing.reasonKey }
			: {}),
		// `no-healthy-uplink` is the ONE band that literally asserts a per-row
		// state ("every uplink is down"); nothing else names one, so nothing else
		// may mute a row. The row check is re-made here rather than assumed: an
		// empty roster bands the same way and has no rows to deduplicate.
		restatesRowState:
			governing.kind === "no-healthy-uplink" &&
			rows.length > 0 &&
			rows.every((row) => row.state === "down"),
		...counts,
	};
}

/**
 * The bands the headline did NOT speak for. They are still true, so they are
 * demoted into the diagnostics disclosure rather than dropped — a second
 * standing band beside the headline is exactly the duplication this removes.
 */
export function subordinateBands(
	bands: readonly SharingBand[],
	headline: SharingHeadlineView,
): readonly SharingBand[] {
	return bands.filter((band) => band.kind !== headline.kind);
}

// ─────────────────────── the diagnostics disclosure ───────────────────────

export type DiagnosticsTone = "neutral" | "info" | "warning";

export interface DiagnosticsSummaryView {
	readonly tone: DiagnosticsTone;
	/** How many separate findings are folded away behind the disclosure. */
	readonly findings: number;
	readonly labelKey: string;
}

const TONE_RANK: Record<DiagnosticsTone, number> = {
	neutral: 0,
	info: 1,
	warning: 2,
};

/**
 * The chip on the collapsed disclosure's summary. A folded surface that cannot
 * say it holds a warning is a hidden warning, so the chip carries BOTH the tone
 * and the count — and an `unreported` shaper is deliberately NOT a finding: an
 * honest non-state is not a fault to review.
 */
export function deriveDiagnosticsSummary(
	priority: PriorityView,
	diag: SharingDiagView | undefined,
	subordinate: readonly SharingBand[],
): DiagnosticsSummaryView {
	let findings = 0;
	let tone: DiagnosticsTone = "neutral";
	const escalate = (next: DiagnosticsTone) => {
		if (TONE_RANK[next] > TONE_RANK[tone]) tone = next;
	};

	if (priority.kind === "degraded") {
		findings += 1;
		escalate("warning");
	}
	if (diag !== undefined) {
		findings += diag.findings.length;
		escalate(diag.tone);
	}
	for (const band of subordinate) {
		findings += 1;
		escalate(band.tone);
	}

	return {
		tone,
		findings,
		labelKey:
			findings === 0
				? "network.sharing.diagnostics.clear"
				: findings === 1
					? "network.sharing.diagnostics.findingsOne"
					: "network.sharing.diagnostics.findingsMany",
	};
}

// ─────────────────────────── the whole section ───────────────────────────

export interface SharingSectionInput {
	readonly uplinks: UplinksMessage | undefined;
	readonly diag: SharingDiag | undefined;
	readonly steering: UplinkSteeringStatus | undefined;
	readonly shaper: UplinkShaperStatus | undefined;
	readonly netif: NetifMessage | undefined;
	readonly hotspotInterfaces: readonly HotspotZoneInput[];
	readonly now: number;
}

/**
 * May a row render its steering weight?
 *
 * The weight is the device's SELECTION SHARE for shared-client traffic — how
 * much of it this uplink is asked to carry — and it is not a link-quality
 * reading, so it is only meaningful where client traffic is actually being
 * steered. Two situations withhold it, on POSITIVE evidence in both cases:
 * no client zone exists (nothing to share), or the device has said its steering
 * layer is unavailable (clients fall back to the default route, so the share
 * steers nothing). An UNREPORTED steering state withholds nothing — absence is
 * not evidence, and the weight is still the record's own field.
 */
export function showSteeringShare(
	zones: ClientZoneSummary,
	steering: UplinkSteeringStatus | undefined,
): boolean {
	return zones.active && steering?.state !== "steering_unavailable";
}

export interface SharingSectionView {
	readonly rows: readonly UplinkRowView[];
	readonly zones: ClientZoneSummary;
	readonly priority: PriorityView;
	readonly bands: readonly SharingBand[];
	readonly diag?: SharingDiagView;
	readonly headline: SharingHeadlineView;
	readonly subordinate: readonly SharingBand[];
	readonly diagnostics: DiagnosticsSummaryView;
	readonly showSteeringShare: boolean;
	readonly quiet: boolean;
}

export function deriveSharingSection(
	input: SharingSectionInput,
): SharingSectionView {
	const zones = deriveClientZones(input.hotspotInterfaces, input.netif);
	const rows = (input.uplinks ?? []).map((record, index) =>
		toRow(record, index, input.now),
	);

	const bands: SharingBand[] = [];
	const steering = steeringBand(input.steering);
	if (steering) bands.push(steering);
	const reachability = reachabilityBand(input.uplinks, zones);
	if (reachability) bands.push(reachability);

	const diag = deriveSharingDiagView(input.diag);
	const priority = derivePriority(input.shaper);
	const headline = deriveSharingHeadline(bands, rows);
	const subordinate = subordinateBands(bands, headline);
	return {
		rows,
		zones,
		priority,
		bands,
		...(diag !== undefined ? { diag } : {}),
		headline,
		subordinate,
		diagnostics: deriveDiagnosticsSummary(priority, diag, subordinate),
		showSteeringShare: showSteeringShare(zones, input.steering),
		quiet: !zones.active,
	};
}
