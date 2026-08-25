import { describe, expect, test } from "bun:test";

import {
	applyNftablesRules,
	deactivateUplinkSharing,
	flushConntrack,
	setIpForwarding,
	type UplinkSharingDeps,
} from "../modules/network/uplink-sharing.ts";
import {
	SHARE_RULESET_PATH,
	SHARE_SERVICE,
} from "../modules/network/uplink-steering/contracts.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";

type EffectsHarness = Omit<UplinkSharingDeps, "run"> & {
	files: Map<string, string>;
	calls: string[][];
	run: UplinkSharingDeps["run"];
};

function effectsHarness(initial?: string): EffectsHarness {
	const files = new Map<string, string>();
	if (initial !== undefined) files.set(SHARE_RULESET_PATH, initial);
	const calls: string[][] = [];
	return {
		files,
		calls,
		readFile: async (path) => files.get(path),
		writeFile: async (path, contents) => {
			files.set(path, contents);
		},
		renameFile: async (from, to) => {
			const contents = files.get(from);
			if (contents === undefined) throw new Error("missing temp");
			files.set(to, contents);
			files.delete(from);
		},
		removeFile: async (path) => {
			files.delete(path);
		},
		run: async (command, args) => {
			calls.push([command, ...args]);
			return "";
		},
	};
}

describe("applyNftablesRules", () => {
	test("checks a temp file, renames atomically, and reloads without restart", async () => {
		const h = effectsHarness("old");
		await applyNftablesRules("new", h);

		expect(h.files.get(SHARE_RULESET_PATH)).toBe("new");
		expect(h.calls[0]?.slice(0, 3)).toEqual(["nft", "--check", "--file"]);
		expect(h.calls[1]).toEqual(["systemctl", "reload", SHARE_SERVICE]);
		expect(h.calls.flat()).not.toContain("restart");
		expect(h.calls.flat()).not.toContain("stop");
	});

	test("activates a stopped carrier before reloading the published file", async () => {
		const h = effectsHarness();
		await applyNftablesRules("new", h, "activate");

		expect(h.calls[0]?.slice(0, 3)).toEqual(["nft", "--check", "--file"]);
		expect(h.calls.slice(1)).toEqual([
			["systemctl", "start", SHARE_SERVICE],
			["systemctl", "reload", SHARE_SERVICE],
		]);
		expect(h.calls.flat()).not.toContain("restart");
	});

	test("cleans up a first activation when the carrier start fails", async () => {
		const h = effectsHarness();
		h.run = async (command, args) => {
			h.calls.push([command, ...args]);
			if (command === "systemctl" && args[0] === "start") {
				throw new Error("start refused");
			}
			return "";
		};

		await expect(
			applyNftablesRules("new", h, "activate"),
		).rejects.toMatchObject({
			reason: "ruleset_reload_failed",
		});
		expect(h.files.has(SHARE_RULESET_PATH)).toBe(false);
		expect(h.calls.slice(1)).toEqual([
			["systemctl", "start", SHARE_SERVICE],
			["systemctl", "stop", SHARE_SERVICE],
		]);
	});

	test("restores the prior file and reloads it when the new reload fails", async () => {
		const h = effectsHarness("old");
		let reloads = 0;
		h.run = async (command, args) => {
			h.calls.push([command, ...args]);
			if (command === "systemctl" && ++reloads === 1) {
				throw new Error("reload refused");
			}
			return "";
		};

		await expect(applyNftablesRules("new", h)).rejects.toMatchObject({
			reason: "ruleset_reload_failed",
		});
		expect(h.files.get(SHARE_RULESET_PATH)).toBe("old");
		expect(h.calls.filter((call) => call[0] === "systemctl")).toHaveLength(2);
	});

	test("a failed check leaves the live file untouched", async () => {
		const h = effectsHarness("old");
		h.run = async (command, args) => {
			h.calls.push([command, ...args]);
			throw new Error("nft check failed");
		};

		await expect(applyNftablesRules("bad", h)).rejects.toMatchObject({
			reason: "ruleset_publish_failed",
		});
		expect(h.files.get(SHARE_RULESET_PATH)).toBe("old");
		expect(h.calls.filter((call) => call[0] === "systemctl")).toEqual([]);
	});
});

describe("uplink sharing privileged argv", () => {
	test("flushes only the removed uplink's namespaced conntrack mark", async () => {
		const calls: string[][] = [];
		const mark = stableUplinkMark("removed");
		await flushConntrack(mark, {
			run: async (command, args) => {
				calls.push([command, ...args]);
				return "";
			},
		});
		expect(calls).toEqual([
			["conntrack", "--delete", "--mark", `${hexMark(mark)}/0xffffff00`],
		]);
	});

	test("toggles only IPv4 forwarding", async () => {
		const calls: string[][] = [];
		const deps = {
			run: async (command: string, args: string[]) => {
				calls.push([command, ...args]);
				return "";
			},
		};
		await setIpForwarding(true, deps);
		await setIpForwarding(false, deps);
		expect(calls).toEqual([
			["sysctl", "-w", "net.ipv4.ip_forward=1"],
			["sysctl", "-w", "net.ipv4.ip_forward=0"],
		]);
	});

	test("reserves service stop for sharing deactivation", async () => {
		const h = effectsHarness("active");
		await deactivateUplinkSharing(h);
		expect(h.calls).toEqual([["systemctl", "stop", SHARE_SERVICE]]);
		expect(h.files.get(SHARE_RULESET_PATH)).toBe("active");
	});
});

function hexMark(mark: number): string {
	return `0x${mark.toString(16).padStart(8, "0")}`;
}
