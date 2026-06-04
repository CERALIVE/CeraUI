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
