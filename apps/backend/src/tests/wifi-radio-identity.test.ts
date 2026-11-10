import { describe, expect, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import {
	type RadioIdentityReaders,
	radioIdentityReaders,
	WifiRadioIdentityProducer,
} from "../modules/wifi/wifi-radio-identity.ts";

const MAC = "58:02:05:e1:79:1c";
const OTHER_MAC = "dc:a6:32:aa:bb:cc";
const PHY = "/sys/devices/radio/ieee80211/phy0";

type Netdev = { ifindex: string; phy: string; path?: string };
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
		readPath: async (ifname) => {
			this.beforeRead(`GENERAL.PATH:${ifname}`);
			return this.netdevs.get(ifname)?.path;
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

	test.each([2, 3, 4, 5, 6])(
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
			if (++reads === 7) {
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

	test.each([
		["PCI-0000:01:00.A\n", "PCI-0000:01:00.A"],
		["PCI-0000:01:00.A", "PCI-0000:01:00.A"],
		["PCI-0000:01:00.A\nother\n", undefined],
		["PCI-0000\\:01\\:00.A\n", undefined],
		["\n", undefined],
	])(
		"the production locator boundary decodes exactly one unescaped field: %j",
		async (output, expected) => {
			let argv: readonly string[] | undefined;
			const command = spyOn(runner, "run").mockImplementation(
				async (_bin, args) => {
					argv = args;
					return output ?? "";
				},
			);
			try {
				const files = new RadioFiles();
				const producer = new WifiRadioIdentityProducer({
					...files.readers,
					readPath: radioIdentityReaders.readPath,
				});
				await producer.discover([{ ifname: "wlan0" }]);
				expect(producer.state.rows.get("wlan0")?.path).toBe(expected);
				expect(argv).toEqual([
					"--terse",
					"--escape",
					"no",
					"--get-values",
					"GENERAL.PATH",
					"device",
					"show",
					"wlan0",
				]);
			} finally {
				command.mockRestore();
			}
		},
	);
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
			readPath: async (ifname: string) => {
				if (ifname === "wlan1") {
					entered.resolve();
					await release.promise;
				}
				return undefined;
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

	test.each([
		["PCI-0000:01:00.A", "pci-0000:02:00.0", "composite"],
		["pci-0000:01:00.0", "pci-0000:01:00.0", "limited"],
		["unsafe*", "pci-0000:02:00.0", "limited"],
		["unsafe\npath", "pci-0000:02:00.0", "limited"],
		["unsafe\\path", "pci-0000:02:00.0", "limited"],
	] as const)(
		"paths %s / %s classify the first twin as %s",
		async (path, twinPath, expected) => {
			const files = new RadioFiles();
			files.netdevs.set("wlan0", { ifindex: "3", phy: PHY, path });
			files.netdevs.set("wlan1", {
				ifindex: "4",
				phy: `${PHY}-twin`,
				path: twinPath,
			});
			files.phys.set(`${PHY}-twin`, { index: "1", mac: MAC });
			const producer = new WifiRadioIdentityProducer(files.readers);
			await producer.discover([{ ifname: "wlan0" }, { ifname: "wlan1" }]);
			expect(producer.state.rows.get("wlan0")?.classification).toBe(expected);
			expect(producer.state.rows.get("wlan0")?.key).toBe(
				expected === "composite" ? `${MAC}@${path}` : "degraded:wlan0",
			);
		},
	);

	test("a replacement during GENERAL.PATH cannot attribute its locator to its predecessor", async () => {
		const files = new RadioFiles();
		files.beforeRead = (path) => {
			if (path.startsWith("GENERAL.PATH:")) {
				files.netdevs.set("wlan0", {
					ifindex: "8",
					phy: PHY,
					path: "pci-0000:02:00.0",
				});
			}
		};
		const producer = new WifiRadioIdentityProducer(files.readers);
		await producer.discover([{ ifname: "wlan0" }]);
		expect(producer.state.rows.get("wlan0")?.path).toBeUndefined();
	});
});
