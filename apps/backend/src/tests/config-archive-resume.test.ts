import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getConfig,
	isRuntimeConfigAvailable,
	loadConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	awaitRuntimeConfig,
	bootRuntimeConfig,
	stopRuntimeConfigRecovery,
} from "../modules/config-boot.ts";

// Real archive/reload work measured 5.87 s under 64 burners; retry waits already use fixture events.
test("post-bind config recovery resumes on the next attempt after one archive cleanup EIO", async () => {
	// Given unavailable config through all initial attempts (boot cleanup already passed).
	const root = fs.mkdtempSync(join(tmpdir(), "config-archive-resume-"));
	const path = join(root, "config.json");
	fs.mkdirSync(path);
	setConfigFilePath(path);
	const waits: number[] = [];
	const announced: string[] = [];
	let release = () => {};
	let secondWait = () => {};
	const failedOnce = new Promise<void>((resolve) => {
		secondWait = resolve;
	});
	let thirdWait = () => {};
	const stillUnavailable = new Promise<void>((resolve) => {
		thirdWait = resolve;
	});
	const unlink = fs.unlinkSync;
	let failed = false;
	const fault = spyOn(fs, "unlinkSync").mockImplementation((p) => {
		if (String(p).endsWith(".tmp") && !failed) {
			failed = true;
			throw Object.assign(new Error("EIO cleanup"), { code: "EIO" });
		}
		return unlink(p);
	});
	try {
		await bootRuntimeConfig({
			sleep: (ms, signal) => {
				waits.push(ms);
				if (waits.length <= 2) return Promise.resolve();
				if (waits.length === 4) secondWait();
				if (waits.length === 5) thirdWait();
				return new Promise<void>((resolve) => {
					release = resolve;
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
			},
			onDamagedReset: (copy) => {
				announced.push(copy);
			},
		});
		expect(isRuntimeConfigAvailable()).toBe(false);
		fs.rmSync(path, { recursive: true });
		fs.writeFileSync(path, "{");
		// When the first background attempt publishes but cannot clean; the next retries.
		release();
		await failedOnce;
		expect(fs.readFileSync(path, "utf8")).toBe("{");
		expect(announced).toEqual([]);
		release();
		await Promise.race([awaitRuntimeConfig(), stillUnavailable]);
		// Then storage recovery makes config available exactly once without another boot sweep.
		expect(isRuntimeConfigAvailable()).toBe(true);
		expect(getConfig().autostart).toBe(false);
		expect(waits).toEqual([250, 1000, 1000, 2000]);
		expect(announced).toHaveLength(1);
		expect(fs.readFileSync(announced[0] ?? "missing", "utf8")).toBe("{");
		expect(fs.readFileSync(path, "utf8")).toBe("{}");
		expect(fs.readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		expect(
			fs.readdirSync(root).filter((n) => n.includes(".damaged-")),
		).toHaveLength(1);
	} finally {
		fault.mockRestore();
		stopRuntimeConfigRecovery();
		release();
		fs.rmSync(path, { recursive: true, force: true });
		fs.writeFileSync(path, "{}");
		await loadConfig();
		setConfigFilePath("config.json");
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 10_000);
