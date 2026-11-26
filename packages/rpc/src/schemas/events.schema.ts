/**
 * Typed producer registry, imported only through @ceraui/rpc/events.
 * Params are flat and strict: undeclared identifiers and credentials never enter
 * the event store. Keep field names compatible with the logger's key redaction.
 */
import { z } from 'zod';
import type { EventFamily, EventSeverity } from './events-wire.schema';
import {
	startFailureCaptureCauseSchema,
	startFailureClassSchema,
	startFailurePhaseSchema,
} from './streaming-lifecycle.schema';

export const STREAM_STOP_CAUSES = ['operator', 'engine_loss', 'reconfigure'] as const;
export const streamStopCauseSchema = z.enum(STREAM_STOP_CAUSES);
export type StreamStopCause = z.infer<typeof streamStopCauseSchema>;
export const RECOVERY_FAILURE_REASONS = [
	'runtime_state_unknown',
	'lifecycle_busy',
	'config_invalid',
	'start_failed',
	'start_busy',
	'start_cancelled',
] as const;
export const recoveryFailureReasonSchema = z.enum(RECOVERY_FAILURE_REASONS);
export type RecoveryFailureReason = z.infer<typeof recoveryFailureReasonSchema>;
export const UPLINK_KINDS = ['ethernet', 'wifi', 'cellular', 'other'] as const;
export const uplinkKindSchema = z.enum(UPLINK_KINDS);
export type UplinkKind = z.infer<typeof uplinkKindSchema>;
export const UPLINK_HEALTH_STATES = ['up', 'degraded', 'down'] as const;
export const uplinkHealthStateSchema = z.enum(UPLINK_HEALTH_STATES);
export type UplinkHealthState = z.infer<typeof uplinkHealthStateSchema>;
export const UPLINK_HEALTH_REASONS = [
	'probe_failed',
	'captive_portal',
	'passive_congestion',
	'definitive_loss',
] as const;
export const uplinkHealthReasonSchema = z.enum(UPLINK_HEALTH_REASONS);
export type UplinkHealthReason = z.infer<typeof uplinkHealthReasonSchema>;

export const EVENT_TEXT_LIMIT = 1024;
const text = z.string().max(EVENT_TEXT_LIMIT);
const strings = z.array(text);
const duration = z.number().nonnegative();
const count = z.number().int().nonnegative();
const bootId = z.string().regex(/^[0-9a-f]{32}$/);
const empty = z.strictObject({});
const startAttempt = z.strictObject({
	attemptId: text.optional(),
	class: startFailureClassSchema,
	phase: startFailurePhaseSchema,
	attempt: z.number().int().min(1),
	maxAttempts: z.number().int().min(1),
});
const link = z.strictObject({
	iface: text,
	kind: uplinkKindSchema,
	displayName: text.optional(),
	reason: uplinkHealthReasonSchema.optional(),
	downSec: duration.optional(),
});
const netif = z.strictObject({ iface: text, kind: uplinkKindSchema });
const modem = z.strictObject({ modemKey: text });
const modemPresence = modem.extend({ name: text });
const engine = z.strictObject({ streaming: z.boolean() });
const bond = z.strictObject({ linkCount: count });
const disk = z.strictObject({ freeBytes: duration });
const source = z.strictObject({ name: text.optional() });
const input = z.strictObject({ name: text, activeCamera: z.boolean() });
const standby = z.strictObject({ durationSec: duration });
const updateIdentity = z.strictObject({ id: text });
const updateVersion = updateIdentity.extend({ version: text });

function entry<S extends z.ZodType>(
	family: EventFamily,
	params: S,
	severity: EventSeverity | ((params: Readonly<Record<string, unknown>>) => EventSeverity),
	subject: (params: Readonly<Record<string, unknown>>) => string,
) {
	return {
		family,
		params,
		severity:
			typeof severity === 'function'
				? severity
				: (_params: Readonly<Record<string, unknown>>): EventSeverity => severity,
		subject,
	};
}

function update<S extends z.ZodType<{ id: string }>>(
	code: string,
	params: S,
	severity: EventSeverity,
) {
	return entry('update', params, severity, (params) => `update:${code}:${params.id}`);
}

const streamSubject = (): string => 'stream';
const engineSubject = (): string => 'engine';
const linkSubject = (params: Readonly<Record<string, unknown>>): string => `link:${params.iface}`;
const modemSubject = (params: Readonly<Record<string, unknown>>): string =>
	`modem:${params.modemKey}`;
const inputSubject = (params: Readonly<Record<string, unknown>>): string =>
	`capture:input:${params.name}`;

export const EVENT_REGISTRY = {
	stream_started: entry(
		'stream',
		z.strictObject({ attemptId: text.optional(), origin: text.optional() }),
		'success',
		streamSubject,
	),
	stream_stopped: entry(
		'stream',
		z.strictObject({ cause: streamStopCauseSchema, durationSec: duration }),
		(params) => (params.cause === 'operator' ? 'info' : 'warning'),
		streamSubject,
	),
	stream_stop_failed: entry('stream', empty, 'error', streamSubject),
	stream_start_retrying: entry('stream', startAttempt, 'info', streamSubject),
	stream_start_failed: entry(
		'stream',
		startAttempt.extend({ captureCause: startFailureCaptureCauseSchema.optional() }),
		'error',
		streamSubject,
	),
	stream_reconfigured: entry(
		'stream',
		z.strictObject({ outcome: z.enum(['streaming', 'idle', 'reconciling']) }),
		(params) => (params.outcome === 'streaming' ? 'info' : 'warning'),
		streamSubject,
	),
	stream_restored: entry('stream', empty, 'success', streamSubject),
	stream_restore_failed: entry(
		'stream',
		z.strictObject({ reason: recoveryFailureReasonSchema }),
		'error',
		streamSubject,
	),
	stream_autostart_failed: entry(
		'stream',
		z.strictObject({ reason: text }),
		'error',
		streamSubject,
	),
	engine_lost: entry('stream', engine, 'error', engineSubject),
	engine_recovered: entry('stream', engine, 'success', engineSubject),
	link_down: entry('network', link, 'warning', linkSubject),
	link_degraded: entry('network', link, 'warning', linkSubject),
	link_up: entry('network', link, 'success', linkSubject),
	bond_all_links_down: entry('network', bond, 'error', () => 'bond'),
	bond_links_recovered: entry('network', bond, 'success', () => 'bond'),
	internet_lost: entry('network', empty, 'warning', () => 'internet'),
	internet_restored: entry('network', empty, 'success', () => 'internet'),
	interface_added: entry('network', netif, 'info', linkSubject),
	interface_removed: entry('network', netif, 'info', linkSubject),
	modem_added: entry('cellular', modemPresence, 'info', modemSubject),
	modem_removed: entry('cellular', modemPresence, 'warning', modemSubject),
	modem_connected: entry(
		'cellular',
		modem.extend({ networkType: text.optional(), roaming: z.boolean() }),
		'success',
		modemSubject,
	),
	modem_disconnected: entry('cellular', modem, 'warning', modemSubject),
	modem_registration_rejected: entry(
		'cellular',
		modem.extend({ rejection: text }),
		'warning',
		modemSubject,
	),
	sim_inserted: entry('cellular', modem, 'info', modemSubject),
	sim_removed: entry('cellular', modem, 'warning', modemSubject),
	update_packages_recovered: update('packages_recovered', updateIdentity, 'info'),
	update_slot_sync_recovered: update('slot_sync_recovered', updateIdentity, 'info'),
	update_updates_available: update('updates_available', updateIdentity, 'info'),
	update_installed: update('installed', updateIdentity.extend({ packages: strings }), 'success'),
	update_refused: update('refused', updateIdentity.extend({ reason: text }), 'warning'),
	update_download_paused: update('download_paused', updateIdentity, 'info'),
	update_os_staged: update('os_staged', updateVersion, 'info'),
	update_os_activation_requested: update('os_activation_requested', updateVersion, 'info'),
	update_os_activated: update('os_activated', updateVersion, 'success'),
	update_os_rollback: update('os_rollback', updateVersion, 'error'),
	update_slots_current: update('slots_current', updateIdentity, 'success'),
	update_restart_recommended: update(
		'restart_recommended',
		updateIdentity.extend({ unit: text }),
		'warning',
	),
	update_cellular_approval: update(
		'cellular_approval',
		updateIdentity.extend({ size: text }),
		'warning',
	),
	update_credentials_expiring: update(
		'credentials_expiring',
		updateIdentity.extend({ days: z.union([z.literal(90), z.literal(30), z.literal(7)]) }),
		'warning',
	),
	update_credentials_expired: update('credentials_expired', updateIdentity, 'error'),
	update_transport_unhealthy: update(
		'transport_unhealthy',
		updateIdentity.extend({ reasons: strings }),
		'warning',
	),
	update_kernel_staged: update('kernel_staged', updateVersion, 'info'),
	update_kernel_succeeded: update('kernel_succeeded', updateVersion, 'success'),
	update_kernel_rolled_back: update('kernel_rolled_back', updateVersion, 'error'),
	update_os_stage_retry: update('os_stage_retry', updateVersion, 'info'),
	update_os_stage_operator: update('os_stage_operator', updateVersion, 'warning'),
	update_os_stage_unresolved: update('os_stage_unresolved', updateVersion, 'error'),
	update_failed: entry(
		'update',
		z.strictObject({
			stage: z.enum(['download', 'commit', 'sync', 'os-staging']),
			reason: text,
			id: z.uuid().optional(),
		}),
		'error',
		(params) => `update:failed:${params.stage}:${params.id ?? params.reason}`,
	),
	device_started: entry(
		'device',
		z.strictObject({
			osImage: text.nullable(),
			slot: text.nullable(),
			board: text.nullable(),
			boardModel: text.nullable(),
			ceraui: text.nullable(),
			engine: text.nullable(),
			senderVersion: text.nullable(),
			kernel: text.nullable(),
			bun: text.nullable(),
			previousBootId: bootId.nullable(),
			previousShutdown: z.enum(['clean', 'unclean', 'unknown']).nullable(),
		}),
		'info',
		() => 'device:boot',
	),
	previous_boot_unclean: entry(
		'device',
		z.strictObject({ bootId, evidence: strings }),
		'warning',
		(params) => `device:previous-boot:${params.bootId}`,
	),
	shutdown_requested: entry(
		'device',
		z.strictObject({ action: z.enum(['reboot', 'poweroff']), origin: text }),
		'info',
		() => 'device:shutdown',
	),
	service_stopping: entry(
		'device',
		z.strictObject({ signal: z.enum(['SIGTERM', 'SIGINT']) }),
		'info',
		() => 'device:service',
	),
	power_action_refused: entry(
		'device',
		z.strictObject({ reason: text }),
		'warning',
		() => 'device:power-refused',
	),
	disk_low: entry('device', disk, 'warning', () => 'device:disk'),
	disk_ok: entry('device', disk, 'success', () => 'device:disk'),
	config_reset_damaged: entry('device', empty, 'error', () => 'device:config'),
	hardware_identity_drift: entry(
		'device',
		z.strictObject({ detected: text, configured: text }),
		'warning',
		() => 'device:hardware',
	),
	bootloader_update_failed: entry('device', empty, 'error', () => 'device:bootloader'),
	capture_source_lost: entry('capture', source, 'error', () => 'capture:source'),
	capture_source_recovered: entry('capture', source, 'success', () => 'capture:source'),
	audio_source_lost: entry('capture', empty, 'warning', () => 'capture:audio'),
	audio_source_recovered: entry('capture', empty, 'success', () => 'capture:audio'),
	capture_input_lost: entry('capture', input, 'warning', inputSubject),
	capture_input_returned: entry('capture', input, 'success', inputSubject),
	capture_standby_entered: entry('capture', standby, 'error', () => 'capture:standby'),
	capture_standby_exited: entry('capture', standby, 'success', () => 'capture:standby'),
} as const;

export type EventCode = keyof typeof EVENT_REGISTRY;
export type EventParams<C extends EventCode> = z.infer<(typeof EVENT_REGISTRY)[C]['params']>;
