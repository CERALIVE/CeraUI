import type { Locator } from '@playwright/test';

/**
 * Expand `ModemConfigDialog`'s "Advanced" disclosure (todo 64).
 *
 * The dialog's four read-only instrument panels — data usage, serving-cell
 * detail, the SMS inbox and the USB-composition switch — plus the network-type
 * lock now sit behind one collapsed disclosure, so a spec that asserts any of
 * them is VISIBLE has to open it first. Their DOM presence is unchanged (the
 * body stays mounted, clipped and `inert`), which is why only visibility-based
 * assertions need this.
 *
 * Idempotent: a disclosure that is already open is left alone, so a spec can
 * call this before every assertion without tracking state.
 */
export async function openModemAdvanced(dialog: Locator): Promise<void> {
	const toggle = dialog.getByTestId('modem-advanced-toggle');
	// `count()` does NOT auto-wait, and every config dialog is a LAZY CHUNK — so
	// a bare count-is-zero check reads "the chunk has not mounted yet" as "this
	// dialog has no disclosure" and silently no-ops. The caller then clicks a
	// control that is still clipped inside the collapsed section, and Playwright
	// reports the section intercepting pointer events rather than the race. Wait
	// for the toggle to attach first; a dialog that genuinely has none still
	// no-ops, just after the timeout rather than instantly.
	try {
		await toggle.waitFor({ state: 'attached', timeout: 5_000 });
	} catch {
		return;
	}
	if ((await toggle.getAttribute('aria-expanded')) === 'true') return;
	await toggle.click();
	await dialog
		.getByTestId('modem-advanced-body')
		.waitFor({ state: 'visible' });
}
