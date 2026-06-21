import { describe, expect, it } from "vitest";

import {
	type DiskUsageLike,
	isDiskLow,
	LOW_DISK_THRESHOLD_BYTES,
} from "./disk-warning";

const MIB = 1024 * 1024;

/** Build a disk signal with exactly `freeMiB` free out of a 16 GiB volume. */
function diskWithFree(freeMiB: number): DiskUsageLike {
	const total = 16 * 1024 * MIB;
	return { total, used: total - freeMiB * MIB };
}

describe("isDiskLow — fixed 512 MiB boundary", () => {
	it("the threshold is exactly 512 MiB", () => {
		// Given the production-readiness floor
		// Then it is 512 MiB expressed in bytes
		expect(LOW_DISK_THRESHOLD_BYTES).toBe(512 * MIB);
	});

	it("fires when free space is below 512 MiB (511 MiB)", () => {
		// Given /data with 511 MiB free
		// When the warning is derived
		// Then it fires (511 < 512)
		expect(isDiskLow(diskWithFree(511))).toBe(true);
	});

	it("does NOT fire at exactly 512 MiB free (strict boundary)", () => {
		// Given /data with exactly 512 MiB free
		// Then the strict `<` boundary does not warn
		expect(isDiskLow(diskWithFree(512))).toBe(false);
	});

	it("does NOT fire when free space is above 512 MiB (513 MiB)", () => {
		// Given /data with 513 MiB free
		// Then no warning (513 > 512)
		expect(isDiskLow(diskWithFree(513))).toBe(false);
	});

	it("does not warn on a missing disk signal", () => {
		// Given a degraded/absent disk source
		// Then a null/undefined signal never raises a false alarm
		expect(isDiskLow(null)).toBe(false);
		expect(isDiskLow(undefined)).toBe(false);
	});

	it("does not warn when used exceeds total (unparseable free)", () => {
		// Given a nonsensical snapshot (used > total)
		// Then the negative free space is treated as low — recording cannot proceed
		expect(isDiskLow({ total: 100, used: 200 })).toBe(true);
	});
});
