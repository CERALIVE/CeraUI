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
 */
export const claimCodeOutputSchema = z.object({
	code: z.string().regex(CLAIM_CODE_RE),
	validUntil: z.number().int().nonnegative(),
	windowSeconds: z.number().int().positive(),
});
export type ClaimCodeOutput = z.infer<typeof claimCodeOutputSchema>;
