/**
 * The both-slots reader against RAUC's REAL output, not a hand-written shape.
 *
 * The fixtures are byte-for-byte captures from a Rock 5B+ running RAUC 1.15
 * (`rauc status --detailed --output-format=json` and the image's slot-sync
 * receipt). They are kept as `.txt` so the formatter never rewrites them.
 * Real RAUC differs from the older unit fixtures in two ways that matter:
 * a non-rootfs slot (`certs.0`) carries `bootname`/`boot_status` as `null`,
 * and the bundle version and install time are nested under `slot_status`.
 */
import { describe, expect, test } from "bun:test";
import { readUpdateDetails } from "../modules/system/update-orchestrator/details.ts";
import { parseBothSlotStatus } from "../modules/system/update-orchestrator/slot-status.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

const FIXTURE_DIR = `${import.meta.dir}/fixtures/rauc`;
const raucJson = await Bun.file(
	`${FIXTURE_DIR}/status-detailed-rock-5b-plus-rauc-1.15.txt`,
).text();
const receipt: unknown = await Bun.file(
	`${FIXTURE_DIR}/sync-receipt-rock-5b-plus.txt`,
).json();

function detailsFor(
	readSlots: () => Promise<ReturnType<typeof parseBothSlotStatus>>,
) {
	return readUpdateDetails({
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "slot-sync"],
		}),
		readSlots,
		readBootedVersion: async () => "2026.10.30",
		readStagedReceipt: async () => undefined,
		orchestratorState: () => initialOrchestratorState(0),
		osSummary: () => ({ candidate: null, pendingCellular: null }),
		lastTransport: () => undefined,
	});
}

describe("parseBothSlotStatus on real RAUC 1.15 output", () => {
	test("reads both rootfs slots from the nested slot_status and leaves certs.0 out", () => {
		expect(parseBothSlotStatus(raucJson, null)).toEqual([
			{
				name: "rootfs.1",
				bootname: "B",
				state: "booted",
				bootStatus: "good",
				version: "36d8131",
				lastSyncedAt: null,
			},
			{
				name: "rootfs.0",
				bootname: "A",
				state: "inactive",
				bootStatus: "good",
				version: "36d8131",
				lastSyncedAt: null,
			},
		]);
	});

	test("the board's own receipt marks the mirrored slot as synced", () => {
		const slots = parseBothSlotStatus(raucJson, receipt);
		expect(slots.map((slot) => [slot.name, slot.lastSyncedAt])).toEqual([
			["rootfs.1", null],
			["rootfs.0", "2026-09-30T06:22:00Z"],
		]);
	});

	test("a RAUC install into the mirror after the receipt drops the receipt", () => {
		// Same document, but RAUC reports rootfs.0 installed AFTER the sync
		// completed: the receipt no longer describes that slot's contents.
		const reinstalled = raucJson.replace(
			'"installed":{"timestamp":"2026-09-30T05:59:27Z"',
			'"installed":{"timestamp":"2026-09-30T07:00:00Z"',
		);
		expect(reinstalled).not.toBe(raucJson);
		const mirror = parseBothSlotStatus(reinstalled, receipt).find(
			(slot) => slot.name === "rootfs.0",
		);
		expect(mirror?.lastSyncedAt).toBeNull();
		expect(mirror?.version).toBe("36d8131");
	});
});

describe("getUpdateDetails slots on real RAUC output", () => {
	test("the real document reaches the wire instead of degrading to null", async () => {
		const details = await detailsFor(async () =>
			parseBothSlotStatus(raucJson, receipt),
		);
		expect(details.slots?.map((slot) => slot.name)).toEqual([
			"rootfs.1",
			"rootfs.0",
		]);
	});

	test("a genuinely malformed document still degrades slots to null", async () => {
		const details = await detailsFor(async () =>
			parseBothSlotStatus('{"slots":[{"rootfs.0":{"class":7}}]}', null),
		);
		expect(details.slots).toBeNull();
	});
});
