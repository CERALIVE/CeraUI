import { describe, expect, test } from 'bun:test';
import {
	EVENT_REGISTRY,
	type EventCode,
	type EventParams,
	RECOVERY_FAILURE_REASONS,
	recoveryFailureReasonSchema,
	STREAM_STOP_CAUSES,
	streamStopCauseSchema,
	UPLINK_HEALTH_REASONS,
	UPLINK_HEALTH_STATES,
	UPLINK_KINDS,
	uplinkHealthReasonSchema,
	uplinkHealthStateSchema,
	uplinkKindSchema,
} from '@ceraui/rpc/events';
import { appContract, eventsContract } from '../contracts';
import {
	type DeviceEvent,
	deviceEventSchema,
	EVENT_FAMILIES,
	EVENT_PUSH,
	EVENT_SEVERITIES,
	eventAppendSchema,
	eventBootRecordSchema,
	eventListInputSchema,
	eventListOutputSchema,
	LOW_DISK_THRESHOLD_BYTES,
} from './index';

const bootId = '66d8d1808694489b8c3a3fb4795cab24';
const versions = {
	bootId,
	osImage: null,
	slot: null,
	board: null,
	boardModel: null,
	ceraui: '2026.11.3',
	engine: null,
	senderVersion: '1.2.3',
	kernel: null,
	bun: null,
};
const samples = {
	stream_started: {},
	stream_stopped: { cause: 'operator', durationSec: 12 },
	stream_stop_failed: {},
	stream_start_retrying: {
		class: 'engine_unavailable',
		phase: 'connect',
		attempt: 1,
		maxAttempts: 3,
	},
	stream_start_failed: {
		class: 'capture_source_unavailable',
		phase: 'start-rpc',
		captureCause: 'no_signal',
		attempt: 3,
		maxAttempts: 3,
	},
	stream_reconfigured: { outcome: 'streaming' },
	stream_restored: {},
	stream_restore_failed: { reason: 'start_failed' },
	stream_autostart_failed: { reason: 'network_links_unavailable' },
	engine_lost: { streaming: true },
	engine_recovered: { streaming: false },
	link_down: {
		iface: 'eth0',
		kind: 'ethernet',
		displayName: 'Ethernet',
		reason: 'probe_failed',
		downSec: 2,
	},
	link_degraded: { iface: 'wlan0', kind: 'wifi' },
	link_up: { iface: 'eth0', kind: 'ethernet', downSec: 5 },
	bond_all_links_down: { linkCount: 0 },
	bond_links_recovered: { linkCount: 2 },
	internet_lost: {},
	internet_restored: {},
	interface_added: { iface: 'eth0', kind: 'ethernet' },
	interface_removed: { iface: 'eth0', kind: 'ethernet' },
	modem_added: { modemKey: 'usb-port-1', name: 'Modem' },
	modem_removed: { modemKey: 'usb-port-1', name: 'Modem' },
	modem_connected: { modemKey: 'usb-port-1', networkType: 'lte', roaming: false },
	modem_disconnected: { modemKey: 'usb-port-1' },
	modem_registration_rejected: { modemKey: 'usb-port-1', rejection: 'no-cells-in-location-area' },
	sim_inserted: { modemKey: 'usb-port-1' },
	sim_removed: { modemKey: 'usb-port-1' },
	update_packages_recovered: { id: 'txn-1' },
	update_slot_sync_recovered: { id: 'txn-1' },
	update_updates_available: { id: 'txn-1' },
	update_installed: { id: 'txn-1', packages: ['ceraui'] },
	update_refused: { id: 'txn-1', reason: 'streaming' },
	update_download_paused: { id: 'txn-1' },
	update_os_staged: { id: 'txn-1', version: '2026.11.1' },
	update_os_activation_requested: { id: 'txn-1', version: '2026.11.1' },
	update_os_activated: { id: 'txn-1', version: '2026.11.1' },
	update_os_rollback: { id: 'txn-1', version: '2026.11.1' },
	update_slots_current: { id: 'txn-1' },
	update_restart_recommended: { id: 'txn-1', unit: 'ceralive.service' },
	update_cellular_approval: { id: 'txn-1', size: '100 MB' },
	update_credentials_expiring: { id: 'txn-1', days: 30 },
	update_credentials_expired: { id: 'txn-1' },
	update_transport_unhealthy: { id: 'txn-1', reasons: ['unreachable'] },
	update_kernel_staged: { id: 'txn-1', version: '6.1.0' },
	update_kernel_succeeded: { id: 'txn-1', version: '6.1.0' },
	update_kernel_rolled_back: { id: 'txn-1', version: '6.1.0' },
	update_os_stage_retry: { id: 'txn-1', version: '2026.11.1' },
	update_os_stage_operator: { id: 'txn-1', version: '2026.11.1' },
	update_os_stage_unresolved: { id: 'txn-1', version: '2026.11.1' },
	update_failed: { stage: 'download', reason: 'download_failed' },
	device_started: {
		osImage: null,
		slot: null,
		board: null,
		boardModel: null,
		ceraui: '2026.11.3',
		engine: null,
		senderVersion: '1.2.3',
		kernel: null,
		bun: null,
		previousBootId: null,
		previousShutdown: null,
	},
	previous_boot_unclean: { bootId, evidence: ['no_shutdown_markers'] },
	shutdown_requested: { action: 'reboot', origin: 'operator' },
	service_stopping: { signal: 'SIGTERM' },
	power_action_refused: { reason: 'streaming' },
	disk_low: { freeBytes: 1 },
	disk_ok: { freeBytes: 536870912 },
	config_reset_damaged: {},
	hardware_identity_drift: { detected: 'rock5b', configured: 'rock5b-plus' },
	bootloader_update_failed: {},
	capture_source_lost: { name: 'Camera' },
	capture_source_recovered: {},
	audio_source_lost: {},
	audio_source_recovered: {},
	capture_input_lost: { name: 'Camera', activeCamera: true },
	capture_input_returned: { name: 'Camera', activeCamera: false },
	capture_standby_entered: { durationSec: 0 },
	capture_standby_exited: { durationSec: 12 },
} satisfies { [C in EventCode]: EventParams<C> };
const samplesByCode: Readonly<Record<string, DeviceEvent['params']>> = samples;

const event = {
	id: '66d8d180-1',
	seq: 1,
	bootId,
	at: 1000,
	code: 'stream_started',
	family: 'stream',
	severity: 'success',
	params: {},
} satisfies DeviceEvent;
const list = { events: [event], nextBeforeSeq: null, headSeq: 1, retainedFromSeq: 1 };
const boot = { bootId, startedAt: 1000, versions };

describe('event producer registry', () => {
	test('every planned code produces flat wire params without dropping any data', () => {
		expect(Object.keys(EVENT_REGISTRY).sort()).toEqual(Object.keys(samples).sort());
		for (const [code, definition] of Object.entries(EVENT_REGISTRY)) {
			const params = { ...samplesByCode[code] };
			expect(EVENT_FAMILIES).toContain(definition.family);
			const parsed = definition.params.parse(params);
			expect(parsed).toEqual(params);
			const severity = definition.severity(parsed);
			expect(EVENT_SEVERITIES).toContain(severity);
			expect(definition.subject(parsed).length).toBeGreaterThan(0);
			expect(
				deviceEventSchema.parse({
					...event,
					code,
					family: definition.family,
					severity,
					params: parsed,
				}).params,
			).toEqual(params);
		}
	});

	test('each params boundary rejects undeclared and sensitive keys instead of stripping them', () => {
		for (const [code, definition] of Object.entries(EVENT_REGISTRY)) {
			const params = { ...samplesByCode[code] };
			for (const key of ['unknown', 'iccid', 'imei', 'imsi', 'password', 'sender', 'serial']) {
				expect(definition.params.safeParse({ ...params, [key]: 'x' }).success).toBe(false);
			}
		}
	});

	test('a known code rejects missing, nested, and wrong typed params', () => {
		for (const [code, definition] of Object.entries(EVENT_REGISTRY)) {
			const params = { ...samplesByCode[code] };
			const schema = definition.params;
			for (const key of Object.keys(params)) {
				expect(schema.safeParse({ ...params, [key]: { nested: 'x' } }).success).toBe(false);
			}
		}
		expect(EVENT_REGISTRY.stream_stopped.params.safeParse({}).success).toBe(false);
		expect(EVENT_REGISTRY.engine_lost.params.safeParse({ streaming: 'true' }).success).toBe(false);
	});

	test('all text params and text array elements have the declared 1024 character ceiling', () => {
		for (const [code, definition] of Object.entries(EVENT_REGISTRY)) {
			const params = { ...samplesByCode[code] };
			const schema = definition.params;
			for (const [key, value] of Object.entries(params)) {
				if (typeof value === 'string' || Array.isArray(value)) {
					expect(
						schema.safeParse({
							...params,
							[key]: Array.isArray(value) ? ['x'.repeat(1025)] : 'x'.repeat(1025),
						}).success,
					).toBe(false);
				}
			}
		}
		expect(
			EVENT_REGISTRY.modem_added.params.parse({ modemKey: 'x'.repeat(1024), name: '' }).modemKey,
		).toHaveLength(1024);
		for (const key of [
			'osImage',
			'slot',
			'board',
			'boardModel',
			'ceraui',
			'engine',
			'senderVersion',
			'kernel',
			'bun',
		]) {
			expect(
				EVENT_REGISTRY.device_started.params.safeParse({
					...samples.device_started,
					[key]: 'x'.repeat(1025),
				}).success,
			).toBe(false);
		}
	});

	test('typed enums reject invented values and retain all existing alternatives', () => {
		for (const [schema, values] of [
			[streamStopCauseSchema, ['operator', 'engine_loss', 'reconfigure']],
			[
				recoveryFailureReasonSchema,
				[
					'runtime_state_unknown',
					'lifecycle_busy',
					'config_invalid',
					'start_failed',
					'start_busy',
					'start_cancelled',
				],
			],
			[uplinkKindSchema, ['ethernet', 'wifi', 'cellular', 'other']],
			[uplinkHealthStateSchema, ['up', 'degraded', 'down']],
			[
				uplinkHealthReasonSchema,
				['probe_failed', 'captive_portal', 'passive_congestion', 'definitive_loss'],
			],
		] as const) {
			for (const value of values) expect(schema.parse(value)).toBe(value);
			expect(schema.safeParse('invented').success).toBe(false);
		}
		expect(streamStopCauseSchema.options).toEqual([...STREAM_STOP_CAUSES]);
		expect(recoveryFailureReasonSchema.options).toEqual([...RECOVERY_FAILURE_REASONS]);
		expect(uplinkKindSchema.options).toEqual([...UPLINK_KINDS]);
		expect(uplinkHealthStateSchema.options).toEqual([...UPLINK_HEALTH_STATES]);
		expect(uplinkHealthReasonSchema.options).toEqual([...UPLINK_HEALTH_REASONS]);
		for (const [code, params, key] of [
			['stream_stopped', samples.stream_stopped, 'cause'],
			['stream_restore_failed', samples.stream_restore_failed, 'reason'],
			['stream_start_retrying', samples.stream_start_retrying, 'class'],
			['stream_start_retrying', samples.stream_start_retrying, 'phase'],
			['stream_start_failed', samples.stream_start_failed, 'captureCause'],
			['stream_reconfigured', samples.stream_reconfigured, 'outcome'],
			['link_down', samples.link_down, 'kind'],
			['link_down', samples.link_down, 'reason'],
			['interface_added', samples.interface_added, 'kind'],
			['update_failed', samples.update_failed, 'stage'],
			['device_started', samples.device_started, 'previousShutdown'],
			['shutdown_requested', samples.shutdown_requested, 'action'],
			['service_stopping', samples.service_stopping, 'signal'],
		] as const)
			expect(EVENT_REGISTRY[code].params.safeParse({ ...params, [key]: 'invented' }).success).toBe(
				false,
			);
		for (const days of [90, 30, 7])
			expect(
				EVENT_REGISTRY.update_credentials_expiring.params.safeParse({ id: 'x', days }).success,
			).toBe(true);
		expect(
			EVENT_REGISTRY.update_credentials_expiring.params.safeParse({ id: 'x', days: 8 }).success,
		).toBe(false);
	});

	test('counts and durations reject negatives and counters reject fractions', () => {
		for (const [code, params, key] of [
			['stream_stopped', samples.stream_stopped, 'durationSec'],
			['link_down', samples.link_down, 'downSec'],
			['bond_all_links_down', samples.bond_all_links_down, 'linkCount'],
			['disk_low', samples.disk_low, 'freeBytes'],
			['capture_standby_entered', samples.capture_standby_entered, 'durationSec'],
			['stream_start_retrying', samples.stream_start_retrying, 'attempt'],
			['stream_start_retrying', samples.stream_start_retrying, 'maxAttempts'],
		] as const)
			expect(EVENT_REGISTRY[code].params.safeParse({ ...params, [key]: -1 }).success).toBe(false);
		for (const key of ['attempt', 'maxAttempts']) {
			for (const value of [0, 1.5])
				expect(
					EVENT_REGISTRY.stream_start_retrying.params.safeParse({
						...samples.stream_start_retrying,
						[key]: value,
					}).success,
				).toBe(false);
		}
		expect(EVENT_REGISTRY.bond_links_recovered.params.safeParse({ linkCount: 1.5 }).success).toBe(
			false,
		);
	});

	test('severity follows the fact and subjects join transitions of the same entity', () => {
		expect(EVENT_REGISTRY.stream_stopped.severity({ cause: 'operator', durationSec: 0 })).toBe(
			'info',
		);
		expect(EVENT_REGISTRY.stream_stopped.severity({ cause: 'engine_loss', durationSec: 0 })).toBe(
			'warning',
		);
		for (const outcome of ['streaming', 'idle', 'reconciling'] as const)
			expect(EVENT_REGISTRY.stream_reconfigured.severity({ outcome })).toBe(
				outcome === 'streaming' ? 'info' : 'warning',
			);
		expect(EVENT_REGISTRY.link_down.subject(samples.link_down)).toBe(
			EVENT_REGISTRY.link_up.subject(samples.link_up),
		);
		expect(EVENT_REGISTRY.link_down.subject(samples.link_down)).not.toBe(
			EVENT_REGISTRY.link_down.subject({ iface: 'eth1', kind: 'ethernet' }),
		);
		expect(EVENT_REGISTRY.modem_added.subject(samples.modem_added)).toBe(
			EVENT_REGISTRY.modem_connected.subject(samples.modem_connected),
		);
		expect(EVENT_REGISTRY.update_installed.subject(samples.update_installed)).not.toBe(
			EVENT_REGISTRY.update_installed.subject({ id: 'txn-2', packages: [] }),
		);
		expect(EVENT_REGISTRY.update_os_staged.subject(samples.update_os_staged)).not.toBe(
			EVENT_REGISTRY.update_os_activated.subject(samples.update_os_activated),
		);
		expect(EVENT_REGISTRY.capture_input_lost.subject(samples.capture_input_lost)).toBe(
			EVENT_REGISTRY.capture_input_returned.subject(samples.capture_input_returned),
		);
	});
});

describe('event wire compatibility and RPC boundary', () => {
	test('future codes survive and unknown family and severity fall back independently', () => {
		const future = {
			id: 'x',
			seq: 1,
			bootId: 'b',
			at: 1,
			code: 'from_the_future',
			family: 'nope',
			severity: 'weird',
			params: {},
		};
		expect(deviceEventSchema.parse(future)).toEqual({
			...future,
			family: 'device',
			severity: 'info',
		});
		for (const family of EVENT_FAMILIES)
			expect(deviceEventSchema.parse({ ...event, family }).family).toBe(family);
		for (const severity of EVENT_SEVERITIES)
			expect(deviceEventSchema.parse({ ...event, severity }).severity).toBe(severity);
	});

	test('all flat wire value branches round trip and nested values fail', () => {
		const params = { text: 'x', number: 1, boolean: true, nothing: null, strings: ['a'] };
		expect(deviceEventSchema.parse({ ...event, params, suppressed: 2 }).params).toEqual(params);
		for (const bad of [{ nested: {} }, { mixed: ['a', 1] }, { missing: undefined }])
			expect(deviceEventSchema.safeParse({ ...event, params: bad }).success).toBe(false);
		for (const patch of [{ seq: 1.5 }, { suppressed: 1.5 }, { seq: undefined }])
			expect(deviceEventSchema.safeParse({ ...event, ...patch }).success).toBe(false);
	});

	test('list defaults are stable and every input guard rejects malformed values', () => {
		expect(eventListInputSchema.parse({})).toEqual({ limit: 100 });
		expect(
			eventListInputSchema.parse({
				limit: 200,
				beforeSeq: 2,
				bootId,
				families: ['network'],
				problemsOnly: true,
			}).limit,
		).toBe(200);
		for (const patch of [
			{ limit: 0 },
			{ limit: 201 },
			{ limit: 1.5 },
			{ beforeSeq: 1.5 },
			{ families: ['unknown'] },
			{ bootId: '66d8d180-8694-489b-8c3a-3fb4795cab24' },
			{ bootId: bootId.toUpperCase() },
			{ unknown: true },
			{ problemsOnly: 'yes' },
		])
			expect(eventListInputSchema.safeParse(patch).success).toBe(false);
		for (const schema of [
			EVENT_REGISTRY.previous_boot_unclean.params,
			EVENT_REGISTRY.device_started.params,
		]) {
			const params =
				schema === EVENT_REGISTRY.previous_boot_unclean.params
					? samples.previous_boot_unclean
					: samples.device_started;
			const key =
				schema === EVENT_REGISTRY.previous_boot_unclean.params ? 'bootId' : 'previousBootId';
			for (const bad of ['66d8d180-8694-489b-8c3a-3fb4795cab24', bootId.toUpperCase()])
				expect(schema.safeParse({ ...params, [key]: bad }).success).toBe(false);
		}
	});

	test('outputs preserve records, paging metadata, and independent boot versions', () => {
		expect(eventListOutputSchema.parse(list)).toEqual(list);
		expect(eventListOutputSchema.parse({ ...list, nextBeforeSeq: 1 }).nextBeforeSeq).toBe(1);
		for (const key of ['nextBeforeSeq', 'headSeq', 'retainedFromSeq'])
			expect(eventListOutputSchema.safeParse({ ...list, [key]: 1.5 }).success).toBe(false);
		expect(eventListOutputSchema.safeParse({ ...list, unknown: true }).success).toBe(false);
		expect(eventBootRecordSchema.parse(boot)).toEqual(boot);
		expect(eventBootRecordSchema.parse({ ...boot, versions: null }).versions).toBeNull();
		for (const patch of [{ unknown: true }, { bootId: 'B'.repeat(32) }])
			expect(eventBootRecordSchema.safeParse({ ...boot, ...patch }).success).toBe(false);
		expect(eventAppendSchema.parse({ append: [event] })).toEqual({ append: [event] });
		expect(eventAppendSchema.safeParse({ append: [event], unknown: true }).success).toBe(false);
		expect(EVENT_PUSH).toBe('event');
		expect(LOW_DISK_THRESHOLD_BYTES).toBe(512 * 1024 * 1024);
		expect(Object.keys(appContract.events).sort()).toEqual(['boots', 'clear', 'list']);
		expect(appContract.events).toEqual(eventsContract);
	});

	test('a list output may name its ring epoch as a UUID or leave it out', () => {
		const named = { ...list, epoch: '0f4c2a51-8d3e-4b7a-9c1f-2e6d8a4b5c7e' };
		expect(eventListOutputSchema.parse(named)).toEqual(named);
		expect(eventListOutputSchema.parse(list)).toEqual(list);
		for (const epoch of [1, null, '', 'ring-1'])
			expect(eventListOutputSchema.safeParse({ ...list, epoch }).success).toBe(false);
	});
});
