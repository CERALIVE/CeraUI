/**
 * The operator's roaming choice cannot be overridden by a duplicate profile.
 *
 * Board-measured on a Quectel RM530N-GL (192.168.78.132, 2026-08-16): ONE SIM,
 * FOURTEEN NetworkManager gsm profiles (`gsm`, `gsm-1`..`gsm-13`), every one of
 * them carrying the identical `gsm.device-id`/`gsm.sim-id` pair NetworkManager
 * matches a modem on — and ELEVEN of them still reading `gsm.home-only: no`
 * while the operator had roaming DISABLED. `gsm.home-only` becomes the bearer's
 * allow-roaming flag at ModemManager's `Simple.Connect`, so any path that
 * activated one of those eleven would have registered a roaming session with no
 * error, no notification, and a UI still reporting the value of the ONE profile
 * CeraUI had written.
 *
 * Todo 50 fixed WHICH profile a save writes to and disarmed the rest; that
 * narrows the race without closing it, because nothing forbids NetworkManager
 * from activating a disarmed profile (an explicit `nmcli connection up <uuid>`,
 * an autoconnect-priority change, a boot-time reconnect). The guarantee has to
 * come from the profiles AGREEING, not from predicting which one wins — so
 * enforcement is the load-bearing half here and the deletion of provably
 * abandoned duplicates is hygiene layered on top of it.
 */

import { describe, expect, test } from "bun:test";
import {
	classifyGsmDuplicate,
	type GsmProfileAudit,
	type GsmReconcileDeps,
	reconcileDuplicateGsmProfiles,
} from "../modules/modems/gsm-duplicate-reconcile.ts";
import {
	applyModemConfig,
	type ModemApplyDeps,
} from "../modules/modems/modems.ts";
import {
	getModems,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import type { NetworkManagerConnectionModemConfig } from "../modules/network/network-manager.ts";

const DEVICE_ID = "b59f0594669e9a71267b592f4bfeff95d5d8f40b";
const SIM_ID = "89571017025053051654";
const KEEP = "091ca73b-9f75-42bd-a737-2c447ca44533";

function audit(over: Partial<GsmProfileAudit> = {}): GsmProfileAudit {
	return {
		uuid: "11ab26e2-7951-433f-97e1-ad8c4a98076f",
		deviceId: DEVICE_ID,
		simId: SIM_ID,
		state: "",
		autoconnect: "no",
		timestamp: "0",
		...over,
	};
}

/** Roaming DISABLED, as `sanitizeModemConfigForNetworkManager` renders it. */
const ROAMING_OFF: NetworkManagerConnectionModemConfig = {
	"gsm.apn": "internet",
	"gsm.username": "",
	"gsm.password": "",
	"gsm.password-flags": "4",
	"gsm.home-only": "yes",
	"gsm.network-id": "",
	"gsm.auto-config": "no",
};

type Recorder = {
	readonly deps: GsmReconcileDeps;
	readonly writes: Array<{ uuid: string; fields: Record<string, string> }>;
	readonly deletes: string[];
	readonly journal: string[];
};

function recorder(
	audits: Array<GsmProfileAudit>,
	over: Partial<GsmReconcileDeps> = {},
): Recorder {
	const writes: Array<{ uuid: string; fields: Record<string, string> }> = [];
	const deletes: string[] = [];
	const journal: string[] = [];
	return {
		writes,
		deletes,
		journal,
		deps: {
			audit: async () => audits,
			setFields: async (uuid, fields) => {
				writes.push({ uuid, fields });
				journal.push(`set:${uuid}`);
				return true;
			},
			remove: async (uuid) => {
				deletes.push(uuid);
				journal.push(`del:${uuid}`);
				return true;
			},
			...over,
		},
	};
}

describe("a duplicate may be DELETED only on positive evidence", () => {
	test("the selected profile is never a deletion candidate", () => {
		expect(classifyGsmDuplicate(audit({ uuid: KEEP }), KEEP)).toBe("keep");
	});

	test("an abandoned clone — disarmed, detached, never activated — is prunable", () => {
		expect(classifyGsmDuplicate(audit(), KEEP)).toBe("prune");
	});

	test("a profile NetworkManager is holding is retained", () => {
		expect(classifyGsmDuplicate(audit({ state: "activated" }), KEEP)).toBe(
			"retain",
		);
		// `activating` is the state this bench's rejected modem sits in for hours;
		// it is still NM holding the profile.
		expect(classifyGsmDuplicate(audit({ state: "activating" }), KEEP)).toBe(
			"retain",
		);
	});

	test("an ARMED clone is retained — it has never been through our hands", () => {
		expect(classifyGsmDuplicate(audit({ autoconnect: "yes" }), KEEP)).toBe(
			"retain",
		);
	});

	test("a profile NetworkManager has activated before is retained", () => {
		expect(classifyGsmDuplicate(audit({ timestamp: "1786937361" }), KEEP)).toBe(
			"retain",
		);
	});

	test("an unreadable timestamp retains — a failed read is not evidence", () => {
		expect(classifyGsmDuplicate(audit({ timestamp: "" }), KEEP)).toBe("retain");
		expect(classifyGsmDuplicate(audit({ timestamp: "--" }), KEEP)).toBe(
			"retain",
		);
	});
});

describe("every profile bound to this SIM carries the operator's answer", () => {
	test("the board's own 14 profiles all end up with roaming disabled", async () => {
		// The bench state verbatim: 11 roaming-allowed clones, 2 already-correct
		// clones, and the selected profile.
		const clones = Array.from({ length: 13 }, (_, i) =>
			audit({ uuid: `dup-${i}` }),
		);
		const rec = recorder([audit({ uuid: KEEP }), ...clones]);

		const result = await reconcileDuplicateGsmProfiles(
			DEVICE_ID,
			SIM_ID,
			KEEP,
			ROAMING_OFF,
			rec.deps,
		);

		expect(result.duplicates).toBe(13);
		expect(result.enforced).toBe(13);
		for (const clone of clones) {
			const write = rec.writes.find(
				(w) => w.uuid === clone.uuid && "gsm.home-only" in w.fields,
			);
			expect(write?.fields["gsm.home-only"]).toBe("yes");
		}
		// The selected profile is written by `applyModemConfig` itself; the
		// reconciler must not write it a second time.
		expect(rec.writes.some((w) => w.uuid === KEEP)).toBe(false);
	});

	test("enforcement lands before any deletion, so a failed prune costs nothing", async () => {
		const rec = recorder([audit({ uuid: KEEP }), audit({ uuid: "dup-0" })]);

		await reconcileDuplicateGsmProfiles(
			DEVICE_ID,
			SIM_ID,
			KEEP,
			ROAMING_OFF,
			rec.deps,
		);

		expect(rec.journal.indexOf("set:dup-0")).toBeLessThan(
			rec.journal.indexOf("del:dup-0"),
		);
	});

	test("a prune that fails still leaves the duplicate carrying the right values", async () => {
		const rec = recorder([audit({ uuid: KEEP }), audit({ uuid: "dup-0" })], {
			remove: async () => false,
		});

		const result = await reconcileDuplicateGsmProfiles(
			DEVICE_ID,
			SIM_ID,
			KEEP,
			ROAMING_OFF,
			rec.deps,
		);

		expect(result.pruned).toBe(0);
		expect(result.retained).toBe(1);
		expect(rec.writes[0]?.fields["gsm.home-only"]).toBe("yes");
	});

	test("an armed clone is enforced and disarmed, but NOT deleted on the same pass", async () => {
		const rec = recorder([
			audit({ uuid: KEEP }),
			audit({ uuid: "armed", autoconnect: "yes" }),
		]);

		const result = await reconcileDuplicateGsmProfiles(
			DEVICE_ID,
			SIM_ID,
			KEEP,
			ROAMING_OFF,
			rec.deps,
		);

		expect(result.enforced).toBe(1);
		expect(result.demoted).toBe(1);
		expect(result.pruned).toBe(0);
		expect(rec.deletes).toEqual([]);
		expect(
			rec.writes.some((w) => w.fields["connection.autoconnect"] === "no"),
		).toBe(true);
	});

	test("a profile for a DIFFERENT SIM is neither written nor deleted", async () => {
		const rec = recorder([
			audit({ uuid: KEEP }),
			audit({ uuid: "other-sim", simId: "89000000000000000000" }),
			audit({ uuid: "other-device", deviceId: "deadbeef" }),
		]);

		const result = await reconcileDuplicateGsmProfiles(
			DEVICE_ID,
			SIM_ID,
			KEEP,
			ROAMING_OFF,
			rec.deps,
		);

		expect(result.duplicates).toBe(0);
		expect(rec.writes).toEqual([]);
		expect(rec.deletes).toEqual([]);
	});

	test("a consolidated modem costs no writes at all", async () => {
		const rec = recorder([audit({ uuid: KEEP })]);

		const result = await reconcileDuplicateGsmProfiles(
			DEVICE_ID,
			SIM_ID,
			KEEP,
			ROAMING_OFF,
			rec.deps,
		);

		expect(result).toEqual({
			duplicates: 0,
			enforced: 0,
			demoted: 0,
			pruned: 0,
			retained: 0,
		});
		expect(rec.journal).toEqual([]);
	});

	test("an unidentifiable modem reconciles nothing rather than guessing", async () => {
		const rec = recorder([audit({ uuid: "dup-0" })]);

		expect(
			await reconcileDuplicateGsmProfiles(
				"",
				SIM_ID,
				KEEP,
				ROAMING_OFF,
				rec.deps,
			),
		).toMatchObject({ duplicates: 0 });
		expect(rec.journal).toEqual([]);
	});
});

const SAVED_MSG = {
	device: 2,
	network_type: "4g3g",
	roaming: false,
	network: "",
	autoconfig: false,
	apn: "internet",
	username: "",
	password: "",
};

function seedModem(roaming: boolean): void {
	for (const id of Object.keys(getModems())) removeModem(Number(id));
	setModem(2, {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		sim_network: "Movistar",
		network_type: {
			supported: { "4g3g": { allowed: "3g|4g", preferred: "4g" } },
			active: "4g3g",
		},
		config: {
			conn: KEEP,
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming,
			network: "",
		},
	});
}

type ApplySpy = {
	readonly deps: ModemApplyDeps;
	readonly journal: string[];
};

function applySpy(over: Partial<ModemApplyDeps> = {}): ApplySpy {
	const journal: string[] = [];
	return {
		journal,
		deps: {
			writeConnection: async (uuid) => {
				journal.push(`write:${uuid}`);
				return true;
			},
			readConnectionHold: async () => "held",
			enforceAcrossProfiles: async (uuid) => {
				journal.push(`enforce:${uuid}`);
				return 13;
			},
			disconnect: async (uuid) => {
				journal.push(`down:${uuid}`);
				return true;
			},
			setNetworkTypes: async () => true,
			autoconfigSupported: () => true,
			...over,
		},
	};
}

describe("the save path itself fans the operator's answer out", () => {
	test("disabling roaming enforces across duplicates BEFORE the reconnect", async () => {
		seedModem(true);
		const spy = applySpy();

		expect(await applyModemConfig(SAVED_MSG, spy.deps)).toEqual({
			ok: true,
			reconnected: true,
		});

		expect(spy.journal).toEqual([
			`write:${KEEP}`,
			`enforce:${KEEP}`,
			`down:${KEEP}`,
		]);
	});

	test("a save that changes nothing still re-asserts the answer everywhere", async () => {
		// The reconnect is correctly skipped (todo 57) — but a duplicate that
		// drifted since the last save is exactly what this todo exists for, and
		// re-asserting costs no bearer interruption.
		seedModem(false);
		const spy = applySpy();

		expect(await applyModemConfig(SAVED_MSG, spy.deps)).toEqual({
			ok: true,
			reconnected: false,
		});

		expect(spy.journal).toEqual([`write:${KEEP}`, `enforce:${KEEP}`]);
	});

	test("a FAILED write enforces nothing — there is no answer to spread", async () => {
		seedModem(true);
		const spy = applySpy({ writeConnection: async () => false });

		expect(await applyModemConfig(SAVED_MSG, spy.deps)).toEqual({
			ok: false,
			reason: "write_failed",
		});

		expect(spy.journal.some((e) => e.startsWith("enforce:"))).toBe(false);
	});
});
