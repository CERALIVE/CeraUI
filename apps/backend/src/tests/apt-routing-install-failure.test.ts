import { expect, test } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import type { AptRoutingEntry } from "../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../modules/system/apt-routing-ownership.ts";
import { setAptTransportDepsForTest } from "../modules/system/apt-transport.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import * as updates from "../modules/system/software-updates.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import {
	PINNED_CAPABILITIES,
	sample,
} from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
const { install } = aptEntryHarness();
const ranked = [sample("eth0", "ethernet", 4)];

test.each([
	{ fault: "route-add", phase: "simulation", add: 5, save: 11 },
	{ fault: "third-intent", phase: "simulation", add: 5, save: 11 },
	{ fault: "route-add", phase: "download", add: 13, save: 27 },
	{ fault: "third-intent", phase: "download", add: 13, save: 27 },
])("ends the install with a typed refusal when %o fails", async (scenario) => {
	// Given a real install continuation whose pin fails after earlier local work.
	await withDeviceType("real", async () => {
		const { h, pins, launches, run } = await install(ranked);
		await using _h = h;
		let adds = 0;
		const pin = createUpdatePinController({
			readCapabilities: async () =>
				updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
			run: async (_bin, args) => {
				if (
					args.includes("add") &&
					++adds === scenario.add &&
					scenario.fault === "route-add"
				)
					throw Object.assign(new Error("gateway changed"), {
						stderr: "Error: Nexthop has invalid gateway.\n",
					});
				return args.includes("default") && args.includes("show")
					? "default via 192.0.2.1 dev eth0"
					: "";
			},
		});
		await pin.sweep();
		let entries: readonly AptRoutingEntry[] = [];
		let saves = 0;
		const owner = createAptRoutingOwnership({
			read: async () => entries,
			save: (next) => {
				if (++saves === scenario.save && scenario.fault === "third-intent")
					throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
				entries = next;
			},
		});
		setAptTransportDepsForTest({
			select: async () => rankTransports(ranked),
			pin,
			ownership: owner,
		});
		// When the operation's pin cannot be installed.
		await expect(run()).resolves.toBeUndefined();
		// Then the continuation settles, clears busy, and never launches the unit.
		expect(updates.isUpdating()).toBe(false);
		expect(updates.getUpdateState()).toHaveProperty("kind", "failed");
		expect(launches).toEqual([]);
		expect(entries).toEqual([]);
		expect(pins.active()).toBe(false);
	});
});
