// First-run onboarding dismissal, persisted with Svelte 5 runes.
// Mirrors display-profile.svelte.ts: a single `$persist` boolean keyed in
// localStorage so a dismissal survives reloads. The LiveView checklist auto-hides
// once both config steps are satisfied; this only records an explicit dismissal.
import "svelte-persistent-runes";

let onboardingDismissed = $persist<boolean>(false, "live-onboarding-dismissed");

export function isOnboardingDismissed(): boolean {
	return onboardingDismissed;
}

export function dismissOnboarding(): void {
	onboardingDismissed = true;
}

// Test/dev helper: restore the first-run guidance (no production caller).
export function resetOnboarding(): void {
	onboardingDismissed = false;
}
