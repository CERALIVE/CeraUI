import type { VersionContextDeps } from "../../modules/system/version-context.ts";

export const BOOT_ID = "66d8d1808694489b8c3a3fb4795cab24";
export const RAUC = await Bun.file(
	new URL(
		"../fixtures/rauc/status-detailed-rock-5b-plus-rauc-1.15.txt",
		import.meta.url,
	),
).text();
export const REVISIONS = {
	ceralive: "2026.11.3 (cd64289c)",
	srtla: "2026.11.1",
	cerastream: "2026.11.2",
	kernel: "6.1.115",
	bun: "1.4.4",
};
export const FULL_CONTEXT = {
	bootId: BOOT_ID,
	osImage: "2026.11.0",
	slot: "B",
	board: "ceralive-rock-5b-plus",
	boardModel: "Radxa ROCK 5B+",
	ceraui: REVISIONS.ceralive,
	engine: REVISIONS.cerastream,
	senderVersion: REVISIONS.srtla,
	kernel: REVISIONS.kernel,
	bun: REVISIONS.bun,
};
export const deps = (): VersionContextDeps => ({
	bootId: () => BOOT_ID,
	revisions: () => ({ ...REVISIONS }),
	mocks: () => false,
	readOsImage: async () => "2026.11.0",
	readLegacyOsImage: async () => "2026.10.0\n",
	readRauc: async () => RAUC,
	readBoardModel: async () => "Radxa ROCK 5B+\0\n",
});
export const unavailable = async (): Promise<never> => {
	throw new Error("reader unavailable");
};
