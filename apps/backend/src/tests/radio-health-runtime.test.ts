import { afterEach, expect, test } from "bun:test";
import { radioHealthListSchema } from "@ceraui/rpc/schemas";
import {
	commitRadioRoster,
	getRadioHealth,
	radioForModem,
	refreshRadioHealth,
	resetRadioHealthForTest,
} from "../modules/modems/radio-health-runtime.ts";

afterEach(resetRadioHealthForTest);

type SamplerDeps = NonNullable<Parameters<typeof refreshRadioHealth>[1]>;
/** One poll: these rows are the committed roster, then the sampler runs. */
async function sample(
	rows: Record<string, object>,
	now: number,
	deps: Partial<SamplerDeps>,
): Promise<void> {
	commitRadioRoster(rows, deps as SamplerDeps);
	await refreshRadioHealth(now, deps as SamplerDeps);
}
test("the real sampler publishes explicit unavailable fields and a neighbour delta without any device commands", async () => {
	let bytes = 100;
	const deps = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => ({
			signal: "LTE:\n RSRP: '-101 dBm'\n SNR: '-8 dB'",
			band: "Active band: 'LTE band 3'",
		}),
		readText: async () => String(bytes),
		realpath: async () => "/sys/devices/usb1/1-1/1-1.2/1-1.2:1.4",
		run: async () =>
			JSON.stringify({
				MESSAGE: "usb 1-1.2: reset high-speed USB device",
				__REALTIME_TIMESTAMP: "30000000",
			}),
		health: () => undefined,
		modem: () => undefined,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1" },
		"2": { ifname: "fixture2", stable_key: "port-2" },
	};
	await sample(rows, 1000, deps);
	bytes = 200;
	await sample(rows, 31000, deps);
	const result = radioHealthListSchema.parse(getRadioHealth(rows, 31000));
	expect(result["1"]?.metrics.lteTxPower?.value).toBeNull();
	expect(result["1"]?.neighbours[0]?.transmitting).toBe("yes");
	expect(result["1"]?.usb.events).toEqual([{ at: 30000, kind: "reset" }]);
	expect(result["1"]?.finding.kind).toBe("unknown");
	expect(result["1"]?.timeline.length).toBe(2);
	expect(radioForModem("1", rows["1"], 31000).timeline).toHaveLength(1);
	expect(getRadioHealth(rows, 100000)["1"]?.finding.kind).toBe("unknown");
	expect(getRadioHealth(rows, 100000)["1"]?.metrics.rsrp?.reason).toBe(
		"not-observed",
	);
	bytes = 0;
	await sample(rows, 61000, deps);
	expect(getRadioHealth(rows, 61000)["1"]?.neighbours[0]?.transmitting).toBe(
		"unknown",
	);
	await sample(rows, 90000, {
		...deps,
		enabled: async () => false,
		readNas: async () => {
			throw new Error("disabled sampler issued modem query");
		},
	});
	expect(getRadioHealth(rows, 90000)).toEqual({});
	await sample({}, 91000, deps);
	expect(getRadioHealth({}, 91000)).toEqual({});
});

test("vendor-neutral devices never enter the vendor reader, and replacement drops history", async () => {
	const deps = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => {
			throw new Error("unexpected vendor read");
		},
		readText: async () => "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: () => undefined,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1", model: "FM350-GL" },
		"2": { ifname: "fixture2", stable_key: "port-2", model: "DW5821e" },
	};
	await sample(rows, 1000, deps);
	await sample(rows, 31000, deps);
	expect(getRadioHealth(rows, 31000)["1"]?.timeline.length).toBe(2);
	const replaced = {
		...rows,
		"1": { ...rows["1"], stable_key: "replacement" },
	};
	// Until the replacement is sampled, the old identity's history is not served.
	expect(getRadioHealth(replaced, 31000)["1"]).toBeUndefined();
	await sample(replaced, 61000, deps);
	expect(getRadioHealth(replaced, 61000)["1"]?.timeline.length).toBe(1);
	expect(getRadioHealth(rows, 61000)["1"]).toBeUndefined();
	expect(getRadioHealth(replaced, 100)["1"]?.registration.value).toBeNull();
	const restarting = {
		...replaced,
		"2": { ...rows["2"], availability_reason: "mm-restarting" },
	};
	await sample(restarting, 91000, deps);
	expect(
		getRadioHealth(restarting, 91000)["1"]?.neighbours.find((n) => n.id === "2")
			?.transmitting,
	).toBe("unknown");
});

test("wire unknowns explicitly replace a missing, stale or differently identified cache", async () => {
	const { radioForModem } = await import(
		"../modules/modems/radio-health-runtime.ts"
	);
	expect(
		radioForModem("1", { ifname: "fixture", stable_key: "new" }, 1000)
			.registration.value,
	).toBeNull();
	const first = radioForModem(
		"1",
		{ ifname: "fixture", stable_key: "new" },
		1000,
	);
	expect(
		radioForModem("1", { ifname: "fixture", stable_key: "new" }, 2000),
	).toEqual(first);
	expect(
		radioForModem(
			"1",
			{ ifname: "fixture", availability_reason: "mm-unavailable" },
			3000,
		).finding.kind,
	).toBe("unknown");
});

test("registration retains its successful owner-read time and expires without another read", async () => {
	const deps = {
		enabled: async () => true,
		registration: () => ({ value: "home", capturedAt: 1000 }),
		readNas: async () => ({ signal: "", band: "" }),
		readText: async () => "0",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: () => ({ ifname: "fixture1" }) as never,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1", model: "DW5821e" },
	};
	await sample(rows, 31000, deps);
	expect(getRadioHealth(rows, 31000)["1"]?.registration.value).toBe("home");
	expect(getRadioHealth(rows, 31000)["1"]?.registration.capturedAt).toBe(1000);
	await sample(rows, 91000, deps);
	expect(getRadioHealth(rows, 91000)["1"]?.registration.value).toBeNull();
	expect(getRadioHealth(rows, 91000)["1"]?.finding.kind).toBe("unknown");
});

test("the serving cell is read only on the released AT port, and a refusal says why", async () => {
	const { QENG_LTE_REPLY } = await import("./helpers/fake-at-modem.ts");
	const served: number[] = [];
	const base = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => ({ signal: "", band: "", listed: true }),
		readText: async () => "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: () => undefined,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1", model: "RM520N-GL" },
	};
	await sample(rows, 1000, {
		...base,
		readServing: async (id: number) => {
			served.push(id);
			return { ok: true as const, raw: QENG_LTE_REPLY.replace(/\r\n?/g, "\n") };
		},
	});
	expect(served).toEqual([1]);
	expect(getRadioHealth(rows, 1000)["1"]?.layer.source).toBe(
		"QENG servingcell",
	);
	expect(getRadioHealth(rows, 1000)["1"]?.metrics.servingCell).toBeUndefined();

	await sample(rows, 31000, {
		...base,
		readServing: async () => ({
			ok: false as const,
			unavailable: true as const,
			reason: "not-released" as const,
			capturedAt: 1000,
		}),
	});
	const refused = radioHealthListSchema.parse(getRadioHealth(rows, 31000))["1"];
	expect(refused?.metrics.servingCell).toMatchObject({
		value: null,
		reason: "not-available",
		source: "QENG servingcell · not available: not-released",
		capturedAt: 1000,
	});

	await sample(rows, 61000, {
		...base,
		readServing: async () => ({
			ok: false as const,
			unavailable: false as const,
			reason: "timeout" as const,
		}),
	});
	expect(getRadioHealth(rows, 61000)["1"]?.metrics.servingCell).toMatchObject({
		value: null,
		reason: "not-reported",
		source: "QENG servingcell · no reading: timeout",
	});

	// Unlisted firmware: no serving-cell read at all.
	await sample(rows, 91000, {
		...base,
		readNas: async () => ({ signal: "", band: "" }),
		readServing: async () => {
			throw new Error("unlisted firmware reached the AT port");
		},
	});
	expect(getRadioHealth(rows, 91000)["1"]?.metrics.servingCell).toBeUndefined();
});

test("binary journal messages cannot stall later USB diagnostics", async () => {
	const deps = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => ({ signal: "", band: "" }),
		readText: async () => "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		health: () => undefined,
		modem: () => undefined,
		run: async () =>
			[
				JSON.stringify({ MESSAGE: [255, 0], __REALTIME_TIMESTAMP: "1000000" }),
				JSON.stringify({
					MESSAGE: "usb 1-1: reset high-speed USB device",
					__REALTIME_TIMESTAMP: "2000000",
				}),
			].join("\n"),
	};
	const one = { "1": { ifname: "fixture1", stable_key: "port-1" } };
	await sample(one, 3000, deps);
	expect(getRadioHealth(one, 3000)["1"]?.usb.events).toEqual([
		{ at: 2000, kind: "reset" },
	]);
});

test("overlapping refreshes skip immediately and release the guard after failure", async () => {
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const paused = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const deps = {
		enabled: async () => {
			calls++;
			entered();
			await paused;
			throw new Error("read failed");
		},
	} as SamplerDeps;
	const first = refreshRadioHealth(1000, deps);
	await started;
	try {
		const skipped = refreshRadioHealth(2000, deps);
		expect(
			await Promise.race([
				skipped.then(() => true),
				Bun.sleep(100).then(() => false),
			]),
		).toBe(true);
		expect(calls).toBe(1);
	} finally {
		release();
		await expect(first).rejects.toThrow("read failed");
	}
	await refreshRadioHealth(3000, { ...deps, enabled: async () => false });
	expect(getRadioHealth({}, 3000)).toEqual({});
});

test("a staged SIM swap on the same id is neither sampled nor served from the old history", async () => {
	const live = { ifname: "fixture1", iccid: "8900000000000000001" };
	const deps = {
		enabled: async () => true,
		registration: () => ({ value: "home", capturedAt: 1000 }),
		readNas: async () => ({ signal: "", band: "" }),
		readText: async () => "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: () => live as never,
	};
	const committed = {
		"1": { ifname: "fixture1", stable_key: "port-1", iccid: live.iccid },
	};
	await sample(committed, 1000, deps);
	await sample(committed, 31000, deps);
	expect(getRadioHealth(committed, 31000)["1"]?.timeline.length).toBe(2);
	// The new SIM is live but not yet committed: no sample, no old history.
	live.iccid = "8900000000000000002";
	await sample(committed, 61000, deps);
	// No sample and none of the old history, only an explicit unknown.
	expect(getRadioHealth(committed, 61000)["1"]?.timeline ?? []).toHaveLength(0);
	expect(
		getRadioHealth(committed, 61000)["1"]?.registration.value ?? null,
	).toBeNull();
	expect(
		radioForModem("1", committed["1"], 61000).registration.value,
	).toBeNull();
	// Once committed, sampling restarts with a fresh history.
	const swapped = { "1": { ...committed["1"], iccid: live.iccid } };
	await sample(swapped, 91000, deps);
	expect(getRadioHealth(swapped, 91000)["1"]?.timeline.length).toBe(1);
	expect(getRadioHealth(committed, 91000)["1"]).toBeUndefined();
});

test("a swap or removal during the awaited reads is not stored under the committed identity", async () => {
	for (const change of ["swap", "removal"] as const) {
		resetRadioHealthForTest();
		const live: { ifname: string; iccid: string; model: string } | undefined = {
			ifname: "fixture1",
			iccid: "8900000000000000001",
			model: "RM520N-GL",
		};
		let current: typeof live | undefined = live;
		const committed = {
			"1": {
				ifname: "fixture1",
				stable_key: "port-1",
				iccid: "8900000000000000001",
				model: "RM520N-GL",
			},
		};
		const deps = {
			enabled: async () => true,
			registration: () => ({ value: "home", capturedAt: 1000 }),
			readNas: async () => {
				if (change === "swap") live.iccid = "8900000000000000002";
				else current = undefined;
				return { signal: "LTE:\n RSRP: '-90 dBm'", band: "" };
			},
			readText: async () => "100",
			realpath: async () => "/sys/1-1/1-1:1.4",
			run: async () => "",
			health: () => undefined,
			modem: () => current as never,
		};
		await sample(committed, 1000, deps);
		const served = getRadioHealth(committed, 1000)["1"];
		expect(served?.metrics["lte.rsrp"]).toBeUndefined();
		expect(served?.timeline ?? []).toHaveLength(0);
		expect(radioForModem("1", committed["1"], 1000).metrics["lte.rsrp"]).toBe(
			undefined,
		);
	}
});

test("a SIM that returns after a swap starts without the old byte baseline", async () => {
	let bytes = 100;
	const live = { ifname: "fixture1", iccid: "8900000000000000001" };
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1", iccid: live.iccid },
		"2": { ifname: "fixture2", stable_key: "port-2" },
	};
	const deps = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => ({ signal: "", band: "" }),
		readText: async (path: string) =>
			path.includes("fixture1") ? String(bytes) : "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: (id: number) => (id === 1 ? (live as never) : undefined),
	};
	await sample(rows, 1000, deps);
	live.iccid = "8900000000000000002"; // swapped, not yet committed
	bytes = 500; // sent by the other SIM
	await sample(rows, 21000, deps);
	live.iccid = "8900000000000000001"; // the first SIM is back
	await sample(rows, 41000, deps);
	expect(
		getRadioHealth(rows, 41000)["2"]?.neighbours.find((n) => n.id === "1")
			?.transmitting,
	).toBe("unknown");
});

const quiet = {
	enabled: async () => true,
	readNas: async () => ({ signal: "", band: "" }),
	readText: async () => "100",
	realpath: async () => "/sys/1-1/1-1:1.4",
	run: async () => "",
	health: () => undefined,
};

test("registration is the value committed with the row; a live read only renews an agreeing one", async () => {
	const live = { ifname: "fixture1", iccid: "8900000000000000001" };
	let observed = { value: "home" as string | undefined, capturedAt: 1000 };
	const deps = {
		...quiet,
		registration: () => observed,
		modem: () => live as never,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1", iccid: live.iccid },
	};
	commitRadioRoster(rows, deps);
	// A same-SIM refresh staged a different registration: not committed yet.
	observed = { value: "searching", capturedAt: 2000 };
	await refreshRadioHealth(3000, deps);
	expect(getRadioHealth(rows, 3000)["1"]?.registration).toMatchObject({
		value: "home",
		capturedAt: 1000,
	});
	expect(radioForModem("1", rows["1"], 3000).registration.value).toBe("home");
	// A later live read that agrees with the commit renews its time.
	observed = { value: "home", capturedAt: 31000 };
	await refreshRadioHealth(31000, deps);
	expect(getRadioHealth(rows, 31000)["1"]?.registration.capturedAt).toBe(31000);
	// The staged value is served once it is committed.
	observed = { value: "searching", capturedAt: 40000 };
	commitRadioRoster(rows, deps);
	await refreshRadioHealth(41000, deps);
	expect(getRadioHealth(rows, 41000)["1"]?.registration.value).toBe(
		"searching",
	);
});

test("a committed swap and return between polls starts a new baseline and history", async () => {
	let bytes = 100;
	const rowsA = {
		"1": { ifname: "fixture1", stable_key: "port-1", iccid: "89001" },
		"2": { ifname: "fixture2", stable_key: "port-2" },
	};
	const rowsB = { ...rowsA, "1": { ...rowsA["1"], iccid: "89002" } };
	let live = { ifname: "fixture1", iccid: "89001" };
	const deps = {
		...quiet,
		registration: () => undefined,
		readText: async (path: string) =>
			path.includes("fixture1") ? String(bytes) : "100",
		modem: (id: number) => (id === 1 ? (live as never) : undefined),
	};
	await sample(rowsA, 1000, deps);
	await sample(rowsA, 11000, deps);
	expect(getRadioHealth(rowsA, 11000)["1"]?.timeline).toHaveLength(2);
	// A to B and back to A, each committed, with no poll in between.
	live = { ifname: "fixture1", iccid: "89002" };
	commitRadioRoster(rowsB, deps);
	expect(radioForModem("1", rowsB["1"], 11000).capturedAt).toBe(0);
	live = { ifname: "fixture1", iccid: "89001" };
	commitRadioRoster(rowsA, deps);
	// Neither the old record nor its history comes back with the SIM.
	expect(getRadioHealth(rowsA, 11000)["1"]).toBeUndefined();
	bytes = 500; // partly sent while B was in the slot
	await refreshRadioHealth(21000, deps);
	const served = getRadioHealth(rowsA, 21000);
	expect(served["1"]?.timeline).toHaveLength(1);
	expect(served["2"]?.neighbours.find((n) => n.id === "1")?.transmitting).toBe(
		"unknown",
	);
});

test("a neighbour whose identity a commit changes is never published with its old readings", async () => {
	const band = (value: string) => ({
		tech: "lte" as const,
		band: value,
		provenance: { source: "ModemManager", observed_at: 1000 },
	});
	const rowsA = {
		"1": {
			ifname: "fixture1",
			stable_key: "port-1",
			iccid: "89001",
			cell_info: band("3"),
		},
		"2": {
			ifname: "fixture2",
			stable_key: "port-2",
			model: "RM520N-GL",
			cell_info: band("7"),
		},
	};
	const rowsB = { ...rowsA, "1": { ...rowsA["1"], iccid: "89002" } };
	let live = { ifname: "fixture1", iccid: "89001" };
	const base = {
		...quiet,
		registration: () => undefined,
		modem: (id: number) => (id === 1 ? (live as never) : undefined),
	};
	// The swap of 1 commits while the sampler reads 2.
	await sample(rowsA, 1000, {
		...base,
		readNas: async (id: number) => {
			if (id === 2) {
				live = { ifname: "fixture1", iccid: "89002" };
				commitRadioRoster(rowsB, base);
			}
			return { signal: "", band: "" };
		},
	});
	const during = getRadioHealth(rowsB, 1000);
	expect(during["1"]).toBeUndefined();
	const neighbour = during["2"]?.neighbours.find((n) => n.id === "1");
	expect(neighbour?.band.value ?? null).toBeNull();
	expect(neighbour?.transmitting ?? "unknown").toBe("unknown");
	// Nor is it kept in 2's history as that ID's reading.
	const kept = during["2"]?.timeline[0]?.observation.neighbours.find(
		(n) => n.id === "1",
	);
	expect(kept?.band.value ?? null).toBeNull();

	// After a clean poll, a commit that swaps 1 before the next one withholds
	// what 2's record says about it, in the broadcast and the dialog alike.
	live = { ifname: "fixture1", iccid: "89001" };
	await sample(rowsA, 2000, base);
	expect(
		getRadioHealth(rowsA, 2000)["2"]?.neighbours.find((n) => n.id === "1")?.band
			.value,
	).toBe("3");
	live = { ifname: "fixture1", iccid: "89002" };
	commitRadioRoster(rowsB, base);
	for (const record of [
		radioForModem("2", rowsB["2"], 2000),
		getRadioHealth(rowsB, 2000)["2"],
	]) {
		const n = record?.neighbours.find((other) => other.id === "1");
		expect(n?.band.value).toBeNull();
		expect(n?.transmitting).toBe("unknown");
		expect(record?.finding.neighbour).toBeUndefined();
	}
});

test("a fresh committed read replaces one the sample found expired", async () => {
	const live = { ifname: "fixture1" };
	let observed = { value: "home" as string | undefined, capturedAt: 1000 };
	const deps = {
		...quiet,
		registration: () => observed,
		modem: () => live as never,
	};
	const rows = { "1": { ifname: "fixture1", stable_key: "port-1" } };
	// Sampled at 70 s: the committed read from 1 s has expired.
	await sample(rows, 70000, deps);
	expect(radioForModem("1", rows["1"], 70000).registration.value).toBeNull();
	// A later commit brings a fresh read of the same value.
	observed = { value: "home", capturedAt: 71000 };
	commitRadioRoster(rows, deps);
	for (const record of [
		radioForModem("1", rows["1"], 72000),
		getRadioHealth(rows, 72000)["1"],
	]) {
		expect(record?.registration.value).toBe("home");
		expect(record?.registration.capturedAt).toBe(71000);
	}
});
