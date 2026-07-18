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
import { initIdentity } from "../../modules/identity/index.ts";
import { generateClaimCode } from "../../modules/pairing/claim-code.ts";
import { completeMockPairing } from "../../modules/pairing/mock-platform.ts";
import { completePlatformPairing } from "../../modules/pairing/platform-claim.ts";
import { setRemoteConfig } from "../../modules/remote/remote.ts";
import { initControlChannel } from "../../modules/remote-control/channel.ts";
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
 *
 * On a successful claim the device also re-resolves its identity and re-dials the
 * control channel via {@link reconnectControlChannelAfterClaim} so a freshly
 * claimed device connects WITHOUT a reboot (the boot-time identity resolved it as
 * unpaired). When present, `authorization` is forwarded as the pinned
 * `x-ceralive-pairing-authorization` header on both platform HTTP calls.
 */
export const completePairingProcedure = authedProcedure
	.input(completePairingInputSchema)
	.output(completePairingOutputSchema)
	.handler(async ({ input }) => {
		const applyToken = (token: string, deviceId?: string) =>
			setRemoteConfig({
				token,
				...(deviceId !== undefined ? { device_id: deviceId } : {}),
			});
		const result = shouldUseMocks()
			? await completeMockPairing(input.code, { applyToken })
			: await completePlatformPairing(input.code, {
					applyToken,
					...(input.authorization !== undefined
						? { authorization: input.authorization }
						: {}),
				});
		if (result.paired) {
			await reconnectControlChannelAfterClaim();
		}
		return result;
	});

/**
 * Re-resolve device identity from the just-persisted claim, then re-dial the
 * control channel — so a freshly claimed device connects without a reboot. Both
 * steps are idempotent ({@link initControlChannel} tears down any prior channel
 * first), so a repeated claim never double-connects.
 */
async function reconnectControlChannelAfterClaim(): Promise<void> {
	await initIdentity();
	await initControlChannel();
}
