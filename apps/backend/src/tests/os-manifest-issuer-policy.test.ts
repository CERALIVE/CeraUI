import { expect, test } from "bun:test";
import { parseManifestSignerDetails } from "../modules/system/update-orchestrator/os-agent.ts";
import { validateSignedOsManifest } from "../modules/system/update-orchestrator/os-manifest.ts";

const context = {
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable" as const,
	serial: 2,
	bootedVersion: "2026.9.0",
	installedVersion: "2026.9.3",
	now: Date.parse("2026-09-25T00:00:00Z"),
};
const invalidManifest = new TextEncoder().encode("{}");
const signature = new Uint8Array([1, 2, 3]);

test("issuer parsing removes OpenSSL framing, not the DN's trailing space", () => {
	expect(
		parseManifestSignerDetails(
			"subject=CN=CeraLive OTA Manifest Signer\n",
			"X509v3 Extended Key Usage:\n    Code Signing\n",
			"issuer=CN=CeraLive RAUC Intermediate CA,O=CeraLive \n",
		).issuer,
	).toBe("CN=CeraLive RAUC Intermediate CA,O=CeraLive ");
});

test.each([
	"CN=CeraLive RAUC Intermediate CA,O=CeraLive",
	"CN=CeraLive RAUC Bench Intermediate CA,O=CeraLive",
] as const)("admits issuer %s before manifest parsing", async (issuer) => {
	const result = await validateSignedOsManifest(
		invalidManifest,
		signature,
		context,
		{
			verifyCms: async () => ({
				cn: "CeraLive OTA Manifest Signer",
				eku: ["codeSigning"],
				issuer,
			}),
			compare: async () => {
				throw new Error("manifest must not reach comparison");
			},
			isQuarantined: async () => false,
		},
	);
	expect(result).toEqual({ ok: false, reason: "schema_invalid" });
});

test.each([
	"CN=CeraLive RAUC Root CA",
	"CN=CeraLive RAUC Bench Root CA (NON-PRODUCTION, PERSISTENT)",
	"CN=Alternate Intermediate CA,O=CeraLive",
	"CN=ceralive RAUC Intermediate CA,O=CeraLive",
	"CN=CeraLive RAUC Intermediate CA ,O=CeraLive",
	"CN=CeraLive RAUC Intermediate CA,O=CeraLive ",
	"CN=CeraLive RAUC Intermediate CA,O=CeraLive,OU=OTA",
] as const)("refuses issuer %s before manifest parsing", async (issuer) => {
	const result = await validateSignedOsManifest(
		invalidManifest,
		signature,
		context,
		{
			verifyCms: async () => ({
				cn: "CeraLive OTA Manifest Signer",
				eku: ["codeSigning"],
				issuer,
			}),
			compare: async () => {
				throw new Error("manifest must not reach comparison");
			},
			isQuarantined: async () => false,
		},
	);
	expect(result).toEqual({ ok: false, reason: "signer_issuer_invalid" });
});

test("refuses a different CN despite valid EKU and issuer", async () => {
	const result = await validateSignedOsManifest(
		invalidManifest,
		signature,
		context,
		{
			verifyCms: async () => ({
				cn: "Other OTA Manifest Signer",
				eku: ["codeSigning"],
				issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
			}),
			compare: async () => false,
			isQuarantined: async () => false,
		},
	);
	expect(result).toEqual({ ok: false, reason: "signer_not_manifest_signer" });
});
