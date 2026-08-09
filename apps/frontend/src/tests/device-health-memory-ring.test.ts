// @vitest-environment jsdom
/**
 * The memory history ring — the third channel of the Device Health recorder.
 *
 * It rides the EXISTING `device-stats` effect: there is no second message owner
 * and no second fetch, which is the CI-gated rule the store's own header states.
 * So every assertion here drives the ring by publishing a new `device-stats`
 * OBJECT, exactly as `subscriptions.svelte.ts` does on the wire.
 *
 * The rule the ring exists to keep honest is the same one the payload keeps: an
 * ABSENT `memUsedPercent` is a delivery whose memory reading was not measurable
 * — it stamps the delivery and appends NOTHING, so the trace grows a hole. A
 * measured `0` is a reading and is kept.
 */

import type { DeviceStats } from "@ceraui/rpc/schemas";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"$lib/rpc/subscriptions.svelte",
	async () => await import("./fixtures/device-stats-feed.svelte"),
);

function stats(extra: Partial<DeviceStats> = {}): DeviceStats {
	return {
		disk: null,
		cpuLoad1: 0.5,
		socTemp: null,
		ifaceRxTx: null,
		raucSlot: "A",
		...extra,
	};
}

async function store() {
	return await import("$lib/stores/device-health-history.svelte");
}

async function publish(next: DeviceStats | undefined): Promise<void> {
	const feed = await import("./fixtures/device-stats-feed.svelte");
	feed.publishDeviceStats(next);
	flushSync();
}

// Deliberately NOT `vi.resetModules()`: the mocked subscription module is
// resolved once by the module under test, so resetting the registry would hand
// the test a SECOND fixture instance and every publish would land in a module
// the store is not reading. Destroying the store singleton is the real reset —
// it drops the effect root, the rings and the `prev*` arrival keys together.
beforeEach(async () => {
	(await store()).destroyDeviceHealthHistory();
	(await import("./fixtures/device-stats-feed.svelte")).publishDeviceStats(
		undefined,
	);
});

afterEach(async () => {
	(await store()).destroyDeviceHealthHistory();
});

describe("the memory ring fills from the device-stats broadcast", () => {
	it("appends one sample per delivery, in arrival order", async () => {
		const s = await store();
		s.initDeviceHealthHistory();
		await publish(stats({ memUsedPercent: 41 }));
		await publish(stats({ memUsedPercent: 43 }));

		expect(s.getMemorySamples().map((sample) => sample.v)).toEqual([41, 43]);
		expect(s.getMemoryStatus().state).toBe("live");
		expect(s.getMemoryStatus().value).toBe(43);
	});

	it("keeps a measured zero — an empty board is a reading", async () => {
		const s = await store();
		s.initDeviceHealthHistory();
		await publish(stats({ memUsedPercent: 0 }));

		expect(s.getMemorySamples().map((sample) => sample.v)).toEqual([0]);
		expect(s.getMemoryStatus().value).toBe(0);
	});

	it("an absent memUsedPercent appends nothing but still stamps the delivery", async () => {
		const s = await store();
		s.initDeviceHealthHistory();
		await publish(stats({ memUsedPercent: 41 }));
		await publish(stats());

		// The 41 stays in the ring — history is not rewritten — but the delivery
		// that carried no reading contributes no point, so the trace gaps.
		expect(s.getMemorySamples().map((sample) => sample.v)).toEqual([41]);
		const status = s.getMemoryStatus();
		expect(status.state).toBe("unavailable");
		expect(status.value).toBeNull();
	});

	it("does not disturb the load ring it shares an effect with", async () => {
		const s = await store();
		s.initDeviceHealthHistory();
		await publish(stats({ cpuLoad1: 1.25, memUsedPercent: 41 }));

		expect(s.getLoadSamples().map((sample) => sample.v)).toEqual([1.25]);
		expect(s.getMemorySamples().map((sample) => sample.v)).toEqual([41]);
	});

	it("waits rather than inventing a first reading", async () => {
		const s = await store();
		s.initDeviceHealthHistory();
		flushSync();

		expect(s.getMemorySamples()).toHaveLength(0);
		expect(s.getMemoryStatus().state).toBe("waiting");
	});
});
