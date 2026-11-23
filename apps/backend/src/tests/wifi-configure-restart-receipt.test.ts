import { expect, jest, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import {
	defaultHotspotConfigDeps,
	defaultHotspotStopDeps,
	reconfigureHotspotForRegdomain,
	wifiHotspotConfig,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { radioIdentityReaders } from "../modules/wifi/wifi-radio-identity.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

type Fixture = Awaited<ReturnType<typeof firstAp>>;

test("Stop cannot report success or release its hybrid leg while Down is only acknowledged", async () => {
	const f = await firstAp(undefined, true);
	const delay = f.delayDown();
	try {
		const uuid = await start(f);
		const release = spyOn(
			defaultHotspotStopDeps,
			"releaseConcurrentInterface",
		).mockResolvedValue(true);
		const stopping = wifiHotspotStop({ device: f.row.id });
		try {
			expect(
				await Promise.race([delay.postReplyRead.then(() => "read"), stopping]),
			).toBe("read");
			const pending = Symbol("pending");
			expect(await Promise.race([stopping, setImmediate(pending)])).toBe(
				pending,
			);
			expect(f.active()).toBe(uuid);
			expect(f.row.hotspot.transition).toBe("deactivating");
			expect(release).not.toHaveBeenCalled();
		} finally {
			delay.finish();
			expect(await stopping).toEqual({ success: true });
		}
		expect(f.active()).toBeUndefined();
		expect(release).toHaveBeenCalledTimes(1);
	} finally {
		delay.finish();
		await f.restore();
	}
});

test("Stop returns the retryable deactivation error if acknowledged Down never becomes terminal", async () => {
	const f = await firstAp(undefined, true);
	try {
		const uuid = await start(f);
		const delay = f.delayDown();
		jest.useFakeTimers();
		const release = spyOn(defaultHotspotStopDeps, "releaseConcurrentInterface");
		const stopping = wifiHotspotStop({ device: f.row.id });
		expect(
			await Promise.race([delay.postReplyRead.then(() => "read"), stopping]),
		).toBe("read");
		await setImmediate();
		jest.advanceTimersByTime(10_000);
		expect(await stopping).toEqual({
			success: false,
			error: "deactivation-failed",
		});
		expect(f.active()).toBe(uuid);
		expect(release).not.toHaveBeenCalled();
	} finally {
		jest.useRealTimers();
		await f.restore();
	}
});

async function start(f: Fixture) {
	expect(await f.start()).toEqual({ success: true });
	settlePending(f.row.ifname, true);
	const uuid = f.created();
	if (!uuid) throw new Error("Missing fixture AP");
	return uuid;
}

test.each(["configure", "regulatory", "rollback", "refresh"] as const)(
	"%s downs only its own activation when radio proof is lost after Up",
	async (window) => {
		const f = await firstAp();
		try {
			await start(f);
			const beginning = f.commands.length;
			const remember = spyOn(defaultHotspotConfigDeps, "rememberCredentials");
			let ups = 0;
			const deps: typeof defaultHotspotConfigDeps = {
				...defaultHotspotConfigDeps,
				nmConnect: async (...args) => {
					ups++;
					if (window === "rollback" && ups === 1) return false;
					const result = await defaultHotspotConfigDeps.nmConnect(...args);
					if (window !== "refresh") await f.rotate();
					return result;
				},
				wifiUpdateSavedConns: async () => {
					if (window === "refresh") await f.rotate();
				},
				broadcastState: () => undefined,
			};

			if (window === "configure") {
				await wifiHotspotConfig(
					f.context.ws,
					{
						device: f.row.id,
						name: "Changed AP",
						password: "changed-password",
						channel: "auto",
					},
					deps,
				);
				expect(
					f.frames.some((frame) => frame.includes('"error":"activating"')),
				).toBe(true);
			} else {
				expect(
					await reconfigureHotspotForRegdomain(MAC, f.row, "auto", deps),
				).toBe(false);
			}
			expect(ups).toBe(window === "rollback" ? 2 : 1);
			expect(
				f.commands.slice(beginning).filter((args) => args[1] === "down"),
			).toEqual([["conn", "down", "apath", f.nm.activePath()]]);
			expect(f.active()).toBeUndefined();
			expect(remember).not.toHaveBeenCalled();
			expect(f.row.hotspot.transition).toBeUndefined();
		} finally {
			await f.restore();
		}
	},
);

test("exclusive restart refuses Up when the live radio has no provable port pin", async () => {
	const f = await firstAp();
	try {
		await start(f);
		spyOn(radioIdentityReaders, "readDevicePath").mockResolvedValue(undefined);
		const up = spyOn(defaultHotspotConfigDeps, "nmConnect");

		expect(await reconfigureHotspotForRegdomain(MAC, f.row, "auto")).toBe(
			false,
		);
		expect(up).not.toHaveBeenCalled();
	} finally {
		await f.restore();
	}
});

test.each([false, true])(
	"restart losing its selected profile compensates by receipt, successor=%s",
	async (successor) => {
		const f = await firstAp();
		try {
			const uuid = await start(f);
			const beginning = f.commands.length;
			let restartPath = "";
			const remember = spyOn(defaultHotspotConfigDeps, "rememberCredentials");
			expect(
				await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
					...defaultHotspotConfigDeps,
					broadcastState: () => undefined,
					wifiUpdateSavedConns: async () => {
						restartPath = f.nm.activePath();
						if (successor) f.nm.activate(uuid);
						f.row.hotspot = { ...f.row.hotspot, conn: undefined };
					},
				}),
			).toBe(false);
			expect(restartPath).not.toBe("");
			expect(
				f.commands.slice(beginning).filter((args) => args[1] === "down"),
			).toEqual(successor ? [] : [["conn", "down", "apath", restartPath]]);
			expect(f.inspectedDownPaths).toEqual([restartPath]);
			expect(f.active()).toBe(successor ? uuid : undefined);
			expect(remember).not.toHaveBeenCalled();
		} finally {
			await f.restore();
		}
	},
);

test.each([false, true])(
	"a committed restart timeout never issues a second Up, radio replaced=%s",
	async (replace) => {
		const f = await firstAp();
		try {
			const uuid = await start(f);
			const beginning = f.commands.length;
			const remember = spyOn(defaultHotspotConfigDeps, "rememberCredentials");
			const result = await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
				...defaultHotspotConfigDeps,
				broadcastState: () => undefined,
				wifiUpdateSavedConns: async () => undefined,
				nmConnect: async (...args) => {
					f.faults.upTimeout = true;
					const up = await defaultHotspotConfigDeps.nmConnect(...args);
					f.faults.upTimeout = false;
					if (replace) {
						await f.rotate();
						f.nm.activate(uuid);
					}
					return up;
				},
			});
			const commands = f.commands.slice(beginning);
			expect(commands.filter((args) => args[3] === "up")).toHaveLength(1);
			expect(result).toBe(!replace);
			expect(f.active()).toBe(uuid);
			if (replace) {
				expect(commands.filter((args) => args[1] === "down")).toEqual([]);
				expect(remember).not.toHaveBeenCalled();
			}
		} finally {
			await f.restore();
		}
	},
);

test("timeout readback never substitutes a successor for the command's own path", async () => {
	const f = await firstAp();
	try {
		const uuid = await start(f);
		const beginning = f.commands.length;
		let restartPath = "";
		expect(
			await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
				...defaultHotspotConfigDeps,
				broadcastState: () => undefined,
				wifiUpdateSavedConns: async () => undefined,
				nmConnect: async (profile, timeout, onActivated, onTimeout) => {
					await defaultHotspotConfigDeps.nmConnect(profile, timeout, (path) => {
						restartPath = path;
						onActivated?.(path);
					});
					f.nm.activate(uuid);
					await f.rotate();
					onTimeout?.();
					return false;
				},
			}),
		).toBe(false);
		expect(restartPath).not.toBe("");
		expect(
			f.commands.slice(beginning).filter((args) => args[1] === "down"),
		).toEqual([]);
		expect(f.inspectedDownPaths).toEqual([restartPath]);
		expect(f.active()).toBe(uuid);
	} finally {
		await f.restore();
	}
});
