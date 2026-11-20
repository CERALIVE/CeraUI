import { describe, expect, spyOn, test } from "bun:test";
import { versionContextSchema } from "@ceraui/rpc/schemas";
import { ENGINE_UNREACHABLE_REVISION } from "../modules/system/revisions.ts";
import { collectVersionContext } from "../modules/system/version-context.ts";
import {
	BOOT_ID,
	deps,
	FULL_CONTEXT,
	REVISIONS,
	unavailable,
} from "./helpers/version-context-fixtures.ts";

describe("version context", () => {
	test("collects one RAUC snapshot and satisfies the published wire schema", async () => {
		const readRauc = spyOn(deps(), "readRauc");
		const context = await collectVersionContext({ ...deps(), readRauc });
		expect(context).toEqual(FULL_CONTEXT);
		expect(versionContextSchema.parse(context)).toEqual(FULL_CONTEXT);
		expect(context.bootId).toMatch(/^[0-9a-f]{32}$/);
		expect(readRauc).toHaveBeenCalledTimes(1);
		readRauc.mockRestore();
	});

	test("a failed RAUC read leaves both slot and board unknown", async () => {
		const context = await collectVersionContext({
			...deps(),
			readRauc: unavailable,
		});
		expect(context).toEqual({ ...FULL_CONTEXT, slot: null, board: null });
	});

	test.each(["not json", "null", "[]", '{"booted":4,"compatible":false}'])(
		"malformed RAUC output never claims a slot or board: %s",
		async (stdout) => {
			const context = await collectVersionContext({
				...deps(),
				readRauc: async () => stdout,
			});
			expect(context.slot).toBeNull();
			expect(context.board).toBeNull();
		},
	);

	test("missing RAUC fields remain null without guessing from boot_primary", async () => {
		const context = await collectVersionContext({
			...deps(),
			readRauc: async () => '{"boot_primary":"rootfs.0"}',
		});
		expect(context.slot).toBeNull();
		expect(context.board).toBeNull();
	});

	test.each([
		[{ booted: "B" }, "B", null],
		[{ compatible: "ceralive-rock-5b-plus" }, null, "ceralive-rock-5b-plus"],
		[
			{ booted: null, compatible: "ceralive-rock-5b-plus" },
			null,
			"ceralive-rock-5b-plus",
		],
		[
			{ booted: 4, compatible: "ceralive-rock-5b-plus" },
			null,
			"ceralive-rock-5b-plus",
		],
		[{ booted: "B", compatible: false }, "B", null],
	])(
		"a missing or invalid RAUC field preserves its readable sibling: %j",
		async (status, slot, board) => {
			const context = await collectVersionContext({
				...deps(),
				readRauc: async () => JSON.stringify(status),
			});
			expect(context.slot).toBe(slot);
			expect(context.board).toBe(board);
		},
	);

	test.each(["", " \n"])("empty optional text is unknown: %j", async (text) => {
		const context = await collectVersionContext({
			...deps(),
			readOsImage: async () => undefined,
			readLegacyOsImage: async () => text,
			readBoardModel: async () => text,
			readRauc: async () => JSON.stringify({ booted: text, compatible: text }),
		});
		expect(context).toEqual({
			...FULL_CONTEXT,
			osImage: null,
			slot: null,
			board: null,
			boardModel: null,
		});
	});

	test("the validated OS stamp outranks the legacy image file", async () => {
		const context = await collectVersionContext({
			...deps(),
			readLegacyOsImage: async () => {
				throw new Error("legacy must not be read");
			},
		});
		expect(context.osImage).toBe("2026.11.0");
	});

	test.each([async () => undefined, unavailable])(
		"missing or rejected OS stamp falls back to trimmed legacy content",
		async (readOsImage) => {
			const context = await collectVersionContext({ ...deps(), readOsImage });
			expect(context.osImage).toBe("2026.10.0");
		},
	);

	test("an unreachable engine does not retain a stale version", async () => {
		const sources = deps();
		await collectVersionContext(sources);
		const context = await collectVersionContext({
			...sources,
			revisions: () => ({
				...REVISIONS,
				cerastream: ENGINE_UNREACHABLE_REVISION,
			}),
		});
		expect(context.engine).toBeNull();
	});

	test("an unreadable sender revision is unknown rather than a version", async () => {
		const context = await collectVersionContext({
			...deps(),
			revisions: () => ({ ...REVISIONS, srtla: "unknown revision" }),
		});
		expect(context.senderVersion).toBeNull();
	});

	test("every optional reader can reject without losing required identity", async () => {
		const context = await collectVersionContext({
			...deps(),
			revisions: () => ({ ceralive: REVISIONS.ceralive }),
			readOsImage: unavailable,
			readLegacyOsImage: unavailable,
			readRauc: unavailable,
			readBoardModel: unavailable,
		});
		expect(context).toEqual({
			bootId: BOOT_ID,
			ceraui: REVISIONS.ceralive,
			osImage: null,
			slot: null,
			board: null,
			boardModel: null,
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
		});
	});

	test("mock mode uses the existing mock slot and never probes host hardware", async () => {
		let hostReads = 0;
		const hostProbe = async (): Promise<never> => {
			hostReads += 1;
			throw new Error("host hardware must not be read");
		};
		const context = await collectVersionContext({
			...deps(),
			mocks: () => true,
			readOsImage: hostProbe,
			readLegacyOsImage: hostProbe,
			readRauc: hostProbe,
			readBoardModel: hostProbe,
		});
		expect(hostReads).toBe(0);
		expect(context).toEqual({
			bootId: BOOT_ID,
			ceraui: REVISIONS.ceralive,
			osImage: null,
			slot: "A",
			board: null,
			boardModel: null,
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
		});
	});

	test("absent CeraUI revision uses the existing unknown revision label", async () => {
		const context = await collectVersionContext({
			...deps(),
			revisions: () => ({}),
		});
		expect(context.ceraui).toBe("unknown revision");
	});

	test("revision strings remain verbatim while only absent revisions use fallbacks", async () => {
		const context = await collectVersionContext({
			...deps(),
			revisions: () => ({
				ceralive: "",
				cerastream: "",
				srtla: "",
				kernel: "",
				bun: "",
			}),
		});
		expect(context).toEqual({
			...FULL_CONTEXT,
			ceraui: "",
			engine: "",
			senderVersion: "",
			kernel: "",
			bun: "",
		});
	});

	test("a present empty OS stamp is unknown without selecting the legacy version", async () => {
		const context = await collectVersionContext({
			...deps(),
			readOsImage: async () => "",
		});
		expect(context.osImage).toBeNull();
	});

	test("missing boot identity cannot produce a falsely valid context", async () => {
		await expect(
			collectVersionContext({ ...deps(), bootId: () => undefined }),
		).rejects.toThrow();
	});
});
