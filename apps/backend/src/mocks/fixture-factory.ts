/*
	CeraUI - Mock Fixture Factory (parameterized builders)

	One typed builder per mock domain object. Each builder merges its sensible
	defaults with a caller's overrides and then runs the result through the SAME
	Zod schema that validates the shipped fixtures (Task 3 — mock-schemas.ts), so
	a builder can NEVER hand back a malformed object: an out-of-range signal, a
	bad IMEI, an unknown SIM-lock state all throw at the build site instead of
	leaking into the mmcli/nmcli/relay providers.

	Defaults mirror the pristine scenario seed — the modem / wifi / radio defaults
	equal `mockModems[0]` / `mockWifiRadios[0]` / `mockWifiNetworks[0]`; the SIM
	default equals the per-modem unlocked seed `initMockService` writes; the relay
	default equals a plain (non-default) relay-server entry; the add-on and kiosk
	defaults reuse the canonical Task 13/14 fixtures. Tests assert these against
	the shipped fixtures so any future drift fails loudly.

	The factory is a runtime leaf of the mock graph: it imports schemas + fixture
	defaults but is imported only by runtime call sites (providers/relays.ts,
	mock-service.ts) and the test suite — never by mock-config.ts or the schema
	modules — so it introduces no module cycle into the mock-schemas ⇄ mock-config
	edge that Task 3 deliberately kept one-directional.
*/

import {
	type AddonDescriptor,
	AddonDescriptorSchema,
	type AddonState,
	AddonStateSchema,
} from "@ceraui/rpc/schemas";

import {
	type RelayServer,
	relayServerSchema,
} from "../helpers/config-schemas.ts";
import {
	MOCK_SIM_PIN_RETRIES,
	MOCK_SIM_PUK_RETRIES,
} from "./mock-constants.ts";
import {
	type MockKioskToken,
	type MockModemConfig,
	type MockSimState,
	type MockWifiNetwork,
	type MockWifiRadio,
	mockKioskTokenSchema,
	mockModemConfigSchema,
	mockSimStateSchema,
	mockWifiNetworkSchema,
	mockWifiRadioSchema,
} from "./mock-schemas.ts";
import { MockAddonDescriptor, MockAddonState } from "./providers/addons.ts";
import { MOCK_KIOSK_TOKEN } from "./providers/kiosk.ts";

// ─── Pristine defaults ───────────────────────────────────────────────────────
// Independent literals (NOT a reference to the shipped arrays) so the factory
// test can assert default === shipped-fixture and catch drift in either copy.

const DEFAULT_MODEM = {
	id: 0,
	model: "RM520N-GL",
	manufacturer: "Quectel",
	imei: "867034057012345",
	iccid: "89014103211118510720",
	carrier: "T-Mobile",
	operatorCode: "310260",
	network_type: { supported: ["5g", "4g", "3g"], active: "5g" },
	interfaceName: "usb0",
	ip: "10.0.0.2",
} satisfies MockModemConfig;

const DEFAULT_WIFI_RADIO = {
	device: "wlan0",
	ifname: "wlan0",
	macAddress: "dc:a6:32:12:34:57",
	supports_hotspot: true,
} satisfies MockWifiRadio;

const DEFAULT_WIFI_NETWORK = {
	ssid: "HomeNetwork",
	bssid: "AA:BB:CC:DD:EE:01",
	signal: 92,
	frequency: 5180,
	security: "WPA2-Personal",
	active: true,
} satisfies MockWifiNetwork;

const DEFAULT_RELAY = {
	type: "srt",
	name: "US-East",
	addr: "relay-us-east.example.com",
	port: 2001,
} satisfies RelayServer;

const DEFAULT_SIM_STATE = {
	lock: "unlocked",
	pinRetries: MOCK_SIM_PIN_RETRIES,
	pukRetries: MOCK_SIM_PUK_RETRIES,
} satisfies MockSimState;

// ─── Builders ────────────────────────────────────────────────────────────────

/** Build a schema-valid mock modem config (defaults = `mockModems[0]`). */
export function buildMockModem(
	overrides: Partial<MockModemConfig> = {},
): MockModemConfig {
	return mockModemConfigSchema.parse({ ...DEFAULT_MODEM, ...overrides });
}

/** Build a schema-valid mock WiFi radio (defaults = `mockWifiRadios[0]`). */
export function buildMockWifiRadio(
	overrides: Partial<MockWifiRadio> = {},
): MockWifiRadio {
	return mockWifiRadioSchema.parse({ ...DEFAULT_WIFI_RADIO, ...overrides });
}

/** Build a schema-valid mock WiFi network (defaults = `mockWifiNetworks[0]`). */
export function buildMockWifiNetwork(
	overrides: Partial<MockWifiNetwork> = {},
): MockWifiNetwork {
	return mockWifiNetworkSchema.parse({ ...DEFAULT_WIFI_NETWORK, ...overrides });
}

/** Build a schema-valid mock relay-server entry (defaults = a plain SRT server). */
export function buildMockRelay(
	overrides: Partial<RelayServer> = {},
): RelayServer {
	return relayServerSchema.parse({ ...DEFAULT_RELAY, ...overrides });
}

/** Build a schema-valid mock add-on descriptor (defaults = `MockAddonDescriptor`). */
export function buildMockAddonDescriptor(
	overrides: Partial<AddonDescriptor> = {},
): AddonDescriptor {
	return AddonDescriptorSchema.parse({
		...structuredClone(MockAddonDescriptor),
		...overrides,
	});
}

/** Build a schema-valid mock add-on runtime state (defaults = `MockAddonState`). */
export function buildMockAddonState(
	overrides: Partial<AddonState> = {},
): AddonState {
	return AddonStateSchema.parse({
		...structuredClone(MockAddonState),
		...overrides,
	});
}

/**
 * Build a schema-valid kiosk loopback token. Defaults to the deterministic
 * `MOCK_KIOSK_TOKEN`; pass a token string to override (validated as 64 lowercase
 * hex characters — an out-of-contract value throws).
 */
export function buildMockKioskToken(override?: string): MockKioskToken {
	return mockKioskTokenSchema.parse(override ?? MOCK_KIOSK_TOKEN);
}

/** Build a schema-valid per-modem SIM state (defaults = the unlocked seed). */
export function buildMockSimState(
	overrides: Partial<MockSimState> = {},
): MockSimState {
	return mockSimStateSchema.parse({ ...DEFAULT_SIM_STATE, ...overrides });
}
