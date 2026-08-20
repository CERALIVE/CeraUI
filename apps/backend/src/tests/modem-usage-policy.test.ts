/**
 * The data-usage POLICY write path.
 *
 * The load-bearing case is the LAST describe: it drives the REAL pinned
 * `@ceralive/modem-control` against a real temp file, so this suite reports what
 * the installed package can actually do rather than what a double says it can.
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
	setUsagePolicyPackageForTest,
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
	setUsagePolicyPackageForTest(undefined);
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

describe("a package with no setter", () => {
	beforeEach(() => {
		setUsagePolicyPackageForTest(null);
	});

	test("reports the capability as false rather than pretending", async () => {
		await refreshUsagePolicies();
		expect(isUsagePolicySupported()).toBe(false);
	});

	test("REFUSES the write instead of accepting one it would drop", async () => {
		const result = await writeUsagePolicy("modem:1", { cycleDay: 5 });

		expect(result).toEqual({ ok: false, reason: "usage_policy_unsupported" });
		expect(getCachedUsagePolicy("modem:1")).toBeUndefined();
	});
});

describe("the REAL pinned @ceralive/modem-control", () => {
	test("a write round-trips through a real file and reaches the sync cache", async () => {
		await refreshUsagePolicies();
		if (!isUsagePolicySupported()) {
			// The pinned release predates `setUsagePolicy`. That is a legitimate
			// state (the wire reports `supported: false` and the UI disables the
			// controls), so the honest assertion is the refusal, not a skip.
			expect(await writeUsagePolicy("modem:1", { cycleDay: 5 })).toEqual({
				ok: false,
				reason: "usage_policy_unsupported",
			});
			return;
		}

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
		if (!isUsagePolicySupported()) return;

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
		if (!isUsagePolicySupported()) return;

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
		if (!isUsagePolicySupported()) return;

		await writeUsagePolicy("modem:1", { cycleDay: 1 });
		await writeUsagePolicy("modem:2", { cycleDay: 20 });
		await writeUsagePolicy("modem:1", { cycleDay: 5 });

		expect(getCachedUsagePolicy("modem:1")).toEqual({ cycleDay: 5 });
		expect(getCachedUsagePolicy("modem:2")).toEqual({ cycleDay: 20 });
	});
});
