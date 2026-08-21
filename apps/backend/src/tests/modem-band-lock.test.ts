/**
 * Band lock, end to end.
 *
 * Four things are asserted, and the last two are the reason this suite exists:
 *
 *   1. `SupportedBands` PARSING against the real `-K` shape, per fleet modem.
 *   2. THE CONTROL IS HIDDEN WITHOUT CERTIFICATION EVIDENCE — a modem that
 *      advertises bands and has no reviewed entry answers a typed `uncertified`
 *      refusal, and NOTHING is dispatched at it.
 *   3. THE TIMED ROLLBACK fires within the bound, driven by a mock clock, and
 *      restores the previous selection.
 *   4. IT SURVIVES A BACKEND RESTART. The in-process rollback and the journal
 *      replay are two halves of ONE guarantee, so a process killed inside the
 *      registration window is simulated by leaving the journal entry `executing`
 *      and running the real replay against it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig } from "../modules/config.ts";
import {
	refreshBandCapability,
	resetBandCapabilityCache,
	setBandCatalogPackageForTest,
	setBandIdentityResolver,
} from "../modules/modems/band-capability.ts";
import {
	applyBandLock,
	BAND_REGISTRATION_BOUND_MS,
	type BandTiming,
	waitForRegistration,
} from "../modules/modems/band-lock.ts";
import {
	extractBands,
	extractState,
	isRegisteredState,
	parseSetBandsSuccess,
	resetBandMmcliDeps,
	setBandMmcliDeps,
} from "../modules/modems/band-mmcli.ts";
import { restoreBandLock } from "../modules/modems/band-rollback.ts";
import { mmcliParseSep } from "../modules/modems/mmcli.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import { setModem } from "../modules/modems/modems-state.ts";
import {
	listMutationEntries,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { runMutationReplay } from "../modules/modems/mutation-replay.ts";
import { setMutationCaptureDeps } from "../modules/modems/mutation-rollback.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";

const IFNAME = "wwan0";
const ID_PATH = "platform-xhci-hcd.0.auto-usb-0:1.4.4";
const KEY = ID_PATH;
const DEVICE = "0";

// ─── verbatim-shaped `mmcli -K -m N` band output, per fleet modem ────────────
// mmcli prints an array as a `.length` line followed by `.value[n]` lines, and
// `--` for an empty one; these fixtures reproduce that exactly so the parser is
// exercised against the writer's real grammar rather than a convenient object.

function bandBlock(key: string, bands: readonly string[]): string {
	if (bands.length === 0) return `${key} : --\n`;
	const lines = [`${key}.length : ${bands.length}`];
	for (const [index, band] of bands.entries()) {
		lines.push(`${key}.value[${index + 1}] : ${band}`);
	}
	return `${lines.join("\n")}\n`;
}

function modemOutput(options: {
	readonly supported?: readonly string[];
	readonly current?: readonly string[];
	readonly state?: string;
}): string {
	return [
		"modem.dbus-path : /org/freedesktop/ModemManager1/Modem/0",
		`modem.generic.state : ${options.state ?? "registered"}`,
		bandBlock(
			"modem.generic.supported-bands",
			options.supported ?? [],
		).trimEnd(),
		bandBlock("modem.generic.current-bands", options.current ?? []).trimEnd(),
	].join("\n");
}

/** Quectel RM530N-GL — the bench 5G unit (todo 2 fleet map, `2c7c:0801`). */
const QUECTEL_SUPPORTED = [
	"egsm",
	"dcs",
	"utran-1",
	"utran-8",
	"eutran-1",
	"eutran-3",
	"eutran-7",
	"eutran-20",
	"eutran-28",
	"ngran-1",
	"ngran-3",
	"ngran-78",
];

/** SIMCom SIM7600G-H — the bench LTE unit, no NR block at all. */
const SIMCOM_SUPPORTED = [
	"egsm",
	"dcs",
	"pcs",
	"g850",
	"utran-1",
	"utran-2",
	"utran-5",
	"utran-8",
	"eutran-1",
	"eutran-3",
	"eutran-5",
	"eutran-8",
	"eutran-20",
];

let journalDir = "";

function certifiedCatalog(offerable: readonly string[]): void {
	setBandCatalogPackageForTest({
		catalog: { entries: [{ id: "test" }] },
		isCertified: () => true,
		findEntry: () => ({ id: "test" }),
		offerable: (_entry, supported) =>
			offerable.length === 0
				? supported
				: supported.filter((b) => offerable.includes(b)),
	});
}

function uncertifiedCatalog(): void {
	setBandCatalogPackageForTest({
		catalog: { entries: [] },
		isCertified: () => false,
		findEntry: () => undefined,
		offerable: () => [],
	});
}

async function seedModem(): Promise<void> {
	setModem(0, {
		ifname: IFNAME,
		name: "Quectel RM530N-GL",
		sim_network: "",
		network_type: { supported: {}, active: "5g" },
		status: {
			connection: "connected",
			network: "Movistar",
			network_type: "5G",
			signal: 72,
			roaming: false,
		},
		config: {
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
	});
	setModemIdPathReader(() => Promise.resolve(new Map([[IFNAME, ID_PATH]])));
	await refreshModemIdPaths();
	// The production resolver enumerates real USB and reads mmcli's port list;
	// neither exists here, so the SKU is pinned instead.
	setBandIdentityResolver(() =>
		Promise.resolve({
			stableKey: KEY,
			vidPid: "2c7c:0801",
			model: "RM530N-GL",
			firmwareRevision: "RM530NGLAAR05A01M4G",
			currentMode: "qmi" as const,
			physicalUid: ID_PATH,
			ifname: IFNAME,
			ports: [],
		}),
	);
	// The replay path's presence check enumerates the same device.
	setMutationCaptureDeps({
		enumerate: () =>
			Promise.resolve([
				{
					vendorId: "2c7c",
					productId: "0801",
					model: "RM530N-GL",
					firmwareRevision: "RM530NGLAAR05A01M4G",
					ifname: IFNAME,
					physicalUid: ID_PATH,
					interfaces: [],
				},
			] as never),
	});
}

/**
 * A scripted modem: `readModem` answers from a mutable band/state slot, and
 * `setBands` writes into it. That is what makes the readback, the rollback and
 * the replay assertions real rather than mocked at the seam under test.
 */
function scriptedModem(options: {
	readonly supported: readonly string[];
	readonly current: string[];
	/** Bands on which the radio never attaches — the unavailable-band case. */
	readonly deadBands?: readonly string[];
	readonly refuseWrite?: boolean;
	/** Accept the write and report something else — an ignored write. */
	readonly ignoreWrite?: boolean;
}) {
	const writes: string[][] = [];
	const state = () =>
		options.current.some((band) => (options.deadBands ?? []).includes(band))
			? "searching"
			: "registered";
	setBandMmcliDeps({
		readModem: () =>
			Promise.resolve(
				modemOutput({
					supported: options.supported,
					current: options.current,
					state: state(),
				}),
			),
		setBands: (_device, spec) => {
			const requested = spec.split(",");
			writes.push(requested);
			if (options.refuseWrite === true)
				return Promise.resolve("error: could not set bands");
			if (options.ignoreWrite !== true) {
				options.current.splice(0, options.current.length, ...requested);
			}
			return Promise.resolve("successfully set current bands in the modem\n");
		},
	});
	return { writes };
}

/** A clock that jumps instead of sleeping, so the 45 s bound costs no time. */
function mockClock(): BandTiming {
	let now = 1_000;
	return {
		now: () => now,
		sleep: (ms) => {
			now += ms;
			return Promise.resolve();
		},
	};
}

beforeEach(async () => {
	journalDir = await mkdtemp(join(tmpdir(), "ceraui-bands-"));
	setMutationJournalDeps({ dir: journalDir });
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetBandCapabilityCache();
	getConfig().modem_capabilities = { band_lock: true };
	await seedModem();
});

afterEach(async () => {
	resetBandMmcliDeps();
	resetMutationJournalDeps();
	resetModemWireProducer();
	setBandCatalogPackageForTest(undefined);
	setBandIdentityResolver(null);
	resetBandCapabilityCache();
	getConfig().modem_capabilities = undefined;
	await rm(journalDir, { recursive: true, force: true });
});

describe("parsing the real `-K` band output, per fleet modem", () => {
	test("the Quectel RM530N-GL's GSM + UTRAN + LTE + NR set", () => {
		const parsed = mmcliParseSep(
			modemOutput({ supported: QUECTEL_SUPPORTED, current: ["any"] }),
		);
		expect(extractBands(parsed)).toEqual({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
		});
		expect(extractState(parsed)).toBe("registered");
	});

	test("the SIMCom SIM7600G-H's LTE-only set — no NR block", () => {
		const parsed = mmcliParseSep(
			modemOutput({ supported: SIMCOM_SUPPORTED, current: ["any"] }),
		);
		const { supported } = extractBands(parsed);
		expect(supported).toEqual(SIMCOM_SUPPORTED);
		expect(supported.some((band) => band.startsWith("ngran-"))).toBe(false);
	});

	test("a locked modem reports its lock, not `any`", () => {
		const parsed = mmcliParseSep(
			modemOutput({
				supported: QUECTEL_SUPPORTED,
				current: ["eutran-3", "eutran-7"],
			}),
		);
		expect(extractBands(parsed).current).toEqual(["eutran-3", "eutran-7"]);
	});

	test("a modem that advertises NO band is an empty list, not a parse failure", () => {
		// mmcli prints `--` for an empty array, which is a real reading: this
		// modem cannot be band-locked, and the control must not be offered.
		const parsed = mmcliParseSep(modemOutput({ supported: [], current: [] }));
		expect(extractBands(parsed)).toEqual({ supported: [], current: [] });
	});

	test("a malformed member is DROPPED rather than passed on toward argv", () => {
		const parsed = mmcliParseSep(
			[
				"modem.generic.supported-bands.length : 2",
				"modem.generic.supported-bands.value[1] : eutran-3",
				"modem.generic.supported-bands.value[2] : --set-current-bands=evil",
			].join("\n"),
		);
		expect(extractBands(parsed).supported).toEqual(["eutran-3"]);
	});

	test("registration is read from mmcli's own state string", () => {
		expect(isRegisteredState("registered")).toBe(true);
		expect(isRegisteredState("connected")).toBe(true);
		expect(isRegisteredState("searching")).toBe(false);
		expect(isRegisteredState("enabled")).toBe(false);
		expect(isRegisteredState(undefined)).toBe(false);
	});

	test("only mmcli's own confirmation counts as a successful write", () => {
		expect(
			parseSetBandsSuccess("successfully set current bands in the modem\n"),
		).toBe(true);
		expect(parseSetBandsSuccess("error: 'Failed'")).toBe(false);
		expect(parseSetBandsSuccess("")).toBe(false);
	});
});

describe("the control is HIDDEN without certification evidence", () => {
	test("an uncertified modem refuses and DISPATCHES NOTHING", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
		});
		uncertifiedCatalog();

		const result = await applyBandLock(DEVICE, ["eutran-3"], mockClock());

		expect(result).toEqual({ success: false, error: "uncertified" });
		expect(modem.writes).toHaveLength(0);
		expect(await listMutationEntries()).toHaveLength(0);
	});

	test("a pinned modem-control with NO band catalog fails CLOSED", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
		});
		setBandCatalogPackageForTest(null);

		const result = await applyBandLock(DEVICE, ["eutran-3"], mockClock());

		expect(result.error).toBe("uncertified");
		expect(modem.writes).toHaveLength(0);
	});

	test("a certified modem refuses a band the catalog does NOT prove", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
		});
		certifiedCatalog(["eutran-3"]);

		const result = await applyBandLock(DEVICE, ["eutran-7"], mockClock());

		expect(result).toMatchObject({
			success: false,
			error: "uncertified",
			detail: "eutran-7",
		});
		expect(modem.writes).toHaveLength(0);
	});

	test("the reset value is always reachable, even when the catalog narrows the set", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["eutran-3"],
		});
		certifiedCatalog(["eutran-3"]);

		const result = await applyBandLock(DEVICE, ["any"], mockClock());

		expect(result.status).toBe("applied");
		expect(modem.writes).toEqual([["any"]]);
	});

	test("the capability read reports `absent` for a modem advertising no band", async () => {
		scriptedModem({ supported: [], current: [] });
		certifiedCatalog([]);
		const snapshot = await refreshBandCapability(DEVICE, KEY);
		expect(snapshot.capability).toBe("absent");
		expect(snapshot.offerable).toEqual([]);
	});

	test("an unreadable modem is `unknown`, never `absent`", async () => {
		setBandMmcliDeps({
			readModem: () => Promise.reject(new Error("mmcli is gone")),
		});
		certifiedCatalog([]);
		const snapshot = await refreshBandCapability(DEVICE, KEY);
		expect(snapshot.capability).toBe("unknown");
	});
});

describe("a band change that lands", () => {
	test("sets, reads back, proves registration, and leaves NOTHING journaled", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
		});
		certifiedCatalog([]);

		const result = await applyBandLock(
			DEVICE,
			["eutran-3", "eutran-7"],
			mockClock(),
		);

		expect(result).toMatchObject({
			success: true,
			status: "applied",
			bands: ["eutran-3", "eutran-7"],
		});
		expect(modem.writes).toEqual([["eutran-3", "eutran-7"]]);
		expect(await listMutationEntries()).toHaveLength(0);
	});

	test("a refused write changes nothing and leaves nothing outstanding", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
			refuseWrite: true,
		});
		certifiedCatalog([]);

		const result = await applyBandLock(DEVICE, ["eutran-3"], mockClock());

		expect(result).toMatchObject({
			success: false,
			status: "rejected",
			bands: ["any"],
		});
		expect(modem.writes).toEqual([["eutran-3"]]);
		expect(await listMutationEntries()).toHaveLength(0);
	});

	test("an ACCEPTED-BUT-IGNORED write is caught by the readback and rolled back", async () => {
		// The failure mode that looks like success from the call site alone.
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
			ignoreWrite: true,
		});
		certifiedCatalog([]);

		const result = await applyBandLock(DEVICE, ["eutran-3"], mockClock());

		expect(result.status).toBe("readback_failed");
		expect(result.success).toBe(false);
		expect(modem.writes[0]).toEqual(["eutran-3"]);
	});
});

describe("the TIMED ROLLBACK for an unavailable band", () => {
	test("fires within the bound and restores the previous selection", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
			deadBands: ["eutran-28"],
		});
		certifiedCatalog([]);

		const result = await applyBandLock(DEVICE, ["eutran-28"], mockClock());

		expect(result).toMatchObject({
			success: false,
			status: "auto_restored",
			bands: ["any"],
		});
		expect(modem.writes).toEqual([["eutran-28"], ["any"]]);
		// Restored and reconfirmed ⇒ nothing outstanding ⇒ the entry is cancelled.
		expect(await listMutationEntries()).toHaveLength(0);
	});

	test("the wait is BOUNDED — it does not poll forever on a searching radio", async () => {
		scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["eutran-28"],
			deadBands: ["eutran-28"],
		});
		const clock = mockClock();
		const started = clock.now();

		expect(await waitForRegistration(DEVICE, clock)).toBe(false);
		expect(clock.now() - started).toBeGreaterThanOrEqual(
			BAND_REGISTRATION_BOUND_MS,
		);
	});

	test("a radio that attaches inside the window is NOT rolled back", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
		});
		certifiedCatalog([]);

		const result = await applyBandLock(DEVICE, ["eutran-1"], mockClock());

		expect(result.status).toBe("applied");
		expect(modem.writes).toEqual([["eutran-1"]]);
	});

	test("a restore that itself fails leaves the device FAIL-CLOSED and journaled", async () => {
		// The modem accepts the lock and then refuses everything, so neither the
		// requested bands nor the baseline can be reached.
		let firstWriteDone = false;
		const current = ["any"];
		setBandMmcliDeps({
			readModem: () =>
				Promise.resolve(
					modemOutput({
						supported: QUECTEL_SUPPORTED,
						current,
						state: firstWriteDone ? "searching" : "registered",
					}),
				),
			setBands: (_device, spec) => {
				if (firstWriteDone) return Promise.resolve("error: modem is wedged");
				firstWriteDone = true;
				current.splice(0, current.length, ...spec.split(","));
				return Promise.resolve("successfully set current bands in the modem\n");
			},
		});
		certifiedCatalog([]);

		const result = await applyBandLock(DEVICE, ["eutran-28"], mockClock());

		expect(result.status).toBe("restore_failed");
		const entries = await listMutationEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.state).toBe("failed");
		expect(entries[0]?.kind).toBe("band-lock");
		expect(entries[0]?.preState).toEqual({ bands: ["any"] });
	});
});

describe("it survives a BACKEND RESTART", () => {
	test("an `executing` entry left by a killed process is rolled back on the next boot", async () => {
		// GIVEN a process that died inside the registration window: the band change
		// is on the modem and the journal entry is still `executing`.
		const current = ["eutran-28"];
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current,
			deadBands: ["eutran-28"],
		});
		const { commitMutationEntry, journalNow } = await import(
			"../modules/modems/mutation-journal.ts"
		);
		const at = journalNow();
		await commitMutationEntry({
			version: 1,
			stableKey: KEY,
			kind: "band-lock",
			state: "executing",
			attemptId: "killed-mid-window",
			startedAt: at,
			updatedAt: at,
			preState: { bands: ["any"] },
			history: [
				{ state: "armed", at },
				{ state: "executing", at },
			],
		});

		// WHEN the backend boots and replays the journal.
		const summary = await runMutationReplay();

		// THEN the previous selection is back and the entry is gone.
		expect(summary.rolledBack).toBe(1);
		expect(current).toEqual(["any"]);
		expect(modem.writes).toEqual([["any"]]);
		expect(await listMutationEntries()).toHaveLength(0);
	});

	test("an `armed` entry — the write never dispatched — is a no-op restore", async () => {
		const modem = scriptedModem({
			supported: QUECTEL_SUPPORTED,
			current: ["any"],
		});
		const { commitMutationEntry, journalNow } = await import(
			"../modules/modems/mutation-journal.ts"
		);
		const at = journalNow();
		await commitMutationEntry({
			version: 1,
			stableKey: KEY,
			kind: "band-lock",
			state: "armed",
			attemptId: "never-dispatched",
			startedAt: at,
			updatedAt: at,
			preState: { bands: ["any"] },
			history: [{ state: "armed", at }],
		});

		const summary = await runMutationReplay();

		expect(summary.rolledBack).toBe(1);
		expect(modem.writes).toHaveLength(0);
	});

	test("the rollback handler restores from the stable key ALONE — no modem id", async () => {
		const current = ["eutran-28"];
		scriptedModem({ supported: QUECTEL_SUPPORTED, current });

		expect(await restoreBandLock(KEY, { bands: ["eutran-3"] })).toBe(
			"restored",
		);
		expect(current).toEqual(["eutran-3"]);
	});

	test("an EMPTY persisted selection restores `any`, the only reachable baseline", async () => {
		const current = ["eutran-28"];
		scriptedModem({ supported: QUECTEL_SUPPORTED, current });

		expect(await restoreBandLock(KEY, { bands: [] })).toBe("restored");
		expect(current).toEqual(["any"]);
	});

	test("a modem the key no longer names cannot be restored", async () => {
		scriptedModem({ supported: QUECTEL_SUPPORTED, current: ["eutran-28"] });
		expect(
			await restoreBandLock("platform-usb-0:9.9.9", { bands: ["any"] }),
		).toBe("failed");
	});
});
