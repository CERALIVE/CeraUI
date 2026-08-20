/**
 * Phase-B modem schema/contract tests.
 *
 * Covers:
 *  (a) the pre-Phase-B wire shape still parses BYTE-IDENTICALLY (nothing the
 *      additive delta introduced became mandatory, and nothing was added to a
 *      legacy payload's parse output)
 *  (b) every additive-optional field validates and round-trips
 *  (c) `deriveModemStableKey` — one rule, USB parent / non-USB verbatim / omitted
 *  (d) `setUsbMode` strict-input negatives, incl. a missing `confirm`
 *  (e) the usage-policy WRITE fields are ABSENT from `modems.configure`'s input
 *      (deferred — see the note on `modemConfigInputSchema`)
 */
import { describe, expect, test } from 'bun:test';

import {
	CELLULAR_STACK_INITIALIZING,
	canonicalModemIdPath,
	connectionStatusSchema,
	deriveModemStableKey,
	type Modem,
	modemCellInfoSchema,
	modemConfigAppliedSchema,
	modemConfigInputSchema,
	modemDataUsagePolicySchema,
	modemDataUsageSchema,
	modemEsimSchema,
	modemListSchema,
	modemMutationRefusalSchema,
	modemSchema,
	modemSmsInputSchema,
	modemSmsOutputSchema,
	modemSmsRefusalSchema,
	SMS_INBOX_CAP,
	setUsbModeFailureReasonSchema,
	setUsbModeInputSchema,
	setUsbModeOutputSchema,
	setUsbModeRefusalSchema,
	smsMessageSchema,
	smsStateSchema,
	sysfsDevpathToIdPath,
} from './modems.schema';
import { MODEM_TRANSITION_ACTIVE_ERROR } from './streaming.schema';

/**
 * A modem entry exactly as a pre-Phase-B backend emits it. Every key here
 * predates this change; NOT ONE Phase-B field appears.
 */
const LEGACY_MODEM_PAYLOAD = {
	ifname: 'wwan0',
	name: 'QUECTEL Mobile Broadband Module',
	sim_network: 'Movistar',
	model: 'RM530N-GL',
	manufacturer: 'Quectel',
	network_type: {
		supported: ['3g', '4g', '5g'],
		active: '5g4g3g',
	},
	config: {
		apn: 'internet',
		username: '',
		password: '',
		roaming: false,
		network: '',
		autoconfig: true,
	},
	available_networks: {
		'123': { name: 'Movistar', availability: 'available' },
	},
	status: {
		connection: 'connected',
		network_type: '5G',
		signal: 62,
		roaming: false,
	},
	no_sim: false,
	sim_lock: { required: 'none' },
} as const;

describe('legacy wire-shape compatibility', () => {
	test('a pre-Phase-B modem payload parses byte-identically', () => {
		const parsed = modemSchema.parse(LEGACY_MODEM_PAYLOAD);

		expect(parsed).toEqual(LEGACY_MODEM_PAYLOAD);
		expect(JSON.stringify(parsed)).toBe(JSON.stringify(LEGACY_MODEM_PAYLOAD));
	});

	test('no Phase-B field is defaulted onto a legacy payload', () => {
		const parsed = modemSchema.parse(LEGACY_MODEM_PAYLOAD) as Record<string, unknown>;

		for (const key of [
			'device_class',
			'availability_reason',
			'slot_label',
			'recovery_state',
			'usb_mode',
			'recommended_usb_mode',
			'data_usage',
			'firmware_revision',
			'esim',
			'cell_info',
			'stable_key',
		]) {
			expect(Object.hasOwn(parsed, key)).toBe(false);
		}
	});

	test('a legacy modem LIST parses byte-identically', () => {
		const legacyList = { '0': LEGACY_MODEM_PAYLOAD, '1': LEGACY_MODEM_PAYLOAD };

		expect(JSON.stringify(modemListSchema.parse(legacyList))).toBe(JSON.stringify(legacyList));
	});

	test('the barest possible legacy entry still parses', () => {
		expect(() =>
			modemSchema.parse({
				ifname: 'wwan0',
				name: 'modem',
				network_type: { supported: [], active: null },
			}),
		).not.toThrow();
	});
});

describe('additive Phase-B fields', () => {
	test('a fully-populated Phase-B entry round-trips', () => {
		const full: Modem = {
			...LEGACY_MODEM_PAYLOAD,
			device_class: 'usb',
			availability_reason: 'SIM slot empty',
			slot_label: 'SIM 1',
			recovery_state: 'online',
			usb_mode: 'qmi',
			recommended_usb_mode: 'mbim',
			data_usage: {
				session_bytes: 12_345,
				cycle_bytes: 987_654_321,
				cycle_day: 31,
				threshold_bytes: 10_000_000_000,
			},
			firmware_revision: 'RM530NGLAAR05A01M4G',
			esim: { sim_type: 'physical', esim_status: 'unknown' },
			cell_info: {
				tech: 'nr',
				cell_id: '0x1A2B3C',
				band: 'n78',
				rsrp: -92,
				rsrq: -11,
				sinr: 14.5,
				provenance: { source: 'mmcli', observed_at: 1_760_000_000 },
			},
			stable_key: 'platform-fc880000.usb-usb-0:1.4.1',
		};

		expect(modemSchema.parse(full)).toEqual(full);
	});

	test('data usage requires both cumulative counters and rejects a bad cycle day', () => {
		expect(() => modemDataUsageSchema.parse({ session_bytes: 0, cycle_bytes: 0 })).not.toThrow();
		expect(() => modemDataUsageSchema.parse({ session_bytes: 0 })).toThrow();
		expect(() =>
			modemDataUsageSchema.parse({ session_bytes: 0, cycle_bytes: 0, cycle_day: 0 }),
		).toThrow();
		expect(() =>
			modemDataUsageSchema.parse({ session_bytes: 0, cycle_bytes: 0, cycle_day: 32 }),
		).toThrow();
		expect(() =>
			modemDataUsageSchema.parse({ session_bytes: 0, cycle_bytes: 0, threshold_bytes: -1 }),
		).toThrow();
	});

	test('the EID is never carried on the eSIM wire shape', () => {
		const parsed = modemEsimSchema.parse({
			sim_type: 'esim',
			esim_status: 'with-profiles',
			eid: '89049032005008882600033489102145',
		}) as Record<string, unknown>;

		expect(Object.hasOwn(parsed, 'eid')).toBe(false);
	});

	test('cell info keeps LTE snr and NR sinr as separate keys', () => {
		const parsed = modemCellInfoSchema.parse({ tech: 'lte', snr: 9, sinr: 21 });

		expect(parsed.snr).toBe(9);
		expect(parsed.sinr).toBe(21);
	});
});

describe('deriveModemStableKey', () => {
	test('a USB interface path reduces to its usb_device parent', () => {
		expect(deriveModemStableKey('platform-fc880000.usb-usb-0:1.4.1:1.2')).toBe(
			'platform-fc880000.usb-usb-0:1.4.1',
		);
		expect(deriveModemStableKey('pci-0000:00:14.0-usb-0:2.1:1.0')).toBe(
			'pci-0000:00:14.0-usb-0:2.1',
		);
	});

	test('every interface of one physical unit yields the SAME key', () => {
		const keys = [
			'platform-fc880000.usb-usb-0:1.4.1:1.0',
			'platform-fc880000.usb-usb-0:1.4.1:1.2',
			'platform-fc880000.usb-usb-0:1.4.1:1.3',
		].map(deriveModemStableKey);

		expect(new Set(keys).size).toBe(1);
	});

	test('two units on different ports never collide', () => {
		expect(deriveModemStableKey('platform-fc880000.usb-usb-0:1.4.1:1.2')).not.toBe(
			deriveModemStableKey('platform-fc880000.usb-usb-0:1.4.3:1.2'),
		);
	});

	test('an already-reduced usb_device path is idempotent', () => {
		const parent = 'platform-fc880000.usb-usb-0:1.4.1';

		expect(deriveModemStableKey(parent)).toBe(parent);
		expect(deriveModemStableKey(deriveModemStableKey(parent))).toBe(parent);
	});

	test('a NON-USB path is used verbatim', () => {
		const pcie = 'platform-fc800000.pcie-pci-0000:01:00.0';

		expect(deriveModemStableKey(pcie)).toBe(pcie);
	});

	test('no ID_PATH yields undefined so the field is OMITTED', () => {
		expect(deriveModemStableKey(undefined)).toBeUndefined();
		expect(deriveModemStableKey(null)).toBeUndefined();
		expect(deriveModemStableKey('')).toBeUndefined();
		expect(deriveModemStableKey('   ')).toBeUndefined();
	});

	test('a USB path naming no port chain is left alone rather than truncated', () => {
		expect(deriveModemStableKey('platform-fc880000.usb-usb-0')).toBe('platform-fc880000.usb-usb-0');
	});
});

/**
 * Todo 24's live drill on `ceralive2` (2026-08-18) recorded ONE physical socket
 * described by TWO adapters in TWO encodings at the same instant. The strings
 * below are those payloads verbatim — hardware evidence, not a constructed case.
 */
describe('one socket, two encodings — the todo-24 regression', () => {
	/** What udev-sourced rows published for chassis-C socket 1 (`ID_PATH`). */
	const UDEV_ID_PATH = 'platform-xhci-hcd.0.auto-usb-0:1.4.1';
	/** What the ModemManager row published for the SAME socket (`Modem.Physdev`). */
	const MM_SYSFS_DEVPATH =
		'/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1';

	test('Given the two encodings the board emitted, When each is keyed, Then they resolve to the SAME canonical key', () => {
		expect(deriveModemStableKey(MM_SYSFS_DEVPATH)).toBe(deriveModemStableKey(UDEV_ID_PATH));
		expect(deriveModemStableKey(MM_SYSFS_DEVPATH)).toBe(UDEV_ID_PATH);
	});

	test('Given a sysfs path, When converted, Then it becomes the udev ID_PATH — and the ID_PATH side is untouched', () => {
		expect(sysfsDevpathToIdPath(MM_SYSFS_DEVPATH)).toBe(UDEV_ID_PATH);
		// An ID_PATH is not a sysfs path, so the converter must decline it rather
		// than mangle the encoding everything else already agrees on.
		expect(sysfsDevpathToIdPath(UDEV_ID_PATH)).toBeUndefined();
		expect(canonicalModemIdPath(UDEV_ID_PATH)).toBe(UDEV_ID_PATH);
	});

	test('Given a sysfs path naming an INTERFACE, When keyed, Then it folds onto the same socket', () => {
		expect(deriveModemStableKey(`${MM_SYSFS_DEVPATH}/1-1.4.1:1.2`)).toBe(UDEV_ID_PATH);
		// The kernel's own DEVPATH form carries no `/sys` prefix and is the same path.
		expect(deriveModemStableKey(MM_SYSFS_DEVPATH.slice('/sys'.length))).toBe(UDEV_ID_PATH);
	});

	test('Given a PCIe-hosted controller, When a sysfs path is converted, Then the PCI function names it', () => {
		expect(sysfsDevpathToIdPath('/sys/devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1.4')).toBe(
			'pci-0000:00:14.0-usb-0:1.4',
		);
	});

	test('Given two sysfs paths on DIFFERENT ports, When keyed, Then they never collide', () => {
		const sibling = MM_SYSFS_DEVPATH.replaceAll('1-1.4.1', '1-1.4.3');

		expect(deriveModemStableKey(sibling)).toBe('platform-xhci-hcd.0.auto-usb-0:1.4.3');
		expect(deriveModemStableKey(sibling)).not.toBe(deriveModemStableKey(MM_SYSFS_DEVPATH));
	});

	test('Given a path that names no USB device, When converted, Then nothing is invented', () => {
		expect(sysfsDevpathToIdPath('/sys/devices/platform/fc400000.usb')).toBeUndefined();
		expect(sysfsDevpathToIdPath('/sys/class/net/wwan0')).toBeUndefined();
		expect(sysfsDevpathToIdPath('')).toBeUndefined();
		// A usb chain with no root hub above it cannot name a controller.
		expect(sysfsDevpathToIdPath('/sys/devices/1-1.4.1')).toBeUndefined();
		// …and an unconvertible path keeps whatever the caller observed.
		expect(canonicalModemIdPath('/sys/devices/platform/fc400000.usb')).toBe(
			'/sys/devices/platform/fc400000.usb',
		);
	});
});

describe('setUsbMode input (strict + confirm)', () => {
	const VALID = { device: '0', mode: 'qmi', confirm: true } as const;

	test('a fully-formed confirmed request parses', () => {
		expect(setUsbModeInputSchema.parse(VALID)).toEqual(VALID);
	});

	test('a MISSING confirm is rejected', () => {
		expect(() => setUsbModeInputSchema.parse({ device: '0', mode: 'qmi' })).toThrow();
	});

	test('confirm: false is rejected', () => {
		expect(() => setUsbModeInputSchema.parse({ ...VALID, confirm: false })).toThrow();
	});

	test('a truthy non-literal confirm is rejected', () => {
		expect(() => setUsbModeInputSchema.parse({ ...VALID, confirm: 'true' })).toThrow();
		expect(() => setUsbModeInputSchema.parse({ ...VALID, confirm: 1 })).toThrow();
	});

	test('an unknown extra key is REJECTED, never silently stripped', () => {
		expect(() => setUsbModeInputSchema.parse({ ...VALID, force: true })).toThrow();
	});

	test('an empty device and an unknown mode are rejected', () => {
		expect(() => setUsbModeInputSchema.parse({ ...VALID, device: '' })).toThrow();
		expect(() => setUsbModeInputSchema.parse({ ...VALID, mode: 'usb3' })).toThrow();
	});
});

describe('setUsbMode refusals', () => {
	test('the typed refusal set is exactly its contract members', () => {
		expect([...setUsbModeRefusalSchema.options].sort()).toEqual(
			[
				// The six switch-specific refusals…
				'provisioning_disabled',
				'streaming_active',
				'transition_failed',
				'transition_in_progress',
				'unavailable_in_emulated_mode',
				'uncertified',
				// …plus the shared mutation-safety refusals every mutating modem
				// entrypoint answers. A USB-mode switch is a mutation like any other,
				// and flattening these into `transition_failed` would tell an operator
				// the transaction broke when the device is actually waiting on them.
				'device_decommissioned',
				'mutation_blocked',
				'rebaseline_required',
				'recovery_pending',
			].sort(),
		);
	});

	test('every mutation-safety refusal is reachable from setUsbMode', () => {
		for (const refusal of modemMutationRefusalSchema.options) {
			// `identity_unresolved` and `mutation_in_progress` are the two that map
			// onto this procedure's OWN older vocabulary rather than passing through.
			if (refusal === 'identity_unresolved') continue;
			if (refusal === 'mutation_in_progress') continue;
			expect(setUsbModeRefusalSchema.options).toContain(refusal);
		}
	});

	test('the typed failure-reason set is exactly the five contract members', () => {
		expect([...setUsbModeFailureReasonSchema.options].sort()).toEqual([
			'engine_unavailable',
			'identity_unresolved',
			'postcondition_mismatch',
			'preconditions_refused',
			'transaction_error',
		]);
	});

	test('every refusal is expressible on the output shape', () => {
		for (const error of setUsbModeRefusalSchema.options) {
			expect(setUsbModeOutputSchema.parse({ success: false, error })).toEqual({
				success: false,
				error,
			});
		}
	});

	test('an untyped error string is rejected', () => {
		expect(() => setUsbModeOutputSchema.parse({ success: false, error: 'boom' })).toThrow();
	});

	test('a concurrent transition is its OWN refusal, never the streaming one', () => {
		// The lifecycle interlock has TWO holders and they call for DIFFERENT
		// operator actions: an admission means "stop the stream", another
		// transition means "wait". Collapsing them would give the wrong advice.
		expect(setUsbModeRefusalSchema.options).toContain('transition_in_progress');
		expect(setUsbModeRefusalSchema.options).toContain('streaming_active');
	});

	test('transition_failed carries a typed reason, and the reason is ADDITIVE', () => {
		for (const reason of setUsbModeFailureReasonSchema.options) {
			expect(
				setUsbModeOutputSchema.parse({
					success: false,
					error: 'transition_failed',
					reason,
				}),
			).toEqual({ success: false, error: 'transition_failed', reason });
		}
		expect(setUsbModeOutputSchema.parse({ success: false, error: 'transition_failed' })).toEqual({
			success: false,
			error: 'transition_failed',
		});
	});

	test('an untyped failure reason is rejected', () => {
		expect(() =>
			setUsbModeOutputSchema.parse({
				success: false,
				error: 'transition_failed',
				reason: 'because',
			}),
		).toThrow();
	});
});

describe('shared typed codes', () => {
	test('the cellular-stack init code and the transition refusal are wire-stable', () => {
		expect(CELLULAR_STACK_INITIALIZING).toBe('CELLULAR_STACK_INITIALIZING');
		expect(MODEM_TRANSITION_ACTIVE_ERROR).toBe('modem_transition_active');
	});
});

// REPLACES 'modems.configure — usage-policy WRITE is deferred'. That block locked
// the ABSENCE of these two fields, which was correct only while
// `@ceralive/modem-control` published no setter; the same ground — a legacy input
// still parsing byte-identically — is re-asserted here alongside the tri-state the
// write path now needs.
describe('modems.configure — the usage-policy WRITE fields', () => {
	const BASE = {
		device: '0',
		network_type: '5g4g3g',
		apn: 'internet',
		username: '',
		password: '',
	};

	test('a legacy configure input that mentions neither field is unchanged', () => {
		expect(modemConfigInputSchema.parse(BASE)).toEqual(BASE);
	});

	test('both fields are TRI-STATE — a value, an explicit null, or absent', () => {
		expect(
			modemConfigInputSchema.parse({
				...BASE,
				data_usage_cycle_day: 15,
				data_usage_threshold_bytes: 5_000_000_000,
			}),
		).toMatchObject({
			data_usage_cycle_day: 15,
			data_usage_threshold_bytes: 5_000_000_000,
		});

		expect(
			modemConfigInputSchema.parse({
				...BASE,
				data_usage_cycle_day: null,
				data_usage_threshold_bytes: null,
			}),
		).toMatchObject({
			data_usage_cycle_day: null,
			data_usage_threshold_bytes: null,
		});
	});

	test('a day outside 1-31 or a negative limit is refused at the contract', () => {
		for (const day of [0, 32, 1.5]) {
			expect(modemConfigInputSchema.safeParse({ ...BASE, data_usage_cycle_day: day }).success).toBe(
				false,
			);
		}
		expect(
			modemConfigInputSchema.safeParse({
				...BASE,
				data_usage_threshold_bytes: -1,
			}).success,
		).toBe(false);
	});

	test('the applied echo reports the persisted policy, omitting what is unset', () => {
		const applied = {
			device: '0',
			network_type: '5g4g3g',
			roaming: false,
			network: '',
			autoconfig: true,
			apn: 'internet',
			username: '',
			password: '',
		};
		expect(modemConfigAppliedSchema.parse(applied)).toEqual(applied);
		expect(modemConfigAppliedSchema.parse({ ...applied, data_usage_cycle_day: 15 })).toMatchObject({
			data_usage_cycle_day: 15,
		});
	});

	test('the wire policy block always states its capability', () => {
		expect(modemDataUsagePolicySchema.safeParse({}).success).toBe(false);
		expect(modemDataUsagePolicySchema.parse({ supported: false })).toEqual({ supported: false });
		expect(
			modemDataUsagePolicySchema.parse({
				supported: true,
				cycle_day: 17,
				threshold_bytes: 0,
			}),
		).toEqual({ supported: true, cycle_day: 17, threshold_bytes: 0 });
	});
});

/**
 * Real-hardware regression (2026-08-16, Rock 5B+): `status.connection` is
 * mmcli's `modem.generic.state` verbatim, and the enum carried only five of
 * ModemManager's thirteen states. A Quectel RM530N-GL in the ordinary `enabled`
 * state therefore failed OUTPUT validation, which rejects the WHOLE payload —
 * the operator's Cellular section rendered its empty state while two modems
 * were present and MM-managed.
 */
describe('connection status covers the real ModemManager state space', () => {
	const MM_STATES = [
		'failed',
		'unknown',
		'initializing',
		'locked',
		'disabled',
		'disabling',
		'enabling',
		'enabled',
		'searching',
		'registered',
		'disconnecting',
		'connecting',
		'connected',
	] as const;

	function withState(state: string) {
		return {
			ifname: 'wwan0',
			name: 'RM530N-GL - 16855',
			network_type: { supported: ['5G'], active: '5G' },
			status: { connection: state, network_type: '5G', signal: 0, roaming: false },
		};
	}

	test.each(MM_STATES)('%s parses and survives on the wire', (state) => {
		const parsed = modemSchema.parse(withState(state));

		expect(parsed.status?.connection).toBe(state);
	});

	test("CeraUI's own operator-scan override survives too", () => {
		expect(modemSchema.parse(withState('scanning')).status?.connection).toBe('scanning');
	});

	test('the board payload that used to blank the whole modem list now parses', () => {
		const board = {
			'2': withState('enabled'),
			'4': { ...withState('failed'), name: 'SIMCOM_SIM7600G-H', no_sim: true },
		};

		const parsed = modemListSchema.parse(board);

		expect(Object.keys(parsed)).toEqual(['2', '4']);
		expect(parsed['2']?.status?.connection).toBe('enabled');
		expect(parsed['4']?.no_sim).toBe(true);
	});

	test('an UNRECOGNISED token degrades to `unknown` instead of rejecting the payload', () => {
		const parsed = modemListSchema.parse({
			'2': withState('some-future-mm-state'),
			'4': withState('connected'),
		});

		expect(parsed['2']?.status?.connection).toBe('unknown');
		expect(parsed['4']?.status?.connection).toBe('connected');
	});

	test('the enum itself stays strict — it is the typed contract, not a string', () => {
		expect(connectionStatusSchema.safeParse('some-future-mm-state').success).toBe(false);
		expect(connectionStatusSchema.safeParse('enabled').success).toBe(true);
	});
});

describe('read-only SMS inbox schemas', () => {
	const message = {
		id: '36',
		from: '85573',
		timestamp: '2025-08-21T17:20:16-05',
		text: 'body',
		state: 'received',
	};

	test('a full message round-trips, including an alphanumeric sender', () => {
		expect(smsMessageSchema.parse(message)).toEqual(message);
		expect(smsMessageSchema.parse({ ...message, from: 'CLARO' }).from).toBe('CLARO');
	});

	test('`from` and `timestamp` are optional, and `text` may be empty', () => {
		const parsed = smsMessageSchema.parse({ id: '7', text: '', state: 'stored' });
		expect(parsed.text).toBe('');
		expect(Object.hasOwn(parsed, 'from')).toBe(false);
		expect(Object.hasOwn(parsed, 'timestamp')).toBe(false);
	});

	test('an unrecognised MM state degrades to `unknown` rather than rejecting the inbox', () => {
		expect(smsMessageSchema.parse({ ...message, state: 'teleported' }).state).toBe('unknown');
		expect(smsStateSchema.safeParse('teleported').success).toBe(false);
	});

	test('the output caps the inbox at SMS_INBOX_CAP', () => {
		const atCap = Array.from({ length: SMS_INBOX_CAP }, (_, i) => ({ ...message, id: String(i) }));
		expect(modemSmsOutputSchema.safeParse({ success: true, messages: atCap }).success).toBe(true);
		expect(
			modemSmsOutputSchema.safeParse({ success: true, messages: [...atCap, message] }).success,
		).toBe(false);
	});

	test('a refusal is representable WITHOUT a messages array — never an empty-list lie', () => {
		const refused = modemSmsOutputSchema.parse({ success: false, error: 'unsupported' });
		expect(Object.hasOwn(refused, 'messages')).toBe(false);

		// An empty inbox is a DIFFERENT, equally representable fact.
		const empty = modemSmsOutputSchema.parse({ success: true, messages: [] });
		expect(empty.messages).toEqual([]);
		expect(Object.hasOwn(empty, 'error')).toBe(false);
	});

	test('every refusal token is typed, and nothing else is accepted', () => {
		expect([...modemSmsRefusalSchema.options].sort()).toEqual([
			'not_enabled',
			'read_failed',
			'unknown_modem',
			'unsupported',
		]);
		expect(modemSmsRefusalSchema.safeParse('deleted').success).toBe(false);
	});

	test('the input rejects an empty device selector', () => {
		expect(modemSmsInputSchema.safeParse({ device: '2' }).success).toBe(true);
		expect(modemSmsInputSchema.safeParse({ device: '' }).success).toBe(false);
	});
});
