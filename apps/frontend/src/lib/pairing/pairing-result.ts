/**
 * Pure pairing result/expiry reducers (device-pairing dialog, Task 20).
 *
 * Rune-free, DOM-free reducers that form the testable core of the pairing
 * dialog. `PairingController.complete()` drives its state transitions through
 * {@link reducePairingResult}; the dialog styles the post-pairing standing badge
 * with {@link subscriptionTone} and decides regenerate-on-expiry with
 * {@link shouldAutoRegenerate}. Keeping this logic here (not in the runes class
 * or the markup) is what makes the countdown/expiry/result flow unit-testable.
 */
import type {
	CompletePairingOutput,
	SubscriptionStatus,
} from "@ceraui/rpc/schemas";

import type { PairingStatus } from "./pairing.svelte";

/**
 * Discriminated outcome of a `pairing.completePairing` response. `paired`
 * carries the bound device identity + subscription standing (optional fields
 * normalised to `null`); `rejected` carries a stable machine error code.
 */
export type PairingOutcome =
	| {
			kind: "paired";
			deviceId: string | null;
			subStatus: SubscriptionStatus | null;
			validUntil: number | null;
	  }
	| { kind: "rejected"; error: string };

/** Stable fallback error code when a rejection omits one. */
const DEFAULT_PAIR_ERROR = "pair-failed";

/**
 * Reduce a raw `completePairing` RPC output onto a {@link PairingOutcome} the UI
 * renders directly. `paired` is the discriminant; absent optional success
 * fields become `null` so the consumer never branches on `undefined`.
 */
export function reducePairingResult(
	result: CompletePairingOutput,
): PairingOutcome {
	if (result.paired) {
		return {
			kind: "paired",
			deviceId: result.device_id ?? null,
			subStatus: result.sub_status ?? null,
			validUntil: result.validUntil ?? null,
		};
	}
	return { kind: "rejected", error: result.error ?? DEFAULT_PAIR_ERROR };
}

/** Semantic tone for the post-pairing subscription-standing badge. */
export type SubscriptionTone = "positive" | "neutral" | "warning" | "critical";

/**
 * Map a subscription standing onto a semantic tone so the badge styling stays
 * out of the markup. ACTIVE reads positive, FREE neutral, EXPIRED a soft
 * warning, CANCELLED critical.
 */
export function subscriptionTone(status: SubscriptionStatus): SubscriptionTone {
	switch (status) {
		case "ACTIVE":
			return "positive";
		case "FREE":
			return "neutral";
		case "EXPIRED":
			return "warning";
		case "CANCELLED":
			return "critical";
	}
}

/**
 * Regenerate-on-expiry decision. Returns true only when a live, displayed code
 * (`status === "active"`) has crossed its validity window (`expired`). Every
 * other state is excluded so the dialog never loops on a generate failure, nor
 * fires mid-generation, mid-pairing, or after a successful pair.
 */
export function shouldAutoRegenerate(
	status: PairingStatus,
	expired: boolean,
): boolean {
	return status === "active" && expired;
}
