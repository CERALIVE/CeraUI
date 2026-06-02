import { beforeEach, describe, expect, test } from "bun:test";

import { mmcliParseSep } from "../modules/modems/mmcli.ts";
import type { Modem } from "../modules/modems/modems-state.ts";
import {
	getModemsState,
	onModemsChange,
	reconcileModems,
	setModemsState,
} from "../modules/modems/state/modems-state-cache.ts";
import type { ModemsState, StateDiff } from "../modules/network/state-types.ts";
import { loadFixture } from "./helpers/load-fixture.ts";

type ModemStatusFields = NonNullable<Modem["status"]>;

function makeModem(
	statusOverrides: Partial<ModemStatusFields> = {},
	overrides: Partial<Modem> = {},
): Modem {
	return {
		ifname: "wwan0",
		name: "Test Modem - 12345",
		sim_network: "AT&T",
		network_type: {
			supported: { "4g": { allowed: "4g", preferred: "none" } },
			active: "4g",
		},
		status: {
			connection: "connected",
			network: "AT&T",
			network_type: "4G",
			signal: 60,
			roaming: false,
			...statusOverrides,
		},
		...overrides,
	};
}

function ids(
	entries: StateDiff<{ id: number; data: Modem }>["added"],
): Array<number> {
	return entries.map((entry) => entry.id);
}

describe("modems-state-cache", () => {
	beforeEach(() => {
		// Reset the module-level snapshot before each test. No callbacks are
		// registered at this point (each test unsubscribes its own), so this
		// never leaks notifications across tests.
		setModemsState({});
	});

	test("modem removed: prev has id=0, next empty → removed=[0], callback fired once", () => {
		// Establish prev BEFORE subscribing so the prev-setup doesn't notify us.
		setModemsState({ 0: makeModem() });

		let calls = 0;
		let captured: StateDiff<{ id: number; data: Modem }> | undefined;
		const unsub = onModemsChange((diff) => {
			calls++;
			captured = diff;
		});

		setModemsState({});
		unsub();

		expect(calls).toBe(1);
		expect(ids(captured?.removed ?? [])).toEqual([0]);
		expect(captured?.removed[0]?.id).toBe(0);
		expect(captured?.added).toEqual([]);
		expect(captured?.changed).toEqual([]);
		expect(getModemsState()).toEqual({});
	});

	test("signal change: signal 60→80 → changed includes that modem (signal only)", () => {
		const prev: ModemsState = { 0: makeModem({ signal: 60 }) };
		const next: ModemsState = { 0: makeModem({ signal: 80 }) };

		const diff = reconcileModems(next, prev);

		expect(ids(diff.changed)).toEqual([0]);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		// Only the signal moved; everything else in the status is identical.
		expect(diff.changed[0]?.data.status?.signal).toBe(80);
		expect(diff.changed[0]?.data.status?.connection).toBe("connected");
		expect(diff.changed[0]?.data.status?.roaming).toBe(false);
	});

	test("modem added: new modem appears in next → added=[newId], callback fired", () => {
		setModemsState({ 0: makeModem() });

		let calls = 0;
		let captured: StateDiff<{ id: number; data: Modem }> | undefined;
		const unsub = onModemsChange((diff) => {
			calls++;
			captured = diff;
		});

		setModemsState({
			0: makeModem(),
			1: makeModem({}, { ifname: "wwan1", name: "Test Modem - 67890" }),
		});
		unsub();

		expect(calls).toBe(1);
		expect(ids(captured?.added ?? [])).toEqual([1]);
		expect(captured?.added[0]?.data.ifname).toBe("wwan1");
		expect(captured?.removed).toEqual([]);
		expect(captured?.changed).toEqual([]);
	});

	test("no spurious change: deeply-equal prev+next → empty diff, callback NOT fired", () => {
		// Reconcile two distinct-but-equal snapshots: value comparison, not refs.
		const diff = reconcileModems({ 0: makeModem() }, { 0: makeModem() });
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.changed).toEqual([]);

		// And the callback must NOT fire when the new snapshot is equivalent.
		setModemsState({ 0: makeModem() });

		let calls = 0;
		const unsub = onModemsChange(() => {
			calls++;
		});
		setModemsState({ 0: makeModem() });
		unsub();

		expect(calls).toBe(0);
	});

	test("error fixture: mmcli error output parsed → empty/error ModemsState (no crash)", () => {
		const raw = loadFixture("network/mmcli-modem-error.txt");
		const parsed = mmcliParseSep(raw);

		// The error line parses without throwing and yields no usable modem fields.
		expect(parsed.error).toBeDefined();
		expect(parsed["modem.generic.state"]).toBeUndefined();
		expect(parsed["modem.generic.signal-quality.value"]).toBeUndefined();

		// A failed mmcli lookup contributes no modem to the snapshot.
		const errorState: ModemsState = {};
		const diff = reconcileModems(errorState, {});
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.changed).toEqual([]);

		// Feeding it through the cache must not crash and must not notify.
		let calls = 0;
		const unsub = onModemsChange(() => {
			calls++;
		});
		setModemsState(errorState);
		unsub();

		expect(calls).toBe(0);
		expect(getModemsState()).toEqual({});
	});
});
