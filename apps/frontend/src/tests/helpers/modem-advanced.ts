/**
 * Expand `ModemConfigDialog`'s "Advanced" disclosure in a jsdom test.
 *
 * The unit twin of `tests/e2e/helpers/modem-advanced.ts`, and it exists for the
 * same reason that one does — plus one that is specific to querying BY ROLE.
 *
 * The disclosure keeps its body mounted while collapsed, so `getByTestId` has
 * always resolved through it and most assertions need nothing. `getByRole` does
 * not: it runs Testing Library's `isInaccessible`, which honours
 * `visibility: hidden` — the guard that withdraws a collapsed body from hit
 * testing (`CollapsibleSection.svelte`). A collapsed body is genuinely
 * inaccessible, so a role query that reaches into one is asserting against a
 * surface no operator and no screen reader can address.
 *
 * Idempotent: an already-open disclosure is left alone, and a dialog that has
 * none (a class of modem whose Advanced section never rendered) is a no-op
 * rather than a failure.
 */

import { fireEvent, screen } from "@testing-library/svelte";

export async function openModemAdvanced(): Promise<void> {
	const toggle = screen.queryByTestId("modem-advanced-toggle");
	if (toggle === null) return;
	if (toggle.getAttribute("aria-expanded") === "true") return;
	await fireEvent.click(toggle);
}
