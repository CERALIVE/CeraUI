/**
 * `parseStagedActivation` against RAUC 1.15 documents from the Rock 5B+ bench.
 *
 * `status-detailed-rock-5b-plus-rauc-1.15.txt` is the byte-for-byte capture
 * taken after a clean activation into slot B (task-45x/rock 30-baseline.txt;
 * the same stamps as the post-boot capture in task-45/rock-r4b). The crash
 * fixture is the JSON form of the post-crash status in e-37-postcrash.txt:
 * slot A carries the 08:38:53Z install and, as RAUC writes it after an
 * install, no `activated` stamp at all.
 */
import { describe, expect, test } from "bun:test";
import { parseStagedActivation } from "../modules/system/update-orchestrator/slot-status.ts";

const FIXTURE_DIR = `${import.meta.dir}/fixtures/rauc`;
const cleanRauc = await Bun.file(
	`${FIXTURE_DIR}/status-detailed-rock-5b-plus-rauc-1.15.txt`,
).text();
const crashRauc = await Bun.file(
	`${FIXTURE_DIR}/status-detailed-rock-5b-plus-rauc-1.15-crash-armed.txt`,
).text();

type RaucDocument = {
	boot_primary?: string;
	slots: Record<string, { slot_status: Record<string, unknown> }>[];
};

function edit(text: string, change: (document: RaucDocument) => void): string {
	const document: RaucDocument = JSON.parse(text);
	change(document);
	return JSON.stringify(document);
}

function slotStatus(
	document: RaucDocument,
	name: string,
): Record<string, unknown> {
	const slot = document.slots.find((item) => name in item)?.[name];
	if (!slot) throw new Error(`fixture has no ${name}`);
	return slot.slot_status;
}

describe("parseStagedActivation", () => {
	test("the Rock crash replay is still pending activation", () => {
		expect(parseStagedActivation(crashRauc)).toBe("pending");
	});

	test("an install newer than an older activation stamp is pending", () => {
		const withOldStamp = edit(crashRauc, (document) => {
			slotStatus(document, "rootfs.0").activated = {
				timestamp: "2026-09-30T06:00:24Z",
				count: 2,
			};
		});
		expect(parseStagedActivation(withOldStamp)).toBe("pending");
	});

	test("the other slot activated after its install is consumed", () => {
		expect(parseStagedActivation(cleanRauc)).toBe("consumed");
		const activatedThenFellBack = edit(crashRauc, (document) => {
			slotStatus(document, "rootfs.0").activated = {
				timestamp: "2026-09-30T08:50:00Z",
				count: 3,
			};
		});
		expect(parseStagedActivation(activatedThenFellBack)).toBe("consumed");
	});

	test("booting a slot other than the primary is consumed", () => {
		const fallback = edit(crashRauc, (document) => {
			document.boot_primary = "rootfs.0";
		});
		expect(parseStagedActivation(fallback)).toBe("consumed");
	});

	test("a document that cannot answer is unknown", () => {
		expect(parseStagedActivation("")).toBe("unknown");
		expect(parseStagedActivation('{"slots":[]}')).toBe("unknown");
		expect(
			parseStagedActivation(
				edit(crashRauc, (document) => {
					delete document.boot_primary;
				}),
			),
		).toBe("unknown");
		expect(
			parseStagedActivation(
				edit(crashRauc, (document) => {
					slotStatus(document, "rootfs.0").installed = {
						timestamp: "not-a-time",
					};
				}),
			),
		).toBe("unknown");
	});
});
