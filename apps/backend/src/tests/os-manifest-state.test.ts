import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as configLoader from "../helpers/config-loader.ts";
import {
	checkOsChannel,
	readManifestSerial,
	saveStagedManifest,
} from "../modules/system/update-orchestrator/os-agent.ts";
import {
	discoverSignedOsManifest,
	osChannelManifestSchema,
	readBootedOsReleaseVersion,
	resolveOsChannel,
} from "../modules/system/update-orchestrator/os-manifest.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	bytes,
	context,
	deps,
	manifest,
	signature,
	signed,
} from "./helpers/os-manifest-fixture.ts";

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("booted release version", () => {
	test("missing stamp is unknown, not the image-version timestamp fallback", async () => {
		root = await mkdtemp(join(tmpdir(), "os-manifest-"));
		await writeFile(join(root, "image-version"), "20260924T225840Z\n");
		expect(
			await readBootedOsReleaseVersion(join(root, "os-release-version")),
		).toBeUndefined();
	});

	test("malformed stamp is unknown; valid CalVer is accepted", async () => {
		root = await mkdtemp(join(tmpdir(), "os-manifest-"));
		const path = join(root, "os-release-version");
		for (const invalid of [
			"garbage\n",
			"20260924T225840Z\n",
			"2026.10.0\nextra\n",
		]) {
			await writeFile(path, invalid);
			expect(await readBootedOsReleaseVersion(path)).toBeUndefined();
		}
		await writeFile(path, "2026.9.0\n");
		expect(await readBootedOsReleaseVersion(path)).toBe("2026.9.0");
	});
});

test("drill override is accepted only for regular root-owned mode <=0644 and exact bytes", async () => {
	for (const entry of [
		{ content: "drill", uid: 0, mode: 0o644, regular: true, expected: "drill" },
		{
			content: "drill\n",
			uid: 0,
			mode: 0o644,
			regular: true,
			expected: "beta",
		},
		{ content: "stable", uid: 0, mode: 0o644, regular: true, expected: "beta" },
		{
			content: "drill",
			uid: 1000,
			mode: 0o644,
			regular: true,
			expected: "beta",
		},
		{ content: "drill", uid: 0, mode: 0o666, regular: true, expected: "beta" },
		{ content: "drill", uid: 0, mode: 0o644, regular: false, expected: "beta" },
	] as const) {
		const value = await resolveOsChannel("beta", {
			readOverride: async () => ({
				content: entry.content,
				uid: entry.uid,
				mode: entry.mode,
				regular: entry.regular,
			}),
			warn: () => {},
		});
		expect(value).toBe(entry.expected);
	}
});

test("beta serial 7 does not block stable serial 3; serial advances only on stage receipt", async () => {
	root = await mkdtemp(join(tmpdir(), "os-serial-"));
	await writeFile(join(root, "manifest-serial.beta"), "7\n");
	expect(await readManifestSerial("stable", root)).toBe(0);
	const candidate = osChannelManifestSchema.parse(manifest);
	expect(candidate.serial).toBe(3);
	expect(await readManifestSerial("stable", root)).toBe(0);
	await saveStagedManifest(
		candidate,
		"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		1000,
		root,
	);
	expect(await readManifestSerial("stable", root)).toBe(3);
	expect(await readManifestSerial("beta", root)).toBe(7);
});

test("agent discovery leaves an ahead-of-watermark current pointer unconsumed", async () => {
	// Given a fresh current pointer ahead of a real per-channel watermark.
	root = await mkdtemp(join(tmpdir(), "os-discovery-serial-"));
	const path = join(root, "manifest-serial.stable");
	await writeFile(path, "3\n");
	const stateDir = root;
	const write = configLoader.writeFileAtomicSync;
	// Rebase the agent's production store onto the same private reader store.
	const writer = spyOn(configLoader, "writeFileAtomicSync").mockImplementation(
		(target, content) => write(join(stateDir, basename(target)), content),
	);
	let result: Awaited<ReturnType<typeof checkOsChannel>>;
	try {
		// When the real agent discovers the authenticated current version.
		result = await checkOsChannel(
			"stable",
			new UpdateQuarantine(),
			async () => ({
				data: bytes({ ...manifest, serial: 4 }),
				signature,
				context: {
					...context,
					serial: await readManifestSerial("stable", stateDir),
					bootedVersion: manifest.version,
				},
				verification: deps,
			}),
		);
	} finally {
		writer.mockRestore();
	}
	// Then successful discovery writes no stage receipt or serial advancement.
	expect(result).toBeUndefined();
	expect(await Bun.file(path).text()).toBe("3\n");
	expect(await Bun.file(join(root, "os-staged.json")).exists()).toBe(false);
});

test("discovery leaves the persisted serial watermark unchanged when it finds no candidate", async () => {
	// Given a consumed current pointer and a real per-channel watermark file.
	root = await mkdtemp(join(tmpdir(), "os-discovery-serial-"));
	const path = join(root, "manifest-serial.stable");
	await writeFile(path, "3\n");
	const serial = await readManifestSerial("stable", root);
	// When discovery reads the authenticated current version.
	const result = await discoverSignedOsManifest(
		signed,
		signature,
		{ ...context, serial, bootedVersion: manifest.version },
		deps,
	);
	// Then successful discovery writes no stage receipt or serial advancement.
	expect(result).toEqual({ kind: "none", classification: "current" });
	expect(await Bun.file(path).text()).toBe("3\n");
	expect(await Bun.file(join(root, "os-staged.json")).exists()).toBe(false);
});
