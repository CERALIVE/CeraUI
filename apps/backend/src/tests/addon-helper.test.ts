/*
 * Unit tests for the TypeScript wrapper around the privileged
 * `ceralive-addon-helper` binary (T27, src/helpers/addon-helper.ts).
 *
 * These cover the WRAPPER's contract — argv-only construction, the isRealDevice
 * gate (G6), and id validation — via injected deps, without ever spawning sudo.
 * The helper's OWN security logic (allowlist + sig/sha256 verification) is
 * exercised end-to-end against the real bash script in addon-helper-script.test.ts.
 */

import { describe, expect, it } from "bun:test";

import {
	ADDON_UNAVAILABLE_ERROR,
	type AddonHelperDeps,
	addonDisable,
	addonEnable,
	addonRefresh,
	addonStatus,
} from "../helpers/addon-helper.ts";

type Call = { file: string; args: readonly string[] };

/** Build deps with a recording exec spy; defaults to a real device + ok exit. */
function spyDeps(over: Partial<AddonHelperDeps> = {}): {
	deps: AddonHelperDeps;
	calls: Call[];
} {
	const calls: Call[] = [];
	const deps: AddonHelperDeps = {
		isRealDevice: () => Promise.resolve(true),
		exec: (file, args) => {
			calls.push({ file, args });
			return Promise.resolve({ stdout: '{"ok":true}', stderr: "" });
		},
		...over,
	};
	return { deps, calls };
}

describe("addon-helper wrapper — argv-only invocation", () => {
	it("enable spawns `sudo ceralive-addon-helper enable <id>` argv-only and returns stdout", async () => {
		const { deps, calls } = spyDeps();

		const out = await addonEnable("debug-toolset", deps);

		expect(out).toBe('{"ok":true}');
		expect(calls).toHaveLength(1);
		const call = calls[0];
		// argv-only: (file, args) — no shell, no command string.
		expect(call?.file).toBe("sudo");
		expect(call?.args).toEqual([
			"ceralive-addon-helper",
			"enable",
			"debug-toolset",
		]);
	});

	it("disable, refresh, status build the expected argv", async () => {
		const { deps, calls } = spyDeps();

		await addonDisable("debug-toolset", deps);
		await addonRefresh(deps);
		await addonStatus(deps);

		expect(calls.map((c) => c.args)).toEqual([
			["ceralive-addon-helper", "disable", "debug-toolset"],
			["ceralive-addon-helper", "refresh"],
			["ceralive-addon-helper", "status"],
		]);
		// Every op goes through sudo, never a raw helper exec.
		expect(calls.every((c) => c.file === "sudo")).toBe(true);
	});
});

describe("addon-helper wrapper — isRealDevice gate (G6)", () => {
	it("refuses every op in emulated mode and never spawns sudo", async () => {
		let spawned = false;
		const { deps } = spyDeps({
			isRealDevice: () => Promise.resolve(false),
			exec: () => {
				spawned = true;
				return Promise.resolve({ stdout: "", stderr: "" });
			},
		});

		await expect(addonEnable("debug-toolset", deps)).rejects.toThrow(
			ADDON_UNAVAILABLE_ERROR,
		);
		await expect(addonDisable("debug-toolset", deps)).rejects.toThrow(
			ADDON_UNAVAILABLE_ERROR,
		);
		await expect(addonRefresh(deps)).rejects.toThrow(ADDON_UNAVAILABLE_ERROR);
		await expect(addonStatus(deps)).rejects.toThrow(ADDON_UNAVAILABLE_ERROR);

		expect(spawned).toBe(false);
	});
});

describe("addon-helper wrapper — id validation (defense in depth)", () => {
	it("rejects a malformed / traversal id before the gate or any exec", async () => {
		let touched = false;
		const { deps } = spyDeps({
			isRealDevice: () => {
				touched = true;
				return Promise.resolve(true);
			},
			exec: () => {
				touched = true;
				return Promise.resolve({ stdout: "", stderr: "" });
			},
		});

		for (const bad of ["../../etc/passwd", "-rf", "Debug", "a/b", "a.b", ""]) {
			await expect(addonEnable(bad, deps)).rejects.toThrow(/invalid add-on id/);
		}
		// id validation runs first — neither the gate nor exec was reached.
		expect(touched).toBe(false);
	});

	it("accepts a well-formed lowercase-hyphen id", async () => {
		const { deps, calls } = spyDeps();
		await addonEnable("debug-toolset", deps);
		await addonDisable("net-tools-2", deps);
		expect(calls).toHaveLength(2);
	});
});
