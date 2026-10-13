import { afterEach, beforeEach, expect, test } from "bun:test";
import { call } from "@orpc/server";
import {
	addonDisable,
	addonEnable,
	addonRefresh,
	addonStatus,
} from "../helpers/addon-helper.ts";
import { setAddonManagerDeps } from "../modules/addons/manager.ts";
import { runAddonReconciler } from "../modules/addons/reconciler.ts";
import { getConfig, saveConfig } from "../modules/config.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	installAddonProcedure,
	uninstallAddonProcedure,
} from "../rpc/procedures/addons.procedure.ts";
import {
	kioskStartProcedure,
	kioskStopProcedure,
} from "../rpc/procedures/system.procedure.ts";
import { sysextDescriptor, sysextFixture } from "./sysext-action-fixture.ts";

let fixture: ReturnType<typeof sysextFixture>;
beforeEach(() => {
	fixture = sysextFixture();
});
afterEach(() => {
	fixture.reset();
});
const context = buildControlContext();

for (const [name, action] of Object.entries({
	enable: addonEnable,
	disable: addonDisable,
})) {
	test(`privileged ${name} refuses a stream appearing during device detection`, async () => {
		// Given idle at entry but streaming when the awaited device probe returns.
		const effects: string[] = [];
		// When the real primitive reaches final sudo submission.
		await expect(
			action("cog-display", {
				isRealDevice: async () => {
					updateStatus(true);
					return true;
				},
				exec: async () => {
					effects.push("sudo");
					return { stdout: "{}", stderr: "" };
				},
			}),
		).rejects.toThrow("streaming");
		// Then no privileged operation is submitted.
		expect(effects).toEqual([]);
	});
}
test("privileged refresh refuses live while read-only status remains available", async () => {
	// Given a live engine and a harmless injected privileged observation.
	updateStatus(true);
	const effects: string[] = [];
	const deps = {
		isRealDevice: async () => true,
		exec: async (_file: string, args: readonly string[]) => {
			effects.push(args.join(" "));
			return { stdout: "{}", stderr: "" };
		},
	};
	// When refresh and then the independently safe status entry are requested.
	await expect(addonRefresh(deps)).rejects.toThrow("streaming");
	expect(await addonStatus(deps)).toBe("{}");
	// Then only the read-only command reaches sudo.
	expect(effects).toEqual(["ceralive-addon-helper status"]);
});

for (const [name, action] of Object.entries({
	"install userConfig": () =>
		call(
			installAddonProcedure,
			{ id: "cog-display", userConfig: { preserved: "new" } },
			{ context },
		),
	"kiosk start": () => call(kioskStartProcedure, undefined, { context }),
})) {
	test(`${name} rolls back prelude bytes when idle evidence is lost in the space probe`, async () => {
		// Given an admitted entry whose read-only preflight loses positive idle.
		setAddonManagerDeps({
			isRealDevice: async () => true,
			getDataFreeBytes: async () => {
				updateStatus(true);
				return 2 ** 32;
			},
		});
		const before = await Bun.file(fixture.path).bytes();
		// When the actual procedure reaches manager admission again.
		const result = await action();
		// Then it refuses with the same token and restores all persisted intent.
		expect(result).toEqual({ success: false, error: "streaming" });
		expect(await Bun.file(fixture.path).bytes()).toEqual(before);
	});
}

for (const [name, action] of Object.entries({
	install: () =>
		call(installAddonProcedure, { id: "cog-display" }, { context }),
	"kiosk start": () => call(kioskStartProcedure, undefined, { context }),
})) {
	test(`${name} rechecks after download before staging or sysext activation`, async () => {
		// Given an initially idle device that becomes live during verification.
		const effects: string[] = [];
		setAddonManagerDeps({
			isRealDevice: async () => true,
			getDataFreeBytes: async () => 2 ** 32,
			getOsVersion: async () => "13",
			download: async () => {
				effects.push("download");
			},
			verify: async () => {
				updateStatus(true);
			},
			stage: async () => {
				effects.push("stage");
			},
			helperEnable: async () => {
				effects.push("helper");
			},
			removeArtifact: async () => {
				effects.push("remove-temp");
			},
			broadcast: () => {},
		});
		const before = await Bun.file(fixture.path).bytes();
		// When the admitted action resumes from the awaited preparation.
		const result = await action();
		// Then only the earlier permitted download and its cleanup occurred.
		expect(result).toEqual({ success: false, error: "streaming" });
		expect(effects).toEqual(["download", "remove-temp"]);
		expect(await Bun.file(fixture.path).bytes()).toEqual(before);
	});
}

for (const [name, action] of Object.entries({
	uninstall: () =>
		call(uninstallAddonProcedure, { id: "cog-display" }, { context }),
	"kiosk stop": () => call(kioskStopProcedure, undefined, { context }),
})) {
	test(`${name} rechecks after unit teardown before sysext refresh`, async () => {
		// Given enabled intent and a stream appearing during an admitted unit stop.
		Object.assign(getConfig(), {
			kiosk_enabled: true,
			kiosk_last_state: "enabled-running",
		});
		saveConfig();
		const effects: string[] = [];
		setAddonManagerDeps({
			isRealDevice: async () => true,
			systemctl: async () => {
				updateStatus(true);
				return { stdout: "", stderr: "" };
			},
			helperDisable: async () => {
				effects.push("helper");
			},
			broadcast: () => {},
		});
		const before = await Bun.file(fixture.path).bytes();
		// When teardown resumes from its awaited unit operations.
		const result = await action();
		// Then refresh is refused and stored intent is restored rather than reported disabled.
		expect(result).toEqual({ success: false, error: "streaming" });
		expect(effects).toEqual([]);
		expect(await Bun.file(fixture.path).bytes()).toEqual(before);
	});
}

test("reconciler rechecks after staging before sysext refresh", async () => {
	// Given an initially idle reconciler and stream start during awaited staging.
	const effects: string[] = [];
	// When the real reconciler resumes.
	await runAddonReconciler({
		isRealDevice: async () => true,
		getIsStreaming: () => false,
		getOsVersionId: async () => "13",
		getBoard: () => "rk3588",
		getAddons: () => ({
			"cog-display": { enabled: true, phase: "active", autoDisabled: false },
		}),
		readDescriptor: async () => sysextDescriptor,
		rawExists: async () => false,
		fetchAndStage: async () => {
			updateStatus(true);
		},
		refresh: async () => {
			effects.push("refresh");
		},
		setState: () => {},
		log: () => {},
	});
	// Then a stale idle sample cannot dispatch refresh.
	expect(effects).toEqual([]);
});

test("install rechecks after staging before activation", async () => {
	// Given stream start while a previously admitted stage is finishing.
	const effects: string[] = [];
	setAddonManagerDeps({
		isRealDevice: async () => true,
		getDataFreeBytes: async () => 2 ** 32,
		getOsVersion: async () => "13",
		download: async () => {},
		verify: async () => {},
		stage: async () => {
			updateStatus(true);
		},
		helperEnable: async () => {
			effects.push("helper");
		},
		removeArtifact: async () => {},
		broadcast: () => {},
	});
	const before = await Bun.file(fixture.path).bytes();
	// When activation reaches its final manager check.
	const result = await call(
		installAddonProcedure,
		{ id: "cog-display" },
		{ context },
	);
	// Then the new refresh is refused and original stored intent survives.
	expect(result).toEqual({ success: false, error: "streaming" });
	expect(effects).toEqual([]);
	expect(await Bun.file(fixture.path).bytes()).toEqual(before);
});
