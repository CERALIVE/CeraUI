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
 * Complete pairing against the mock platform: validate the submitted claim-code,
 * receive a device token, and store it as the active remote key (reconnecting
 * the channel with it). Gated to mock mode — until the real platform claim
 * endpoint exists, there is no production path to issue a token here.
 */
export const completePairingProcedure = authedProcedure
	.input(completePairingInputSchema)
	.output(completePairingOutputSchema)
	.handler(async ({ input }) => {
		if (!shouldUseMocks()) {
			return { paired: false, error: "mock-platform-unavailable" };
		}
		return completeMockPairing(input.code, {
			applyToken: (token) => setRemoteConfig({ token }),
		});
	});
