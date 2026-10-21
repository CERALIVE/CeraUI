import { createHash, X509Certificate } from "node:crypto";
import { aptClientPaths, type FileProbe } from "../../addons/apt-client-tls.ts";
import {
	CredentialPublicFileError,
	type PublicCredentialFile,
	readPublicCredentialFile,
} from "./credential-public-file.ts";
import { StoredStateReadError } from "./stored-state-file.ts";

export type CredentialExpiry =
	| {
			readonly kind: "known";
			readonly expiresAt: number;
			readonly digest: string;
	  }
	| { readonly kind: "unavailable"; readonly reason: CredentialExpiryReason };

export type CredentialExpiryReason =
	| "missing"
	| "read-failed"
	| "unsafe-file"
	| "oversize"
	| "changed"
	| "invalid-certificate"
	| "invalid-date"
	| "metadata-mismatch";

export type CredentialExpiryDeps = {
	readonly exists: FileProbe;
	readonly readPublic: (path: string, limit: number) => PublicCredentialFile;
};

const PACKAGE_CERT = "/usr/share/ceralive/apt-credentials/client.crt";
const CERT_LIMIT = 65_536;

export const defaultCredentialExpiryDeps: CredentialExpiryDeps = {
	exists: (path) => Bun.file(path).exists(),
	readPublic: readPublicCredentialFile,
};

export function parsePublicCredential(bytes: Buffer): CredentialExpiry {
	try {
		const cert = new X509Certificate(bytes);
		const expiresAt = Date.parse(cert.validTo);
		if (!Number.isSafeInteger(expiresAt))
			return { kind: "unavailable", reason: "invalid-date" };
		return {
			kind: "known",
			expiresAt,
			digest: createHash("sha256").update(cert.raw).digest("hex"),
		};
	} catch {
		// Crypto errors can contain certificate input; only the closed code leaves this boundary.
		return { kind: "unavailable", reason: "invalid-certificate" };
	}
}

function metadataExpiry(bytes: Buffer): number | undefined {
	const text = bytes.toString("utf8");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n?$/.test(text)) return undefined;
	const normalized = text.trimEnd();
	const value = Date.parse(normalized);
	return Number.isSafeInteger(value) &&
		new Date(value).toISOString() === normalized.replace("Z", ".000Z")
		? value
		: undefined;
}

export async function readCredentialExpiry(
	deps: CredentialExpiryDeps = defaultCredentialExpiryDeps,
): Promise<CredentialExpiry> {
	try {
		const selected = await aptClientPaths(deps.exists);
		if (!selected) return { kind: "unavailable", reason: "missing" };
		const before = deps.readPublic(selected.cert, CERT_LIMIT);
		const parsed = parsePublicCredential(before.bytes);
		switch (parsed.kind) {
			case "unavailable":
				return parsed;
			case "known":
				break;
			default: {
				const exhaustive: never = parsed;
				return exhaustive;
			}
		}
		if (selected.cert === PACKAGE_CERT) {
			const path = selected.cert.replace(/client\.crt$/, "not-after");
			const first = deps.readPublic(path, 64);
			const expiry = metadataExpiry(first.bytes);
			if (expiry === undefined)
				return { kind: "unavailable", reason: "invalid-date" };
			if (expiry !== parsed.expiresAt)
				return { kind: "unavailable", reason: "metadata-mismatch" };
			const second = deps.readPublic(path, 64);
			if (
				first.identity !== second.identity ||
				!first.bytes.equals(second.bytes)
			)
				return { kind: "unavailable", reason: "changed" };
		}
		const after = deps.readPublic(selected.cert, CERT_LIMIT);
		const current = await aptClientPaths(deps.exists);
		if (
			current?.cert !== selected.cert ||
			before.identity !== after.identity ||
			!before.bytes.equals(after.bytes)
		)
			return { kind: "unavailable", reason: "changed" };
		return parsed;
	} catch (error) {
		// Filesystem errors contain paths; never retain them as causes or diagnostics.
		const reason: CredentialExpiryReason =
			error instanceof CredentialPublicFileError
				? error.reason
				: error instanceof StoredStateReadError && error.reason === "oversize"
					? "oversize"
					: "read-failed";
		return { kind: "unavailable", reason };
	}
}
