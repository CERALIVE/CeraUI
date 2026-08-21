/**
 * The modem-config save actually lands, and says so when it does not.
 *
 * Every case here reproduces something measured on a live Rock 5B+ board
 * (2026-08-16), where saving an APN through the real UI reported success and
 * changed nothing at the NetworkManager level:
 *
 *  1. `registerModem` created a NEW gsm profile on EVERY registration, even the
 *     pass that had just FOUND one, and re-pointed `config.conn` at it. The
 *     board had accumulated 13 profiles for one SIM in a day, and the one
 *     NetworkManager had activated was none of the ones being written to.
 *  2. With several profiles claiming one (device, SIM) pair, the survivor was
 *     whichever nmcli happened to list last — so the write target was not even
 *     stable between two reads of an unchanged system.
 *  3. Automatic APN was gated on a `setup.json` key no shipped image carries,
 *     so the switch could never be honoured in either direction.
 *  4. `modems.configure` answered `{success: true}` unconditionally, because
 *     the apply was dispatched fire-and-forget.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
	getProbedGsmAutoconfigSupport,
	recordGsmAutoconfigProbe,
	resetGsmAutoconfigProbe,
	resolveGsmAutoconfigSupport,
} from "../modules/modems/gsm-autoconfig.ts";
import { preferGsmConnection } from "../modules/modems/gsm-connections.ts";
import { applyModemConfig } from "../modules/modems/modems.ts";
import {
	getModems,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { setup } from "../modules/setup.ts";

type GsmConnection = Parameters<typeof preferGsmConnection>[0];

function conn(
	uuid: string,
	state: string,
	overrides: Partial<GsmConnection> = {},
): GsmConnection {
	return {
		state,
		uuid,
		deviceId: "b59f0594669e9a71267b592f4bfeff95d5d8f40b",
		simId: "89571017025053051654",
		operatorId: "",
		apn: "internet",
		username: "",
		password: "",
		roaming: true,
		network: "",
		...overrides,
	};
}

function clearModems(): void {
	for (const id of Object.keys(getModems())) {
		removeModem(Number(id));
	}
}

describe("which duplicate profile wins", () => {
	test("the ACTIVATED profile wins, whichever side it is listed on", () => {
		const live = conn("bbb", "activated");
		const idle = conn("aaa", "");

		expect(preferGsmConnection(idle, live).uuid).toBe("bbb");
		expect(preferGsmConnection(live, idle).uuid).toBe("bbb");
	});

	test("an ACTIVATING profile beats every idle one", () => {
		// The board's real state: the Quectel sits in `searching` with the network
		// rejecting it, so its profile never leaves `activating`. Requiring
		// `activated` picked a profile NM was not using — verified live before the
		// rank was widened.
		const activating = conn("ffffffff", "activating");
		const idle = conn("091ca73b", "");

		expect(preferGsmConnection(idle, activating).uuid).toBe("ffffffff");
		expect(preferGsmConnection(activating, idle).uuid).toBe("ffffffff");
	});

	test("an ACTIVATED profile still outranks a merely activating one", () => {
		const activated = conn("ffffffff", "activated");
		const activating = conn("091ca73b", "activating");

		expect(preferGsmConnection(activating, activated).uuid).toBe("ffffffff");
		expect(preferGsmConnection(activated, activating).uuid).toBe("ffffffff");
	});

	test("the board's ACTIVATING roster resolves to the profile NM holds", () => {
		// 14 profiles, the live one is neither first nor lowest-uuid — the exact
		// roster that exposed the activated-only rule.
		const roster = [
			conn("11ab26e2", "activating"),
			conn("3dc47357", ""),
			conn("1d565ed8", ""),
			conn("091ca73b", ""),
			conn("3daeb050", ""),
		];

		const winner = roster.reduce((current, candidate) =>
			preferGsmConnection(current, candidate),
		);

		expect(winner.uuid).toBe("11ab26e2");
	});

	test("with no candidate in use the choice is STABLE, not list order", () => {
		const first = conn("ffff", "");
		const second = conn("aaaa", "");

		expect(preferGsmConnection(first, second).uuid).toBe("aaaa");
		expect(preferGsmConnection(second, first).uuid).toBe("aaaa");
	});

	test("two equally-used profiles still resolve deterministically", () => {
		const a = conn("ffff", "activated");
		const b = conn("aaaa", "activated");

		expect(preferGsmConnection(a, b).uuid).toBe("aaaa");
		expect(preferGsmConnection(b, a).uuid).toBe("aaaa");
	});

	test("the board's real roster resolves to the profile NM activated", () => {
		// The 13 profiles the board carried, in the order nmcli listed them: the
		// activated one (`gsm-1`) is neither first nor last, and its uuid is not
		// the lowest — so only the activated-wins rule finds it.
		const roster = [
			conn("11ab26e2", ""),
			conn("3dc47357", ""),
			conn("1d565ed8", "activated"),
			conn("5f7b3a83", ""),
			conn("bc2299f5", ""),
		];

		const winner = roster.reduce((current, candidate) =>
			preferGsmConnection(current, candidate),
		);

		expect(winner.uuid).toBe("1d565ed8");
	});
});

describe("Automatic APN capability is resolved, not assumed", () => {
	const originalSetup = setup.has_gsm_autoconfig;

	// The probe is a module singleton and `bun test` runs every file in ONE
	// process, so a `true` recorded here would otherwise leak into any later
	// suite that reads the resolver.
	afterAll(() => {
		resetGsmAutoconfigProbe();
	});

	beforeEach(() => {
		resetGsmAutoconfigProbe();
		if (originalSetup === undefined) {
			delete setup.has_gsm_autoconfig;
		} else {
			setup.has_gsm_autoconfig = originalSetup;
		}
	});

	test("an unprobed device does not claim the capability", () => {
		delete setup.has_gsm_autoconfig;

		expect(getProbedGsmAutoconfigSupport()).toBeUndefined();
		expect(resolveGsmAutoconfigSupport()).toBe(false);
	});

	test("a successful probe grants it on a setup.json that says nothing", () => {
		// This IS the shipped board: no `has_gsm_autoconfig` key anywhere in
		// `setup.json`, and a NetworkManager that answers the property fine.
		delete setup.has_gsm_autoconfig;
		recordGsmAutoconfigProbe(true);

		expect(resolveGsmAutoconfigSupport()).toBe(true);
	});

	test("an EXPLICIT setup.json opt-out outranks a successful probe", () => {
		setup.has_gsm_autoconfig = false;
		recordGsmAutoconfigProbe(true);

		expect(resolveGsmAutoconfigSupport()).toBe(false);
	});

	test("an EXPLICIT setup.json opt-in outranks a failed probe", () => {
		setup.has_gsm_autoconfig = true;
		recordGsmAutoconfigProbe(false);

		expect(resolveGsmAutoconfigSupport()).toBe(true);
	});

	test("one failed probe never revokes a capability already proven", () => {
		delete setup.has_gsm_autoconfig;
		recordGsmAutoconfigProbe(true);
		recordGsmAutoconfigProbe(false);

		expect(resolveGsmAutoconfigSupport()).toBe(true);
	});
});

describe("registration never creates a SECOND profile for a found one", () => {
	// `registerModem` is module-private and its collaborators are four separate
	// mmcli/nmcli spawns, so this is a SOURCE lock — the same shape
	// `cellular-boot-order.test.ts` uses for `main.ts`'s ordering. It is exactly
	// the assertion that would have caught the defect: the create call itself was
	// always there, and what was missing was the guard in front of it.
	test("addConnectionForModem is reachable only when no profile was found", async () => {
		const source = await Bun.file(
			new URL("../modules/modems/modem-registration.ts", import.meta.url)
				.pathname,
		).text();

		const callSites = source.match(/await addConnectionForModem\(/g) ?? [];
		expect(callSites.length).toBe(1);

		const guarded =
			/if \(config && !config\.conn\) \{\s*await addConnectionForModem\(/;
		expect(guarded.test(source)).toBe(true);
	});
});

describe("duplicates are reconciled, and deletion needs evidence", () => {
	// SUPERSEDES todo 50's "disarmed, never deleted" lock, by decision rather than
	// by drift. Demotion narrows NetworkManager's race; it does not forbid NM from
	// activating a disarmed profile, and the board proved the consequence — eleven
	// disarmed clones still reading `gsm.home-only: no` under an operator who had
	// disabled roaming. Enforcement (every clone carries the operator's answer) is
	// the guarantee; deletion is now permitted, but only on the positive evidence
	// `classifyGsmDuplicate` demands. Demotion itself is unchanged and still runs.
	test("registration reconciles the clones it did not select", async () => {
		const source = await Bun.file(
			new URL("../modules/modems/modem-registration.ts", import.meta.url)
				.pathname,
		).text();

		expect(source).toContain("reconcileDuplicateGsmProfiles(");
	});

	test("the reconciliation still disarms autoconnect", async () => {
		const source = await Bun.file(
			new URL("../modules/modems/gsm-duplicate-reconcile.ts", import.meta.url)
				.pathname,
		).text();

		expect(source).toContain('"connection.autoconnect": "no"');
	});

	test("nothing is deleted without a decision from the classifier", async () => {
		const source = await Bun.file(
			new URL("../modules/modems/gsm-duplicate-reconcile.ts", import.meta.url)
				.pathname,
		).text();

		const removeCalls = source.match(/deps\.remove\(/g) ?? [];
		expect(removeCalls.length).toBe(1);
		expect(source).toContain('verdicts.get(duplicate.uuid) !== "prune"');
	});
});

describe("a refused save is NAMED, never reported as saved", () => {
	beforeEach(() => {
		clearModems();
	});

	const validMsg = {
		device: 2,
		network_type: "5g",
		roaming: false,
		network: "",
		autoconfig: false,
		apn: "internet",
		username: "",
		password: "",
	};

	test("a modem that is not attached", async () => {
		expect(await applyModemConfig(validMsg)).toEqual({
			ok: false,
			reason: "unknown_modem",
		});
	});

	test("a MISSING id is refused — but id 0 is an ordinary modem", async () => {
		expect(
			await applyModemConfig({
				...validMsg,
				device: undefined as unknown as number,
			}),
		).toEqual({ ok: false, reason: "unknown_modem" });

		// Modem 0 is not attached in this test either, so it reaches the SAME
		// refusal — the point is that it got past the id check to do so, which a
		// falsy `!msg.device` test would not have allowed.
		expect(await applyModemConfig({ ...validMsg, device: 0 })).toEqual({
			ok: false,
			reason: "unknown_modem",
		});
	});

	test("a modem with no NetworkManager profile yet", async () => {
		setModem(2, {
			ifname: "wwan0",
			name: "Quectel",
			sim_network: "Test",
			network_type: { supported: { "5g": { allowed: "5g" } }, active: "5g" },
		});

		expect(await applyModemConfig(validMsg)).toEqual({
			ok: false,
			reason: "unconfigured_modem",
		});
	});

	test("a network type the modem does not support", async () => {
		setModem(2, {
			ifname: "wwan0",
			name: "Quectel",
			sim_network: "Test",
			network_type: { supported: { "4g": { allowed: "4g" } }, active: "4g" },
			config: {
				conn: "1d565ed8",
				autoconfig: false,
				apn: "internet",
				username: "",
				password: "",
				roaming: false,
				network: "",
			},
		});

		expect(await applyModemConfig(validMsg)).toEqual({
			ok: false,
			reason: "unsupported_network_type",
		});
	});

	test("an incomplete configuration", async () => {
		setModem(2, {
			ifname: "wwan0",
			name: "Quectel",
			sim_network: "Test",
			network_type: { supported: { "5g": { allowed: "5g" } }, active: "5g" },
			config: {
				conn: "1d565ed8",
				autoconfig: false,
				apn: "internet",
				username: "",
				password: "",
				roaming: false,
				network: "",
			},
		});

		expect(
			await applyModemConfig({
				...validMsg,
				apn: undefined as unknown as string,
			}),
		).toEqual({ ok: false, reason: "invalid_config" });
	});

	test("an operator that is no longer on offer", async () => {
		setModem(2, {
			ifname: "wwan0",
			name: "Quectel",
			sim_network: "Test",
			network_type: { supported: { "5g": { allowed: "5g" } }, active: "5g" },
			config: {
				conn: "1d565ed8",
				autoconfig: false,
				apn: "internet",
				username: "",
				password: "",
				roaming: false,
				network: "",
			},
		});

		expect(await applyModemConfig({ ...validMsg, network: "21403" })).toEqual({
			ok: false,
			reason: "unavailable_network",
		});
	});
});
