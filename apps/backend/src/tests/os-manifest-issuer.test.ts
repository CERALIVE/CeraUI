import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmsSigner } from "../modules/system/update-orchestrator/os-agent.ts";
import { validateSignedOsManifest } from "../modules/system/update-orchestrator/os-manifest.ts";

let dir: string;
const payload = new TextEncoder().encode(
	JSON.stringify({
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
	}),
);

function openssl(...args: string[]): void {
	const result = Bun.spawnSync(["openssl", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(new TextDecoder().decode(result.stderr));
}

function root(name: string, cn: string): string {
	const cert = join(dir, `${name}.pem`);
	openssl(
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"3",
		"-subj",
		`/CN=${cn}`,
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign",
		"-keyout",
		join(dir, `${name}.key`),
		"-out",
		cert,
	);
	return cert;
}

async function issued(
	name: string,
	subject: string,
	ca: string,
	extensions: string,
): Promise<string> {
	const csr = join(dir, `${name}.csr`);
	const cert = join(dir, `${name}.pem`);
	const ext = join(dir, `${name}.ext`);
	await Bun.write(ext, extensions);
	openssl(
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-subj",
		subject,
		"-keyout",
		join(dir, `${name}.key`),
		"-out",
		csr,
	);
	openssl(
		"x509",
		"-req",
		"-in",
		csr,
		"-CA",
		join(dir, `${ca}.pem`),
		"-CAkey",
		join(dir, `${ca}.key`),
		"-CAcreateserial",
		"-days",
		"2",
		"-extfile",
		ext,
		"-out",
		cert,
	);
	return cert;
}

async function signedBy(name: string, chain?: string): Promise<Uint8Array> {
	const data = join(dir, "manifest.json");
	const signature = join(dir, `${name}.sig`);
	await Bun.write(data, payload);
	openssl(
		"cms",
		"-sign",
		"-binary",
		"-in",
		data,
		"-signer",
		join(dir, `${name}.pem`),
		"-inkey",
		join(dir, `${name}.key`),
		...(chain ? ["-certfile", chain] : []),
		"-outform",
		"DER",
		"-out",
		signature,
	);
	return new Uint8Array(await Bun.file(signature).arrayBuffer());
}

const intermediateExtensions =
	"basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign\n";
const leafExtensions =
	"basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=codeSigning\n";
let productionRoot: string;
let benchRoot: string;
let productionIntermediate: string;
let benchIntermediate: string;
let alternateIntermediate: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceraui-manifest-issuer-"));
	productionRoot = root("root", "CeraLive RAUC Root CA");
	benchRoot = root(
		"bench-root",
		"CeraLive RAUC Bench Root CA (NON-PRODUCTION, PERSISTENT)",
	);
	root("foreign-root", "Foreign Root CA");
	productionIntermediate = await issued(
		"intermediate",
		"/O=CeraLive/CN=CeraLive RAUC Intermediate CA",
		"root",
		intermediateExtensions,
	);
	benchIntermediate = await issued(
		"bench-intermediate",
		"/O=CeraLive/CN=CeraLive RAUC Bench Intermediate CA",
		"bench-root",
		intermediateExtensions,
	);
	alternateIntermediate = await issued(
		"alternate-intermediate",
		"/O=CeraLive/CN=Alternate Intermediate CA",
		"root",
		intermediateExtensions,
	);
	for (const [name, ca] of [
		["production", "intermediate"],
		["bench", "bench-intermediate"],
		["direct", "root"],
		["alternate", "alternate-intermediate"],
		["foreign", "foreign-root"],
	] as const) {
		await issued(name, "/CN=CeraLive OTA Manifest Signer", ca, leafExtensions);
	}
	await issued(
		"bundle",
		"/CN=CeraLive Bundle Signer",
		"intermediate",
		"basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=codeSigning,emailProtection\n",
	);
	// Twelve synchronous RSA-2048 keygens: ~1 s on an idle workstation, but
	// they exceeded bun's 5 s default hook bound on a loaded CI runner.
}, 60_000);

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

test.each([
	[
		"production",
		(): string => productionRoot,
		(): string => productionIntermediate,
		"accepted",
	],
	[
		"bench",
		(): string => benchRoot,
		(): string => benchIntermediate,
		"accepted",
	],
	[
		"direct",
		(): string => productionRoot,
		(): undefined => undefined,
		"signer_issuer_invalid",
	],
	[
		"alternate",
		(): string => productionRoot,
		(): string => alternateIntermediate,
		"signer_issuer_invalid",
	],
	[
		"foreign",
		(): string => productionRoot,
		(): undefined => undefined,
		"signature_invalid",
	],
	[
		"bundle",
		(): string => productionRoot,
		(): string => productionIntermediate,
		"signer_not_manifest_signer",
	],
] as const)(
	"checks the real CMS chain for a %s-signed manifest",
	async (name, keyring, chain, expected) => {
		const signature = await signedBy(name, chain());
		const result = await validateSignedOsManifest(
			payload,
			signature,
			{
				board: "rock-5b-plus",
				compatible: "ceralive-rock-5b-plus",
				channel: "stable",
				serial: 2,
				bootedVersion: "2026.9.0",
				installedVersion: "2026.9.3",
				now: Date.parse("2026-09-25T00:00:00Z"),
			},
			{
				verifyCms: (data, sig) => cmsSigner(data, sig, keyring()),
				compare: async (candidate, installed) =>
					candidate === "2026.10.0" && installed === "2026.9.0",
				isQuarantined: async () => false,
			},
		);
		if (expected === "accepted") expect(result).toMatchObject({ ok: true });
		else expect(result).toEqual({ ok: false, reason: expected });
	},
);
