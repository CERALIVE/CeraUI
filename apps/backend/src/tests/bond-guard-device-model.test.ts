import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as commands from "../helpers/run.ts";
import {
	getConfigFilePath,
	loadConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	initNetworkInterfaceMonitoring,
	setBondDisableGuardContext,
} from "../modules/network/network-interfaces.ts";
import {
	type DeviceDetectionDeps,
	isRealDevice,
	observeRealDeviceAtBoot,
} from "../modules/system/device-detection.ts";

const readings = ["match", "nonmatch", "absent", "error"] as const;
type Reading = (typeof readings)[number];
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
function reader(reading: Reading, marker: string): () => Promise<string> {
	return async () => {
		if (reading === "match") return marker;
		if (reading === "nonmatch") return "";
		throw Object.assign(new Error("Fixture hardware read"), {
			code: reading === "absent" ? "ENOENT" : "EIO",
		});
	};
}

test("hardware evidence matches the consulted-read table, including ENOENT", async () => {
	for (const c of readings)
		for (const m of readings)
			for (const r of readings)
				for (const p of readings)
					for (const b of readings) {
						const deps: DeviceDetectionDeps = {
							getDeviceTypeOverride: () => undefined,
							isDevelopment: () => false,
							readDeviceTreeCompatible: reader(c, "rockchip,rk3588"),
							readDeviceTreeModel: reader(m, "RK3588"),
							readCeraliveRelease: reader(r, 'ID="ceralive"'),
							readDmiProductName: reader(p, "N100"),
							readDmiBoardName: reader(b, "Mini PC"),
						};
						const positive =
							c === "match" ||
							m === "match" ||
							(r === "match" && (p === "match" || b === "match"));
						const inconclusive = [
							c,
							m,
							r,
							...(r === "match" ? [p, b] : []),
						].includes("error");
						const observer = observeRealDeviceAtBoot(false, deps);
						expect(await observer.ready).toBe(positive);
						await drain();
						expect(observer.isStillReal()).toBe(positive || inconclusive);
					}
});

test("boot, completion and refresh respect the selector/evidence table", async () => {
	for (const boot of [undefined, "real", "emulated"])
		for (const development of [false, true])
			for (const simulation of [false, true])
				for (const outcome of ["match", "nonmatch", "error"] as const) {
					let override = boot;
					let reads = 0;
					const gate = Promise.withResolvers<void>();
					const empty = reader("nonmatch", "");
					const deps: DeviceDetectionDeps = {
						getDeviceTypeOverride: () => override,
						isDevelopment: () => development,
						readDeviceTreeCompatible: async () => {
							++reads;
							await gate.promise;
							return reader(outcome, "rockchip,rk3588")();
						},
						readDeviceTreeModel: empty,
						readCeraliveRelease: empty,
						readDmiProductName: empty,
						readDmiBoardName: empty,
					};
					const observer = observeRealDeviceAtBoot(
						development || simulation,
						deps,
					);
					const eager =
						!development &&
						(boot === undefined || (boot === "real" && !simulation));
					expect(reads).toBe(Number(eager));
					if (boot !== undefined || development)
						expect(await observer.ready).toBe(boot === "real");
					override = undefined;
					expect(observer.isStillReal()).toBe(true);
					override = "emulated";
					observer.refresh();
					expect(reads).toBe(Number(eager));
					expect(observer.isStillReal()).toBe(false);
					override = undefined;
					if (!development && !simulation) {
						observer.refresh();
						observer.refresh();
						expect(reads).toBe(1);
					}
					gate.resolve();
					await drain();
					expect(await observer.ready).toBe(
						boot === "real" ||
							(boot === undefined && !development && outcome === "match"),
					);
					expect(observer.isStillReal()).toBe(
						reads === 0 || outcome !== "nonmatch",
					);
					const atCompletion = reads;
					// Simulate a later eligible tick after all network fences clear.
					observer.refresh();
					observer.refresh();
					expect(reads).toBe(
						atCompletion + Number(atCompletion === 0 || outcome === "error"),
					);
					await drain();
					override = "real";
					expect(observer.isStillReal()).toBe(true);
					override = "emulated";
					expect(observer.isStillReal()).toBe(false);
				}
});

test("ordinary classification settles in main's microtask budget on every read path", async () => {
	for (const [
		development,
		override,
		compatible,
		model,
		release,
		product,
		expected,
	] of [
		[true, undefined, "", "", "", "", 1],
		[false, "real", "", "", "", "", 1],
		[false, "emulated", "", "", "", "", 1],
		[false, undefined, "rockchip,rk3588", "", "", "", 3],
		[false, undefined, "", "RK3588", "", "", 5],
		[false, undefined, "", "", "", "", 7],
		[false, undefined, "", "", "ID=ceralive", "N100", 11],
		[false, undefined, "", "", "ID=ceralive", "", 11],
	] as const) {
		let settled = false;
		void isRealDevice({
			getDeviceTypeOverride: () => override,
			isDevelopment: () => development,
			readDeviceTreeCompatible: async () => compatible,
			readDeviceTreeModel: async () => model,
			readCeraliveRelease: async () => release,
			readDmiProductName: async () => product,
			readDmiBoardName: async () => "",
		}).then(() => {
			settled = true;
		});
		for (let tick = 1; tick <= expected; ++tick) {
			await Promise.resolve();
			expect(settled).toBe(tick === expected);
		}
	}
});

test("installation and the existing poll honor native provenance and live fences", async () => {
	const saved = { ...process.env };
	const priorConfig = getConfigFilePath();
	const folder = mkdtempSync(join(tmpdir(), "bond-guard-model-"));
	const networkConfig = join(folder, "config.json");
	const interval = spyOn(globalThis, "setInterval");
	const run = spyOn(commands, "run").mockImplementation(
		() => new Promise<string>(() => {}),
	);
	let checks = 0;
	const observer = {
		isStillReal: () => true,
		refresh: () => {
			++checks;
		},
	};
	try {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		delete process.env.MOCK_SCENARIO;
		delete process.env.HWSIM_REPO;
		writeFileSync(networkConfig, "{}");
		setConfigFilePath(networkConfig);
		await loadConfig();
		initNetworkInterfaceMonitoring();
		const poll = interval.mock.calls[0]?.[0];
		if (typeof poll !== "function")
			throw new Error("Missing existing interface poll");
		setBondDisableGuardContext(observer, false);
		poll();
		expect(checks).toBe(0);
		process.env.MOCK_MODE = "true";
		setBondDisableGuardContext(observer, true);
		poll();
		expect(checks).toBe(0);
		delete process.env.MOCK_MODE;
		poll();
		expect(checks).toBe(1);
		process.env.HWSIM_REPO = "";
		poll();
		expect(checks).toBe(1);
		delete process.env.HWSIM_REPO;
		setBondDisableGuardContext(observer, true);
		expect(checks).toBe(2);
		await drain();
	} finally {
		setBondDisableGuardContext(undefined, false);
		for (const { value } of interval.mock.results) {
			if (typeof value === "number") clearInterval(value);
			else if (value instanceof Object && "hasRef" in value)
				clearInterval(Number(value));
		}
		run.mockRestore();
		interval.mockRestore();
		setConfigFilePath(priorConfig);
		rmSync(folder, { recursive: true });
		for (const key of [
			"NODE_ENV",
			"MOCK_MODE",
			"MOCK_SCENARIO",
			"HWSIM_REPO",
		]) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
