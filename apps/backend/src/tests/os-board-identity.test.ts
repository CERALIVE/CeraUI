import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type OsAgentError,
	readBoardIdentity,
} from "../modules/system/update-orchestrator/os-agent.ts";
import { validateSignedOsManifest } from "../modules/system/update-orchestrator/os-manifest.ts";

let root: string | undefined;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function identityFromConfig(compatible: string) {
	root = await mkdtemp(join(tmpdir(), "os-board-identity-"));
	const path = join(root, "system.conf");
	await writeFile(path, `[system]\ncompatible=${compatible}\n`);
	return readBoardIdentity(path);
}

describe("physical RAUC compatible selects only its known product channel", () => {
	test.each([
		["ceralive-rock-5b-plus", "rock-5b-plus"],
		["ceralive-orangepi5-plus", "orange-pi-5-plus"],
	] as const)(
		"%s selects %s without changing the compatible",
		async (compatible, board) => {
			const identity = await identityFromConfig(compatible);
			expect(identity).toEqual({ board, compatible });
			expect(
				`https://images.ceralive.tv/channels/drill/${identity.board}.json`,
			).toBe(`https://images.ceralive.tv/channels/drill/${board}.json`);
		},
	);

	test.each([
		"ceralive-orange-pi-5-plus",
		"ceralive-orangepi5-plus-extra",
		"ceralive-rock-5b-plus-extra",
		"ceralive-rock-5b-plu",
		"ceralive-orangepi5-plus/../rock-5b-plus",
		"ceralive-unknown-board",
		"orangepi5-plus",
	] as const)("refuses %s before channel selection", async (compatible) => {
		await expect(identityFromConfig(compatible)).rejects.toMatchObject({
			name: "OsAgentError",
			reason: "rauc_compatible_unknown",
		} satisfies Partial<OsAgentError>);
	});
});

const orangeManifest = {
	schema: 1,
	board: "orange-pi-5-plus",
	compatible: "ceralive-orangepi5-plus",
	channel: "drill",
	version: "2026.10.6",
	serial: 5,
	published_at: "2026-09-28T12:00:00Z",
	expires_at: "2026-12-28T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/orange-pi-5-plus/2026.10.6/bundle.raucb",
		size: 10,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/orange-pi-5-plus/2026.10.6/flash.raw.xz",
		size: 10,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/orange-pi-5-plus/2026.10.6/packages.lock.json",
} as const;

async function verifyOrangePointer(pointer: unknown) {
	const identity = await identityFromConfig("ceralive-orangepi5-plus");
	const context = {
		...identity,
		channel: "drill" as const,
		serial: 4,
		bootedVersion: "2026.10.5",
		installedVersion: "2026.9.5",
		now: Date.parse("2026-09-28T13:00:00Z"),
	};
	const deps = {
		verifyCms: async () => ({
			cn: "CeraLive OTA Manifest Signer",
			eku: ["codeSigning"],
			issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
		}),
		compare: async (candidate: string, current: string) =>
			candidate === "2026.10.6" && current === "2026.10.5",
		isQuarantined: async () => false,
	};
	return validateSignedOsManifest(
		new TextEncoder().encode(JSON.stringify(pointer)),
		new Uint8Array([1]),
		context,
		deps,
	);
}

test("signed Orange pointer admits the distinct slug and compatible", async () => {
	expect(await verifyOrangePointer(orangeManifest)).toEqual({
		ok: true,
		manifest: orangeManifest,
	});
});

test.each([
	[
		"cross-board slug",
		{ ...orangeManifest, board: "rock-5b-plus" },
		"wrong_board",
	],
	[
		"product-slug-compatible alias",
		{ ...orangeManifest, compatible: "ceralive-orange-pi-5-plus" },
		"wrong_compatible",
	],
	[
		"cross-board compatible",
		{ ...orangeManifest, compatible: "ceralive-rock-5b-plus" },
		"wrong_compatible",
	],
	[
		"same-prefix near compatible",
		{ ...orangeManifest, compatible: "ceralive-orangepi5-plus-extra" },
		"wrong_compatible",
	],
] as const)(
	"signed Orange pointer refuses %s",
	async (_label, pointer, reason) => {
		expect(await verifyOrangePointer(pointer)).toEqual({ ok: false, reason });
	},
);
