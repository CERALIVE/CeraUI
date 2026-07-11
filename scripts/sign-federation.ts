#!/usr/bin/env bun

// Federation bundle signing (Task 40, production-hardening).
//
// Post-build step for the Vite lib-mode federation bundles (Task 39). For every
// dialog bundle emitted under dist/federation/<ceraui-version>/ it produces the
// two artifacts the version-federation hosting/signing contract requires (root
// AGENTS.md → version-federation):
//
//   <file>.js.sri  — the `sha384-…` Subresource-Integrity hash (base64)
//   <file>.js.sig  — a DETACHED GPG signature (cert-work/gpg keyring)
//
// It then emits a signed manifest the cloud dashboard's trust gate consumes:
//
//   manifest.json      — { ceraUiVersion, files: [{ filename, integrity }] }
//   manifest.json.sig  — base64 detached Ed25519 signature over the EXACT bytes
//
// TWO signature mechanisms, by design — they guard two different boundaries:
//
//   • Bundles use GPG. apt-worker already GPG-signs/-verifies .debs with the
//     cert-work/gpg key; the same keyring signs each bundle and GPG-verifies it
//     at the R2 upload boundary (federation-security-design.md §3). Task 41
//     (apt-worker publish) is the GPG verifier.
//   • manifest.json uses raw Ed25519, NOT GPG. The cloud verifies the manifest
//     with `verifyManifestSignature` (node:crypto `verify(null, …)`, PEM SPKI
//     public key) BEFORE trusting any SRI hash inside it
//     (federation-security-design.md §4; ceralive-platform
//     apps/api/lib/federation/manifest-verify.ts). A GPG manifest signature
//     could not be verified by that gate, so manifest.json.sig MUST be the
//     base64 Ed25519 signature the gate expects. Task 42 (platform consumer
//     verify) runs `verifyAndParseManifest` against exactly these fixtures.
//
// The manifest SHAPE is dictated by FederationManifestSchema in the consumer —
// do not change it. This script emits that exact shape.
//
// Keys (fail-closed — the script never signs with an auto-generated key):
//   GPG_SIGNING_KEY            base64 of an ASCII-armored private key (CI secret);
//                              imported into a throwaway GNUPGHOME. Omit to use a
//                              pre-imported keyring instead.
//   GPG_SIGNING_KEY_ID         optional explicit signing identity; default = the
//                              first secret key in the keyring (no hardcoded id).
//   GPG_SIGNING_KEY_PASSPHRASE optional passphrase (loopback pinentry).
//   FEDERATION_MANIFEST_PRIVATE_KEY  Ed25519 private key, PEM PKCS8 or base64 of
//                              that PEM (CI secret).
//   FEDERATION_MANIFEST_PUBLIC_KEY   optional PEM SPKI public key; when set the
//                              verify step also checks the signature against it
//                              (proves the provisioned cloud key matches).
//
// Usage:  bun run scripts/sign-federation.ts [--verify-only]
// Self-contained (Rule D): reads nothing above the CeraUI checkout root.

import { spawnSync } from 'node:child_process';
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as edSign,
	verify as edVerify,
} from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertFederationAssetSet,
	discoverFederationAssets,
	normalizeFederationAssetText,
	parsePackageVersion,
	parseSignedManifestAssets,
	type SignedFederationAsset,
} from './federation-assets';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CERAUI_ROOT = resolve(SCRIPT_DIR, '..');

interface GpgContext {
	readonly env: Record<string, string>;
	readonly keyId: string;
	readonly passphrase: string | undefined;
}

const tempDirs: string[] = [];

function fail(message: string): never {
	process.stderr.write(`✗ sign-federation: ${message}\n`);
	cleanup();
	process.exit(1);
}

function cleanup(): void {
	for (const dir of tempDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort temp cleanup — never mask the real exit reason
		}
	}
	tempDirs.length = 0;
}

function readVersion(): string {
	return parsePackageVersion(readFileSync(join(CERAUI_ROOT, 'package.json'), 'utf8'));
}

function sriHash(bytes: Buffer): string {
	return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

function gpg(
	args: string[],
	env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
	const proc = spawnSync('gpg', args, {
		env: { ...process.env, ...env },
		encoding: 'utf8',
	});
	return {
		code: proc.status ?? 1,
		stdout: proc.stdout ?? '',
		stderr: proc.stderr ?? '',
	};
}

/** First secret-key fingerprint in `--with-colons` output (the `fpr` after `sec`). */
function firstSecretFingerprint(colons: string): string {
	let seenSec = false;
	for (const line of colons.split('\n')) {
		const fields = line.split(':');
		if (fields[0] === 'sec') {
			seenSec = true;
		} else if (seenSec && fields[0] === 'fpr' && fields[9]) {
			return fields[9];
		}
	}
	return '';
}

function setupGpg(): GpgContext {
	const env: Record<string, string> = {};
	const armored = process.env.GPG_SIGNING_KEY?.trim();
	if (armored) {
		const home = mkdtempSync(join(tmpdir(), 'ceraui-fedsign-'));
		tempDirs.push(home);
		env.GNUPGHOME = home;
		const keyPath = join(home, 'signing-key.asc');
		writeFileSync(keyPath, Buffer.from(armored, 'base64'));
		const imported = gpg(['--batch', '--import', keyPath], env);
		if (imported.code !== 0) {
			fail(`GPG key import failed: ${imported.stderr.trim()}`);
		}
	}
	let keyId = process.env.GPG_SIGNING_KEY_ID?.trim() ?? '';
	if (!keyId) {
		keyId = firstSecretFingerprint(gpg(['--list-secret-keys', '--with-colons'], env).stdout);
	}
	if (!keyId) {
		fail('no GPG secret key available — set GPG_SIGNING_KEY (base64) or import a key first');
	}
	return { env, keyId, passphrase: process.env.GPG_SIGNING_KEY_PASSPHRASE };
}

function gpgDetachSign(file: string, out: string, ctx: GpgContext): void {
	const args = ['--batch', '--yes', '--pinentry-mode', 'loopback', '--local-user', ctx.keyId];
	if (ctx.passphrase) {
		args.push('--passphrase', ctx.passphrase);
	}
	args.push('--detach-sign', '--output', out, file);
	const result = gpg(args, ctx.env);
	if (result.code !== 0) {
		fail(`GPG sign failed for ${file}: ${result.stderr.trim()}`);
	}
}

function gpgVerify(file: string, sig: string, ctx: GpgContext): boolean {
	return gpg(['--batch', '--verify', sig, file], ctx.env).code === 0;
}

function loadManifestPrivateKey(): ReturnType<typeof createPrivateKey> {
	const raw = process.env.FEDERATION_MANIFEST_PRIVATE_KEY?.trim();
	if (!raw) {
		fail('FEDERATION_MANIFEST_PRIVATE_KEY not set (Ed25519, PEM PKCS8 or base64 of the PEM)');
	}
	const pem = raw.includes('-----BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
	try {
		return createPrivateKey(pem);
	} catch (error) {
		return fail(`FEDERATION_MANIFEST_PRIVATE_KEY is not a valid key: ${String(error)}`);
	}
}

function bundlePath(dir: string, name: string): string {
	const file = join(dir, name);
	if (!existsSync(file)) {
		fail(`missing federation bundle ${name} — run \`bun run build:federation\` first`);
	}
	return file;
}

function sign(dir: string, version: string): SignedFederationAsset[] {
	const gpgCtx = setupGpg();
	const privateKey = loadManifestPrivateKey();
	const files: SignedFederationAsset[] = [];

	const assets = discoverFederationAssets(dir);
	assertFederationAssetSet(assets);
	for (const asset of assets) {
		const file = bundlePath(dir, asset.filename);
		const original = readFileSync(file, 'utf8');
		const normalized = normalizeFederationAssetText(original);
		if (normalized !== original) writeFileSync(file, normalized);
		const bytes = readFileSync(file);
		const integrity = sriHash(bytes);
		writeFileSync(`${file}.sri`, `${integrity}\n`);
		gpgDetachSign(file, `${file}.sig`, gpgCtx);
		files.push({ ...asset, integrity });
		process.stdout.write(`  signed ${asset.filename}  ${integrity}\n`);
	}

	// EXACT shape FederationManifestSchema expects. The bytes written here are the
	// bytes signed — the cloud verifies the signature over them verbatim.
	const manifestText = `${JSON.stringify({ ceraUiVersion: version, files }, null, 2)}\n`;
	writeFileSync(join(dir, 'manifest.json'), manifestText);
	const signature = edSign(null, Buffer.from(manifestText, 'utf8'), privateKey).toString('base64');
	writeFileSync(join(dir, 'manifest.json.sig'), `${signature}\n`);
	process.stdout.write(
		`  signed manifest.json (Ed25519, key ${gpgCtx.keyId.slice(-16)} for bundles)\n`,
	);

	return files;
}

function verify(dir: string): void {
	const gpgCtx = setupGpg();
	const manifestText = readFileSync(join(dir, 'manifest.json'), 'utf8');
	const manifestFiles = parseSignedManifestAssets(manifestText);
	const discovered = discoverFederationAssets(dir);
	assertFederationAssetSet(discovered);
	if (
		discovered.some(
			(asset) =>
				!manifestFiles.some(
					(entry) => entry.filename === asset.filename && entry.kind === asset.kind,
				),
		)
	) {
		fail('manifest does not cover every emitted federation asset');
	}

	for (const entry of manifestFiles) {
		const file = bundlePath(dir, entry.filename);
		const text = readFileSync(file, 'utf8');
		if (normalizeFederationAssetText(text) !== text) {
			fail(`trailing whitespace in ${entry.filename}`);
		}
		const recomputed = sriHash(readFileSync(file));
		if (recomputed !== entry.integrity) {
			fail(`SRI mismatch for ${entry.filename}: manifest=${entry.integrity} actual=${recomputed}`);
		}
		const sriFile = readFileSync(`${file}.sri`, 'utf8').trim();
		if (sriFile !== entry.integrity) {
			fail(`.sri file disagrees with manifest for ${entry.filename}`);
		}
		if (!gpgVerify(file, `${file}.sig`, gpgCtx)) {
			fail(`GPG signature did not verify for ${entry.filename}`);
		}
		process.stdout.write(`  verified ${entry.filename} (SRI + GPG)\n`);
	}

	// Reuse the consumer's exact check: verify(null, bytes, publicKey, sig).
	const signature = readFileSync(join(dir, 'manifest.json.sig'), 'utf8').trim();
	const privatePem = loadManifestPrivateKey().export({ type: 'pkcs8', format: 'pem' });
	const derivedPublic = createPublicKey(privatePem);
	if (
		!edVerify(
			null,
			Buffer.from(manifestText, 'utf8'),
			derivedPublic,
			Buffer.from(signature, 'base64'),
		)
	) {
		fail('manifest.json.sig did not verify against the manifest private key');
	}
	const provisionedPublic = process.env.FEDERATION_MANIFEST_PUBLIC_KEY?.trim();
	if (provisionedPublic) {
		const pub = provisionedPublic.includes('-----BEGIN')
			? provisionedPublic
			: Buffer.from(provisionedPublic, 'base64').toString('utf8');
		if (
			!edVerify(
				null,
				Buffer.from(manifestText, 'utf8'),
				createPublicKey(pub),
				Buffer.from(signature, 'base64'),
			)
		) {
			fail('manifest.json.sig did not verify against FEDERATION_MANIFEST_PUBLIC_KEY');
		}
	}
	process.stdout.write('  verified manifest.json (Ed25519)\n');
}

function main(): void {
	const verifyOnly = process.argv.includes('--verify-only');
	const version = readVersion();
	const dir = join(CERAUI_ROOT, 'dist', 'federation', version);
	if (!existsSync(dir)) {
		fail(
			`no federation output at dist/federation/${version} — run \`bun run build:federation\` first`,
		);
	}

	process.stdout.write(`sign-federation: dist/federation/${version}\n`);
	if (!verifyOnly) {
		sign(dir, version);
	}
	verify(dir);
	cleanup();
	process.stdout.write('✓ sign-federation: all artifacts signed and verified\n');
}

main();
