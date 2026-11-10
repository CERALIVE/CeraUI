import { describe, expect, test } from "bun:test";
import {
	type RadioIdentityReaders,
	WifiRadioIdentityProducer,
} from "../modules/wifi/wifi-radio-identity.ts";

const MAC = "58:02:05:e1:79:1c";
const OTHER_MAC = "dc:a6:32:aa:bb:cc";
const PHY = "/sys/devices/radio/ieee80211/phy0";

type Netdev = { ifindex: string; phy: string };
type Phy = { index: string; mac?: string };

class RadioFiles {
	readonly netdevs = new Map<string, Netdev>([
		["wlan0", { ifindex: "3", phy: PHY }],
	]);
	readonly phys = new Map<string, Phy>([
		[PHY, { index: "0", mac: `${MAC.toUpperCase()}\n` }],
	]);
	beforeRead: (path: string) => void = () => {};
	readonly readers: RadioIdentityReaders = {
		readText: async (path) => {
			this.beforeRead(path);
			const ifname = /^\/sys\/class\/net\/([^/]+)\/ifindex$/.exec(path)?.[1];
			if (ifname) return this.netdevs.get(ifname)?.ifindex;
			for (const [phy, values] of this.phys) {
				if (path === `${phy}/index`) return values.index;
				if (path === `${phy}/macaddress`) return values.mac;
			}
			return undefined;
		},
		realpath: async (path) => {
			this.beforeRead(path);
			const ifname = /^\/sys\/class\/net\/([^/]+)\/phy80211$/.exec(path)?.[1];
			return ifname ? this.netdevs.get(ifname)?.phy : undefined;
		},
	};
}

describe("coherent radio evidence", () => {
	test("phy zero and a normalized permanent address produce a verified witness", async () => {
		const files = new RadioFiles();
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.rows.get("wlan0")).toMatchObject({
			key: MAC,
			classification: "verified",
			permanentMac: MAC,
			lifetime: { ifindex: 3, wiphy: 0, phyPath: PHY },
			degradedReason: undefined,
		});
	});

	test.each([2, 3, 4, 5])(
		"a netdev replacement at boundary read %i cannot seed the pair cache",
		async (replaceAt) => {
			const files = new RadioFiles();
			const producer = new WifiRadioIdentityProducer(files.readers);
			let reads = 0;
			files.beforeRead = () => {
				if (++reads === replaceAt) {
					files.netdevs.set("wlan0", { ifindex: "8", phy: PHY });
				}
			};
			await producer.discover([{ ifname: "wlan0" }]);
			expect(producer.state.rows.get("wlan0")).toMatchObject({
				key: "degraded:wlan0",
				classification: "unverified",
				lifetime: undefined,
				permanentMac: undefined,
			});
			files.beforeRead = () => {};
			files.phys.set(PHY, { index: "0" });
			await producer.discover([{ ifname: "wlan0" }]);
			expect(producer.state.rows.get("wlan0")?.permanentMac).toBeUndefined();
		},
	);

	test("a changed phy realpath rejects a sample even with the same ifindex", async () => {
		const files = new RadioFiles();
		let reads = 0;
		files.beforeRead = () => {
			if (++reads === 6) {
				files.netdevs.set("wlan0", { ifindex: "3", phy: `${PHY}-new` });
			}
		};
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.rows.get("wlan0")?.lifetime).toBeUndefined();
	});

	test.each([
		["0", "0"],
		["-1", "0"],
		["3.5", "0"],
		["", "0"],
		["3", "-1"],
		["3", "1.5"],
		["3", ""],
		["9007199254740992", "0"],
	])(
		"invalid kernel indexes %s/%s remain unverified",
		async (ifindex, wiphy) => {
			const files = new RadioFiles();
			files.netdevs.set("wlan0", { ifindex, phy: PHY });
			files.phys.set(PHY, { index: wiphy, mac: MAC });
			const producer = new WifiRadioIdentityProducer(files.readers);
			await producer.discover([{ ifname: "wlan0" }]);
			expect(producer.state.rows.get("wlan0")?.classification).toBe(
				"unverified",
			);
		},
	);

	test("unsafe interface names never reach an input reader", async () => {
		const files = new RadioFiles();
		const reads: string[] = [];
		files.beforeRead = (path) => reads.push(path);
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "../wlan0" }]);
		expect(reads).toEqual([]);
		expect(producer.state.rows.get("../wlan0")?.classification).toBe(
			"unverified",
		);
	});
});

describe("pair-scoped cache and shadow identities", () => {
	test("a true rename and a transient failed MAC read keep the same incarnation", async () => {
		const files = new RadioFiles();
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "wlan0" }]);
		const first = producer.state.rows.get("wlan0");
		files.netdevs.delete("wlan0");
		files.netdevs.set("wlrenamed", { ifindex: "3", phy: PHY });
		files.phys.set(PHY, { index: "0" });
		await producer.discover([{ ifname: "wlrenamed" }]);
		expect(producer.state.rows.get("wlrenamed")).toMatchObject({
			key: MAC,
			classification: "verified",
			incarnation: first?.incarnation,
		});
	});

	test("reused phy0 after module reload cannot recover a MAC from another ifindex", async () => {
		const files = new RadioFiles();
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "wlan0" }]);
		const first = producer.state.rows.get("wlan0")?.incarnation;
		files.netdevs.set("wlan0", { ifindex: "9", phy: PHY });
		files.phys.set(PHY, { index: "0" });
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.rows.get("wlan0")).toMatchObject({
			key: "degraded:wlan0",
			classification: "limited",
			permanentMac: undefined,
			lifetime: { ifindex: 9, wiphy: 0, phyPath: PHY },
		});
		expect(producer.state.rows.get("wlan0")?.incarnation).not.toBe(first);
	});

	test("a coherent limited placeholder keeps its incarnation across a true rename", async () => {
		const files = new RadioFiles();
		files.phys.set(PHY, { index: "0" });
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "wlan0" }]);
		const first = producer.state.rows.get("wlan0")?.incarnation;
		files.netdevs.delete("wlan0");
		files.netdevs.set("wlrenamed", { ifindex: "3", phy: PHY });
		await producer.discover([{ ifname: "wlrenamed" }]);
		expect(producer.state.rows.get("wlrenamed")).toMatchObject({
			key: "degraded:wlrenamed",
			incarnation: first,
			classification: "limited",
		});
	});

	test.each(["absent", "incoherent"] as const)(
		"%s pairs are pruned before a later failed MAC read",
		async (kind) => {
			const files = new RadioFiles();
			const producer = new WifiRadioIdentityProducer(files.readers);
			await producer.discover([{ ifname: "wlan0" }]);
			if (kind === "absent") {
				await producer.discover([]);
			} else {
				files.netdevs.set("wlan0", { ifindex: "", phy: PHY });
				await producer.discover([{ ifname: "wlan0" }]);
			}
			files.netdevs.set("wlan0", { ifindex: "3", phy: PHY });
			files.phys.set(PHY, { index: "0" });
			await producer.discover([{ ifname: "wlan0" }]);
			expect(producer.state.rows.get("wlan0")?.permanentMac).toBeUndefined();
		},
	);

	test.each(["00:00:00:00:00:00", "not-a-mac"])(
		"an explicitly invalid permanent address %s cannot use the read-failure cache",
		async (mac) => {
			const files = new RadioFiles();
			const producer = new WifiRadioIdentityProducer(files.readers);
			await producer.discover([{ ifname: "wlan0" }]);
			files.phys.set(PHY, { index: "0", mac });
			await producer.discover([{ ifname: "wlan0" }]);
			expect(producer.state.rows.get("wlan0")?.classification).toBe("limited");
		},
	);

	test.each([undefined, MAC])(
		"a not-ready replacement cannot inherit its predecessor's key (MAC=%s)",
		async (mac) => {
			const files = new RadioFiles();
			const producer = new WifiRadioIdentityProducer(files.readers);
			await producer.discover([{ ifname: "wlan0" }]);
			const predecessor = producer.state.rows.get("wlan0");
			files.netdevs.set("wlan0", { ifindex: "12", phy: PHY });
			files.phys.set(PHY, { index: "0", mac });
			await producer.discover([
				{ ifname: "wlan0", degradedReason: "unavailable" },
			]);
			expect(producer.state.rows.get("wlan0")?.key).toBe("degraded:wlan0");
			expect(producer.state.rows.get("wlan0")?.incarnation).not.toBe(
				predecessor?.incarnation,
			);
			const replacement = producer.state.rows.get("wlan0")?.incarnation;
			await producer.discover([
				{ ifname: "wlan0", degradedReason: "unavailable" },
			]);
			expect(producer.state.rows.get("wlan0")?.key).toBe("degraded:wlan0");
			expect(producer.state.rows.get("wlan0")?.incarnation).toBe(replacement);
		},
	);

	test("both degraded edges project while unchanged runs and repeated unavailable do not rotate", async () => {
		const files = new RadioFiles();
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "wlan0" }]);
		const healthy = producer.state.rows.get("wlan0")?.incarnation;
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.changed).toEqual([]);
		expect(producer.state.rows.get("wlan0")?.incarnation).toBe(healthy);
		producer.markUnavailable("wlan0");
		const degraded = producer.state;
		expect(degraded.changed).toEqual(["wlan0"]);
		expect(degraded.rows.get("wlan0")?.incarnation).not.toBe(healthy);
		producer.markUnavailable("wlan0");
		expect(producer.state).toBe(degraded);
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.changed).toEqual(["wlan0"]);
		expect(producer.state.rows.get("wlan0")?.incarnation).not.toBe(
			degraded.rows.get("wlan0")?.incarnation,
		);
		expect(producer.state.rows.get("wlan0")?.degradedReason).toBeUndefined();
	});

	test("same objects survive reset, but a new pair with the same MAC rotates", async () => {
		const files = new RadioFiles();
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "wlan0" }]);
		const first = producer.state.rows.get("wlan0")?.incarnation;
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.rows.get("wlan0")?.incarnation).toBe(first);
		files.netdevs.set("wlan0", { ifindex: "5", phy: PHY });
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.rows.get("wlan0")?.incarnation).not.toBe(first);
	});
});

describe("two-pass duplicate classification", () => {
	test("no partial healthy row is published and duplicate runs are order-independent", async () => {
		const files = new RadioFiles();
		files.netdevs.set("wlan1", { ifindex: "4", phy: `${PHY}-twin` });
		files.phys.set(`${PHY}-twin`, { index: "1", mac: MAC });
		const producer = new WifiRadioIdentityProducer(files.readers);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const readers = {
			...files.readers,
			readText: async (path: string) => {
				if (path === "/sys/class/net/wlan1/ifindex") {
					entered.resolve();
					await release.promise;
				}
				return files.readers.readText(path);
			},
		};
		const paused = new WifiRadioIdentityProducer(readers);
		const run = paused.discover([{ ifname: "wlan0" }, { ifname: "wlan1" }]);
		await entered.promise;
		expect([...paused.state.rows]).toEqual([]);
		release.resolve();
		await run;
		expect([...paused.state.rows.values()].map((row) => row.key)).toEqual([
			"degraded:wlan0",
			"degraded:wlan1",
		]);
		await producer.discover([{ ifname: "wlan0" }, { ifname: "wlan1" }]);
		const first = producer.state.rows;
		await producer.discover([{ ifname: "wlan1" }, { ifname: "wlan0" }]);
		expect(producer.state.changed).toEqual([]);
		for (const ifname of ["wlan0", "wlan1"]) {
			expect(producer.state.rows.get(ifname)?.incarnation).toBe(
				first.get(ifname)?.incarnation,
			);
		}
		files.phys.set(`${PHY}-twin`, { index: "1", mac: OTHER_MAC });
		await producer.discover([{ ifname: "wlan0" }, { ifname: "wlan1" }]);
		expect([...producer.state.rows.values()].map((row) => row.key)).toEqual([
			MAC,
			OTHER_MAC,
		]);
		for (const ifname of ["wlan0", "wlan1"]) {
			expect(producer.state.rows.get(ifname)?.incarnation).not.toBe(
				first.get(ifname)?.incarnation,
			);
		}
	});

	test("an older sample cannot overwrite a later unavailable monitor edge", async () => {
		const files = new RadioFiles();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let pause = false;
		const readers = {
			...files.readers,
			readText: async (path: string) => {
				if (pause && path.endsWith("/macaddress")) {
					entered.resolve();
					await release.promise;
				}
				return files.readers.readText(path);
			},
		};
		const producer = new WifiRadioIdentityProducer(readers);
		await producer.discover([{ ifname: "wlan0" }]);
		pause = true;
		const older = producer.discover([{ ifname: "wlan0" }]);
		await entered.promise;
		producer.markUnavailable("wlan0");
		const unavailableState = producer.state;
		const unavailable = producer.state.rows.get("wlan0");
		release.resolve();
		await older;
		expect(producer.state.rows.get("wlan0")).toBe(unavailable);
		expect(producer.state.rows.get("wlan0")?.degradedReason).toBe(
			"unavailable",
		);
		expect(producer.state).toBe(unavailableState);
	});

	test.each([true, false])(
		"a queued older observation cannot erase a later unavailable event (present=%s)",
		async (present) => {
			const files = new RadioFiles();
			const producer = new WifiRadioIdentityProducer(files.readers);
			await producer.discover([{ ifname: "wlan0" }]);
			const older = producer.captureObservation();
			producer.markUnavailable("wlan0");
			const unavailableState = producer.state;
			const unavailable = producer.state.rows.get("wlan0");
			await producer.discover(present ? [{ ifname: "wlan0" }] : [], older);
			expect(producer.state.rows.get("wlan0")).toBe(unavailable);
			expect(producer.state).toBe(unavailableState);
			await producer.discover([{ ifname: "wlan0" }]);
			expect(producer.state.rows.get("wlan0")?.degradedReason).toBeUndefined();
		},
	);

	test("an aborted sample cannot publish or seed its pair cache", async () => {
		const files = new RadioFiles();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const producer = new WifiRadioIdentityProducer({
			...files.readers,
			readText: async (path) => {
				const value = await files.readers.readText(path);
				if (path.endsWith("/macaddress")) {
					entered.resolve();
					await release.promise;
				}
				return value;
			},
		});
		const run = producer.discover(
			[{ ifname: "wlan0" }],
			producer.captureObservation(),
			controller.signal,
		);
		await entered.promise;
		controller.abort();
		release.resolve();
		await run;
		expect([...producer.state.rows]).toEqual([]);
		files.phys.set(PHY, { index: "0" });
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.rows.get("wlan0")?.permanentMac).toBeUndefined();
	});

	test("an older queued observation starts no I/O after a newer publication", async () => {
		const files = new RadioFiles();
		const producer = new WifiRadioIdentityProducer(files.readers);
		const older = producer.captureObservation();
		await producer.discover([{ ifname: "wlan0" }]);
		const published = producer.state;
		const reads: string[] = [];
		files.beforeRead = (path) => reads.push(path);
		await producer.discover([{ ifname: "wlan0" }], older);
		expect(reads).toEqual([]);
		expect(producer.state).toBe(published);
	});
});
