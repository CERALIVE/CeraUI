import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";
import {
	initCellularStack,
	resetCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import {
	broadcastModems,
	broadcastRadioHealth,
	getCommittedModemsWireMessage as getCommittedState,
} from "../modules/modems/modem-status.ts";
import {
	refreshModemIdPaths,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import {
	getModemIds,
	getModem as getModemState,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import {
	getRadioHealth,
	refreshRadioHealth,
	resetRadioHealthForTest,
} from "../modules/modems/radio-health-runtime.ts";
import {
	resetRoamingAdvisoryState,
	standingRoamingAdvisoryNames,
} from "../modules/modems/roaming-advisory.ts";
import {
	getRadioRegistrationObservation,
	recordRadioRegistration,
} from "../modules/modems/state/radio-registration.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { getAllModemsProcedure } from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function modem(name: string): Modem {
	return {
		ifname: `wwan-${name}`,
		name,
		network_type: { supported: {}, active: null },
		status: {
			connection: "disconnected",
			network_type: "unknown",
			signal: 0,
			roaming: false,
		},
	} as unknown as Modem;
}

function context(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function clearModems(): void {
	for (const id of getModemIds()) removeModem(id);
}

describe("committed modem snapshot", () => {
	beforeEach(async () => {
		clearModems();
		resetCellularStack();
		await initCellularStack({ backend: "mmcli" });
	});

	afterEach(() => {
		clearModems();
		resetCellularStack();
	});

	test("radio enrichment cannot replay control fields into a subscriber", () => {
		setModem(1, modem("diagnostic"));
		broadcastModems();
		const frames: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (frame: string) => frames.push(frame),
		} as unknown as AppWebSocket;
		addClient(client);
		try {
			broadcastRadioHealth();
			expect(frames.length).toBe(1);
			const frame = JSON.parse(frames[0] ?? "{}");
			expect(Object.keys(frame.status.modems["1"])).toEqual([
				"status",
				"radio_health",
			]);
			expect(frame.status.modems["1"].radio_health.finding.kind).toBe(
				"unknown",
			);
		} finally {
			removeClient(client);
		}
	});

	test("radio enrichment publishes the committed roster, never a staged change", async () => {
		setModem(1, modem("one"));
		setModem(2, modem("two"));
		broadcastModems();
		// A reconciliation is mid-flight: a staged signal change and a removal.
		const staged = modem("one");
		staged.status = { ...staged.status, signal: 99 } as Modem["status"];
		setModem(1, staged);
		removeModem(2);
		const frames: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (frame: string) => frames.push(frame),
		} as unknown as AppWebSocket;
		addClient(client);
		try {
			broadcastRadioHealth();
			const frame = JSON.parse(frames[0] ?? "{}");
			expect(Object.keys(frame.status.modems).sort()).toEqual(["1", "2"]);
			// The committed status, never the staged signal.
			expect(frame.status.modems["1"].status.signal).toBe(0);
		} finally {
			removeClient(client);
		}
		const result = (await call(getAllModemsProcedure, undefined, {
			context: context(),
		})) as Record<string, { status?: { signal?: number } }>;
		expect(result["1"]?.status?.signal).toBe(0);
		expect(Object.keys(result).sort()).toEqual(["1", "2"]);
	});

	test("a status-only commit after a SIM swap still carries the radio reset", async () => {
		resetRadioHealthForTest();
		const before = { ...modem("one"), iccid: "8900000000000000001" } as Modem;
		setModem(1, before);
		broadcastModems();
		await refreshRadioHealth(Date.now(), {
			enabled: async () => true,
			registration: () => ({ value: "home", capturedAt: Date.now() }),
			readNas: async () => ({ signal: "", band: "" }),
			readText: async () => "100",
			realpath: async () => "/sys/1-1/1-1:1.4",
			run: async () => "",
			health: () => undefined,
			modem: () => before as never,
		});
		setModem(1, { ...before, iccid: "8900000000000000002" } as Modem);
		const frames: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (frame: string) => frames.push(frame),
		} as unknown as AppWebSocket;
		addClient(client);
		try {
			broadcastModems({});
			const frame = JSON.parse(frames.at(-1) ?? "{}");
			expect(frame.status.modems["1"].radio_health.capturedAt).toBe(0);
		} finally {
			removeClient(client);
			resetRadioHealthForTest();
		}
	});

	test("the reset still reaches subscribers when the sampler saw the swap first", async () => {
		resetRadioHealthForTest();
		const before = { ...modem("one"), iccid: "8900000000000000001" } as Modem;
		setModem(1, before);
		broadcastModems();
		const deps = (live: Modem) => ({
			enabled: async () => true,
			registration: () => ({ value: "home", capturedAt: Date.now() }),
			readNas: async () => ({ signal: "", band: "" }),
			readText: async () => "100",
			realpath: async () => "/sys/1-1/1-1:1.4",
			run: async () => "",
			health: () => undefined,
			modem: () => live as never,
		});
		await refreshRadioHealth(Date.now(), deps(before));
		const swapped = { ...before, iccid: "8900000000000000002" } as Modem;
		setModem(1, swapped);
		// The poll samples before the swap is committed: it skips the row.
		await refreshRadioHealth(Date.now() + 1, deps(swapped));
		const frames: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (frame: string) => frames.push(frame),
		} as unknown as AppWebSocket;
		addClient(client);
		try {
			broadcastModems({});
			const frame = JSON.parse(frames.at(-1) ?? "{}");
			expect(frame.status.modems["1"].radio_health.capturedAt).toBe(0);
		} finally {
			removeClient(client);
			resetRadioHealthForTest();
		}
	});

	/** Frames sent to one subscriber while `run` broadcasts. */
	function capture(run: () => void): Array<{
		status?: { modems?: Record<string, Record<string, unknown>> };
		notification?: { show?: { name: string }[]; remove?: { id: string }[] };
	}> {
		const frames: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (frame: string) => frames.push(frame),
		} as unknown as AppWebSocket;
		addClient(client);
		try {
			run();
		} finally {
			removeClient(client);
		}
		return frames.map((frame) => JSON.parse(frame));
	}
	type Radio = {
		neighbours: { id: string; band: { value: unknown } }[];
		registration: { value: unknown };
		finding: { kind: string };
		timeline: {
			observation?: { neighbours: { id: string; band: { value: unknown } }[] };
		}[];
	};
	const neighbourBand = (radio: Radio | undefined, id: string) =>
		radio?.neighbours.find((n) => n.id === id)?.band.value ?? null;
	const sampler = (registration = () => undefined as never) => ({
		enabled: async () => true,
		registration,
		readNas: async () => ({ signal: "", band: "Active band: 'LTE band 3'" }),
		readText: async () => "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: (id: number) =>
			getModemIds().includes(id) ? (getModemState(id) as never) : undefined,
	});
	const radioModem = (name: string, iccid: string) =>
		({ ...modem(name), model: "RM520N-GL", iccid }) as Modem;

	test("a swap or removal commit never publishes the old neighbour reading", async () => {
		resetRadioHealthForTest();
		try {
			for (const change of ["swap", "removal"] as const) {
				clearModems();
				setModem(1, radioModem("one", "8900000000000000001"));
				setModem(2, radioModem("two", "8900000000000000002"));
				broadcastModems();
				await refreshRadioHealth(Date.now(), sampler());
				broadcastRadioHealth();
				const before = getCommittedState()["2"]?.radio_health as Radio;
				expect(neighbourBand(before, "1")).toBe("LTE band 3");
				const sampledAt = getRadioHealth(getCommittedState())[
					"2"
				]?.timeline.map((entry) => entry.at);
				expect(sampledAt?.length ?? 0).toBeGreaterThan(0);

				if (change === "swap")
					setModem(1, radioModem("one", "8900000000000000009"));
				else removeModem(1);
				for (const fullState of [{}, undefined]) {
					const frames = capture(() => broadcastModems(fullState));
					const rows = frames.at(-1)?.status?.modems ?? {};
					const row2 = rows["2"]?.radio_health as Radio | undefined;
					expect(row2).toBeDefined();
					expect(neighbourBand(row2, "1")).toBeNull();
					if (change === "swap") {
						// The changed SIM reaches subscribers as a full descriptor.
						expect(rows["1"]?.iccid).toBe("8900000000000000009");
						expect(rows["1"]?.name).toBe("one");
					}
					const all = (await call(getAllModemsProcedure, undefined, {
						context: context(),
					})) as Record<string, { radio_health?: Radio }>;
					expect(neighbourBand(all["2"]?.radio_health, "1")).toBeNull();
				}
				// Nor does the dialog's retained history keep it under that ID.
				// The entry itself stays, with its time; only the reading of 1 goes.
				const history = getRadioHealth(getCommittedState())["2"];
				expect(history?.timeline.map((entry) => entry.at)).toEqual(
					sampledAt ?? [],
				);
				for (const entry of history?.timeline ?? []) {
					const kept = entry.observation?.neighbours.find((n) => n.id === "1");
					expect(kept).toBeDefined();
					expect(kept?.band.value ?? null).toBeNull();
				}
			}
		} finally {
			resetRadioHealthForTest();
		}
	});

	test("a registration committed during the reads is what the record shows", async () => {
		resetRadioHealthForTest();
		try {
			const first = radioModem("one", "8900000000000000001");
			recordRadioRegistration(first, { value: "home", capturedAt: Date.now() });
			setModem(1, first);
			broadcastModems();
			const deps = sampler((m?: Modem) =>
				getRadioRegistrationObservation(m),
			) as Parameters<typeof refreshRadioHealth>[1] & object;
			await refreshRadioHealth(Date.now(), {
				...deps,
				readNas: async () => {
					// Same SIM, new status and registration, committed mid-poll.
					const next = {
						...first,
						status: { ...first.status, connection: "searching" },
					} as Modem;
					recordRadioRegistration(next, {
						value: "searching",
						capturedAt: Date.now(),
					});
					setModem(1, next);
					broadcastModems({});
					return { signal: "", band: "" };
				},
			});
			const frames = capture(() => broadcastRadioHealth());
			const row = frames.at(-1)?.status?.modems?.["1"] as
				| { status?: { connection?: string }; radio_health?: Radio }
				| undefined;
			expect(row?.status?.connection).toBe("searching");
			expect(row?.radio_health?.registration.value).toBe("searching");
			expect(row?.radio_health?.finding.kind).toBe("unknown");
		} finally {
			resetRadioHealthForTest();
		}
	});

	test("a registration commit reaches existing subscribers with its radio record", async () => {
		resetRadioHealthForTest();
		try {
			const first = radioModem("one", "8900000000000000001");
			recordRadioRegistration(first, { value: "home", capturedAt: Date.now() });
			setModem(1, first);
			setModem(2, radioModem("two", "8900000000000000002"));
			broadcastModems();
			await refreshRadioHealth(
				Date.now(),
				sampler((m?: Modem) => getRadioRegistrationObservation(m)) as never,
			);
			const next = {
				...first,
				status: { ...first.status, connection: "searching" },
			} as Modem;
			recordRadioRegistration(next, {
				value: "searching",
				capturedAt: Date.now(),
			});
			setModem(1, next);
			const rows = capture(() => broadcastModems({})).at(-1)?.status?.modems;
			const radio = rows?.["1"]?.radio_health as Radio | undefined;
			expect(radio?.registration.value).toBe("searching");
			expect(radio?.finding.kind).toBe("unknown");
			// The other modem's row stays status-only.
			expect(rows?.["2"] && "radio_health" in rows["2"]).toBe(false);
		} finally {
			resetRadioHealthForTest();
		}
	});

	test("a fresh read of a value the sample found expired reaches existing subscribers", async () => {
		resetRadioHealthForTest();
		try {
			const first = radioModem("one", "8900000000000000001");
			recordRadioRegistration(first, {
				value: "home",
				capturedAt: Date.now() - 70_000,
			});
			setModem(1, first);
			broadcastModems();
			await refreshRadioHealth(
				Date.now(),
				sampler((m?: Modem) => getRadioRegistrationObservation(m)) as never,
			);
			const stale = getCommittedState()["1"]?.radio_health as Radio;
			expect(stale.registration.value).toBeNull();
			// A signal change commits with a fresh read of the same value.
			const next = {
				...first,
				status: { ...first.status, signal: 40 },
			} as Modem;
			recordRadioRegistration(next, { value: "home", capturedAt: Date.now() });
			setModem(1, next);
			const rows = capture(() => broadcastModems({})).at(-1)?.status?.modems;
			const radio = rows?.["1"]?.radio_health as Radio | undefined;
			expect(radio?.registration.value).toBe("home");
		} finally {
			resetRadioHealthForTest();
		}
	});

	test("a status-only broadcast keeps a roaming advisory in its stable slot", async () => {
		resetRoamingAdvisoryState();
		setModemIdPathReader(
			async () => new Map([["wwan-roamer", "platform-xhci-usb-0:1.2:1.4"]]),
		);
		try {
			await refreshModemIdPaths();
			const roamer = modem("roamer");
			roamer.status = { ...roamer.status, roaming: true } as Modem["status"];
			setModem(1, roamer);
			setModem(2, modem("other"));
			capture(() => broadcastModems());
			const standing = standingRoamingAdvisoryNames();
			expect(standing).toHaveLength(1);
			const frames = capture(() => broadcastModems({}));
			expect(standingRoamingAdvisoryNames()).toEqual(standing);
			expect(frames.flatMap((f) => f.notification?.remove ?? [])).toEqual([]);
			expect(frames.flatMap((f) => f.notification?.show ?? [])).toEqual([]);
		} finally {
			setModemIdPathReader(null);
			await refreshModemIdPaths();
			resetRoamingAdvisoryState();
		}
	});

	test("getAll serves the last complete commit while mutable state is changing", async () => {
		// Given one fully-published modem snapshot
		setModem(1, modem("committed"));
		broadcastModems();

		// When a new row appears before the reconciliation commits its snapshot
		setModem(2, modem("in-progress"));
		broadcastRadioHealth();
		const startedAt = performance.now();
		const result = await call(getAllModemsProcedure, undefined, {
			context: context(),
		});

		// Then the read is immediate and cannot observe the half-applied state
		expect(performance.now() - startedAt).toBeLessThan(1_000);
		expect(Object.keys(result)).toEqual(["1"]);
	});
});
