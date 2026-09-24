import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseManifestSignerDetails,
	readManifestSerial,
	saveStagedManifest,
} from "../modules/system/update-orchestrator/os-agent.ts";
import {
	osChannelManifestSchema,
	readBootedOsReleaseVersion,
	resolveOsChannel,
	validateSignedOsManifest,
} from "../modules/system/update-orchestrator/os-manifest.ts";

const manifest = {
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.0",
	serial: 3,
	published_at: "2026-09-24T12:00:00Z",
	expires_at: "2026-12-30T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/bundle.raucb",
		size: 10,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/flash.raw.xz",
		size: 10,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/packages.lock.json",
};
const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));
const signed = bytes(manifest);
const signature = new Uint8Array([1, 2, 3]);
const context = {
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable" as const,
	serial: 2,
	bootedVersion: "2026.9.0",
	installedVersion: "2026.9.3",
	now: Date.parse("2026-09-25T00:00:00Z"),
};
const deps = {
	verifyCms: async (_data: Uint8Array, _signature: Uint8Array) => ({
		cn: "CeraLive OTA Manifest Signer",
		eku: ["codeSigning"],
	}),
	compare: async (newer: string, older: string) => {
		const result = Bun.spawnSync([
			"dpkg",
			"--compare-versions",
			newer,
			"gt",
			older,
		]);
		return result.exitCode === 0;
	},
	isQuarantined: async (_version: string) => false,
};

describe("signed OS manifest validation", () => {
	test("OpenSSL subject and EKU output distinguishes the manifest leaf from a dual-EKU bundle leaf", () => {
		expect(
			parseManifestSignerDetails(
				"subject=CN=CeraLive OTA Manifest Signer\n",
				"X509v3 Extended Key Usage:\n    Code Signing\n",
			),
		).toEqual({ cn: "CeraLive OTA Manifest Signer", eku: ["codeSigning"] });
		expect(
			parseManifestSignerDetails(
				"subject=CN=CeraLive Bundle Signer\n",
				"X509v3 Extended Key Usage:\n    E-mail Protection, Code Signing\n",
			),
		).toEqual({
			cn: "CeraLive Bundle Signer",
			eku: ["codeSigning", "emailProtection"],
		});
	});
	test("signature is checked before parsing any untrusted fields", async () => {
		const result = await validateSignedOsManifest(
			bytes({ board: "wrong" }),
			signature,
			context,
			{
				...deps,
				verifyCms: async () => {
					throw new Error("bad signature");
				},
			},
		);
		expect(result).toEqual({ ok: false, reason: "signature_invalid" });
	});
	test("rejects bundle leaf even though CMS verified", async () => {
		const result = await validateSignedOsManifest(signed, signature, context, {
			...deps,
			verifyCms: async () => ({
				cn: "CeraLive Bundle Signer",
				eku: ["emailProtection", "codeSigning"],
			}),
		});
		expect(result).toEqual({ ok: false, reason: "signer_not_manifest_signer" });
	});
	test("beta serial 7 then stable serial 3 accepts per-channel tracking", async () => {
		const result = await validateSignedOsManifest(
			signed,
			signature,
			{ ...context, serial: 2 },
			deps,
		);
		expect(result.ok).toBe(true);
	});
	test("rejects same and lower CalVer using real dpkg comparison", async () => {
		for (const bootedVersion of ["2026.10.0", "2026.11.0"]) {
			const result = await validateSignedOsManifest(
				signed,
				signature,
				{ ...context, bootedVersion },
				deps,
			);
			expect(result).toEqual({ ok: false, reason: "downgrade_or_same" });
		}
	});
	test("absent boot stamp refuses closed without consulting comparisons", async () => {
		const result = await validateSignedOsManifest(
			signed,
			signature,
			{ ...context, bootedVersion: undefined },
			{
				...deps,
				compare: async () => {
					throw new Error("must not compare unknown");
				},
			},
		);
		expect(result).toEqual({ ok: false, reason: "booted_version_unknown" });
	});
	test.each([
		["expired", { expires_at: "2026-09-24T00:00:00Z" }, "expired"],
		["replayed", { serial: 2 }, "serial_replayed"],
		["board", { board: "orangepi5-plus" }, "wrong_board"],
		["compatible", { compatible: "other" }, "wrong_compatible"],
		["CeraUI floor", { min_ceraui_version: "2027.1.0" }, "ceraui_too_old"],
	] as const)("refuses %s manifest", async (_label, patch, reason) => {
		const result = await validateSignedOsManifest(
			bytes({ ...manifest, ...patch }),
			signature,
			context,
			deps,
		);
		expect(result).toEqual({ ok: false, reason });
	});
});

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
