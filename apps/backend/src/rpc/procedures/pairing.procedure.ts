/**
 * Pairing Procedures
 * Device-side claim-code generation (device-pairing-claim-code change).
 */

import { claimCodeOutputSchema } from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { generateClaimCode } from "../../modules/pairing/claim-code.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Generate (or return the still-valid) device claim-code.
 *
 * Time-bounded + crypto-seeded: the code is stable within its validity window
 * and deterministically rotates once the window elapses. Returns the code, the
 * epoch-ms instant the window ends (`validUntil`), and the window length in
 * seconds (`windowSeconds`).
 */
export const generateClaimCodeProcedure = authedProcedure
	.output(claimCodeOutputSchema)
	.handler(async () => {
		return generateClaimCode();
	});
