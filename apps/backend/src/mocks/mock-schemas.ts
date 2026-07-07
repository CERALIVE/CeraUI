/*
	CeraUI - Mock Fixture & State Schemas

	Zod schemas that mirror the runtime shapes the dev-mode mocks stand in for.
	The shipped fixtures in `mock-config.ts` are validated against these at
	`initMockService()` time, so a drifted fixture (e.g. an IMEI of the wrong
	length, a non-IPv4 address, a network_type.active that isn't in the supported
	list) fails loudly in dev instead of silently feeding malformed data into the
	mmcli/nmcli mock providers.

	These schemas are the SINGLE SOURCE OF TRUTH for the mock fixture and
	mock-state types: `mock-config.ts` and `mock-service.ts` re-export the
	`z.infer<...>` types from here, and the fixture literals are pinned with
	`satisfies`, so any drift between a literal and its schema is also a compile
	error.

	Real domain types that a mock value must mirror exactly (encoder resolution /
	framerate) are imported from `@ceraui/rpc` rather than redefined.
*/

import type { RuntimeErrorEvent } from "@ceralive/cerastream";
import {
	AddonDescriptorSchema,
	AddonStateSchema,
	type DeviceModeGroup,
	deviceModeGroupSchema,
	framerateSchema,
	kioskStatusSchema,
	type RelayValidateStage,
	resolutionSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";
import { mockModems, mockWifiNetworks, mockWifiRadios } from "./mock-config.ts";
import { MockAddonDescriptor, MockAddonState } from "./providers/addons.ts";
import { MOCK_DEVICE_STATS } from "./providers/device-stats.ts";
import {
	MOCK_COG_DISPLAY_DESCRIPTOR,
	MOCK_KIOSK_STATUS,
	MOCK_KIOSK_TOKEN,
} from "./providers/kiosk.ts";

// ─── Field-level grammars ────────────────────────────────────────────────────

// IMEI: exactly 15 decimal digits (3GPP TS 23.003 — 14-digit TAC+serial plus a
// trailing Luhn check digit).
const imeiSchema = z
	.string()
	.regex(/^\d{15}$/, "IMEI must be exactly 15 digits");

// ICCID: 19–20 decimal digits (ITU-T E.118 — 18-digit body plus check/pad).
const iccidSchema = z
	.string()
	.regex(/^\d{19,20}$/, "ICCID must be 19–20 digits");

// PLMN operator code: MCC (3 digits) + MNC (2–3 digits) = 5–6 digits.
const operatorCodeSchema = z
	.string()
	.regex(/^\d{5,6}$/, "Operator code must be a 5–6 digit PLMN (MCC+MNC)");

// Dotted-quad IPv4 with each octet bounded to 0–255.
const ipv4Schema = z
	.string()
	.regex(
		/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
		"Must be a dotted-quad IPv4 address",
	);

// Colon-separated 48-bit MAC / BSSID.
const macAddressSchema = z
	.string()
	.regex(
		/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/,
		"Must be a colon-separated 48-bit MAC address",
	);

// ─── Fixture schemas (validated at init) ─────────────────────────────────────

/** Mirrors a `mockModems` entry — the seed for the mmcli mock provider. */
export const mockModemConfigSchema = z
	.object({
		id: z.number().int().nonnegative(),
		model: z.string().min(1),
		manufacturer: z.string().min(1),
		imei: imeiSchema,
		iccid: iccidSchema,
		carrier: z.string().min(1),
		operatorCode: operatorCodeSchema,
		network_type: z.object({
			supported: z.array(z.string().min(1)).min(1),
			active: z.string().min(1),
		}),
		interfaceName: z.string().min(1),
		ip: ipv4Schema,
	})
	.refine((m) => m.network_type.supported.includes(m.network_type.active), {
		message: "network_type.active must be one of network_type.supported",
		path: ["network_type", "active"],
	});
export type MockModemConfig = z.infer<typeof mockModemConfigSchema>;

/** Mirrors a `mockWifiRadios` entry. */
export const mockWifiRadioSchema = z.object({
	device: z.string().min(1),
	ifname: z.string().min(1),
	macAddress: macAddressSchema,
	supports_hotspot: z.boolean(),
});
export type MockWifiRadio = z.infer<typeof mockWifiRadioSchema>;

/** Mirrors a `mockWifiNetworks` entry — the seed for the nmcli scan mock. */
export const mockWifiNetworkSchema = z.object({
	ssid: z.string().min(1),
	bssid: macAddressSchema,
	signal: z.number().min(0).max(100),
	frequency: z.number().int().positive(),
	// Free-form descriptive label (e.g. "WPA2-Personal", "Open") — deliberately
	// NOT the rpc `wifiSecuritySchema` enum, whose token set differs.
	security: z.string().min(1),
	active: z.boolean(),
});
export type MockWifiNetwork = z.infer<typeof mockWifiNetworkSchema>;

/** Mirrors the `getAudioDevices()` map — `displayName → alsaId` (e.g. `{ "RØDE AI-Micro": "rode_ai_micro" }`). */
export const mockAudioDevicesSchema = z.record(
	z.string().min(1),
	z.string().min(1),
);
export type MockAudioDevices = z.infer<typeof mockAudioDevicesSchema>;

/** Mirrors the broadcast `device_modes` map — `input_id → DeviceModeGroup`. Reuses the `@ceraui/rpc` `deviceModeGroupSchema` (single source of truth) so a mock fixture can't drift from the wire shape. */
export const mockDeviceModesSchema = z.record(
	z.string().min(1),
	deviceModeGroupSchema,
);
export type MockDeviceModes = Record<string, DeviceModeGroup>;

// ─── Runtime mock-state schemas ──────────────────────────────────────────────
// These describe the mutable session-state slots seeded by `initMockService`.

/** Per-device WiFi connection state (keyed by device id, e.g. "wlan0"). */
export const mockWifiConnectionStateSchema = z.object({
	activeNetwork: z.string().optional(),
	savedNetworks: z.array(z.string()),
});
export type MockWifiConnectionState = z.infer<
	typeof mockWifiConnectionStateSchema
>;

/** Per-modem mutable config (keyed by modem id string, e.g. "0", "1"). */
export const mockModemConfigStateSchema = z.object({
	apn: z.string().optional(),
	network_type_active: z.string().optional(),
	roaming: z.boolean().optional(),
});
export type MockModemConfigState = z.infer<typeof mockModemConfigStateSchema>;

/** Per-interface mutable netif config (keyed by interface name, e.g. "eth0"). */
export const mockNetifConfigStateSchema = z.object({
	enabled: z.boolean(),
	dhcp: z.boolean(),
	ip: z.string().optional(),
});
export type MockNetifConfigState = z.infer<typeof mockNetifConfigStateSchema>;

/** Encoder config echo — mirrors the fields T11/T13 mutate. */
export const mockEncoderConfigStateSchema = z.object({
	pipeline: z.string().optional(),
	max_br: z.number().optional(),
	bitrate_overlay: z.boolean().optional(),
	resolution: resolutionSchema.optional(),
	framerate: framerateSchema.optional(),
});
export type MockEncoderConfigState = z.infer<
	typeof mockEncoderConfigStateSchema
>;

/** Controllable liveness sources for the stream health rollup (Task 13). */
export const mockHealthStateSchema = z.object({
	processAlive: z.boolean(),
	framesAdvancing: z.boolean(),
	frameCount: z.number().int().nonnegative(),
	reconnecting: z.boolean(),
	reconnectCount: z.number().int().nonnegative(),
	linkCount: z.number().int().nonnegative(),
	activeLinks: z.number().int().nonnegative(),
});
export type MockHealthState = z.infer<typeof mockHealthStateSchema>;

/**
 * SIM lock state the dev-mode mmcli mock reports and the deterministic
 * sim-autounlock / SIM PUK recovery fixtures drive. NOT a real device state:
 *   - `unlocked`   — SIM is ready, nothing blocks bonding.
 *   - `pin-locked` — ModemManager requires `sim-pin` (the auto-unlock target).
 *   - `puk-locked` — ModemManager requires `sim-puk`; a PIN can NOT clear it, so
 *     the auto-unlock surfaces it for the PUK recovery UI and never auto-submits.
 */
export const mockSimLockSchema = z.enum([
	"unlocked",
	"pin-locked",
	"puk-locked",
]);
export type MockSimLock = z.infer<typeof mockSimLockSchema>;

/**
 * Per-modem mock SIM lock state (keyed by modem id string, e.g. "0"). The retry
 * budgets mirror mmcli's `unlock-retries` so the mock mmcli output and the
 * unlock state machine stay faithful to the real `parseModemUnlockInfo` path
 * (PIN typically 3 attempts, PUK typically 10).
 */
export const mockSimStateSchema = z.object({
	lock: mockSimLockSchema,
	pinRetries: z.number().int().min(0).max(3),
	pukRetries: z.number().int().min(0).max(10),
});
export type MockSimState = z.infer<typeof mockSimStateSchema>;

/**
 * Simulated cerastream Tier-2 structured error event (Task 16). Re-exported from
 * the `@ceralive/cerastream` binding's `RuntimeErrorEvent` so the mock injection
 * can never drift from the real wire shape; `null` when nothing is injected.
 */
export type MockStreamErrorState = RuntimeErrorEvent | null;

/**
 * Forced relay.validate network-stage fault (TEST-INFRA ONLY — never egress).
 *
 * Drives the deterministic mock seam in `relay.procedure.ts`: when set, the mock
 * short-circuit fails at the named network stage instead of returning a
 * successful probe. Only the `dns` and `probe` stages are stubbable — the seam
 * sits AFTER the `input`/`protocol`/`endpoint` adapter checks, which always run.
 * `null` when no fault is forced (the default, which yields a successful probe).
 */
export type MockRelayValidateFault = {
	stage: Extract<RelayValidateStage, "dns" | "probe">;
	reason: string;
} | null;

/**
 * Forced policy-route self-check fault (DEV/TEST-INFRA ONLY — never spawns `ip`).
 *
 * Drives the deterministic mock seam in `policy-route-check.ts`: when set, the
 * dev/mock path reports the named interfaces as `policy_route_missing` instead of
 * spawning `ip rule`/`ip route`, so dev/e2e can simulate a missing source rule or
 * an absent default route without a real device. `null` (default) yields no flags.
 */
export type MockPolicyRouteFault = {
	missingIfaces: string[];
} | null;

// Mock kiosk loopback token (DC-3): 64 lowercase hex chars — the 32-byte → hex
// shape `mintKioskToken()` (modules/ui/kiosk-token.ts) emits. `generateMockKioskToken`
// is validated against this so the mock never emits a malformed token.
export const mockKioskTokenSchema = z
	.string()
	.regex(/^[a-f0-9]{64}$/, "Kiosk token must be 64 lowercase hex characters");
export type MockKioskToken = z.infer<typeof mockKioskTokenSchema>;

/**
 * Device-stats mock fixture shape (T3). Mirrors the NON-null variant of the
 * 5-signal `DeviceStatsPayload` (device-stats.ts) — every collector's mock value
 * populated (disk/cpuLoad1/socTemp/ifaceRxTx/raucSlot). The disk-type enum is
 * kept in lock-step with `DiskType`; a drift there is a compile error at the
 * fixture's `satisfies MockDeviceStats` site.
 */
export const mockDeviceStatsSchema = z.object({
	disk: z.object({
		used: z.number().int().nonnegative(),
		total: z.number().int().positive(),
		type: z.enum(["SSD", "HDD", "eMMC", "unknown"]),
	}),
	cpuLoad1: z.number().nonnegative(),
	socTemp: z.number(),
	ifaceRxTx: z.object({
		iface: z.string().min(1),
		rxBytesPerSec: z.number().int().nonnegative(),
		txBytesPerSec: z.number().int().nonnegative(),
	}),
	raucSlot: z.string().min(1),
});
export type MockDeviceStats = z.infer<typeof mockDeviceStatsSchema>;

// ─── Fixture validation ──────────────────────────────────────────────────────

function formatIssues(label: string, error: z.ZodError): string[] {
	return error.issues.map(
		(issue) =>
			`  • ${label}[${issue.path.join(".") || "<root>"}]: ${issue.message}`,
	);
}

/**
 * Validate every shipped mock fixture against its schema. Throws a single,
 * descriptive error listing every drift if any fixture fails.
 *
 * Called from `initMockService()` only — i.e. exclusively on the dev/mock path
 * gated by `isDevelopment()`. It never runs in a production build.
 */
export function validateMockFixtures(): void {
	const errors: string[] = [];

	mockModems.forEach((modem, index) => {
		const result = mockModemConfigSchema.safeParse(modem);
		if (!result.success) {
			errors.push(...formatIssues(`mockModems[${index}]`, result.error));
		}
	});

	mockWifiRadios.forEach((radio, index) => {
		const result = mockWifiRadioSchema.safeParse(radio);
		if (!result.success) {
			errors.push(...formatIssues(`mockWifiRadios[${index}]`, result.error));
		}
	});

	mockWifiNetworks.forEach((network, index) => {
		const result = mockWifiNetworkSchema.safeParse(network);
		if (!result.success) {
			errors.push(...formatIssues(`mockWifiNetworks[${index}]`, result.error));
		}
	});

	// Validate against the real @ceraui/rpc schemas, not a local copy: the
	// descriptor/state shape has one source of truth and must never be duplicated.
	const descriptorResult = AddonDescriptorSchema.safeParse(MockAddonDescriptor);
	if (!descriptorResult.success) {
		errors.push(...formatIssues("MockAddonDescriptor", descriptorResult.error));
	}

	const addonStateResult = AddonStateSchema.safeParse(MockAddonState);
	if (!addonStateResult.success) {
		errors.push(...formatIssues("MockAddonState", addonStateResult.error));
	}

	const kioskTokenResult = mockKioskTokenSchema.safeParse(MOCK_KIOSK_TOKEN);
	if (!kioskTokenResult.success) {
		errors.push(...formatIssues("MOCK_KIOSK_TOKEN", kioskTokenResult.error));
	}

	const kioskStatusResult = kioskStatusSchema.safeParse(MOCK_KIOSK_STATUS);
	if (!kioskStatusResult.success) {
		errors.push(...formatIssues("MOCK_KIOSK_STATUS", kioskStatusResult.error));
	}

	const cogDescriptorResult = AddonDescriptorSchema.safeParse(
		MOCK_COG_DISPLAY_DESCRIPTOR,
	);
	if (!cogDescriptorResult.success) {
		errors.push(
			...formatIssues("MOCK_COG_DISPLAY_DESCRIPTOR", cogDescriptorResult.error),
		);
	}

	const deviceStatsResult = mockDeviceStatsSchema.safeParse(MOCK_DEVICE_STATS);
	if (!deviceStatsResult.success) {
		errors.push(...formatIssues("MOCK_DEVICE_STATS", deviceStatsResult.error));
	}

	if (errors.length > 0) {
		throw new Error(
			`Mock fixture validation failed — a fixture has drifted from its schema:\n${errors.join(
				"\n",
			)}`,
		);
	}
}
