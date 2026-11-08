import { expect, spyOn, test } from "bun:test";
import { hotspotClientsSchema } from "@ceraui/rpc/schemas";

import { logger } from "../helpers/logger.ts";
import { MockMonitorEmitter } from "../modules/network/monitor/mock-monitor.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import {
	broadcastWifiState,
	currentHotspotApIfnames,
	wifiBuildMsg,
} from "../modules/wifi/wifi.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	removeWifiInterface,
	wifiStateInit,
} from "../modules/wifi/wifi-connections.ts";
import {
	refreshHotspotClients,
	resetHotspotClientsForTest,
	setHotspotClientsChangeListener,
	setHotspotClientsDepsForTest,
	startHotspotClientsPoll,
	stopHotspotClientsPoll,
} from "../modules/wifi/wifi-hotspot-clients.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const SIZES = [0, 1, 31, 32, 33, 100] as const;
const mac = (n: number) => {
	const hex = n.toString(16).padStart(6, "0");
	return `02:ab:cd:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4)}`;
};
type RosterFrame = Record<string, { count: number; macs: string[] }>;
type Sample = {
	ifname: string;
	members: number[];
	outcome: "valid" | "failure" | "garbage";
	signal: number;
	done: boolean;
	started: boolean;
	gate: ReturnType<typeof Promise.withResolvers<string>>;
};

// Independent oracle: numeric station identities, the display last broadcast to
// existing viewers, and samples. Private snapshots never acknowledge that display.
async function scenario(seed: number): Promise<void> {
	let randomState = seed;
	const pick = (size: number) => {
		randomState ^= randomState << 13;
		randomState ^= randomState >>> 17;
		randomState ^= randomState << 5;
		return (randomState >>> 0) % size;
	};
	const registry = isolateWifiRegistry();
	const monitor = new MockMonitorEmitter();
	const radios = [0, 1, 2].map((id) => ({
		id,
		present: true,
		enabled: true,
		deleted: false,
		revision: 0,
		members: [id + 1],
		signal: -40,
		outcome: "valid" as Sample["outcome"],
	}));
	const interfaces: WifiInterfaceWithHotspot[] = radios.map(({ id }) => ({
		id,
		ifname: `wlan${id}`,
		conn: "uplink",
		activeConn: "uplink",
		activeMode: "infrastructure",
		hw: "model-radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		supportsApStaConcurrency: true,
		hotspot: {
			conn: "hotspot",
			name: "model",
			availableChannels: ["auto"],
			warnings: {},
		},
	}));
	const apName = (radio: (typeof radios)[number]) =>
		`clap-wlan${radio.id}r${radio.revision}`;
	const active = () => radios.filter((r) => r.present && r.enabled);
	const sync = () => {
		for (const radio of radios) {
			const iface = interfaces[radio.id];
			if (!iface) throw new Error("missing model radio");
			iface.ifname = `wlan${radio.id}r${radio.revision}`;
			if (radio.deleted) delete iface.concurrentHotspot;
			else
				iface.concurrentHotspot = {
					ifname: apName(radio),
					activeConn: radio.enabled ? "hotspot" : null,
				};
			if (radio.present) addWifiInterface(mac(1000 + radio.id), iface);
			else removeWifiInterface(mac(1000 + radio.id));
		}
	};
	const cache = new Map<string, { members: number[]; at: number }>();
	const flights = new Map<string, Sample>();
	const samples: Sample[] = [];
	const batches: { samples: Sample[]; listener: number; done: boolean }[] = [];
	const running: Promise<unknown>[] = [];
	const expected: RosterFrame[] = [];
	const actual: RosterFrame[] = [];
	const listenerErrors: string[] = [];
	const debug = spyOn(logger, "debug").mockImplementation((message) => {
		if (String(message).includes("change listener failed"))
			listenerErrors.push(String(message));
		return logger;
	});
	let published = "[]";
	let listener = 0;
	let listenerSerial = 0;
	let polling = false;
	let sampling = false;
	let now = 100_000;
	let nextTimer = 0;
	let nextMember = 10_000;
	const intervals = new Map<
		number | ReturnType<typeof setInterval>,
		() => void
	>();
	const timers = {
		setInterval(callback: () => void, delay: number) {
			expect(delay).toBe(5000);
			intervals.set(++nextTimer, callback);
			return nextTimer;
		},
		clearInterval(id: number | ReturnType<typeof setInterval>) {
			intervals.delete(id);
		},
	};
	const display = () => {
		const names = active().map(apName);
		for (const name of [...cache.keys(), ...flights.keys()]) {
			if (!names.includes(name)) {
				cache.delete(name);
				flights.delete(name);
			}
		}
		return active().flatMap((radio) => {
			const entry = cache.get(apName(radio));
			return entry === undefined
				? []
				: [{ id: radio.id, members: entry.members }];
		});
	};
	const publication = (kind: "private" | "broadcast") => {
		const rows = display();
		if (kind === "broadcast") {
			published = JSON.stringify(
				rows.map(({ id, members }) => [id, [...members].sort((a, b) => a - b)]),
			);
			expected.push(
				Object.fromEntries(
					rows.map(({ id, members }) => [
						id,
						{ count: members.length, macs: members.slice(0, 32).map(mac) },
					]),
				),
			);
		}
		// A snapshot can also join outstanding stale/unread samples. Its
		// eventual completion is another opportunity to publish a changed view.
		batches.push({
			samples: active().flatMap((radio) => {
				const name = apName(radio),
					entry = cache.get(name),
					flight = flights.get(name);
				return flight && (entry === undefined || now - entry.at >= 5000)
					? [flight]
					: [];
			}),
			listener,
			done: false,
		});
	};
	const completeBatches = () => {
		for (const batch of batches) {
			if (batch.done || batch.samples.some((s) => !s.done)) continue;
			batch.done = true;
			if (listener === 0 || batch.listener !== listener) continue;
			const key = JSON.stringify(
				display().map(({ id, members }) => [
					id,
					[...members].sort((a, b) => a - b),
				]),
			);
			if (key !== published) publication("broadcast");
		}
	};
	const capture = spyOn(websocket, "broadcastMsg").mockImplementation(
		(type, data) => {
			if (
				type !== "status" ||
				typeof data !== "object" ||
				data === null ||
				!("wifi" in data)
			)
				throw new Error("unexpected model broadcast");
			if (typeof data.wifi !== "object" || data.wifi === null)
				throw new Error("missing Wi-Fi status");
			actual.push(
				Object.fromEntries(
					Object.entries(data.wifi).flatMap(([id, iface]) => {
						if (typeof iface !== "object" || iface === null)
							throw new Error("missing Wi-Fi row");
						if (!("hotspot" in iface)) return [];
						const hotspot = iface.hotspot;
						if (typeof hotspot !== "object" || hotspot === null)
							throw new Error("missing hotspot");
						if (!("clients" in hotspot)) return [];
						const clients = hotspotClientsSchema.parse(hotspot.clients);
						return [
							[
								id,
								{
									count: clients.count,
									macs: clients.stations.map((s) => s.mac),
								},
							],
						];
					}),
				),
			);
		},
	);
	const link = spyOn(
		capabilities,
		"refreshWifiLinkTelemetry",
	).mockResolvedValue(undefined);
	const caps = spyOn(
		capabilities,
		"getWifiCapabilitiesForInterface",
	).mockReturnValue(undefined);
	const wire = () =>
		setHotspotClientsDepsForTest({
			now: () => now,
			runIw: (args) => {
				// A builder may request an unread roster in the background. A failed
				// read preserves absence; only explicit sampling supplies new evidence.
				if (!sampling)
					return Promise.reject(new Error("background read unavailable"));
				const sample = flights.get(args[1] ?? "");
				if (!sample || sample.started)
					throw new Error("duplicate or unexpected iw flight");
				sample.started = true;
				return sample.gate.promise;
			},
		});
	const init = () => {
		listener = ++listenerSerial;
		polling = true;
		wifiStateInit(monitor, timers);
	};
	const replaceListener = (enabled: boolean) => {
		listener = enabled ? ++listenerSerial : 0;
		setHotspotClientsChangeListener(
			enabled ? () => broadcastWifiState() : null,
		);
	};
	const tick = () => {
		if (!polling) return;
		display();
		const waiting = active().map((radio) => {
			const ifname = apName(radio);
			let sample = flights.get(ifname);
			if (!sample) {
				sample = {
					ifname,
					members: [...radio.members],
					outcome: radio.outcome,
					signal: radio.signal,
					done: false,
					started: false,
					gate: Promise.withResolvers<string>(),
				};
				flights.set(ifname, sample);
				samples.push(sample);
			}
			return sample;
		});
		batches.push({ samples: waiting, listener, done: false });
		now += 5000;
		sampling = true;
		running.push(
			Promise.all([...intervals.values()].map((callback) => callback())),
		);
		sampling = false;
	};
	const release = (sample: Sample) => {
		if (sample.done) return;
		if (sample.outcome !== "failure") display();
		sample.done = true;
		if (
			flights.get(sample.ifname) === sample &&
			active().some((r) => apName(r) === sample.ifname)
		) {
			if (sample.outcome === "valid")
				cache.set(sample.ifname, { members: sample.members, at: now });
			if (sample.outcome === "garbage") cache.delete(sample.ifname);
			flights.delete(sample.ifname);
		}
		if (sample.outcome === "failure")
			sample.gate.reject(new Error("iw failed"));
		else
			sample.gate.resolve(
				sample.outcome === "garbage"
					? "Station <unknown>\n"
					: sample.members
							.map(
								(n) =>
									`Station ${mac(n).toUpperCase()}\n\tsignal: ${sample.signal} dBm\n`,
							)
							.join(""),
			);
	};
	const check = async (event: string) => {
		completeBatches();
		// Drain the finite promise graph, not a timer or a wall-clock deadline.
		for (let i = 0; i < 24; i++) await Promise.resolve();
		expect(listenerErrors).toEqual([]);
		expect(actual, `seed ${seed}: ${event}`).toEqual(expected);
		expect(intervals.size).toBe(polling ? 1 : 0);
	};
	const privateSnapshot = () => {
		publication("private");
		wifiBuildMsg();
	};
	try {
		resetHotspotClientsForTest();
		sync();
		wire();
		init();
		tick();
		samples.forEach(release);
		await check("initial measured roster");
		// Every seed starts with the previously missed external publication.
		const first = radios[0];
		if (!first) throw new Error("missing first radio");
		// A new viewer connects after one AP has measured a join while the
		// remaining dumps are held. Existing viewers still need that join.
		first.members.push(nextMember++);
		tick();
		const joined = flights.get(apName(first));
		if (!joined) throw new Error("missing staggered sample");
		release(joined);
		await check("first AP measured an unannounced join");
		privateSnapshot();
		privateSnapshot();
		await check("repeated private snapshots during staggered dumps");
		samples.filter((s) => !s.done).forEach(release);
		await check("pending join reaches existing viewers");
		first.enabled = false;
		first.deleted = true;
		sync();
		publication("broadcast");
		broadcastWifiState();
		await check("structural off publication");
		tick();
		samples.filter((s) => !s.done).forEach(release);
		await check("empty removal poll after structural publication");
		first.enabled = true;
		first.deleted = false;
		sync();

		for (let step = 0; step < 120; step++) {
			const event = pick(31);
			const radio = radios[pick(radios.length)];
			if (!radio) throw new Error("missing generated radio");
			switch (event) {
				case 0:
				case 1: {
					const size = SIZES[pick(SIZES.length)] ?? 0;
					radio.members = Array.from({ length: size }, () => nextMember++);
					radio.outcome = "valid";
					break;
				}
				case 2:
					radio.members.push(nextMember++);
					break;
				case 3:
					radio.members.pop();
					break;
				case 4:
					radio.members = [...radio.members.slice(0, -1), nextMember++];
					break;
				case 5:
					radio.members.reverse();
					break;
				case 6:
					radio.signal = -pick(100);
					break;
				case 7:
					radio.enabled = !radio.enabled;
					radio.deleted = false;
					break;
				case 8:
					radio.enabled = false;
					radio.deleted = true;
					break;
				case 9:
					radio.enabled = true;
					radio.deleted = false;
					break;
				case 10:
					radio.revision++;
					break;
				case 11:
					radio.present = !radio.present;
					break;
				case 12:
				case 13:
				case 14:
				case 15:
					tick();
					break;
				case 16:
				case 17:
				case 18:
				case 19: {
					const held = samples.filter((s) => !s.done);
					const sample = held[pick(Math.max(1, held.length))];
					if (sample) release(sample);
					break;
				}
				case 20:
					replaceListener(false);
					break;
				case 21:
					replaceListener(true);
					break;
				case 22:
					polling = false;
					stopHotspotClientsPoll();
					break;
				case 23:
					polling = true;
					startHotspotClientsPoll(currentHotspotApIfnames, timers);
					break;
				case 24:
					init();
					init();
					break;
				case 25:
					resetHotspotClientsForTest();
					cache.clear();
					flights.clear();
					published = "[]";
					listener = 0;
					polling = false;
					wire();
					break;
				case 26:
					radio.outcome = "failure";
					break;
				case 27:
					radio.outcome = "garbage";
					break;
				case 28:
				case 29:
				case 30:
					privateSnapshot();
					privateSnapshot();
					break;
			}
			sync();
			await check(`step ${step}, event ${event}`);
			if (step % 11 === 0) {
				if (step % 22 === 0) {
					privateSnapshot();
				} else {
					publication("broadcast");
					broadcastWifiState();
				}
				await check(`step ${step}, independent Wi-Fi publication`);
			}
		}
		samples.filter((s) => !s.done).forEach(release);
		await check("all held samples released");
		await Promise.all(running);
	} finally {
		resetHotspotClientsForTest();
		for (const sample of samples) if (!sample.done) sample.gate.resolve("");
		await Promise.all(running);
		monitor.reset();
		capture.mockRestore();
		link.mockRestore();
		caps.mockRestore();
		debug.mockRestore();
		restoreWifiRegistry(registry);
	}
}

const firstSeed = Number(process.env.HOTSPOT_MODEL_SEED ?? 1);
const seedCount = Number(process.env.HOTSPOT_MODEL_SEEDS ?? 320);
for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
	test(`published roster model agrees after every event, seed ${seed}`, () =>
		scenario(seed));
}

for (const hybrid of [false, true])
	for (const change of [
		"join",
		"leave",
		"unchanged",
		"already broadcast",
	] as const) {
		test(`private snapshots during staggered ${hybrid ? "Hybrid" : "Hotspot"} dumps: ${change}`, async () => {
			const registry = isolateWifiRegistry();
			const monitor = new MockMonitorEmitter();
			const frames: unknown[] = [];
			const capture = spyOn(websocket, "broadcastMsg").mockImplementation(
				(type, data) => {
					frames.push({ type, data });
				},
			);
			const link = spyOn(
				capabilities,
				"refreshWifiLinkTelemetry",
			).mockResolvedValue(undefined);
			const first = Promise.withResolvers<string>();
			const second = Promise.withResolvers<string>();
			const aps = hybrid ? ["clap-wlan0", "clap-wlan1"] : ["wlan0", "wlan1"];
			const station = "Station aa:bb:cc:dd:ee:01\n";
			const baseline = change === "leave" ? station : "";
			const next = change === "unchanged" || change === "leave" ? "" : station;
			const count = next === "" ? 0 : 1;
			const timers = {
				setInterval: () => 1,
				clearInterval: () => undefined,
			};
			let pending: Promise<void> | undefined;
			let now = 100_000;
			try {
				resetHotspotClientsForTest();
				for (const id of [0, 1]) {
					const iface: WifiInterfaceWithHotspot = {
						id,
						ifname: `wlan${id}`,
						conn: hybrid ? "upstream" : "hotspot",
						activeConn: hybrid ? "upstream" : "hotspot",
						activeMode: hybrid ? "infrastructure" : "ap",
						hw: "snapshot-radio",
						available: new Map(),
						saved: {},
						savedAll: {},
						...(hybrid
							? {
									supportsApStaConcurrency: true,
									concurrentHotspot: {
										ifname: `clap-wlan${id}`,
										activeConn: "hotspot",
									},
								}
							: {}),
						hotspot: {
							conn: "hotspot",
							name: "snapshot",
							availableChannels: ["auto"],
							warnings: {},
						},
					};
					addWifiInterface(mac(1000 + id), iface);
				}
				setHotspotClientsDepsForTest({
					now: () => now,
					runIw: async (args) => (args[1] === aps[0] ? baseline : ""),
				});
				await refreshHotspotClients(aps);
				broadcastWifiState();
				expect(frames).toHaveLength(1);
				frames.length = 0;
				wifiStateInit(monitor, timers);
				wifiStateInit(monitor, timers);
				// A private read of unchanged state neither broadcasts nor consumes
				// the later join/leave.
				wifiBuildMsg();
				expect(frames).toHaveLength(0);
				setHotspotClientsDepsForTest({
					now: () => now,
					runIw: (args) =>
						args[1] === aps[0] ? first.promise : second.promise,
				});
				pending = refreshHotspotClients(aps, { force: true });
				first.resolve(next);
				await first.promise;
				for (let i = 0; i < 3; i++) {
					expect(wifiBuildMsg()[0]?.hotspot?.clients?.count).toBe(count);
					expect(frames).toHaveLength(0);
				}
				if (change === "already broadcast") broadcastWifiState();
				second.resolve("");
				await pending;
				now += 5000;
				setHotspotClientsDepsForTest({
					now: () => now,
					runIw: async (args) => (args[1] === aps[0] ? next : ""),
				});
				await refreshHotspotClients(aps, { force: true });
				expect(frames).toHaveLength(change === "unchanged" ? 0 : 1);
				if (change !== "unchanged")
					expect(frames[0]).toMatchObject({
						type: "status",
						data: { wifi: { "0": { hotspot: { clients: { count } } } } },
					});
			} finally {
				first.resolve("");
				second.resolve("");
				await pending;
				resetHotspotClientsForTest();
				monitor.reset();
				link.mockRestore();
				capture.mockRestore();
				restoreWifiRegistry(registry);
			}
		});
	}
