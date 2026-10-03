import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
	discoverSignedOsManifest,
	osChannelManifestSchema,
	validateSignedOsManifest,
} from "../modules/system/update-orchestrator/os-manifest.ts";
import {
	bytes,
	context,
	deps,
	manifest,
	signature,
	signed,
} from "./helpers/os-manifest-fixture.ts";

describe("signed OS manifest discovery", () => {
	test.each([
		[
			"bundle leaf",
			"CeraLive Bundle Signer",
			deps.verifyCms,
			"signer_not_manifest_signer",
		],
		[
			"issuer",
			"CeraLive OTA Manifest Signer",
			async () => ({
				cn: "CeraLive OTA Manifest Signer",
				eku: ["codeSigning"],
				issuer: "CN=Other",
			}),
			"signer_issuer_invalid",
		],
	] as const)(
		"refuses current when %s is invalid",
		async (_label, cn, verifyCms, reason) => {
			// Given a CMS-verified current pointer with an unauthorized signer.
			// When discovery checks signer authority before version equality.
			const result = await discoverSignedOsManifest(
				signed,
				signature,
				{ ...context, bootedVersion: manifest.version },
				{
					...deps,
					verifyCms: async () => ({
						...(await verifyCms(signed, signature)),
						cn,
					}),
				},
			);
			// Then a current version cannot bypass signer policy.
			expect(result).toEqual({ kind: "refused", reason });
		},
	);

	test.each([
		["quarantine", "2026.9.3", true, "version_quarantined"],
		["CeraUI floor", "2026.8.0", false, "ceraui_too_old"],
	] as const)(
		"refuses a candidate when %s fails strict admission",
		async (_label, installedVersion, quarantined, reason) => {
			// Given an authenticated newer pointer failing an installation gate.
			// When discovery tries to offer it.
			const result = await discoverSignedOsManifest(
				signed,
				signature,
				{ ...context, installedVersion },
				{ ...deps, isQuarantined: async () => quarantined },
			);
			// Then full admission, not current-only exemptions, decides.
			expect(result).toEqual({ kind: "refused", reason });
		},
	);

	test.each([2, 3, 4])(
		"returns current when the stored serial is %i",
		async (serial) => {
			// Given a trusted current pointer, including an installation-only floor it cannot meet.
			const current = bytes({ ...manifest, min_ceraui_version: "2027.1.0" });
			// When discovery reads the pointer.
			const result = await discoverSignedOsManifest(
				current,
				signature,
				{ ...context, bootedVersion: manifest.version, serial },
				deps,
			);
			// Then no candidate is offered, irrespective of the serial watermark.
			expect(result).toEqual({ kind: "none", classification: "current" });
		},
	);

	test.each([
		["expiry", { expires_at: "2026-09-24T00:00:00Z" }, "expired"],
		["board", { board: "wrong" }, "wrong_board"],
		["compatible", { compatible: "wrong" }, "wrong_compatible"],
		["channel", { channel: "beta" }, "wrong_channel"],
		["schema", { schema: 2 }, "schema_invalid"],
	] as const)(
		"refuses current when %s is invalid",
		async (_label, patch, reason) => {
			// Given a current pointer with invalid trust or freshness and a consumed serial.
			const data = bytes({ ...manifest, ...patch });
			// When discovery reads it.
			const result = await discoverSignedOsManifest(
				data,
				signature,
				{ ...context, bootedVersion: manifest.version, serial: 3 },
				deps,
			);
			// Then current-version equality cannot suppress the refusal.
			expect(result).toEqual({ kind: "refused", reason });
		},
	);

	test("refuses unsigned current before parsing or comparing its version", async () => {
		// Given unsigned current bytes and an invalid board claim.
		const data = bytes({ ...manifest, board: "wrong" });
		// When CMS verification rejects the pointer.
		const result = await discoverSignedOsManifest(
			data,
			signature,
			{ ...context, bootedVersion: manifest.version },
			{
				...deps,
				verifyCms: async () => {
					throw new Error("unsigned");
				},
				compare: async () => {
					throw new Error("untrusted comparison");
				},
			},
		);
		// Then the signature failure wins, not current or board classification.
		expect(result).toEqual({ kind: "refused", reason: "signature_invalid" });
	});

	test.each([undefined, "garbage"])(
		"refuses when booted version is %s",
		async (bootedVersion) => {
			// Given a trusted pointer but no orderable booted version.
			// When discovery reads it.
			const result = await discoverSignedOsManifest(
				signed,
				signature,
				{ ...context, bootedVersion },
				deps,
			);
			// Then neither a candidate nor success can be inferred.
			expect(result).toEqual({
				kind: "refused",
				reason: "booted_version_unknown",
			});
		},
	);

	test.each([3, 4])(
		"refuses newer boot target when stored serial is %i",
		async (serial) => {
			// Given a consumed pointer whose target may have been staged and rolled back.
			// When discovery reads it on the older booted version.
			const result = await discoverSignedOsManifest(
				signed,
				signature,
				{ ...context, serial },
				deps,
			);
			// Then serial replay remains a refusal.
			expect(result).toEqual({ kind: "refused", reason: "serial_replayed" });
		},
	);

	test("returns installed-serial when a consumed pointer is positively older than booted", async () => {
		// Given a consumed pointer superseded by the booted release.
		// When discovery compares the authenticated versions.
		const result = await discoverSignedOsManifest(
			signed,
			signature,
			{ ...context, serial: 3, bootedVersion: "2026.11.0" },
			deps,
		);
		// Then it offers no installation candidate.
		expect(result).toEqual({
			kind: "none",
			classification: "installed-serial",
		});
	});

	test("refuses when a superseded consumed pointer is quarantined", async () => {
		// Given a consumed older target known to have rolled back.
		// When discovery reads it.
		const result = await discoverSignedOsManifest(
			signed,
			signature,
			{ ...context, serial: 3, bootedVersion: "2026.11.0" },
			{ ...deps, isQuarantined: async () => true },
		);
		// Then strict replay precedence is preserved.
		expect(result).toEqual({ kind: "refused", reason: "serial_replayed" });
	});

	test("offers a candidate when trust and strict admission pass", async () => {
		// Given a fresh newer pointer.
		// When discovery reads it.
		const result = await discoverSignedOsManifest(
			signed,
			signature,
			context,
			deps,
		);
		// Then it offers the admitted manifest.
		expect(result).toEqual({
			kind: "candidate",
			manifest: osChannelManifestSchema.parse(manifest),
		});
	});

	test("refuses other lower-version pointers through strict admission", async () => {
		// Given an unconsumed older pointer.
		// When discovery reads it.
		const result = await discoverSignedOsManifest(
			signed,
			signature,
			{ ...context, bootedVersion: "2026.11.0" },
			deps,
		);
		// Then it remains an admission refusal.
		expect(result).toEqual({ kind: "refused", reason: "downgrade_or_same" });
	});

	test("strict admission keeps replay precedence when version is current and expired", async () => {
		// Given a consumed current pointer that has also expired.
		const data = bytes({ ...manifest, expires_at: "2026-09-24T00:00:00Z" });
		// When installation admission checks it, rather than discovery.
		const result = await validateSignedOsManifest(
			data,
			signature,
			{ ...context, serial: 3, bootedVersion: manifest.version },
			deps,
		);
		// Then the existing first refusal remains replay.
		expect(result).toEqual({ ok: false, reason: "serial_replayed" });
	});
});

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});
