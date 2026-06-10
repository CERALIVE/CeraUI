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

// Revisions schema
export const revisionsSchema = z.object({
	ceralive: z.string(),
	ceracoder: z.string(),
	srtla: z.string(),
	bun: z.string(),
	'CERALIVE image': z.string().optional(),
});
export type Revisions = z.infer<typeof revisionsSchema>;

// SSH status schema
export const sshStatusSchema = z.object({
	user: z.string(),
	user_pass: z.boolean(),
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
	result: z.number().optional(),
});
export type UpdateProgress = z.infer<typeof updateProgressSchema>;

// Updating status schema (can be boolean, null, or progress object)
export const updatingStatusSchema = z.union([z.boolean(), z.null(), updateProgressSchema]);
export type UpdatingStatus = z.infer<typeof updatingStatusSchema>;

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
export const KIOSK_UNAVAILABLE_ERROR = "kiosk_unavailable_in_emulated_mode";

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
