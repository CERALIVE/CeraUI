/**
 * Unit tests for modem-config-echo.ts
 *
 * The predicate is the optimistic-configure confirm signal: a configure is
 * confirmed only when a broadcast `modem` echo proves the device stored what we
 * sent. These cases lock the contracts that matter — a stale/partial echo (wrong
 * active network type, mismatched roaming/network, manual credentials that don't
 * echo) must NOT confirm, while the auto-APN normalisation (blanked OR left-as-
 * sent credentials) still matches.
 */

import { describe, expect, it } from "vitest";

import {
	type ModemConfigEcho,
	type ModemConfigSent,
	modemConfigEchoMatches,
} from "./modem-config-echo";

const sentManual: ModemConfigSent = {
	network_type: "4g",
	roaming: true,
	network: "26201",
	autoconfig: false,
	apn: "internet.provider.com",
	username: "user",
	password: "pass",
};

const echoFor = (
	sent: ModemConfigSent,
	overrides: Partial<ModemConfigEcho["config"]> = {},
	networkTypeActive: string | null = sent.network_type,
): ModemConfigEcho => ({
	networkTypeActive,
	config: {
		apn: sent.apn,
		username: sent.username,
		password: sent.password,
		roaming: sent.roaming,
		network: sent.network,
		autoconfig: sent.autoconfig,
		...overrides,
	},
});

describe("modemConfigEchoMatches — manual APN", () => {
	it("confirms when every stored field echoes what was sent", () => {
		expect(modemConfigEchoMatches(sentManual, echoFor(sentManual))).toBe(true);
	});

	it("does NOT confirm a no-SIM echo with no config", () => {
		expect(
			modemConfigEchoMatches(sentManual, { networkTypeActive: "4g" }),
		).toBe(false);
	});

	it("does NOT confirm while the active network type is still the pre-save value", () => {
		// A connecting→connected cycle re-broadcasts the OLD active type.
		expect(
			modemConfigEchoMatches(sentManual, echoFor(sentManual, {}, "3g")),
		).toBe(false);
	});

	it("does NOT confirm when roaming differs", () => {
		expect(
			modemConfigEchoMatches(
				sentManual,
				echoFor(sentManual, { roaming: false }),
			),
		).toBe(false);
	});

	it("does NOT confirm when the selected network differs", () => {
		expect(
			modemConfigEchoMatches(
				sentManual,
				echoFor(sentManual, { network: "26202" }),
			),
		).toBe(false);
	});

	it("does NOT confirm until the APN credentials echo back", () => {
		expect(
			modemConfigEchoMatches(
				sentManual,
				echoFor(sentManual, { apn: "old.apn" }),
			),
		).toBe(false);
		expect(
			modemConfigEchoMatches(
				sentManual,
				echoFor(sentManual, { password: "old" }),
			),
		).toBe(false);
	});

	it("does NOT confirm a manual config that echoes autoconfig:true", () => {
		expect(
			modemConfigEchoMatches(
				sentManual,
				echoFor(sentManual, {
					autoconfig: true,
					apn: "",
					username: "",
					password: "",
				}),
			),
		).toBe(false);
	});
});

describe("modemConfigEchoMatches — auto APN", () => {
	const sentAuto: ModemConfigSent = {
		network_type: "5g",
		roaming: false,
		network: "",
		autoconfig: true,
		apn: "internet",
		username: "",
		password: "",
	};

	it("confirms when the board blanked the credentials and echoes autoconfig:true", () => {
		expect(
			modemConfigEchoMatches(
				sentAuto,
				echoFor(sentAuto, {
					apn: "",
					username: "",
					password: "",
					autoconfig: true,
				}),
			),
		).toBe(true);
	});

	it("confirms when a board WITHOUT gsm-autoconfig forces autoconfig:false and leaves creds", () => {
		// Real hardware path: applyAutoconfigToModemConfig is skipped, so the echo
		// reports autoconfig off with the credentials left as sent.
		expect(
			modemConfigEchoMatches(
				sentAuto,
				echoFor(sentAuto, { apn: "internet", autoconfig: false }),
			),
		).toBe(true);
	});

	it("still requires the active network type / roaming / network to match", () => {
		expect(modemConfigEchoMatches(sentAuto, echoFor(sentAuto, {}, "4g"))).toBe(
			false,
		);
		expect(
			modemConfigEchoMatches(sentAuto, echoFor(sentAuto, { roaming: true })),
		).toBe(false);
	});
});
