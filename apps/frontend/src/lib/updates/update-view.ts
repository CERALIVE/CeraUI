/**
 * Rules behind the Updates dialog, the global orchestrator
 * badge and the Go-Live refusal band (Todo 41).
 *
 * Resolve returned i18n keys at the render site rather than showing wire tokens.
 */
import type {
	UpdateCapabilities,
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
	UpdateSettings,
	UpdateTransportProbeState,
	UpdateTransportUplinkKind,
} from "@ceraui/rpc/schemas";

export const UPDATE_BUSY_PHASES: readonly UpdateOrchestratorPhase[] = [
	"downloading",
	"awaiting-idle",
	"committing",
	"restarting-services",
	"os-staging",
	"os-activation-armed",
	"syncing",
];

/**
 * This display list does not predict downloading-unit refusals; see the root
 * AGENTS.md D8 admission note and docs/DEVICE-UPDATES.md's D8 section.
 */
export const UPDATE_REFUSING_PHASES: readonly UpdateOrchestratorPhase[] = [
	"committing",
	"restarting-services",
];

export function isUpdateBusy(
	wire: UpdateOrchestratorWireState | undefined | null,
): boolean {
	return (
		wire !== undefined &&
		wire !== null &&
		UPDATE_BUSY_PHASES.includes(wire.phase)
	);
}

export function isUpdateRefusingStart(
	wire: UpdateOrchestratorWireState | undefined | null,
): boolean {
	return (
		wire !== undefined &&
		wire !== null &&
		UPDATE_REFUSING_PHASES.includes(wire.phase)
	);
}

const PHASE_LABEL_KEYS: Readonly<Record<UpdateOrchestratorPhase, string>> = {
	idle: "settings.updates.phase.idle",
	checking: "settings.updates.phase.checking",
	available: "settings.updates.phase.available",
	downloading: "settings.updates.phase.downloading",
	"awaiting-idle": "settings.updates.phase.awaitingIdle",
	committing: "settings.updates.phase.committing",
	"restarting-services": "settings.updates.phase.restartingServices",
	settled: "settings.updates.phase.settled",
	"os-available": "settings.updates.phase.osAvailable",
	"os-staging": "settings.updates.phase.osStaging",
	"os-staged": "settings.updates.phase.osStaged",
	"os-activation-armed": "settings.updates.phase.osActivationArmed",
	"os-verifying": "settings.updates.phase.osVerifying",
	"sync-eligible": "settings.updates.phase.syncEligible",
	syncing: "settings.updates.phase.syncing",
	synced: "settings.updates.phase.synced",
	quarantined: "settings.updates.phase.quarantined",
	failed: "settings.updates.phase.failed",
};

export function phaseLabelKey(phase: UpdateOrchestratorPhase): string {
	return PHASE_LABEL_KEYS[phase];
}

export const UPDATE_PHASE_LABEL_KEYS = PHASE_LABEL_KEYS;

/** A staged system image that takes effect on the next restart. */
export function appliesAfterRestart(
	phase: UpdateOrchestratorPhase | undefined,
): boolean {
	return phase === "os-staged" || phase === "os-activation-armed";
}

/**
 * Whole minutes remaining, or `undefined` when the device did not estimate.
 * The wire uses `0` for "no estimate" (the OS stager reports percent alone), so
 * a zero must never render as "0 min left".
 */
export function etaMinutes(
	etaSeconds: number | undefined | null,
): number | undefined {
	if (etaSeconds === undefined || etaSeconds === null) return undefined;
	if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) return undefined;
	return Math.max(1, Math.ceil(etaSeconds / 60));
}

/** A progress percent worth showing: a real number between 0 and 100. */
export function progressPercent(
	wire: UpdateOrchestratorWireState | undefined | null,
): number | undefined {
	const percent = wire?.progress?.percent;
	if (percent === undefined || !Number.isFinite(percent)) return undefined;
	return Math.min(100, Math.max(0, Math.round(percent)));
}

// ─── capabilities ──────────────────────────────────────────────────────────

export interface UpdateCapabilityView {
	readonly legacy: boolean;
	readonly system: boolean;
	readonly slots: boolean;
}

export function updateCapabilityView(
	caps: UpdateCapabilities | undefined,
): UpdateCapabilityView {
	if (caps === undefined || caps.mode !== "capable") {
		return { legacy: true, system: false, slots: false };
	}
	const has = (feature: UpdateCapabilities["features"][number]) =>
		caps.features.includes(feature);
	return {
		legacy: false,
		system: has("apt-all-packages") && has("rauc-verity-streaming"),
		slots: has("slot-sync"),
	};
}

// ─── schedule window ───────────────────────────────────────────────────────

export interface ScheduleDraft {
	readonly mode: UpdateSettings["schedule"]["mode"];
	readonly start: string;
	readonly end: string;
	/**
	 * The operator's statement that the window runs past midnight. The wire has
	 * no such flag — the backend infers it from `end < start` — so the UI asks
	 * for it explicitly and refuses a window whose times disagree with it.
	 */
	readonly crossesMidnight: boolean;
}

export type ScheduleError =
	| "invalid-time"
	| "same-time"
	| "end-before-start"
	| "contradictory-crossing";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function minutesOf(time: string): number {
	const [hours, minutes] = time.split(":");
	return Number(hours) * 60 + Number(minutes);
}

/** Seed the draft from applied settings; an overnight window seeds the flag on. */
export function scheduleDraftFrom(
	schedule: UpdateSettings["schedule"],
): ScheduleDraft {
	const crossesMidnight =
		TIME_RE.test(schedule.start) &&
		TIME_RE.test(schedule.end) &&
		minutesOf(schedule.end) < minutesOf(schedule.start);
	return { ...schedule, crossesMidnight };
}

export function validateSchedule(
	draft: ScheduleDraft,
): ScheduleError | undefined {
	if (draft.mode !== "window") return undefined;
	if (!TIME_RE.test(draft.start) || !TIME_RE.test(draft.end))
		return "invalid-time";
	const start = minutesOf(draft.start);
	const end = minutesOf(draft.end);
	if (start === end) return "same-time";
	if (end < start && !draft.crossesMidnight) return "end-before-start";
	if (end > start && draft.crossesMidnight) return "contradictory-crossing";
	return undefined;
}

const SCHEDULE_ERROR_KEYS: Readonly<Record<ScheduleError, string>> = {
	"invalid-time": "settings.updates.schedule.error.invalidTime",
	"same-time": "settings.updates.schedule.error.sameTime",
	"end-before-start": "settings.updates.schedule.error.endBeforeStart",
	"contradictory-crossing": "settings.updates.schedule.error.contradictory",
};

export function scheduleErrorKey(error: ScheduleError): string {
	return SCHEDULE_ERROR_KEYS[error];
}

/** The complete input `setUpdateSettings` requires, with one change applied. */
export function withSettings(
	current: UpdateSettings,
	patch: Partial<UpdateSettings>,
): UpdateSettings {
	return {
		...current,
		...patch,
		schedule: { ...(patch.schedule ?? current.schedule) },
	};
}

export function scheduleFromDraft(
	draft: ScheduleDraft,
): UpdateSettings["schedule"] {
	return { mode: draft.mode, start: draft.start, end: draft.end };
}

export function scheduleDraftDirty(
	draft: ScheduleDraft,
	applied: UpdateSettings["schedule"],
): boolean {
	return (
		draft.mode !== applied.mode ||
		draft.start !== applied.start ||
		draft.end !== applied.end
	);
}

// ─── operator actions ──────────────────────────────────────────────────────

const ACTION_REFUSAL_KEYS: Readonly<Record<string, string>> = {
	UPDATE_ORCHESTRATOR_INITIALIZING: "settings.updates.refusal.initializing",
	busy: "settings.updates.refusal.busy",
	not_available: "settings.updates.refusal.notAvailable",
	stream_active: "settings.updates.refusal.streamActive",
	booted_version_unknown: "settings.updates.refusal.bootedVersionUnknown",
};

/** A known refusal token resolves to its own sentence; anything else is generic. */
export function actionRefusalKey(reason: string | undefined): string {
	return (
		(reason !== undefined ? ACTION_REFUSAL_KEYS[reason] : undefined) ??
		"settings.updates.refusal.generic"
	);
}

// ─── transport ─────────────────────────────────────────────────────────────

const PROBE_STATE_KEYS: Readonly<Record<UpdateTransportProbeState, string>> = {
	clear: "settings.updates.connection.state.clear",
	"captive-http": "settings.updates.connection.state.captiveHttp",
	"captive-tls": "settings.updates.connection.state.captiveTls",
	"tls-error": "settings.updates.connection.state.tlsError",
	tampered: "settings.updates.connection.state.tampered",
	blocked: "settings.updates.connection.state.blocked",
	"no-route": "settings.updates.connection.state.noRoute",
	"dns-failed": "settings.updates.connection.state.dnsFailed",
	"credentials-invalid": "settings.updates.connection.state.credentialsInvalid",
	"probe-unavailable": "settings.updates.connection.state.probeUnavailable",
};

export function probeStateKey(state: UpdateTransportProbeState): string {
	return PROBE_STATE_KEYS[state];
}

const UPLINK_KIND_KEYS: Readonly<Record<UpdateTransportUplinkKind, string>> = {
	ethernet: "settings.updates.connection.kind.ethernet",
	wifi: "settings.updates.connection.kind.wifi",
	dongle: "settings.updates.connection.kind.dongle",
	cellular: "settings.updates.connection.kind.cellular",
	other: "settings.updates.connection.kind.other",
};

export function uplinkKindKey(kind: UpdateTransportUplinkKind): string {
	return UPLINK_KIND_KEYS[kind];
}

/** `IPv4` / `IPv6` are protocol names, identical in every locale. */
export function familyLabel(family: 4 | 6): string {
	return family === 4 ? "IPv4" : "IPv6";
}

// ─── slots ─────────────────────────────────────────────────────────────────

/** RAUC reports the booted slot as `booted`; any other known state is standby. */
export function slotStateKey(state: string): string {
	if (state === "booted") return "settings.updates.slots.running";
	if (state === "active" || state === "inactive")
		return "settings.updates.slots.standby";
	return "settings.updates.slots.stateUnknown";
}

/** `undefined` when RAUC did not report a boot status for the slot. */
export function slotHealthKey(bootStatus: string | null): string | undefined {
	if (bootStatus === "good") return "settings.updates.slots.healthy";
	if (bootStatus === "bad") return "settings.updates.slots.bad";
	return undefined;
}

/** A slot's display letter: RAUC's bootname (`A`/`B`) when it reported one. */
export function slotLetter(slot: {
	name: string;
	bootname: string | null;
}): string {
	return slot.bootname ?? slot.name;
}

// ─── time ──────────────────────────────────────────────────────────────────

/** Epoch-ms or ISO timestamp → locale date-time, or `undefined` when unusable. */
export function formatUpdateTime(
	value: number | string | null | undefined,
	locale: string,
): string | undefined {
	if (value === null || value === undefined) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}
