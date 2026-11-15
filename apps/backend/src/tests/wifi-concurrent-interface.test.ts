/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { afterEach, describe, expect, test } from "bun:test";
import { RunTimeoutError } from "../helpers/run.ts";
import {
	concurrentApIfname,
	ensureConcurrentApInterface,
	releaseConcurrentApInterface,
	releaseCreatedConcurrentApInterface,
	resetConcurrentInterfaceDepsForTest,
	setConcurrentInterfaceDepsForTest,
} from "../modules/wifi/wifi-concurrent-interface.ts";
import { iwCreationReceipt } from "./helpers/iw-creation-receipt.ts";

afterEach(resetConcurrentInterfaceDepsForTest);

describe("concurrent AP virtual interface", () => {
	test("uses a deterministic Linux-safe interface name", () => {
		expect(concurrentApIfname("wlan0")).toBe("clap-wlan0");
		expect(
			concurrentApIfname("very-long-wireless-name").length,
		).toBeLessThanOrEqual(15);
	});

	test("refuses an incompatible interface without replacing it", async () => {
		const calls: string[][] = [];
		const targets = new Map([
			["clap-wlan0", { identity: "unrecorded", type: "AP" }],
		]);
		setConcurrentInterfaceDepsForTest(
			async (_command, args) => {
				calls.push(args);
				if (args.at(-1) === "info") {
					const target = targets.get("clap-wlan0");
					if (!target) throw new Error("No fixture interface");
					return `type ${target.type}`;
				}
				if (args.at(-1) === "del") targets.delete("clap-wlan0");
				if (args.includes("add"))
					targets.set("clap-wlan0", { identity: "new", type: "managed" });
				return "";
			},
			async () => true,
		);

		expect(await ensureConcurrentApInterface("wlan0")).toBeUndefined();
		expect(targets).toEqual(
			new Map([["clap-wlan0", { identity: "unrecorded", type: "AP" }]]),
		);
		expect(calls).toEqual([["dev", "clap-wlan0", "info"]]);
	});

	test("does not delete a virtual interface without a creation record", async () => {
		const calls: string[][] = [];
		setConcurrentInterfaceDepsForTest(
			async (_command, args) => {
				calls.push(args);
				return "";
			},
			async () => true,
		);
		await releaseConcurrentApInterface("clap-wlan0");
		expect(calls).toEqual([]);
	});
});

for (const outcome of [
	"early-replacement",
	"early-rename",
	"post-create-read-failure",
	"visibility-failure",
	"success",
] as const) {
	test(`creation-bound cleanup preserves kernel ownership after ${outcome}`, async () => {
		const targets = new Map<string, { ifindex: number; wdev: string }>();
		let created = false;
		setConcurrentInterfaceDepsForTest(
			async (bin, args) => {
				if (
					bin === "nmcli" &&
					args.join(" ") === "device set clap-wlan0 autoconnect no"
				)
					return "";
				const entry =
					args[0] === "wdev"
						? [...targets].find(([, value]) => value.wdev === args[1])
						: [...targets].find(([name]) => name === args[1]);
				if (args.includes("add")) {
					targets.set("clap-wlan0", { ifindex: 7, wdev: "0x7" });
					created = true;
					if (outcome === "early-replacement")
						targets.set("clap-wlan0", { ifindex: 99, wdev: "0x99" });
					if (outcome === "early-rename") {
						targets.set("renamed-owned", { ifindex: 7, wdev: "0x7" });
						targets.set("clap-wlan0", { ifindex: 99, wdev: "0x99" });
					}
					return iwCreationReceipt();
				}
				if (args.at(-1) === "info") {
					if (!entry || (created && outcome === "post-create-read-failure"))
						throw new Error("Fixture metadata unavailable");
					return `Interface ${entry[0]}\n ifindex ${entry[1].ifindex}\n wdev ${entry[1].wdev}\n type managed\n`;
				}
				if (args.at(-1) === "del") {
					if (entry) targets.delete(entry[0]);
					return "";
				}
				throw new Error("Unexpected fixture operation");
			},
			async () => outcome === "success" || outcome === "early-rename",
		);
		const target = await ensureConcurrentApInterface("wlan0");
		if (outcome === "success") {
			expect(target).toEqual({
				ifname: "clap-wlan0",
				created: true,
				type: "managed",
			});
			expect(targets).toEqual(
				new Map([["clap-wlan0", { ifindex: 7, wdev: "0x7" }]]),
			);
			if (!target) throw new Error("Missing allocation");
			await releaseCreatedConcurrentApInterface(target);
			await releaseCreatedConcurrentApInterface(target);
			expect(targets).toEqual(new Map());
		} else {
			expect(target).toBeUndefined();
			expect(targets).toEqual(
				outcome === "early-replacement" || outcome === "early-rename"
					? new Map([["clap-wlan0", { ifindex: 99, wdev: "0x99" }]])
					: new Map(),
			);
		}
	});
}

for (const corruption of [
	"absent",
	"query",
	"sequence",
	"name",
	"truncated",
	"duplicate",
]) {
	test(`unattributable creation receipt ${corruption} grants no deletion authority`, async () => {
		const targets = new Map<string, { ifindex: number; wdev: string }>();
		setConcurrentInterfaceDepsForTest(
			async (_bin, args) => {
				if (args.includes("add")) {
					targets.set("clap-wlan0", { ifindex: 7, wdev: "0x7" });
					const receipt = iwCreationReceipt(
						corruption === "name" ? "foreign" : "clap-wlan0",
					);
					if (corruption === "absent") return "";
					if (corruption === "query")
						return receipt.replace(".cmd = 7", ".cmd = 5");
					if (corruption === "sequence")
						return receipt.replace(
							"Received Message:\n",
							"Received Message:\n    .seq = -99\n",
						);
					if (corruption === "truncated") return receipt.slice(0, -50);
					if (corruption === "duplicate")
						return (
							receipt + receipt.slice(receipt.indexOf("-- Debug: Received"))
						);
					return receipt;
				}
				if (args.at(-1) === "del") {
					targets.clear();
					return "";
				}
				throw new Error("Absent fixture interface");
			},
			async () => false,
		);
		expect(await ensureConcurrentApInterface("wlan0")).toBeUndefined();
		expect(targets).toEqual(
			new Map([["clap-wlan0", { ifindex: 7, wdev: "0x7" }]]),
		);
	});
}

test("a creation reply survives command timeout and retains exact cleanup authority", async () => {
	const targets = new Map<string, { ifindex: number; wdev: string }>();
	setConcurrentInterfaceDepsForTest(
		async (_bin, args) => {
			if (args.includes("add")) {
				targets.set("clap-wlan0", { ifindex: 7, wdev: "0x7" });
				throw new RunTimeoutError("fixture creation", "", iwCreationReceipt());
			}
			if (args.at(-1) === "del") {
				const entry = [...targets].find(([, value]) => value.wdev === args[1]);
				if (entry) targets.delete(entry[0]);
				return "";
			}
			throw new Error("No fixture metadata");
		},
		async () => false,
	);
	expect(await ensureConcurrentApInterface("wlan0")).toBeUndefined();
	expect(targets).toEqual(new Map());
});
