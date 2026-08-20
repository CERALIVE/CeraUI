/**
 * Contract-v1 reader for the router-dongle netns runtime metadata.
 *
 * The schema under test is a MIRROR of image-building-pipeline's
 * `docs/dongle-netns-contract.md` §6.1, never an import (Rule D), so these
 * fixtures are CeraUI-LOCAL by design — they are what proves the mirror still
 * matches the producer, and nothing here reads the sibling repo.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { shouldUseMocks } from "../mocks/mock-service.ts";
import {
	DONGLE_METADATA_DIR,
	DONGLE_STALE_MS,
	type DongleMetadata,
	type DongleMetadataDeps,
	defaultDongleMetadataDeps,
	dongleSlotLabel,
	getDongleMarker,
	getDongleRecords,
	isDongleVethName,
	readDongleMetadata,
	refreshDongleMetadata,
	resetDongleMetadata,
} from "../modules/network/dongle-metadata.ts";

const NOW = 1_755_331_200_000;

// The example record from contract §6.1, verbatim apart from the fields a
// per-slot fixture must vary.
function record(over: Partial<DongleMetadata> = {}): DongleMetadata {
	return {
		version: 1,
		slot: 0,
		ifname: "eth1",
		usb_path: "platform-fc800000.usb-usb-0:1.3.2",
		mac: "0c:5b:8f:27:9a:64",
		driver: "cdc_ether",
		inner_ip: "192.168.8.100",
		inner_gateway: "192.168.8.1",
		veth_host: "dg0h",
		veth_host_ip: "10.208.0.1",
		state: "up",
		updated_at_ms: NOW,
		lease_refresh_ms: 30000,
		...over,
	};
}

function deps(files: Record<string, string>, now = NOW): DongleMetadataDeps {
	return {
		listFiles: async () => Object.keys(files),
		readFile: async (path) => files[path],
		now: () => now,
	};
}

function file(slot: number): string {
	return `/run/ceralive/dongles/dongle${slot}.json`;
}

beforeEach(() => {
	resetDongleMetadata();
});

describe("dongle metadata reader — contract v1 mirror", () => {
	test("a valid record is keyed by its host veth", async () => {
		const map = await readDongleMetadata(
			deps({ [file(0)]: JSON.stringify(record()) }),
		);

		expect(map.size).toBe(1);
		expect(map.get("dg0h")?.slot).toBe(0);
		expect(map.get("dg0h")?.state).toBe("up");
		expect(map.get("dg0h")?.usb_path).toBe("platform-fc800000.usb-usb-0:1.3.2");
	});

	test("two slots read independently", async () => {
		const map = await readDongleMetadata(
			deps({
				[file(0)]: JSON.stringify(record()),
				[file(1)]: JSON.stringify(
					record({
						slot: 1,
						veth_host: "dg1h",
						veth_host_ip: "10.208.1.1",
						state: "acquiring",
						inner_ip: null,
						inner_gateway: null,
					}),
				),
			}),
		);

		expect([...map.keys()].sort()).toEqual(["dg0h", "dg1h"]);
		expect(map.get("dg1h")?.state).toBe("acquiring");
		expect(map.get("dg1h")?.inner_ip).toBeNull();
	});

	// §6.1: "A reader MUST ignore fields it does not know." An additive-optional
	// field introduced within v1 must not cost us a working dongle.
	test("an unknown additive field is ignored, not rejected", async () => {
		const map = await readDongleMetadata(
			deps({
				[file(0)]: JSON.stringify({ ...record(), future_field: "whatever" }),
			}),
		);

		expect(map.get("dg0h")?.slot).toBe(0);
	});

	test("an unknown version is ignored — never guessed at, never deleted", async () => {
		const map = await readDongleMetadata(
			deps({ [file(0)]: JSON.stringify({ ...record(), version: 2 }) }),
		);

		expect(map.size).toBe(0);
	});

	test("a record missing a non-nullable field is ignored", async () => {
		const { mac: _dropped, ...withoutMac } = record();
		const map = await readDongleMetadata(
			deps({ [file(0)]: JSON.stringify(withoutMac) }),
		);

		expect(map.size).toBe(0);
	});

	test("malformed JSON is ignored and never throws", async () => {
		const map = await readDongleMetadata(deps({ [file(0)]: "{not json" }));

		expect(map.size).toBe(0);
	});

	test("a missing directory yields an empty map", async () => {
		const map = await readDongleMetadata({
			listFiles: async () => {
				throw new Error("ENOENT");
			},
			readFile: async () => undefined,
			now: () => NOW,
		});

		expect(map.size).toBe(0);
	});

	test("a file that vanishes between listing and reading is skipped", async () => {
		const map = await readDongleMetadata({
			listFiles: async () => [file(0)],
			readFile: async () => undefined,
			now: () => NOW,
		});

		expect(map.size).toBe(0);
	});
});

describe("dongle metadata reader — heartbeat freshness", () => {
	// §6.1: stale only past 3x the 30 s heartbeat. One delayed heartbeat under
	// load must never demote a healthy streaming link.
	test("a record one missed heartbeat old is still trusted", async () => {
		const map = await readDongleMetadata(
			deps(
				{ [file(0)]: JSON.stringify(record({ updated_at_ms: NOW - 30_000 })) },
				NOW,
			),
		);

		expect(map.get("dg0h")?.state).toBe("up");
	});

	test("exactly at the stale bound the record is still trusted", async () => {
		const map = await readDongleMetadata(
			deps(
				{
					[file(0)]: JSON.stringify(
						record({ updated_at_ms: NOW - DONGLE_STALE_MS }),
					),
				},
				NOW,
			),
		);

		expect(map.get("dg0h")?.state).toBe("up");
	});

	test("one millisecond past the bound the record is ignored", async () => {
		const map = await readDongleMetadata(
			deps(
				{
					[file(0)]: JSON.stringify(
						record({ updated_at_ms: NOW - DONGLE_STALE_MS - 1 }),
					),
				},
				NOW,
			),
		);

		expect(map.size).toBe(0);
	});

	test("a future timestamp (clock skew) is not treated as stale", async () => {
		const map = await readDongleMetadata(
			deps(
				{ [file(0)]: JSON.stringify(record({ updated_at_ms: NOW + 60_000 })) },
				NOW,
			),
		);

		expect(map.get("dg0h")?.state).toBe("up");
	});
});

describe("dongle metadata reader — ambiguity", () => {
	// The bench's two Huawei HiLink units share one factory MAC, so a producer
	// bug that mapped both onto one slot is not hypothetical. Picking either
	// would attribute one dongle's state to the other, so NEITHER is trusted.
	test("two records claiming one host veth drop BOTH", async () => {
		const map = await readDongleMetadata(
			deps({
				[file(0)]: JSON.stringify(record()),
				[file(1)]: JSON.stringify(
					record({ slot: 1, usb_path: "platform-fc800000.usb-usb-0:1.3.4" }),
				),
			}),
		);

		expect(map.has("dg0h")).toBe(false);
		expect(map.size).toBe(0);
	});

	test("an ambiguous veth does not poison an unrelated slot", async () => {
		const map = await readDongleMetadata(
			deps({
				[file(0)]: JSON.stringify(record()),
				[file(1)]: JSON.stringify(record({ slot: 1 })),
				[file(2)]: JSON.stringify(
					record({ slot: 2, veth_host: "dg2h", veth_host_ip: "10.208.2.1" }),
				),
			}),
		);

		expect(map.has("dg0h")).toBe(false);
		expect(map.get("dg2h")?.slot).toBe(2);
	});
});

describe("dongle metadata cache", () => {
	test("refresh reports a real edge, and a steady state reports none", async () => {
		const up = deps({ [file(0)]: JSON.stringify(record()) });

		expect(await refreshDongleMetadata(up)).toBe(true);
		expect(await refreshDongleMetadata(up)).toBe(false);

		expect(
			await refreshDongleMetadata(
				deps({ [file(0)]: JSON.stringify(record({ state: "down" })) }),
			),
		).toBe(true);
		expect(getDongleMarker("dg0h")).toEqual({ slot: 0, state: "down" });
	});

	test("a released dongle empties the cache and reports the edge", async () => {
		await refreshDongleMetadata(deps({ [file(0)]: JSON.stringify(record()) }));

		expect(await refreshDongleMetadata(deps({}))).toBe(true);
		expect(getDongleRecords().size).toBe(0);
		expect(getDongleMarker("dg0h")).toBeUndefined();
	});

	test("a stale record is indistinguishable from an absent one to the marker", async () => {
		await refreshDongleMetadata(
			deps(
				{
					[file(0)]: JSON.stringify(
						record({ updated_at_ms: NOW - DONGLE_STALE_MS - 1 }),
					),
				},
				NOW,
			),
		);

		expect(getDongleMarker("dg0h")).toBeUndefined();
		expect(dongleSlotLabel("dg0h")).toBeUndefined();
	});

	test("the slot label names the slot, not the kernel interface", async () => {
		await refreshDongleMetadata(
			deps({
				[file(3)]: JSON.stringify(
					record({ slot: 3, veth_host: "dg3h", veth_host_ip: "10.208.3.1" }),
				),
			}),
		);

		expect(dongleSlotLabel("dg3h")).toBe("dongle3");
		expect(dongleSlotLabel("eth0")).toBeUndefined();
	});

	// Shape is not a claim: an unclaimed name that merely LOOKS like a veth must
	// never resolve to a marker.
	test("veth-shaped names are recognised by shape but carry no claim", () => {
		expect(isDongleVethName("dg0h")).toBe(true);
		expect(isDongleVethName("dg12h")).toBe(true);
		expect(isDongleVethName("dg0n")).toBe(false);
		expect(isDongleVethName("enx344b50000000")).toBe(false);
		expect(isDongleVethName("eth0")).toBe(false);
		expect(getDongleMarker("dg0h")).toBeUndefined();
	});
});

// Every fixture above drives an INJECTED deps seam, which proves the RULES and
// says nothing about the path a device runs. That path is the only one left
// once phase-C todo 39 retires the image's netns layer: no image writes
// `/run/ceralive/dongles`, so "the directory is not there" becomes the steady
// state on every board, and the tolerant reader is what makes an old-image and
// a new-image board degrade to the SAME silence.
describe("dongle metadata reader — the SHIPPED deps with no producer", () => {
	test("an absent /run/ceralive/dongles lists nothing and yields an empty map", async () => {
		// Non-vacuity: the mock seam answers with fixtures instead of touching the
		// filesystem, so the real branch has to be the one under test here.
		expect(shouldUseMocks()).toBe(false);
		expect(DONGLE_METADATA_DIR).toBe("/run/ceralive/dongles");
		// The post-retirement precondition, ASSERTED rather than assumed. A host
		// where this directory exists is still running a producer, and that is a
		// finding worth failing on rather than quietly passing over.
		expect(existsSync(DONGLE_METADATA_DIR)).toBe(false);

		expect(await defaultDongleMetadataDeps.listFiles()).toEqual([]);

		const map = await readDongleMetadata(defaultDongleMetadataDeps);
		expect(map.size).toBe(0);
	});

	test("the cache refresh over the shipped deps reports no edge and no records", async () => {
		expect(await refreshDongleMetadata(defaultDongleMetadataDeps)).toBe(false);
		expect(getDongleRecords().size).toBe(0);
		expect(getDongleMarker("dg0h")).toBeUndefined();
		expect(dongleSlotLabel("dg0h")).toBeUndefined();
	});

	test("a STALE file left behind by a retired manager reads as no dongle at all", async () => {
		// The other half of the degradation. A board that WAS running the old layer
		// can leave a file whose heartbeat simply stopped — the manager masked, the
		// slot never released. The reader must answer exactly as it does for the
		// absent directory instead of carrying the last-known claim forward, or a
		// retired layer would keep publishing a dongle nothing is maintaining.
		expect(
			await refreshDongleMetadata(
				deps(
					{
						[file(0)]: JSON.stringify(
							record({ updated_at_ms: NOW - DONGLE_STALE_MS - 1 }),
						),
					},
					NOW,
				),
			),
		).toBe(false);

		expect(getDongleRecords().size).toBe(0);
		expect(getDongleMarker("dg0h")).toBeUndefined();
	});
});
