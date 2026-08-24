/**
 * The data-usage POLICY write path.
 *
 * Every case drives the REAL pinned `@ceralive/modem-control` against a real
 * temp file, so this suite reports what the installed package can actually do
 * rather than what a double says it can. There is no package double left to
 * inject: the `1.2.1` pin is exact and the setter is a static import, so
 * "installed but without the setter" is not a state this build can reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	getCachedUsagePolicy,
	isUsagePolicySupported,
	refreshUsagePolicies,
	resetUsagePolicyState,
	usagePolicySlotKey,
	writeUsagePolicy,
} from "../modules/modems/usage-policy.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceraui-usage-policy-"));
	process.env.CERALIVE_MODEM_USAGE_POLICY_PATH = join(dir, "policy.json");
	resetUsagePolicyState();
});

afterEach(async () => {
	resetUsagePolicyState();
	delete process.env.CERALIVE_MODEM_USAGE_POLICY_PATH;
	await rm(dir, { recursive: true, force: true });
});

describe("usagePolicySlotKey", () => {
	test("prefers the stable key, because a legacy id is an MM index a replug re-issues", () => {
		expect(usagePolicySlotKey("2", "usb-1-1.4")).toBe("stable:usb-1-1.4");
	});

	test("falls back to the legacy id rather than filing no policy at all", () => {
		expect(usagePolicySlotKey("2")).toBe("modem:2");
		expect(usagePolicySlotKey("2", "")).toBe("modem:2");
	});

	test("two devices never share a slot", () => {
		expect(usagePolicySlotKey("2", "a")).not.toBe(usagePolicySlotKey("2", "b"));
		expect(usagePolicySlotKey("2")).not.toBe(usagePolicySlotKey("3"));
	});
});

describe("the REAL pinned @ceralive/modem-control", () => {
	test("the exact pin GUARANTEES the write, so the wire never claims otherwise", async () => {
		// `modem.data_usage_policy.supported` is published on every row, so this
		// is the one place the wire's claim is checked against the package that
		// has to honour it. A pin that could not write would have to fail here
		// rather than reach an operator as a control that does nothing.
		await refreshUsagePolicies();
		expect(isUsagePolicySupported()).toBe(true);

		const applied = await writeUsagePolicy("modem:1", { cycleDay: 5 });
		expect(applied).toEqual({ ok: true, policy: { cycleDay: 5 } });
		expect(getCachedUsagePolicy("modem:1")).toEqual({ cycleDay: 5 });
	});

	test("a write round-trips through a real file and reaches the sync cache", async () => {
		await refreshUsagePolicies();

		const written = await writeUsagePolicy("stable:usb-1-1.4", {
			cycleDay: 17,
			thresholdBytes: 10_737_418_240,
		});
		expect(written).toEqual({
			ok: true,
			policy: { cycleDay: 17, thresholdBytes: 10_737_418_240 },
		});
		expect(getCachedUsagePolicy("stable:usb-1-1.4")).toEqual({
			cycleDay: 17,
			thresholdBytes: 10_737_418_240,
		});

		// A fresh process reads the same file back.
		resetUsagePolicyState();
		await refreshUsagePolicies();
		expect(getCachedUsagePolicy("stable:usb-1-1.4")).toEqual({
			cycleDay: 17,
			thresholdBytes: 10_737_418_240,
		});
	});

	test("an OMITTED field is left alone and an explicit null clears it", async () => {
		await refreshUsagePolicies();

		await writeUsagePolicy("modem:1", {
			cycleDay: 9,
			thresholdBytes: 1_000_000,
		});
		await writeUsagePolicy("modem:1", { thresholdBytes: 2_000_000 });
		expect(getCachedUsagePolicy("modem:1")).toEqual({
			cycleDay: 9,
			thresholdBytes: 2_000_000,
		});

		await writeUsagePolicy("modem:1", { cycleDay: null });
		expect(getCachedUsagePolicy("modem:1")).toEqual({
			thresholdBytes: 2_000_000,
		});

		await writeUsagePolicy("modem:1", { thresholdBytes: null });
		expect(getCachedUsagePolicy("modem:1")).toBeUndefined();
	});

	test("an out-of-range day is refused, and the stored policy is untouched", async () => {
		await refreshUsagePolicies();

		await writeUsagePolicy("modem:1", { cycleDay: 9 });
		const refused = await writeUsagePolicy("modem:1", { cycleDay: 99 });

		expect(refused).toEqual({
			ok: false,
			reason: "usage_policy_write_failed",
		});
		expect(getCachedUsagePolicy("modem:1")).toEqual({ cycleDay: 9 });
	});

	test("one modem's policy never disturbs another's", async () => {
		await refreshUsagePolicies();

		await writeUsagePolicy("modem:1", { cycleDay: 1 });
		await writeUsagePolicy("modem:2", { cycleDay: 20 });
		await writeUsagePolicy("modem:1", { cycleDay: 5 });

		expect(getCachedUsagePolicy("modem:1")).toEqual({ cycleDay: 5 });
		expect(getCachedUsagePolicy("modem:2")).toEqual({ cycleDay: 20 });
	});
});
