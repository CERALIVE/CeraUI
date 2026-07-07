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
	type StreamSource,
	streamSourceSchema,
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
	type MockAudioDevices,
	type MockDeviceModes,
	type MockKioskToken,
	type MockModemConfig,
	type MockSimState,
	type MockWifiNetwork,
	type MockWifiRadio,
	mockAudioDevicesSchema,
	mockDeviceModesSchema,
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

// Dual USB audio cards: two distinct ALSA card IDs with real product display
// names. Exercises T4's engine-join tier (alsa_card_id match + human-name
// heuristic) and dedupe/auto-follow paths. Seeds the default dev scenario
// (multi-modem-wifi) as well as caps-full/streaming-active.
const DUAL_USB_AUDIO_DEVICES = {
	"RØDE AI-Micro": "rode_ai_micro",
	"Elgato Wave:3": "elgato_wave3",
} satisfies MockAudioDevices;

// Aliased (not forked) so the default and dual maps never drift.
const DEFAULT_AUDIO_DEVICES = DUAL_USB_AUDIO_DEVICES;

// The full-engine-profile per-device modes: an HDMI capture device (1080p@[30,60]
// + 2160p@[30]) and a UVC/USB device (720p@[30,60] + 1080p@[30]). These are the
// FOLDED forms (numeric rung framerates) the getCapabilities() device_modes fold
// produces; the streaming provider expands them back to a list-devices result so
// the fold round-trips to exactly this map.
const DEFAULT_DEVICE_MODES = {
	hdmi: {
		kind: "hdmi",
		modes: [
			{
				width: 1920,
				height: 1080,
				framerates: [30, 60],
				media_type: "video/x-raw",
			},
			{
				width: 3840,
				height: 2160,
				framerates: [30],
				media_type: "video/x-raw",
			},
		],
	},
	usb: {
		kind: "uvc_h264",
		modes: [
			{
				width: 1280,
				height: 720,
				framerates: [30, 60],
				media_type: "video/x-h264",
			},
			{
				width: 1920,
				height: 1080,
				framerates: [30],
				media_type: "video/x-h264",
			},
		],
	},
} satisfies MockDeviceModes;

// The caps-full TWO-DONGLE disambiguation fixture: the default HDMI + RØDE devices
// PLUS a SECOND same-kind (uvc_h264) USB dongle. Two devices bridging to the SAME
// pipeline id (libuvch264) is the case the source list must disambiguate by real
// display name, so caps-full exercises it out of the box.
const CAPS_FULL_DEVICE_MODES = {
	...DEFAULT_DEVICE_MODES,
	usb2: {
		kind: "uvc_h264",
		modes: [
			{
				width: 1920,
				height: 1080,
				framerates: [30, 60],
				media_type: "video/x-h264",
			},
		],
	},
} satisfies MockDeviceModes;

// Realistic per-device display names keyed by list-devices input_id. Consumed ONLY
// by the streaming provider's expandDeviceModes() to name the list-devices result
// (the device_modes fold drops display_name entirely — a group is {kind, modes}).
// The RØDE name is VERBATIM the regression fixture for the USB-as-HDMI mislabel: a
// uvc_h264 USB dongle whose product name contains "HDMI" must NEVER be relabeled
// `hdmi` (the engine's typed kind is authoritative — mapEngineDeviceKind).
export const MOCK_RODE_DISPLAY_NAME = "RØDE HDMI to USB-C: RØDE HDMI";

export const DEFAULT_DEVICE_DISPLAY_NAMES: Record<string, string> = {
	hdmi: "Rockchip HDMI-RX",
	usb: MOCK_RODE_DISPLAY_NAME,
};

export const CAPS_FULL_DEVICE_DISPLAY_NAMES: Record<string, string> = {
	...DEFAULT_DEVICE_DISPLAY_NAMES,
	usb2: "Magewell USB Capture HDMI 4K+",
};

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

/** Build a schema-valid mock audio-device map (defaults = the USB-audio seed). */
export function buildMockAudioDevices(
	overrides: MockAudioDevices = {},
): MockAudioDevices {
	return mockAudioDevicesSchema.parse({
		...DEFAULT_AUDIO_DEVICES,
		...overrides,
	});
}

/** Build the caps-full dual USB audio fixture (RØDE AI-Micro + Elgato Wave:3). */
export function buildMockDualUsbAudioDevices(
	overrides: MockAudioDevices = {},
): MockAudioDevices {
	return mockAudioDevicesSchema.parse({
		...DUAL_USB_AUDIO_DEVICES,
		...overrides,
	});
}

/** Build a schema-valid mock `device_modes` map (defaults = the full-profile HDMI + USB groups). */
export function buildMockDeviceModes(
	overrides: MockDeviceModes = {},
): MockDeviceModes {
	return mockDeviceModesSchema.parse({
		...structuredClone(DEFAULT_DEVICE_MODES),
		...overrides,
	});
}

/** Build the caps-full two-dongle `device_modes` map (HDMI + two same-kind uvc_h264). */
export function buildMockCapsFullDeviceModes(
	overrides: MockDeviceModes = {},
): MockDeviceModes {
	return mockDeviceModesSchema.parse({
		...structuredClone(CAPS_FULL_DEVICE_MODES),
		...overrides,
	});
}

const DEFAULT_STREAM_SOURCE = {
	origin: "capture",
	id: "usb",
	pipelineId: "libuvch264",
	kind: "uvc_h264",
	displayName: MOCK_RODE_DISPLAY_NAME,
	devicePath: "/dev/video1",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
} satisfies StreamSource;

/** Build a schema-valid {@link StreamSource} (defaults = the RØDE capture entry). */
export function buildMockStreamSource(
	overrides: Partial<StreamSource> = {},
): StreamSource {
	return streamSourceSchema.parse({ ...DEFAULT_STREAM_SOURCE, ...overrides });
}
