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
	belaUI: z.string(),
	belacoder: z.string(),
	srtla: z.string(),
	'CERALIVE image': z.string(),
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

// Remote key config input schema
export const remoteKeyInputSchema = z.object({
	remote_key: z.string(),
});
export type RemoteKeyInput = z.infer<typeof remoteKeyInputSchema>;

// Autostart config input schema
export const autostartInputSchema = z.object({
	autostart: z.boolean(),
});
export type AutostartInput = z.infer<typeof autostartInputSchema>;
