/**
 * Pairing Procedures
 * Device-side claim-code generation (device-pairing-claim-code change).
 */

import {
	claimCodeOutputSchema,
	completePairingInputSchema,
	completePairingOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { generateClaimCode } from "../../modules/pairing/claim-code.ts";
import { completeMockPairing } from "../../modules/pairing/mock-platform.ts";
import { completePlatformPairing } from "../../modules/pairing/platform-claim.ts";
import { setRemoteConfig } from "../../modules/remote/remote.ts";
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

/**
 * Complete pairing: submit the claim-code, receive a device token, and store it
 * as the active remote key (reconnecting the channel with it).
 *
 * In mock mode (dev/test, `shouldUseMocks()`) the code is validated and a stub
 * token issued locally via {@link completeMockPairing}. In production the code +
 * serial are POSTed to the real cloud platform `POST /api/claim`
 * ({@link completePlatformPairing}); on success the returned opaque device token
 * is persisted as the active `remote_key`. Both paths apply the token through
 * {@link setRemoteConfig}, so the channel presents it on the next reconnect.
 */
export const completePairingProcedure = authedProcedure
	.input(completePairingInputSchema)
	.output(completePairingOutputSchema)
	.handler(async ({ input }) => {
		const applyToken = (token: string) => setRemoteConfig({ token });
		if (shouldUseMocks()) {
			return completeMockPairing(input.code, { applyToken });
		}
		return completePlatformPairing(input.code, { applyToken });
	});
