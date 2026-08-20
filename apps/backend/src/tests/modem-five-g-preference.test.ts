/**
 * The `five-g-pref` capability module, end to end.
 *
 * Four guarantees, and the middle two are why this suite exists rather than a
 * pure-derivation test alone:
 *
 *   1. THE MODEL — which postures a radio advertised, which pair each one writes,
 *      and which posture a live pair names. `prefer-5g` and `prefer-4g` share an
 *      allowed set, so every rule that could be tempted to compare allowed sets is
 *      exercised against BOTH.
 *   2. THE GATE — off by default, capability-gated on top of that, and the read
 *      block ABSENT from the wire until the claim is surfaceable.
 *   3. A REFUSED WRITE IS NEVER A SUCCESS. This is the exact defect class
 *      `apps/backend/AGENTS.md` records for the sibling network-type selector: a
 *      `mmSetNetworkTypes` answering `false`/`undefined` was dropped on the floor
 *      while the configure-echo parroted the REQUEST, so a rejected mode reached
 *      the operator as "Saved" with the rejected value selected. Every failure arm
 *      below asserts BOTH a typed answer AND that `success` is false.
 *   4. RESTORATION — the journaled pre-state is the radio's OWN previous pair, and
 *      the registered rollback puts it back and PROVES it did.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig } from "../modules/config.ts";
import { initModemCapabilityEvidence } from "../modules/modems/capability-evidence.ts";
import { setModemCapabilityEvidenceReader } from "../modules/modems/capability-gates.ts";
import {
	applyFiveGPreference,
	createFiveGRollbackHandler,
	type FiveGApplyDeps,
	resolveModemIndex,
} from "../modules/modems/five-g-apply.ts";
import {
	buildFiveGPreferenceView,
	fiveGPreferenceEvidence,
	fiveGPreferenceToModes,
	offeredFiveGPreferences,
	readFiveGPreference,
} from "../modules/modems/five-g-preference.ts";
import type { NetworkType } from "../modules/modems/mmcli.ts";
import { buildModemsWireMessage } from "../modules/modems/modem-status.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import {
	getModems,
	type Modem,
	setModem,
} from "../modules/modems/modems-state.ts";
import {
	listMutationEntries,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { beginModemMutation } from "../modules/modems/mutation-lease.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";

const IFNAME = "wwan0";
const ID_PATH = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const KEY = ID_PATH;

/**
 * The bench Quectel RM530N-GL's real catalog shape (todo 2, `ceralive2`): a 5G
 * radio with full sub-5G fallback. The rows are the mmcli `supported-modes`
 * spellings, unfolded — note the TWO rows that share `5g|4g` and differ only in
 * `preferred`, which is precisely what the label-keyed map collapses.
 */
const QUECTEL_CATALOG: Modem["radio_modes"] = {
	supported: [
		{ allowed: "2g", preferred: "none" },
		{ allowed: "3g", preferred: "none" },
		{ allowed: "4g", preferred: "none" },
		{ allowed: "5g", preferred: "none" },
		{ allowed: "5g|4g", preferred: "5g" },
		{ allowed: "5g|4g", preferred: "4g" },
		{ allowed: "5g|4g|3g|2g", preferred: "5g" },
	],
	current: { allowed: "5g|4g|3g|2g", preferred: "5g" },
};

/** The bench SIMCom SIM7600G-H — LTE-max, no 5G anywhere in the catalog. */
const SIMCOM_CATALOG: Modem["radio_modes"] = {
	supported: [
		{ allowed: "2g", preferred: "none" },
		{ allowed: "3g", preferred: "none" },
		{ allowed: "4g", preferred: "none" },
		{ allowed: "4g|3g|2g", preferred: "4g" },
	],
	current: { allowed: "4g|3g|2g", preferred: "4g" },
};

let journalDir = "";

function seedModem(radioModes: Modem["radio_modes"]): Modem {
	const modem: Modem = {
		ifname: IFNAME,
		name: "QUECTEL Broadband Module",
		sim_network: "",
		network_type: { supported: {}, active: "5g4g3g2g" },
		status: {
			connection: "connected",
			network: "Movistar",
			network_type: "5G",
			signal: 72,
			roaming: false,
		},
		...(radioModes === undefined ? {} : { radio_modes: radioModes }),
	};
	setModem(0, modem);
	return modem;
}

function enableGate(): void {
	getConfig().modem_capabilities = { five_g_pref: true };
}

function capable(): void {
	setModemCapabilityEvidenceReader(() => ({
		capability: { "five-g-pref": "present" },
	}));
}

/** A scripted device: records every write and answers a scripted readback. */
function scriptedDevice(options: {
	readonly wrote?: boolean | undefined;
	readonly landsOn?: NetworkType | undefined;
	readonly readbackFails?: boolean;
}) {
	const writes: NetworkType[] = [];
	const deps: FiveGApplyDeps = {
		setNetworkTypes: (_id, allowed, preferred) => {
			writes.push({ allowed, preferred });
			return Promise.resolve(options.wrote ?? true);
		},
		readRadioModes: () =>
			Promise.resolve(
				options.readbackFails === true
					? undefined
					: {
							supported: QUECTEL_CATALOG?.supported ?? [],
							...(options.landsOn === undefined
								? {}
								: { current: options.landsOn }),
						},
			),
		broadcast: () => undefined,
	};
	return { writes, deps };
}

beforeEach(async () => {
	journalDir = await mkdtemp(join(tmpdir(), "ceraui-five-g-journal-"));
	setMutationJournalDeps({ dir: journalDir });
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setModemIdPathReader(() => Promise.resolve(new Map([[IFNAME, ID_PATH]])));
	await refreshModemIdPaths();
});

afterEach(async () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetMutationJournalDeps();
	initModemCapabilityEvidence();
	setModemIdPathReader(null);
	resetModemWireProducer();
	for (const id of Object.keys(getModems())) delete getModems()[Number(id)];
	delete getConfig().modem_capabilities;
	await rm(journalDir, { recursive: true, force: true });
});

describe("the model", () => {
	test("a 5G radio with fallback advertises all four postures", () => {
		expect(offeredFiveGPreferences(QUECTEL_CATALOG)).toEqual([
			"5g-only",
			"prefer-5g",
			"prefer-4g",
			"5g-off",
		]);
	});

	test("an LTE-max radio advertises NONE — not even 5g-off", () => {
		expect(offeredFiveGPreferences(SIMCOM_CATALOG)).toEqual([]);
		expect(offeredFiveGPreferences(undefined)).toEqual([]);
	});

	test("prefer-5g and prefer-4g write the SAME allowed set and differ only in preferred", () => {
		const five = fiveGPreferenceToModes("prefer-5g", QUECTEL_CATALOG);
		const four = fiveGPreferenceToModes("prefer-4g", QUECTEL_CATALOG);
		expect(five?.allowed).toBe(four?.allowed as string);
		expect(five?.preferred).toBe("5g");
		expect(four?.preferred).toBe("4g");
	});

	test("5g-only allows 5G alone; 5g-off keeps every sub-5G family", () => {
		expect(fiveGPreferenceToModes("5g-only", QUECTEL_CATALOG)).toEqual({
			allowed: "5g",
			preferred: "none",
		});
		expect(fiveGPreferenceToModes("5g-off", QUECTEL_CATALOG)).toEqual({
			allowed: "4g|3g|2g",
			preferred: "none",
		});
	});

	test("a posture the radio never advertised resolves undefined, never a neighbour", () => {
		expect(fiveGPreferenceToModes("prefer-5g", SIMCOM_CATALOG)).toBeUndefined();
		expect(fiveGPreferenceToModes("prefer-4g", undefined)).toBeUndefined();
	});

	test("the live pair reads back as its posture, and both `prefer-*` are distinguished", () => {
		const read = (current: NetworkType) =>
			readFiveGPreference({ supported: [], current });
		expect(read({ allowed: "5g|4g|3g|2g", preferred: "5g" })).toBe("prefer-5g");
		expect(read({ allowed: "5g|4g|3g|2g", preferred: "4g" })).toBe("prefer-4g");
		expect(read({ allowed: "5g", preferred: "none" })).toBe("5g-only");
		expect(read({ allowed: "4g|3g", preferred: "4g" })).toBe("5g-off");
	});

	test("a pair no posture names reads NULL and is never rounded", () => {
		expect(
			readFiveGPreference({
				supported: [],
				current: { allowed: "5g|3g", preferred: "3g" },
			}),
		).toBeNull();
		expect(readFiveGPreference(undefined)).toBeNull();
	});

	test("SA/NSA is reported unsupported with a reason, never omitted", () => {
		expect(buildFiveGPreferenceView(QUECTEL_CATALOG).nr_mode).toEqual({
			supported: false,
			reason: "not-exposed-by-modemmanager",
		});
	});

	test("evidence is UNKNOWN for an unread catalog and ABSENT only for an observed one", () => {
		expect(fiveGPreferenceEvidence(undefined)).toBe("unknown");
		expect(fiveGPreferenceEvidence({ supported: [] })).toBe("unknown");
		expect(fiveGPreferenceEvidence(SIMCOM_CATALOG)).toBe("absent");
		expect(fiveGPreferenceEvidence(QUECTEL_CATALOG)).toBe("present");
	});
});

describe("the gate decides what reaches the wire", () => {
	function rowFor(radioModes: Modem["radio_modes"]) {
		seedModem(radioModes);
		return buildModemsWireMessage()["0"];
	}

	test("OFF BY DEFAULT: a capable modem publishes NO 5G block", () => {
		capable();
		expect(rowFor(QUECTEL_CATALOG)?.five_g_preference).toBeUndefined();
	});

	test("gate ON + capable: the block rides the row with the live posture", () => {
		capable();
		enableGate();
		const block = rowFor(QUECTEL_CATALOG)?.five_g_preference;
		expect(block?.offered).toEqual([
			"5g-only",
			"prefer-5g",
			"prefer-4g",
			"5g-off",
		]);
		expect(block?.active).toBe("prefer-5g");
	});

	test("gate ON + INCAPABLE modem publishes NO block, never an empty offer list", () => {
		// An empty `offered` would be indistinguishable from a 5G modem that
		// advertised no postures, which is a different fact.
		setModemCapabilityEvidenceReader(() => ({
			capability: { "five-g-pref": "absent" },
		}));
		enableGate();
		expect(rowFor(SIMCOM_CATALOG)?.five_g_preference).toBeUndefined();
	});

	test("gate ON + UNPROVEN capability publishes NO block — unknown is not consent", () => {
		setModemCapabilityEvidenceReader(() => ({ capability: {} }));
		enableGate();
		expect(rowFor(QUECTEL_CATALOG)?.five_g_preference).toBeUndefined();
	});
});

describe("a refused write is NEVER reported as a success", () => {
	beforeEach(() => {
		capable();
		enableGate();
	});

	test("mmcli did not confirm ⇒ typed write_failed, and NOT success", async () => {
		seedModem(QUECTEL_CATALOG);
		const { deps } = scriptedDevice({ wrote: false });
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: false, error: "write_failed" });
	});

	test("the spawn threw (undefined) ⇒ typed write_failed, and NOT success", async () => {
		seedModem(QUECTEL_CATALOG);
		const { deps } = scriptedDevice({ wrote: undefined as unknown as boolean });
		const withUndefined: FiveGApplyDeps = {
			...deps,
			setNetworkTypes: () => Promise.resolve(undefined),
		};
		const result = await applyFiveGPreference("0", "prefer-4g", withUndefined);
		expect(result).toEqual({ success: false, error: "write_failed" });
	});

	test("THE RADIO CLAMPED IT ⇒ readback_mismatch, distinct from write_failed", async () => {
		// mmcli confirming the call is not the radio taking the mode set. This is
		// the arm a configure-echo could not express at all.
		seedModem(QUECTEL_CATALOG);
		const { deps } = scriptedDevice({
			landsOn: { allowed: "5g|4g|3g|2g", preferred: "5g" },
		});
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: false, error: "readback_mismatch" });
	});

	test("the radio could not be re-read ⇒ readback_failed, and no claim is made", async () => {
		seedModem(QUECTEL_CATALOG);
		const { deps } = scriptedDevice({ readbackFails: true });
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: false, error: "readback_failed" });
	});

	test("a posture the radio never advertised is refused BEFORE any write", async () => {
		seedModem(SIMCOM_CATALOG);
		const { writes, deps } = scriptedDevice({});
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: false, error: "not_offered" });
		expect(writes).toEqual([]);
	});

	test("a success reports the READBACK posture, never the request", async () => {
		seedModem(QUECTEL_CATALOG);
		const { writes, deps } = scriptedDevice({
			landsOn: { allowed: "5g|4g|3g|2g", preferred: "4g" },
		});
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: true, applied: "prefer-4g" });
		expect(writes).toEqual([{ allowed: "5g|4g|3g|2g", preferred: "4g" }]);
	});

	test("an unresolvable selector is refused and dispatches nothing", async () => {
		seedModem(QUECTEL_CATALOG);
		const { writes, deps } = scriptedDevice({});
		expect(await applyFiveGPreference("wwan0", "prefer-4g", deps)).toEqual({
			success: false,
			error: "unknown_modem",
		});
		expect(writes).toEqual([]);
	});

	test("the selector accepts a bare index and a full MM path, and nothing else", () => {
		expect(resolveModemIndex("2")).toBe(2);
		expect(resolveModemIndex("/org/freedesktop/ModemManager1/Modem/7")).toBe(7);
		expect(resolveModemIndex("wwan0")).toBeUndefined();
		expect(resolveModemIndex("2; rm -rf /")).toBeUndefined();
	});
});

describe("it routes through the shared mutation contract", () => {
	beforeEach(() => {
		capable();
		enableGate();
		seedModem(QUECTEL_CATALOG);
	});

	test("GATE OFF refuses module_disabled, and the effect never ran", async () => {
		delete getConfig().modem_capabilities;
		const { writes, deps } = scriptedDevice({});
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: false, refusal: "module_disabled" });
		expect(writes).toEqual([]);
	});

	test("INCAPABLE refuses module_unavailable, and the effect never ran", async () => {
		setModemCapabilityEvidenceReader(() => ({
			capability: { "five-g-pref": "absent" },
		}));
		const { writes, deps } = scriptedDevice({});
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: false, refusal: "module_unavailable" });
		expect(writes).toEqual([]);
	});

	test("IT TAKES THE LEASE — a competing mutation refuses it, nothing ran, nothing journaled", async () => {
		const held = beginModemMutation(KEY);
		expect(held.ok).toBe(true);

		const { writes, deps } = scriptedDevice({});
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: false, refusal: "mutation_in_progress" });
		expect(writes).toEqual([]);
		expect(await readdir(journalDir)).toEqual([]);

		if (held.ok) held.lease.release();
	});

	test("STREAMING GUARD — an admitted stream refuses it, and nothing ran", async () => {
		expect(tryAcquireLifecycle("streaming").admitted).toBe(true);
		const { writes, deps } = scriptedDevice({});
		const result = await applyFiveGPreference("0", "prefer-4g", deps);
		expect(result).toEqual({ success: false, refusal: "streaming_active" });
		expect(writes).toEqual([]);
	});

	test("RECIPROCAL — a stream cannot be admitted while the posture is being written", async () => {
		let admittedDuring: boolean | undefined;
		const { deps } = scriptedDevice({
			landsOn: { allowed: "5g|4g|3g|2g", preferred: "4g" },
		});
		const watching: FiveGApplyDeps = {
			...deps,
			setNetworkTypes: (id, allowed, preferred) => {
				admittedDuring = tryAcquireLifecycle("streaming").admitted;
				return deps.setNetworkTypes(id, allowed, preferred);
			},
		};

		expect(await applyFiveGPreference("0", "prefer-4g", watching)).toEqual({
			success: true,
			applied: "prefer-4g",
		});
		expect(admittedDuring).toBe(false);
		expect(tryAcquireLifecycle("streaming").admitted).toBe(true);
	});

	test("IT IS JOURNALED — the pre-state is armed before the write and cancelled on confirm", async () => {
		let armedDuringWrite: readonly { kind: string; preState: unknown }[] = [];
		const { deps } = scriptedDevice({
			landsOn: { allowed: "5g|4g|3g|2g", preferred: "4g" },
		});
		const watching: FiveGApplyDeps = {
			...deps,
			setNetworkTypes: async (id, allowed, preferred) => {
				armedDuringWrite = (await listMutationEntries()).map((entry) => ({
					kind: entry.kind,
					preState: entry.preState,
				}));
				return deps.setNetworkTypes(id, allowed, preferred);
			},
		};

		await applyFiveGPreference("0", "prefer-4g", watching);

		expect(armedDuringWrite).toEqual([
			{
				kind: "five-g-pref",
				// The radio's OWN previous pair, not a posture name — a rollback has to
				// restore what the operator had, including a pair no posture names.
				preState: { allowed: "5g|4g|3g|2g", preferred: "5g" },
			},
		]);
		expect(await listMutationEntries()).toEqual([]);
	});

	test("AN UNCONFIRMED write leaves the journal FAILED, fail-closed", async () => {
		const { deps } = scriptedDevice({
			landsOn: { allowed: "5g|4g|3g|2g", preferred: "5g" },
		});
		await applyFiveGPreference("0", "prefer-4g", deps);

		const entries = await listMutationEntries();
		expect(entries.map((entry) => entry.state)).toEqual(["failed"]);
		expect(entries[0]?.preState).toEqual({
			allowed: "5g|4g|3g|2g",
			preferred: "5g",
		});
	});
});

describe("restoration", () => {
	beforeEach(() => {
		capable();
		enableGate();
		seedModem(QUECTEL_CATALOG);
	});

	test("the rollback writes the journaled pair back and PROVES the radio took it", async () => {
		const writes: NetworkType[] = [];
		const handler = createFiveGRollbackHandler({
			setNetworkTypes: (_id, allowed, preferred) => {
				writes.push({ allowed, preferred });
				return Promise.resolve(true);
			},
			readRadioModes: () =>
				Promise.resolve({
					supported: [],
					current: { allowed: "5g|4g|3g|2g", preferred: "5g" },
				}),
			broadcast: () => undefined,
		});

		const result = await handler.rollback(KEY, {
			allowed: "5g|4g|3g|2g",
			preferred: "5g",
		});
		expect(result).toBe("restored");
		expect(writes).toEqual([{ allowed: "5g|4g|3g|2g", preferred: "5g" }]);
	});

	test("A RADIO THAT CAME BACK ON THE SIBLING POSTURE IS NOT RESTORED", async () => {
		// `prefer-5g` and `prefer-4g` share an allowed set, so an allowed-only
		// comparison would call this a successful restore of the other posture.
		const handler = createFiveGRollbackHandler({
			setNetworkTypes: () => Promise.resolve(true),
			readRadioModes: () =>
				Promise.resolve({
					supported: [],
					current: { allowed: "5g|4g|3g|2g", preferred: "4g" },
				}),
			broadcast: () => undefined,
		});

		expect(
			await handler.rollback(KEY, { allowed: "5g|4g|3g|2g", preferred: "5g" }),
		).toBe("failed");
	});

	test("a refused or unreadable restore answers FAILED, never restored", async () => {
		const refused = createFiveGRollbackHandler({
			setNetworkTypes: () => Promise.resolve(false),
			readRadioModes: () => Promise.resolve(undefined),
			broadcast: () => undefined,
		});
		expect(
			await refused.rollback(KEY, { allowed: "5g|4g", preferred: "5g" }),
		).toBe("failed");
	});

	test("a pre-state naming no allowed set answers FAILED and writes nothing", async () => {
		const writes: NetworkType[] = [];
		const handler = createFiveGRollbackHandler({
			setNetworkTypes: (_id, allowed, preferred) => {
				writes.push({ allowed, preferred });
				return Promise.resolve(true);
			},
			readRadioModes: () => Promise.resolve(undefined),
			broadcast: () => undefined,
		});

		expect(await handler.rollback(KEY, {})).toBe("failed");
		expect(await handler.rollback(KEY, { allowed: "" })).toBe("failed");
		expect(writes).toEqual([]);
	});

	test("a stable key no live modem answers to writes nothing", async () => {
		const writes: NetworkType[] = [];
		const handler = createFiveGRollbackHandler({
			setNetworkTypes: (_id, allowed, preferred) => {
				writes.push({ allowed, preferred });
				return Promise.resolve(true);
			},
			readRadioModes: () => Promise.resolve(undefined),
			broadcast: () => undefined,
		});

		expect(
			await handler.rollback("platform-usb-0:9:9", {
				allowed: "5g|4g",
				preferred: "5g",
			}),
		).toBe("failed");
		expect(writes).toEqual([]);
	});
});
