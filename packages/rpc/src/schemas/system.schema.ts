/**
 * System Zod schemas (sensors, revisions, SSH, updates)
 */
import { z } from 'zod';

// Sensors status schema
export const sensorsStatusSchema = z.object({
	'SoC temperature': z.string(),
	'SoC current': z.string().optional(),
	'SoC voltage': z.string().optional(),
	'SRT ingest': z.string().nullable().optional(),
	rtmpIngestStats: z.record(z.string(), z.string()).optional(),
});
export type SensorsStatus = z.infer<typeof sensorsStatusSchema>;

// Revisions schema.
//
// `kernel` (the board's running `uname -r`) and `cerastream` (the engine version
// read live off the IPC `hello` handshake) are additive-optional: a status
// snapshot taken before the first engine probe resolves carries neither, and the
// dialog renders only the rows it was actually given rather than inventing a
// placeholder for a value the device has not established.
export const revisionsSchema = z.object({
	ceralive: z.string(),
	srtla: z.string(),
	bun: z.string(),
	kernel: z.string().optional(),
	cerastream: z.string().optional(),
	'CERALIVE image': z.string().optional(),
});
export type Revisions = z.infer<typeof revisionsSchema>;

// The value the backend publishes for `cerastream` when the engine cannot be
// reached. It is PROSE, not a version, so a consumer that renders it in a
// version slot presents "engine unreachable" as though it were a build number.
// Shared here rather than kept backend-local precisely because both sides need
// to agree on it — the producer writes it and every consumer must recognise it.
export const ENGINE_UNREACHABLE_REVISION = 'engine unreachable';

// SSH status schema
export const sshStatusSchema = z.object({
	user: z.string(),
	// Optional: the backend omits `user_pass` when the shadow hash is unreadable
	// (it cannot prove whether the password differs), so the field can be absent
	// on the wire. Consumers must treat an absent value as "unknown".
	user_pass: z.boolean().optional(),
	active: z.boolean(),
});
export type SshStatus = z.infer<typeof sshStatusSchema>;

// Available updates schema
export const availableUpdatesSchema = z.object({
	package_count: z.number(),
	download_size: z.string().optional(),
});
export type AvailableUpdates = z.infer<typeof availableUpdatesSchema>;

// Update progress schema
export const updateProgressSchema = z.object({
	downloading: z.number(),
	unpacking: z.number(),
	setting_up: z.number(),
	total: z.number(),
	// `0` marks completion; a string carries the apt failure message the update
	// loop broadcasts before clearing state.
	result: z.union([z.number(), z.string()]).optional(),
});
export type UpdateProgress = z.infer<typeof updateProgressSchema>;

// Updating status schema (can be boolean, null, or progress object)
export const updatingStatusSchema = z.union([z.boolean(), z.null(), updateProgressSchema]);
export type UpdatingStatus = z.infer<typeof updatingStatusSchema>;

// =============================================================================
// Unified update state machine (Todo 24)
// =============================================================================
// Single source of truth for update availability + lifecycle. Both the backend
// notification producer AND the frontend UpdatesDialog derive from this one wire
// value, so the dialog already shows an available update with no manual re-check.
// `available_updates`/`updating` stay on the wire (back-compat) but are computed
// from the SAME backend signals this state derives from.

// Semantic identity (Todo-23 dismissal key source): a NEW `version` re-notifies
// even if the previous update was dismissed.
export const updateIdentitySchema = z.object({
	version: z.string(),
	packages: z.array(z.string()),
});
export type UpdateIdentity = z.infer<typeof updateIdentitySchema>;

// Why a CHECK could not complete — NOT the same as `failed` (an install that ran
// and failed). A check failure means the device could not establish whether an
// update exists, so answering "up to date" would be a lie.
// `refresh_failed`: `apt-get update` exited non-zero (repos unreachable, apt lock).
// `discovery_failed`: refresh was fine, `dist-upgrade --assume-no` was unreadable.
export const UPDATE_CHECK_FAILURE_REASONS = ['refresh_failed', 'discovery_failed'] as const;
export const updateCheckFailureReasonSchema = z.enum(UPDATE_CHECK_FAILURE_REASONS);
export type UpdateCheckFailureReason = z.infer<typeof updateCheckFailureReasonSchema>;

export const updateStateSchema = z.discriminatedUnion('kind', [
	// `checked_at` (epoch ms) is the operator's evidence a check actually ran: a
	// successful check that changes nothing is otherwise indistinguishable from a
	// dead button — same "up to date" line either way.
	z.object({ kind: z.literal('idle'), checked_at: z.number().optional() }),
	z.object({ kind: z.literal('checking'), checked_at: z.number().optional() }),
	z.object({
		kind: z.literal('check_failed'),
		reason: updateCheckFailureReasonSchema,
		checked_at: z.number().optional(),
	}),
	z.object({
		kind: z.literal('available'),
		identity: updateIdentitySchema,
		package_count: z.number(),
		download_size: z.string().optional(),
		checked_at: z.number().optional(),
	}),
	z.object({
		kind: z.literal('downloading'),
		progress: updateProgressSchema,
		identity: updateIdentitySchema.optional(),
	}),
	z.object({
		kind: z.literal('installing'),
		progress: updateProgressSchema,
		identity: updateIdentitySchema.optional(),
	}),
	z.object({ kind: z.literal('success') }),
	z.object({
		kind: z.literal('failed'),
		reason: z.string(),
		identity: updateIdentitySchema.optional(),
	}),
]);
export type UpdateState = z.infer<typeof updateStateSchema>;

// System command input schema
export const systemCommandInputSchema = z.object({
	command: z.enum([
		'poweroff',
		'reboot',
		'update',
		'start_ssh',
		'stop_ssh',
		'reset_ssh_pass',
		'get_log',
		'get_syslog',
	]),
});
export type SystemCommandInput = z.infer<typeof systemCommandInputSchema>;

// System command output schema
export const systemCommandOutputSchema = z.object({
	success: z.boolean(),
});
export type SystemCommandOutput = z.infer<typeof systemCommandOutputSchema>;

// Log output schema
export const logOutputSchema = z.object({
	log: z.string(),
});
export type LogOutput = z.infer<typeof logOutputSchema>;

// systemd unit/service name: letters, digits and the unit punctuation set
// `@ . _ : -`. Excludes shell metacharacters (`;`, space, `$`, backtick, etc.),
// so a `service` value cannot carry a journalctl command injection.
export const SERVICE_RE = /^[A-Za-z0-9@._:-]+$/;

// Log input schema — `service` is validated at the oRPC boundary so a malicious
// unit name is rejected before reaching getLog(). Optional/absent input is the
// whole-system log.
export const logInputSchema = z
	.object({
		service: z.string().regex(SERVICE_RE).optional(),
	})
	.optional();
export type LogInput = z.infer<typeof logInputSchema>;

// Autostart config input schema
export const autostartInputSchema = z.object({
	autostart: z.boolean(),
});
export type AutostartInput = z.infer<typeof autostartInputSchema>;

// Autostart applied-state output schema (`applied` = value persisted post-write)
export const autostartOutputSchema = z.object({
	success: z.boolean(),
	applied: z.object({
		autostart: z.boolean(),
	}),
});
export type AutostartOutput = z.infer<typeof autostartOutputSchema>;

// =============================================================================
// Kiosk toggle state machine (DC-2 — docs/KIOSK_STATE_MACHINE.md)
// =============================================================================

// The five kiosk states. No others exist. The single source of truth for both
// the persisted `kiosk_last_state` field and the live broadcast `state`.
export const KIOSK_STATES = [
	'disabled',
	'enabled-stopped',
	'enabled-running',
	'enabled-failed',
	'failed-no-display',
] as const;
export const kioskStateSchema = z.enum(KIOSK_STATES);
export type KioskState = z.infer<typeof kioskStateSchema>;

// Display profile for the kiosk loopback URL (?display=lcd|eink|mono — DC-4).
export const kioskDisplaySchema = z.enum(['lcd', 'eink', 'mono']);
export type KioskDisplay = z.infer<typeof kioskDisplaySchema>;

// Performance preset that bounds the kiosk render budget on constrained SBCs.
export const kioskPerformanceSchema = z.enum(['low', 'balanced', 'high']);
export type KioskPerformance = z.infer<typeof kioskPerformanceSchema>;

// Crash-loop classification bound (systemd StartLimitBurst). When the unit is in
// `failed` state and NRestarts is at least this, the backend treats it as a
// crash-loop and applies the auto-disable rule (T5). Single source of truth so
// the bound is never inlined in the poll loop.
export const KIOSK_CRASH_LOOP_RESTART_THRESHOLD = 3;

// Backend failure-observation poll cadence (ms) while kiosk_enabled = true.
export const KIOSK_POLL_INTERVAL_MS = 2000;

// kioskConfigure input — display profile + touch mode + motion + performance.
export const kioskConfigureInputSchema = z.object({
	display: kioskDisplaySchema,
	touch: z.boolean(),
	motion: z.boolean(),
	performance: kioskPerformanceSchema,
});
export type KioskConfigureInput = z.infer<typeof kioskConfigureInputSchema>;

// Structured failure code returned by the kiosk RPC handlers when the backend
// is NOT running on a real device (T13). Single source of truth so neither the
// backend gate nor the frontend banner inlines the literal. On a dev/CI/emulated
// host the handlers return this WITHOUT touching systemd (DC-1: only the real
// device owns the chassis).
export const KIOSK_UNAVAILABLE_ERROR = 'kiosk_unavailable_in_emulated_mode';

// kioskConfigure applied-state output (`applied` = values persisted post-write).
// `applied` is absent and `error` is set on the emulated-mode gate (T13).
export const kioskConfigureOutputSchema = z.object({
	success: z.boolean(),
	applied: kioskConfigureInputSchema.optional(),
	error: z.string().optional(),
});
export type KioskConfigureOutput = z.infer<typeof kioskConfigureOutputSchema>;

// kioskStatus output — the persisted toggle plus the live polled state. The
// toggle (`enabled`) and the live `state` can diverge after auto-disable (T5).
export const kioskStatusSchema = z.object({
	enabled: z.boolean(),
	state: kioskStateSchema,
	display: kioskDisplaySchema,
	touch: z.boolean(),
	motion: z.boolean(),
	performance: kioskPerformanceSchema,
});
export type KioskStatus = z.infer<typeof kioskStatusSchema>;

// kioskStart / kioskStop applied-state output. `applied` echoes the persisted
// toggle + the synchronous post-transition state the backend committed; it is
// absent and `error` is set on the emulated-mode gate (T13).
export const kioskToggleOutputSchema = z.object({
	success: z.boolean(),
	applied: z
		.object({
			enabled: z.boolean(),
			state: kioskStateSchema,
		})
		.optional(),
	error: z.string().optional(),
});
export type KioskToggleOutput = z.infer<typeof kioskToggleOutputSchema>;

// kioskOsk input — show/hide the on-screen keyboard (wvkbd). `visible = true`
// signals SIGUSR2 (show), `false` signals SIGUSR1 (hide). The backend owns the
// signal mapping so the wvkbd convention is never inlined in the UI.
export const kioskOskInputSchema = z.object({
	visible: z.boolean(),
});
export type KioskOskInput = z.infer<typeof kioskOskInputSchema>;

// =============================================================================
// Device stats broadcast (T32 — `device-stats` event)
// =============================================================================
//
// S1 lock: exactly these five signals, mirroring the backend emitter
// (`apps/backend/src/modules/system/device-stats.ts`). Adding a sixth is a
// deliberate contract change. Every field is independently nullable (raucSlot
// degrades to the string "unavailable") so one dead source never blanks the
// whole panel.
export const diskTypeSchema = z.enum(['SSD', 'HDD', 'eMMC', 'unknown']);
export type DiskType = z.infer<typeof diskTypeSchema>;

export const diskStatSchema = z.object({
	used: z.number(),
	total: z.number(),
	type: diskTypeSchema,
});
export type DiskStat = z.infer<typeof diskStatSchema>;

export const ifaceRxTxStatSchema = z.object({
	iface: z.string(),
	rxBytesPerSec: z.number(),
	txBytesPerSec: z.number(),
});
export type IfaceRxTxStat = z.infer<typeof ifaceRxTxStatSchema>;

export const deviceStatsSchema = z.object({
	disk: diskStatSchema.nullable(),
	cpuLoad1: z.number().nullable(),
	socTemp: z.number().nullable(),
	ifaceRxTx: ifaceRxTxStatSchema.nullable(),
	raucSlot: z.string(),
});
export type DeviceStats = z.infer<typeof deviceStatsSchema>;

// =============================================================================
// CPU topology broadcast (`cpu` event)
// =============================================================================
//
// The DENOMINATOR for `device-stats.cpuLoad1`, and its OWN broadcast for the
// same reason `encoder-load` and `fan` have one: the five-signal payload above
// is frozen by the S1 lock and three backend tests assert those keys EXACTLY.
//
// It exists because a bare 1-minute load average is unreadable without it. On an
// 8-core RK3588 a reported `1.00` means roughly an eighth of the board is in
// use, but the figure reads as "fully loaded" to anyone who does not already
// know the core count — which was the operator report that produced this signal.
//
// It is a BOOT FACT, not a sample: core count cannot change without a reboot on
// this hardware, so it is resolved once and re-served from the post-auth
// initial-state push (the same treatment `revisions.kernel` gets).
//
// `cores` is nullable and MUST stay nullable: a host that cannot report its CPU
// topology has to degrade to the raw load average rather than have a
// denominator invented for it.
export const cpuInfoSchema = z.object({
	/** Online CPU count (`nproc`-equivalent). `null` ⇒ unknown, never assumed. */
	cores: z.number().nullable(),
});
export type CpuInfo = z.infer<typeof cpuInfoSchema>;

// =============================================================================
// Per-core encoder load broadcast (`encoder-load` event)
// =============================================================================
//
// This is its OWN broadcast, deliberately NOT a sixth `device-stats` field: the
// S1 lock above is a frozen five-signal contract, and encoder load is structured
// per core rather than a scalar. It is also not foldable into `sensors`, which
// is a flat `Record<string, string>` of display strings — encoding a three-state
// per-core reading as prose would force the consumer to re-parse it, which is
// exactly what the three-state model exists to prevent.
//
// The shape mirrors `apps/frontend/src/lib/streaming/encoder-load.ts`
// (`EncoderLoadReading` / `EncoderCoreReading`) FIELD FOR FIELD. That module is
// the contract; this schema conforms to it, never the other way around.
//
// The two RK3588 kernels report VEPU580 load incomparably — the vendor 6.1 BSP
// exposes real per-core percentages via `/proc/mpp_service`, mainline/edge 7.1
// exposes only the cores' clock enable-state (a busy/idle bit) — so a core is
// `percent`, `active`, or `unavailable`, and NOTHING may turn an `active`
// reading into a number.
export const encoderLoadSourceSchema = z.enum(['mpp-service', 'clk-enable-count']);
export type EncoderLoadSource = z.infer<typeof encoderLoadSourceSchema>;

export const encoderCoreReadingSchema = z.discriminatedUnion('kind', [
	z.object({
		core: z.string(),
		kind: z.literal('percent'),
		percent: z.number(),
	}),
	z.object({
		core: z.string(),
		kind: z.literal('active'),
		active: z.boolean(),
	}),
	z.object({ core: z.string(), kind: z.literal('unavailable') }),
]);
export type EncoderCoreReading = z.infer<typeof encoderCoreReadingSchema>;

export const encoderLoadSchema = z.object({
	/** `null` ⇒ neither kernel interface was readable on this device. */
	source: encoderLoadSourceSchema.nullable(),
	cores: z.array(encoderCoreReadingSchema),
	/** Epoch ms of the sample; `null` when nothing has ever been read. */
	updatedAt: z.number().nullable(),
	/** Always `false` on the wire — the device never publishes a synthetic read. */
	simulated: z.boolean(),
});
export type EncoderLoad = z.infer<typeof encoderLoadSchema>;
