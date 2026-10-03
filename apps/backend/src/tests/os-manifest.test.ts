import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseManifestSignerDetails } from "../modules/system/update-orchestrator/os-agent.ts";
import { validateSignedOsManifest } from "../modules/system/update-orchestrator/os-manifest.ts";
import {
	bytes,
	context,
	deps,
	manifest,
	signature,
	signed,
} from "./helpers/os-manifest-fixture.ts";

describe("signed OS manifest validation", () => {
	test("OpenSSL subject and EKU output distinguishes the manifest leaf from a dual-EKU bundle leaf", () => {
		expect(
			parseManifestSignerDetails(
				"subject=CN=CeraLive OTA Manifest Signer\n",
				"X509v3 Extended Key Usage:\n    Code Signing\n",
				"issuer=CN=CeraLive RAUC Intermediate CA,O=CeraLive\n",
			),
		).toEqual({
			cn: "CeraLive OTA Manifest Signer",
			eku: ["codeSigning"],
			issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
		});
		expect(
			parseManifestSignerDetails(
				"subject=CN=CeraLive Bundle Signer\n",
				"X509v3 Extended Key Usage:\n    E-mail Protection, Code Signing\n",
				"issuer=CN=CeraLive RAUC Intermediate CA,O=CeraLive\n",
			),
		).toEqual({
			cn: "CeraLive Bundle Signer",
			eku: ["codeSigning", "emailProtection"],
			issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
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
				issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
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
