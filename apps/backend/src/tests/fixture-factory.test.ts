import { describe, expect, test } from "bun:test";
import {
	AddonDescriptorSchema,
	AddonStateSchema,
	relayProviderMetaForId,
} from "@ceraui/rpc/schemas";

import { relayServerSchema } from "../helpers/config-schemas.ts";
import {
	buildMockAddonDescriptor,
	buildMockAddonState,
	buildMockKioskToken,
	buildMockModem,
	buildMockRelay,
	buildMockSimState,
	buildMockWifiNetwork,
	buildMockWifiRadio,
} from "../mocks/fixture-factory.ts";
import {
	mockModems,
	mockWifiNetworks,
	mockWifiRadios,
} from "../mocks/mock-config.ts";
import {
	MOCK_SIM_PIN_RETRIES,
	MOCK_SIM_PUK_RETRIES,
} from "../mocks/mock-constants.ts";
import {
	mockKioskTokenSchema,
	mockModemConfigSchema,
	mockSimStateSchema,
	mockWifiNetworkSchema,
	mockWifiRadioSchema,
} from "../mocks/mock-schemas.ts";
import {
	MockAddonDescriptor,
	MockAddonState,
} from "../mocks/providers/addons.ts";
import { MOCK_KIOSK_TOKEN } from "../mocks/providers/kiosk.ts";
import {
	getMockRelaysCache,
	MOCK_RELAY_SERVER_IDS,
} from "../mocks/providers/relays.ts";

const firstModem = mockModems[0];
const firstRadio = mockWifiRadios[0];
const firstNetwork = mockWifiNetworks[0];
if (!firstModem || !firstRadio || !firstNetwork) {
	throw new Error("expected non-empty shipped mock fixtures");
}

describe("buildMockModem", () => {
	test("default is schema-valid", () => {
		expect(mockModemConfigSchema.safeParse(buildMockModem()).success).toBe(
			true,
		);
	});

	test("default matches the pristine mockModems[0]", () => {
		expect(buildMockModem()).toEqual(firstModem);
	});

	test("overrides apply on top of the defaults", () => {
		const modem = buildMockModem({
			id: 1,
			carrier: "AT&T",
			network_type: { supported: ["4g"], active: "4g" },
		});
		expect(modem.id).toBe(1);
		expect(modem.carrier).toBe("AT&T");
		expect(modem.network_type).toEqual({ supported: ["4g"], active: "4g" });
		expect(modem.manufacturer).toBe(firstModem.manufacturer);
	});

	test("throws on an invalid override (bad IMEI length)", () => {
		expect(() => buildMockModem({ imei: "12345" })).toThrow();
	});

	test("throws when network_type.active is not in supported", () => {
		expect(() =>
			buildMockModem({ network_type: { supported: ["4g"], active: "5g" } }),
		).toThrow();
	});
});

describe("buildMockWifiRadio", () => {
	test("default is schema-valid and matches mockWifiRadios[0]", () => {
		expect(mockWifiRadioSchema.safeParse(buildMockWifiRadio()).success).toBe(
			true,
		);
		expect(buildMockWifiRadio()).toEqual(firstRadio);
	});

	test("overrides apply", () => {
		const radio = buildMockWifiRadio({
			device: "wlan1",
			ifname: "wlan1",
			macAddress: "dc:a6:32:12:34:58",
			supports_hotspot: false,
		});
		expect(radio.device).toBe("wlan1");
		expect(radio.supports_hotspot).toBe(false);
	});

	test("throws on an invalid MAC address", () => {
		expect(() => buildMockWifiRadio({ macAddress: "not-a-mac" })).toThrow();
	});
});

describe("buildMockWifiNetwork", () => {
	test("default is schema-valid and matches mockWifiNetworks[0]", () => {
		expect(
			mockWifiNetworkSchema.safeParse(buildMockWifiNetwork()).success,
		).toBe(true);
		expect(buildMockWifiNetwork()).toEqual(firstNetwork);
	});

	test("overrides apply", () => {
		const network = buildMockWifiNetwork({
			ssid: "CoffeeShop_5G",
			signal: 68,
			active: false,
		});
		expect(network.ssid).toBe("CoffeeShop_5G");
		expect(network.signal).toBe(68);
		expect(network.active).toBe(false);
	});

	test("throws on an out-of-range signal", () => {
		expect(() => buildMockWifiNetwork({ signal: 150 })).toThrow();
	});
});

describe("buildMockRelay", () => {
	test("default is schema-valid", () => {
		expect(relayServerSchema.safeParse(buildMockRelay()).success).toBe(true);
	});

	test("the CeraLive-tagged US-East server reproduces from the builder", () => {
		const usEast = getMockRelaysCache().servers[MOCK_RELAY_SERVER_IDS.US_EAST];
		const built = buildMockRelay({
			provider: relayProviderMetaForId("ceralive"),
		});
		expect(built).toEqual(usEast);
	});

	test("overrides reproduce the default-marked EU-West server", () => {
		const euWest = getMockRelaysCache().servers[MOCK_RELAY_SERVER_IDS.EU_WEST];
		const built = buildMockRelay({
			name: "EU-West (Primary)",
			addr: "relay-eu-west.example.com",
			default: true,
			bcrp_port: "2002",
			provider: relayProviderMetaForId("ceralive"),
		});
		expect(built).toEqual(euWest);
	});

	test("throws on an out-of-range port", () => {
		expect(() => buildMockRelay({ port: 70000 })).toThrow();
	});
});

describe("buildMockAddonDescriptor", () => {
	test("default is schema-valid and matches MockAddonDescriptor", () => {
		expect(
			AddonDescriptorSchema.safeParse(buildMockAddonDescriptor()).success,
		).toBe(true);
		expect(buildMockAddonDescriptor()).toEqual(MockAddonDescriptor);
	});

	test("overrides apply", () => {
		const descriptor = buildMockAddonDescriptor({
			id: "other-addon",
			version: "2.0.0",
		});
		expect(descriptor.id).toBe("other-addon");
		expect(descriptor.version).toBe("2.0.0");
		expect(descriptor.category).toBe(MockAddonDescriptor.category);
	});

	test("returns an independent clone of the fixture", () => {
		const built = buildMockAddonDescriptor();
		built.artifact.sha256 = "b".repeat(64);
		expect(MockAddonDescriptor.artifact.sha256).toBe("a".repeat(64));
	});

	test("throws on an invalid version", () => {
		expect(() => buildMockAddonDescriptor({ version: "not-semver" })).toThrow();
	});
});

describe("buildMockAddonState", () => {
	test("default is schema-valid and matches MockAddonState", () => {
		expect(AddonStateSchema.safeParse(buildMockAddonState()).success).toBe(
			true,
		);
		expect(buildMockAddonState()).toEqual(MockAddonState);
	});

	test("overrides apply", () => {
		const state = buildMockAddonState({ enabled: false, phase: "idle" });
		expect(state.enabled).toBe(false);
		expect(state.phase).toBe("idle");
	});

	test("throws on an invalid phase", () => {
		expect(() => buildMockAddonState({ phase: "bogus" as never })).toThrow();
	});
});

describe("buildMockKioskToken", () => {
	test("default is the deterministic pristine token and is schema-valid", () => {
		expect(buildMockKioskToken()).toBe(MOCK_KIOSK_TOKEN);
		expect(mockKioskTokenSchema.safeParse(buildMockKioskToken()).success).toBe(
			true,
		);
	});

	test("override returns the provided token", () => {
		const token = "f".repeat(64);
		expect(buildMockKioskToken(token)).toBe(token);
	});

	test("throws on a malformed token", () => {
		expect(() => buildMockKioskToken("tooshort")).toThrow();
	});
});

describe("buildMockSimState", () => {
	test("default is schema-valid and matches the unlocked seed", () => {
		expect(mockSimStateSchema.safeParse(buildMockSimState()).success).toBe(
			true,
		);
		expect(buildMockSimState()).toEqual({
			lock: "unlocked",
			pinRetries: MOCK_SIM_PIN_RETRIES,
			pukRetries: MOCK_SIM_PUK_RETRIES,
		});
	});

	test("overrides apply", () => {
		const sim = buildMockSimState({ lock: "pin-locked", pinRetries: 2 });
		expect(sim.lock).toBe("pin-locked");
		expect(sim.pinRetries).toBe(2);
		expect(sim.pukRetries).toBe(MOCK_SIM_PUK_RETRIES);
	});

	test("throws when pinRetries exceeds the budget", () => {
		expect(() => buildMockSimState({ pinRetries: 5 })).toThrow();
	});
});
