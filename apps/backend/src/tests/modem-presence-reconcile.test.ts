import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Modem, ModemId } from "../modules/modems/mmcli.ts";
import {
	discoverModems,
	runModemStatusPoll,
	setModemPresenceDepsForTest,
} from "../modules/modems/modem-update-loop.ts";
import {
	getModem,
	getModemIds,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import {
	onModemsChange,
	setModemsState,
} from "../modules/modems/state/modems-state-cache.ts";
import { parseMonitorLine } from "../modules/network/monitor/monitor-manager.ts";

/*
  Board capture — Rock 5B+ `ceralive2`, 2026-08-19.

  ModemManager dropped modems 3 and 5 at 23:58, then created modem9
  (Quectel RM530N-GL, 4-1.4.4) at 23:59:52 and modem10 (Fibocom FM350-GL,
  1-1.2) at 00:00:21. An hour later `mmcli -L` answered 0/6/9/10 while CeraUI
  was still spawning `mmcli -K -m 3` and `-m 5` every 30 s and had never once
  named 9 or 10 — so the FM350 held a live Movistar SIM at `state: registered`
  with NO NetworkManager profile bound to its device id, and nothing could
  bring it up.
*/
const LIVE_ROSTER: ReadonlyArray<ModemId> = [0, 6, 9, 10];
const STALE_REGISTRY: ReadonlyArray<ModemId> = [3, 5];
const FM350 = 10;

/** The FM350-GL row as `mmcli -m 10` reported it while it sat unconnectable. */
function fm350(): Modem {
	return {
		ifname: "enx000011121314",
		name: "FM350-GL",
		sim_network: "Movistar",
		model: "FM350-GL",
		manufacturer: "Fibocom Wireless Inc.",
		iccid: "8957123102400060892",
		network_type: { supported: {}, active: null },
	} as unknown as Modem;
}

function seedRegistry(ids: ReadonlyArray<ModemId>): void {
	for (const id of getModemIds()) removeModem(id);
	const snapshot: Record<number, Modem> = {};
	for (const id of ids) {
		const modem = fm350();
		setModem(id, modem);
		snapshot[id] = modem;
	}
	// The diff cache's baseline must match the registry, or a modem the poll
	// drops was never in the baseline to be reported as removed.
	setModemsState(snapshot);
}

interface Recorder {
	registered: Array<ModemId>;
	refreshed: Array<ModemId>;
	idPathRefreshes: number;
}

function install(
	listResult: Array<ModemId> | undefined,
	onRegister?: (id: ModemId) => void,
): Recorder {
	const rec: Recorder = { registered: [], refreshed: [], idPathRefreshes: 0 };
	setModemPresenceDepsForTest({
		listModems: async () => listResult,
		registerModem: async (id) => {
			rec.registered.push(id);
			onRegister?.(id);
		},
		refreshStatus: async (id) => {
			rec.refreshed.push(id);
		},
		refreshIdPaths: async () => {
			rec.idPathRefreshes++;
		},
	});
	return rec;
}

describe("modem presence reconcile (board: FM350 never registered)", () => {
	afterEach(() => {
		setModemPresenceDepsForTest(null);
	});

	afterAll(() => {
		for (const id of getModemIds()) removeModem(id);
		setModemsState({});
	});

	test("the retained poll registers a modem that appeared AFTER boot", async () => {
		seedRegistry(STALE_REGISTRY);
		const rec = install([...LIVE_ROSTER], (id) => setModem(id, fm350()));

		await runModemStatusPoll();

		// The FM350 is registered — the step that resolves (and, absent a match,
		// CREATES) its NetworkManager GSM profile. Before the fix the poll never
		// listed, so this never ran for any post-boot modem.
		expect(rec.registered).toContain(FM350);
		expect(getModem(FM350)).toBeDefined();

		// …and the indices that no longer exist are dropped instead of polled
		// forever.
		for (const gone of STALE_REGISTRY) {
			expect(getModem(gone)).toBeUndefined();
		}
		expect(getModemIds().sort((a, b) => a - b)).toEqual([...LIVE_ROSTER]);
	});

	test("a poll-discovered modem reconciles as an ADDITION, invalidating cached gsm profiles", async () => {
		seedRegistry(STALE_REGISTRY);
		install([...LIVE_ROSTER], (id) => setModem(id, fm350()));

		const seen: Array<{ added: Array<number>; removed: Array<number> }> = [];
		const unsub = onModemsChange((diff) => {
			seen.push({
				added: diff.added.map((e) => e.id),
				removed: diff.removed.map((e) => e.id),
			});
		});
		await runModemStatusPoll();
		unsub();

		expect(seen).toHaveLength(1);
		expect(seen[0]?.added).toContain(FM350);
		expect(seen[0]?.removed.sort((a, b) => a - b)).toEqual([...STALE_REGISTRY]);
	});

	test("an UNREADABLE `mmcli -L` retains every modem instead of evicting the registry", async () => {
		seedRegistry(LIVE_ROSTER);
		const rec = install(undefined);

		await runModemStatusPoll();

		// A failed read is a statement about the READ. Evicting here would drop
		// every modem's resolved NM profile once per transient failure.
		expect(getModemIds().sort((a, b) => a - b)).toEqual([...LIVE_ROSTER]);
		expect(rec.registered).toEqual([]);
		expect(rec.refreshed.sort((a, b) => a - b)).toEqual([...LIVE_ROSTER]);
	});

	test("an EMPTY roster is authoritative — every modem really is gone", async () => {
		seedRegistry(LIVE_ROSTER);
		install([]);

		await runModemStatusPoll();

		expect(getModemIds()).toEqual([]);
	});

	test("a quiet tick refreshes no ID_PATHs; a presence edge does", async () => {
		seedRegistry(LIVE_ROSTER);
		const quiet = install([...LIVE_ROSTER]);
		await runModemStatusPoll();
		expect(quiet.idPathRefreshes).toBe(0);
		expect(quiet.registered).toEqual([]);

		setModemPresenceDepsForTest(null);
		const edge = install([...LIVE_ROSTER, 11], (id) => setModem(id, fm350()));
		await runModemStatusPoll();
		expect(edge.idPathRefreshes).toBe(1);
	});

	test("discovery still refreshes ID_PATHs unconditionally (it is the boot seed)", async () => {
		seedRegistry(LIVE_ROSTER);
		const rec = install([...LIVE_ROSTER]);

		await discoverModems();

		expect(rec.idPathRefreshes).toBe(1);
	});

	test("the production monitor structurally cannot report a modem arriving", () => {
		// This is WHY the poll must re-list. `nmcli monitor` reports
		// NetworkManager devices and connections; it has no view of the
		// ModemManager modem lifecycle, so `modem-added`/`modem-removed` are
		// reachable only from the scripted MockMonitorEmitter.
		const realLines = [
			"ttyUSB12: disconnected",
			"ttyUSB12: connecting (prepare)",
			"enx000011121314: connected to 'gsm-2'",
			'"gsm-2" (gsm, 10.7.236.127): connection activated',
			"NetworkManager is now in the 'connected' state",
			"Connectivity is now 'full'",
		];

		const types = realLines.map((line) => parseMonitorLine(line)?.type);
		expect(types).not.toContain("modem-added");
		expect(types).not.toContain("modem-removed");
	});
});
