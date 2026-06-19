/**
 * QR-pairing deep-link builder (Onboarding, Task 17).
 *
 * The device shows a QR that encodes a link to the cloud pairing portal with the
 * current claim-code and device serial pre-filled. An operator scans it with a
 * phone, the platform `/pair` page reads the query params and auto-fills the
 * claim form — no manual typing. This module is the single, pure source of the
 * link shape so the device QR and the platform parser stay in agreement.
 *
 * This does NOT touch the claim-code HMAC/token contract: the serial is public
 * (the unguessability lives in the HMAC secret), and the code is the same one
 * `pairing.generateClaimCode` already returns.
 */

/**
 * Default cloud pairing-portal origin the QR deep-links into. The platform web
 * dashboard serves `/pair` here. Override per-build via `VITE_PAIRING_PORTAL_URL`
 * for staging/self-hosted portals.
 */
export const PAIRING_PORTAL_BASE_URL: string =
	import.meta.env.VITE_PAIRING_PORTAL_URL ?? "https://app.ceralive.tv";

export interface PairingDeepLinkInput {
	/** Active claim-code from `pairing.generateClaimCode`. */
	code: string;
	/** Device hardware serial the code is namespaced to. */
	serial: string;
	/** Portal origin (defaults to {@link PAIRING_PORTAL_BASE_URL}). */
	baseUrl?: string;
}

/**
 * Build the `/pair?code=…&serial=…` deep link the device QR encodes. Returns an
 * absolute URL string. Throws on an empty code or serial — there is nothing to
 * pair without both, and a half-built link would silently fail to auto-fill.
 */
export function buildPairingDeepLink(input: PairingDeepLinkInput): string {
	const code = input.code.trim();
	const serial = input.serial.trim();
	if (!code) throw new Error("claim code is required");
	if (!serial) throw new Error("device serial is required");

	const base = input.baseUrl ?? PAIRING_PORTAL_BASE_URL;
	const url = new URL("/pair", base);
	url.searchParams.set("code", code);
	url.searchParams.set("serial", serial);
	return url.toString();
}
