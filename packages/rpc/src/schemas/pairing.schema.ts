/**
 * Device pairing Zod schemas (claim-code generation).
 *
 * Part of the device-pairing-claim-code change. The device generates a
 * short-lived, human-typeable claim-code that an authenticated user submits on
 * the platform to bind the device to their account. This file is the single
 * source of truth for the claim-code charset, length bounds, and RPC output
 * shape shared between the backend handler and the frontend.
 */
import { z } from 'zod';

/**
 * Unambiguous uppercase claim-code alphabet.
 *
 * Crockford-style: the full A–Z/0–9 space minus visually similar characters so
 * a human reading the code off the device screen cannot confuse them:
 *   - `O` / `0`
 *   - `I` / `1`
 *   - `L` (confused with `1`/`I`)
 *
 * 31 characters total (23 letters + 8 digits). No regex-special characters, so
 * the value can be embedded directly inside a character class.
 */
export const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Minimum claim-code length (inclusive). */
export const CLAIM_CODE_MIN_LENGTH = 6;
/** Maximum claim-code length (inclusive). */
export const CLAIM_CODE_MAX_LENGTH = 8;

/**
 * Matches a claim-code: only unambiguous uppercase alphanumerics, 6–8 chars.
 * Built from {@link CLAIM_CODE_ALPHABET} so the charset stays DRY.
 */
export const CLAIM_CODE_RE = new RegExp(
	`^[${CLAIM_CODE_ALPHABET}]{${CLAIM_CODE_MIN_LENGTH},${CLAIM_CODE_MAX_LENGTH}}$`,
);

/**
 * Output of `pairing.generateClaimCode`.
 *
 * - `code`         — the human-typeable claim-code (unambiguous charset, 6–8 chars).
 * - `validUntil`   — epoch milliseconds at which the current code window ends.
 *                    The code is stable until this instant, then rotates.
 * - `windowSeconds`— length of the validity window in seconds.
 * - `serial`       — the device hardware serial the code is namespaced to. It is
 *                    NOT a secret (the unguessability comes from the HMAC secret,
 *                    not the serial) and the platform claim needs it alongside the
 *                    code, so it is surfaced here to drive the QR-pairing deep link.
 */
export const claimCodeOutputSchema = z.object({
	code: z.string().regex(CLAIM_CODE_RE),
	validUntil: z.number().int().nonnegative(),
	windowSeconds: z.number().int().positive(),
	serial: z.string().min(1),
});
export type ClaimCodeOutput = z.infer<typeof claimCodeOutputSchema>;

/** Subscription standing carried in the device token (`sub_status`, ADR-0006); mirrors platform `Billing.status`. */
export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'FREE', 'EXPIRED', 'CANCELLED'] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/**
 * Canonical device-token claims (PASETO v4.public payload, ADR-0006).
 *
 * SINGLE SOURCE OF TRUTH for the device-token claim contract. Both the device
 * (CeraUI `apps/backend/src/modules/pairing/device-token.ts`) and the platform
 * (`ceralive-platform/apps/api/lib/claim.ts`) reference these exact field names
 * — there is no divergent duplicate definition. The field names are fixed by the
 * ADR-0006 claim table (`docs/adr/0006-paseto-device-token.md`): snake_case
 * `device_id` (not `deviceId`) and `sub_status` (not `sub`).
 *
 * Reconciles two prior shapes:
 *   - ADR-0006 registered/core claims: `device_id`, `sub_status`, `iat`, `exp`.
 *   - Platform identity-binding claims: `tenantId`, `serial` (the platform issues
 *     these at claim time — see `claim.ts` `issueDeviceToken`).
 *
 * `tenantId`/`serial` are OPTIONAL: the device-side stub mints a token before the
 * platform has bound a tenant, so it carries only the ADR-0006 core claims; the
 * platform-issued (real) token additionally carries the binding pair. The schema
 * therefore validates both the device stub and the future platform token.
 *
 * ADR-0006 is still `proposed`, so the token is a stub: claims are real but not
 * yet Ed25519-signed (see `modules/pairing/device-token.ts`).
 */
export const deviceTokenClaimsSchema = z.object({
	/** Device serial — becomes `DeviceConnection.serialNumber` on the platform. */
	device_id: z.string().min(1),
	/** Subscription standing at issuance (platform `Billing.status`). */
	sub_status: subscriptionStatusSchema,
	/** Issued-at, epoch seconds. */
	iat: z.number().int().nonnegative(),
	/** Expiry, epoch seconds. The channel rejects expired tokens. */
	exp: z.number().int().nonnegative(),
	/** Owning tenant id — platform-issued binding claim (absent on the device stub). */
	tenantId: z.string().min(1).optional(),
	/** Device-reported hardware serial — platform-issued binding claim (absent on the device stub). */
	serial: z.string().min(1).optional(),
});
export type DeviceTokenClaims = z.infer<typeof deviceTokenClaimsSchema>;

/** Input for `pairing.completePairing`: the claim-code submitted to the (mock) platform. */
export const completePairingInputSchema = z.object({
	code: z.string().regex(CLAIM_CODE_RE),
	/**
	 * Optional operator-pasted pairing authorization credential. When present the
	 * device-side pairing flow forwards it as the `x-ceralive-pairing-authorization`
	 * header on BOTH the pairing-secret registration and the platform claim
	 * requests — the tenant credential both platform routes require. Absent for
	 * the mock/dev path and for platforms that do not require it.
	 */
	authorization: z.string().min(1).optional(),
});
export type CompletePairingInput = z.infer<typeof completePairingInputSchema>;

/**
 * Output of `pairing.completePairing`. `paired` is the discriminant; on success
 * the device stored the issued token as its active `remote_key`. `validUntil` is
 * epoch ms (token `exp` is epoch seconds). `error` carries a stable machine code.
 */
export const completePairingOutputSchema = z.object({
	paired: z.boolean(),
	device_id: z.string().optional(),
	sub_status: subscriptionStatusSchema.optional(),
	validUntil: z.number().int().nonnegative().optional(),
	error: z.string().optional(),
});
export type CompletePairingOutput = z.infer<typeof completePairingOutputSchema>;
