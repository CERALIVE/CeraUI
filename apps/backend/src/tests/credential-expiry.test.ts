/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type CredentialExpiryDeps,
	parsePublicCredential,
	readCredentialExpiry,
} from "../modules/system/update-orchestrator/credential-expiry.ts";
import { StoredStateReadError } from "../modules/system/update-orchestrator/stored-state-file.ts";
import { credentialFixture } from "./helpers/credential-fixture.ts";

const packaged = "/usr/share/ceralive/apt-credentials/";
const legacy = "/etc/apt/certs/";
let fixture: Awaited<ReturnType<typeof credentialFixture>>;
beforeAll(async () => {
	fixture = await credentialFixture();
});
afterAll(async () => {
	await fixture.cleanup();
});

function reader(overrides: Partial<CredentialExpiryDeps> = {}) {
	const reads: string[] = [];
	const metadata = Buffer.from(
		`${new Date(fixture.expiresAt).toISOString().replace(".000Z", "Z")}\n`,
	);
	const deps: CredentialExpiryDeps = {
		exists: () => true,
		readPublic: (path) => {
			reads.push(path);
			return {
				bytes: path.endsWith("not-after") ? metadata : fixture.pem,
				identity: "stable",
			};
		},
		...overrides,
	};
	return { deps, reads };
}

describe("public credential expiry", () => {
	test("PEM and DER retain the openssl UTC date and exact certificate identity", () => {
		// Given independent public openssl date evidence; When Bun parses both encodings; Then identity/date agree.
		const pem = parsePublicCredential(fixture.pem);
		const der = parsePublicCredential(fixture.der);
		expect(pem).toEqual(der);
		expect(pem).toMatchObject({ kind: "known", expiresAt: fixture.expiresAt });
	});
	test("same expiry on a different certificate has a different local identity", () => {
		// Given a different serial; When parsed; Then expiry is equal but generation digest differs.
		const first = parsePublicCredential(fixture.der);
		const second = parsePublicCredential(fixture.replacement);
		expect(second).toMatchObject({
			kind: "known",
			expiresAt: fixture.expiresAt,
		});
		expect(second).not.toEqual(first);
	});
	test("selected packaged pair reads matching metadata and never opens its key", async () => {
		// Given both pairs present; When observed; Then only package public files are read.
		const { deps, reads } = reader();
		expect(await readCredentialExpiry(deps)).toMatchObject({
			kind: "known",
			expiresAt: fixture.expiresAt,
		});
		expect(new Set(reads)).toEqual(
			new Set([`${packaged}client.crt`, `${packaged}not-after`]),
		);
	});
	test("missing packaged key selects legacy without requiring a sidecar", async () => {
		// Given an incomplete packaged pair; When observed; Then monitor the active legacy public cert.
		const { deps, reads } = reader({
			exists: (path) => path !== `${packaged}client.key`,
		});
		expect(await readCredentialExpiry(deps)).toMatchObject({ kind: "known" });
		expect(new Set(reads)).toEqual(new Set([`${legacy}client.crt`]));
	});
	test("malformed selected package certificate never falls back to healthy legacy", async () => {
		// Given selected malformed package bytes; When observed; Then refuse, rather than monitor the wrong pair.
		const { deps } = reader({
			readPublic: () => ({
				bytes: Buffer.from("truncated PEM"),
				identity: "x",
			}),
		});
		expect(await readCredentialExpiry(deps)).toEqual({
			kind: "unavailable",
			reason: "invalid-certificate",
		});
	});
	test.each(["2030-01-01T00:00:00Z\n", "2028-02-30T00:00:00Z", "bad date"])(
		"incoherent or invalid sidecar %s never grants known expiry",
		async (value) => {
			// Given a mismatching/invalid date; When read; Then no known expiry leaves the boundary.
			const { deps } = reader({
				readPublic: (path) => ({
					bytes: path.endsWith("not-after") ? Buffer.from(value) : fixture.pem,
					identity: "x",
				}),
			});
			expect(await readCredentialExpiry(deps)).toMatchObject({
				kind: "unavailable",
			});
		},
	);
	test("replacement during a coherent read defers the observation", async () => {
		// Given a cert replaced between reads; When observed; Then refuse the mixed snapshot.
		let calls = 0;
		const { deps } = reader({
			exists: (path) => path.startsWith(legacy),
			readPublic: () => ({
				bytes: calls++ === 0 ? fixture.pem : fixture.replacement,
				identity: String(calls),
			}),
		});
		expect(await readCredentialExpiry(deps)).toEqual({
			kind: "unavailable",
			reason: "changed",
		});
	});
	test.each(["ENOENT", "EACCES"])(
		"%s stays closed without raw error disclosure",
		async (code) => {
			// Given a private-looking error sentinel; When read; Then only a closed code is returned.
			const sentinel = `-----BEGIN CERTIFICATE----- /secret/client.key digest-sentinel ${code}`;
			const { deps } = reader({
				readPublic: () => {
					throw Object.assign(new Error(sentinel), { code });
				},
			});
			expect(await readCredentialExpiry(deps)).toEqual({
				kind: "unavailable",
				reason: "read-failed",
			});
		},
	);
	test("bounded reader overflow stays unavailable", async () => {
		// Given oversized bytes; When observed; Then no parse or warning is possible.
		const { deps } = reader({
			readPublic: () => {
				throw new StoredStateReadError("oversize");
			},
		});
		expect(await readCredentialExpiry(deps)).toEqual({
			kind: "unavailable",
			reason: "oversize",
		});
	});
	test("absent pairs report missing", async () => {
		// Given no active pair; When read; Then unknown is not healthy/expired.
		const { deps } = reader({ exists: () => false });
		expect(await readCredentialExpiry(deps)).toEqual({
			kind: "unavailable",
			reason: "missing",
		});
	});
});
