/**
 * Pure claim-code validity-window helpers (device-pairing-claim-code, Task 25).
 *
 * The backend returns `validUntil` as epoch ms. These pure functions derive the
 * remaining window and a human countdown without any runes/DOM dependency, so
 * the countdown logic is unit-testable in isolation.
 */

export function claimCodeRemainingMs(validUntil: number, now: number): number {
	return Math.max(0, validUntil - now);
}

export function isClaimCodeExpired(validUntil: number, now: number): boolean {
	return now >= validUntil;
}

/** Format a remaining-ms span as `m:ss` (clamped at zero). */
export function formatClaimCodeRemaining(remainingMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
