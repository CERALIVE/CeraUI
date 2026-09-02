import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { bluetoothContract } from '../contracts/bluetooth.contract';
import { appContract } from '../contracts/index';
import {
	BLUETOOTH_AGENT_FAILURES,
	BLUETOOTH_CAPABILITY_FEATURES,
	BLUETOOTH_MUTATION_REFUSALS,
	BLUETOOTH_TRANSPORTS,
	bluetoothCapabilityClaimsSchema,
	bluetoothDeviceInputSchema,
	bluetoothDeviceSchema,
	bluetoothMutationOutputSchema,
	bluetoothMutationRefusalSchema,
	bluetoothScanStartInputSchema,
	bluetoothScanStopInputSchema,
	bluetoothStatusSchema,
	bluetoothToggleInputSchema,
	bluetoothTrustInputSchema,
} from './bluetooth.schema';
import { SUPPORT_CLAIM_STATES } from './capability-modules.schema';

const DEVICE_PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
const ADAPTER_PATH = '/org/bluez/hci0';

function healthyDevice() {
	return {
		path: DEVICE_PATH,
		adapterPath: ADAPTER_PATH,
		address: 'AA:BB:CC:DD:EE:FF',
		name: 'DJI Mic Mini',
		deviceClass: 'audio-input' as const,
		transport: 'bredr' as const,
		paired: true,
		trusted: true,
		connected: false,
		blocked: false,
		scoCapable: true,
	};
}

describe('the bluetooth device row', () => {
	test('the four recoverable booleans are REQUIRED, never omitted-when-false', () => {
		for (const field of ['paired', 'trusted', 'connected', 'blocked'] as const) {
			const row: Record<string, unknown> = healthyDevice();
			delete row[field];
			expect(bluetoothDeviceSchema.safeParse(row).success).toBe(false);
		}
	});

	test('an explicit false round-trips — that is what makes a disconnect expressible', () => {
		const parsed = bluetoothDeviceSchema.parse({
			...healthyDevice(),
			paired: false,
			trusted: false,
			connected: false,
			blocked: false,
		});
		expect(parsed.paired).toBe(false);
		expect(parsed.connected).toBe(false);
	});

	test('battery and rssi are OPTIONAL — absent is not a measured zero', () => {
		const withoutReadings = bluetoothDeviceSchema.parse(healthyDevice());
		expect(withoutReadings.battery).toBeUndefined();
		expect(withoutReadings.rssi).toBeUndefined();

		const withReadings = bluetoothDeviceSchema.parse({
			...healthyDevice(),
			battery: 0,
			rssi: -71,
		});
		expect(withReadings.battery).toBe(0);
		expect(withReadings.rssi).toBe(-71);
	});

	test('battery is bounded to a percentage', () => {
		expect(bluetoothDeviceSchema.safeParse({ ...healthyDevice(), battery: 101 }).success).toBe(
			false,
		);
		expect(bluetoothDeviceSchema.safeParse({ ...healthyDevice(), battery: -1 }).success).toBe(
			false,
		);
	});

	test('a malformed object path is rejected', () => {
		expect(
			bluetoothDeviceSchema.safeParse({ ...healthyDevice(), path: 'hci0/dev_AA' }).success,
		).toBe(false);
	});

	test('the transport vocabulary keeps `unknown` as a first-class answer', () => {
		expect([...BLUETOOTH_TRANSPORTS].sort()).toEqual(['bredr', 'dual', 'le', 'unknown']);
		expect(
			bluetoothDeviceSchema.parse({ ...healthyDevice(), transport: 'unknown' }).transport,
		).toBe('unknown');
	});
});

describe('every mutation input is strict', () => {
	const cases: Array<[string, { safeParse: (v: unknown) => { success: boolean } }, object]> = [
		['enable/disable', bluetoothToggleInputSchema, {}],
		['scanStart', bluetoothScanStartInputSchema, { adapterPath: ADAPTER_PATH }],
		['scanStop', bluetoothScanStopInputSchema, { adapterPath: ADAPTER_PATH }],
		['pair/forget/connect/disconnect', bluetoothDeviceInputSchema, { devicePath: DEVICE_PATH }],
		['trust', bluetoothTrustInputSchema, { devicePath: DEVICE_PATH, trusted: true }],
	];

	for (const [name, schema, valid] of cases) {
		test(`${name} accepts its own shape and REJECTS an unknown key`, () => {
			expect(schema.safeParse(valid).success).toBe(true);
			expect(schema.safeParse({ ...valid, force: true }).success).toBe(false);
		});
	}

	test('a pair input carrying an extra key is rejected outright', () => {
		const rejected = bluetoothDeviceInputSchema.safeParse({
			devicePath: DEVICE_PATH,
			confirm: true,
		});
		expect(rejected.success).toBe(false);
	});

	test('trust defaults to trusting, and can still REVOKE', () => {
		expect(bluetoothTrustInputSchema.parse({ devicePath: DEVICE_PATH }).trusted).toBe(true);
		expect(
			bluetoothTrustInputSchema.parse({ devicePath: DEVICE_PATH, trusted: false }).trusted,
		).toBe(false);
	});
});

describe('the shared mutation-refusal vocabulary', () => {
	test('every refusal the plan names is a member', () => {
		for (const required of [
			'bt_unavailable_in_emulated_mode',
			'adapter_busy',
			'pairing_failed',
			'unit_missing',
			'service_start_failed',
		]) {
			expect(bluetoothMutationRefusalSchema.safeParse(required).success).toBe(true);
		}
	});

	test('the BlueZ-agent gap has its OWN member — it is never a generic failure', () => {
		expect(BLUETOOTH_MUTATION_REFUSALS).toContain('pairing_agent_unavailable');
		expect(BLUETOOTH_AGENT_FAILURES).toContain('exporter_unavailable');
	});

	test('the enum is exactly the documented set — no member silently added or dropped', () => {
		expect([...BLUETOOTH_MUTATION_REFUSALS].sort()).toEqual([
			'adapter_busy',
			'bluetooth_disabled',
			'bluez_error',
			'bluez_unavailable',
			'bt_unavailable_in_emulated_mode',
			'bus_unreachable',
			'no_adapter',
			'not_connected',
			'pairing_agent_unavailable',
			'pairing_failed',
			'service_start_failed',
			'unit_missing',
			'unknown_adapter',
			'unknown_device',
		]);
	});

	test('an unlisted refusal string is rejected', () => {
		expect(bluetoothMutationRefusalSchema.safeParse('generic').success).toBe(false);
	});

	test('a refusal output carries the holder and the BlueZ name', () => {
		const parsed = bluetoothMutationOutputSchema.parse({
			success: false,
			error: 'adapter_busy',
			heldBy: 'pair',
		});
		expect(parsed.heldBy).toBe('pair');
	});
});

describe('the five-state capability claims', () => {
	test('the claim vocabulary IS the shared ladder', () => {
		for (const state of SUPPORT_CLAIM_STATES) {
			expect(
				bluetoothCapabilityClaimsSchema.safeParse({
					adapter: state,
					pairing: state,
					'audio-input': state,
					battery: state,
				}).success,
			).toBe(true);
		}
	});

	test('an unlisted feature key is rejected', () => {
		expect(
			bluetoothCapabilityClaimsSchema.safeParse({ adapter: 'capable', bogus: 'capable' }).success,
		).toBe(false);
	});

	test('`bluetooth` is NOT registered as a modem CAPABILITY_MODULE', async () => {
		const { CAPABILITY_MODULES } = await import('./capability-modules.schema');
		expect(CAPABILITY_MODULES as readonly string[]).not.toContain('bluetooth');
		expect(BLUETOOTH_CAPABILITY_FEATURES.length).toBeGreaterThan(0);
	});
});

describe('the status answer', () => {
	test('an unavailable stack names its cause and still states enabled', () => {
		const parsed = bluetoothStatusSchema.parse({
			available: false,
			enabled: true,
			unavailable: { cause: 'bluez_unavailable', detail: 'no owner' },
			adapters: [],
			devices: [],
			agent: { registered: false, isDefaultAgent: false, reason: 'exporter_unavailable' },
			bootReconnectDone: false,
			capabilities: {
				adapter: 'enabled',
				pairing: 'unavailable',
				'audio-input': 'enabled',
				battery: 'enabled',
			},
		});
		expect(parsed.enabled).toBe(true);
		expect(parsed.unavailable?.cause).toBe('bluez_unavailable');
		expect(parsed.agent.reason).toBe('exporter_unavailable');
	});

	test('an unrecognised unavailability cause is rejected', () => {
		expect(
			bluetoothStatusSchema.safeParse({
				available: false,
				enabled: false,
				unavailable: { cause: 'radio_off' },
				adapters: [],
				devices: [],
				agent: { registered: false, isDefaultAgent: false },
				bootReconnectDone: false,
				capabilities: { adapter: 'implemented' },
			}).success,
		).toBe(false);
	});
});

describe('the domain is wired, and named by convention', () => {
	test('every contract file has a schema file of the same name', () => {
		const dir = path.dirname(new URL(import.meta.url).pathname);
		const schemas = new Set(
			readdirSync(dir)
				.filter((f) => f.endsWith('.schema.ts') && !f.endsWith('.schema.test.ts'))
				.map((f) => f.replace(/\.schema\.ts$/, '')),
		);
		const contracts = readdirSync(path.join(dir, '..', 'contracts'))
			.filter((f) => f.endsWith('.contract.ts'))
			.map((f) => f.replace(/\.contract\.ts$/, ''));

		expect(contracts).toContain('bluetooth');
		for (const domain of contracts) {
			expect(schemas.has(domain)).toBe(true);
		}
	});

	test('appContract carries the bluetooth domain with all ten procedures', () => {
		expect(Object.keys(appContract.bluetooth).sort()).toEqual(
			Object.keys(bluetoothContract).sort(),
		);
		expect(Object.keys(bluetoothContract).sort()).toEqual([
			'connect',
			'disable',
			'disconnect',
			'enable',
			'forget',
			'getStatus',
			'pair',
			'scanStart',
			'scanStop',
			'trust',
		]);
	});
});
