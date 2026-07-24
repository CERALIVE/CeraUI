/*
 * Task 10 (S4) — surface the previously-swallowed failures.
 *
 * Each fixed path used to swallow its failure silently (or degrade to a wrong
 * value). These tests force the failure and assert the path now surfaces it:
 *   - execPNR logs the failure and preserves the real exit code + stdout
 *     instead of blanking the result;
 *   - the software-update size check logs + notifies the operator when apt
 *     itself cannot run (vs. the intentional `--assume-no` non-zero exit);
 *   - a malformed nmcli WiFi scan row is logged + skipped (typed null) instead
 *     of broadcasting NaN signal/freq.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { execPNR } from "../helpers/exec.ts";
import { logger } from "../helpers/logger.ts";
import { reportUpdateCheckFailure } from "../modules/system/software-updates.ts";
import * as notifMod from "../modules/ui/notifications.ts";
import { parseWifiScanRow } from "../modules/wifi/wifi-connections.ts";

const noop = (() => {}) as never;

describe("execPNR — surfaces swallowed shell failures", () => {
	it("logs the failure and preserves stdout + the real exit code", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(noop);
		try {
			const res = await execPNR("echo hello && false");
			expect(res.code).not.toBe(0);
			expect(res.stdout).toContain("hello");
			expect(debugSpy).toHaveBeenCalled();
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("returns code 0 and logs nothing on a successful command", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(noop);
		try {
			const res = await execPNR("echo ok");
			expect(res.code).toBe(0);
			expect(res.stdout).toContain("ok");
			expect(debugSpy).not.toHaveBeenCalled();
		} finally {
			debugSpy.mockRestore();
		}
	});
});

describe("reportUpdateCheckFailure — surfaces a broken update check", () => {
	afterEach(() => {
		notifMod.notificationRemove("software_update_check_failed");
	});

	it("logs + notifies when apt exits non-zero with no output", () => {
		const errSpy = spyOn(logger, "error").mockImplementation(noop);
		const notifySpy = spyOn(
			notifMod,
			"notificationBroadcast",
		).mockImplementation((() => true) as never);
		try {
			const failed = reportUpdateCheckFailure({
				code: 100,
				stdout: "",
				stderr: "E: Could not get lock /var/lib/dpkg/lock",
			});
			expect(failed).toBe(true);
			expect(errSpy).toHaveBeenCalled();
			expect(notifySpy).toHaveBeenCalledWith(
				"software_update_check_failed",
				"warning",
				expect.any(String),
				60,
				false,
				true,
			);
		} finally {
			errSpy.mockRestore();
			notifySpy.mockRestore();
		}
	});

	it("does NOT notify on the normal --assume-no exit (non-zero WITH output)", () => {
		const notifySpy = spyOn(
			notifMod,
			"notificationBroadcast",
		).mockImplementation((() => true) as never);
		const removeSpy = spyOn(notifMod, "notificationRemove").mockImplementation(
			noop,
		);
		try {
			const failed = reportUpdateCheckFailure({
				code: 1,
				stdout: "The following packages will be upgraded:\n  ceraui\n",
				stderr: "",
			});
			expect(failed).toBe(false);
			expect(notifySpy).not.toHaveBeenCalled();
		} finally {
			notifySpy.mockRestore();
			removeSpy.mockRestore();
		}
	});
});

describe("parseWifiScanRow — surfaces a malformed scan row", () => {
	it("returns null and logs the raw row when signal/chan do not parse", () => {
		const warnSpy = spyOn(logger, "warn").mockImplementation(noop);
		try {
			expect(
				parseWifiScanRow(
					"*:AA\\:BB\\:CC\\:DD\\:EE\\:01:MyNet:Infra:bogus:540 Mbit/s:not-a-number:▂▄▆█:WPA2",
				),
			).toBeNull();
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("parses a well-formed row into typed fields", () => {
		expect(
			parseWifiScanRow(
				"*:AA\\:BB\\:CC\\:DD\\:EE\\:01:MyNet:Infra:72:540 Mbit/s:96:▂▄▆█:WPA2",
			),
		).toEqual({
			active: true,
			bssid: "AA:BB:CC:DD:EE:01",
			ssid: "MyNet",
			signal: 96,
			security: "WPA2",
			chan: 72,
		});
	});

	it("returns null without warning for a hidden (empty-SSID) row", () => {
		const warnSpy = spyOn(logger, "warn").mockImplementation(noop);
		try {
			expect(
				parseWifiScanRow(
					":AA\\:BB\\:CC\\:DD\\:EE\\:02::Infra:72:540 Mbit/s:50:▂▄▆█:WPA2",
				),
			).toBeNull();
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});
