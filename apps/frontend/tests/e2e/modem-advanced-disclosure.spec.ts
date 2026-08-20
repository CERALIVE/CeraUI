import { expect, test } from "./fixtures/index.js";

import { ensureAuthenticated, navigateTo } from "./helpers";

/**
 * The Advanced disclosure is CLICKABLE AT ITS OWN PIXELS, and its collapsed body
 * is not. @functional
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `CollapsibleSection` reveals with `grid-template-rows: 0fr → 1fr` over an
 * `overflow: hidden` wrapper, and the body stays mounted + `inert` while closed.
 * `overflow: hidden` clips PAINTING and nothing else: every control inside keeps
 * a full-size layout box at its uncollapsed coordinates. Measured on the bench
 * board through the Cellular row's own copy of this shape, a collapsed
 * `open-router-admin` reported 173x32 at y=1433 from inside a 0px-tall clipping
 * ancestor.
 *
 * That is a control no pointer can reach which nevertheless advertises itself as
 * reachable, and it fails in the worst possible way: Playwright answers "visible,
 * enabled and stable", hit-tests the box centre, resolves whatever is genuinely
 * painted at those coordinates, and retries `intercepts pointer events`
 * FOREVER — which reads exactly like a re-render race and is not one. `inert`
 * does not help: it governs focus and the accessibility tree, not hit testing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE CLICKS GO THROUGH `page.mouse`
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `locator.click()` performs its own actionability + scroll + hit-test dance, so
 * it can succeed on a control whose VISUAL bounds an operator's finger could
 * never land on. Every click below is dispatched at a coordinate MEASURED from
 * `boundingBox()`, with `document.elementFromPoint` asserted at that exact
 * coordinate first — which is the only form of this test that can distinguish "a
 * pointer at these pixels reaches this control" from "Playwright found a way in".
 */

/**
 * WHAT a pointer at `(x, y)` would actually reach, as a three-way answer.
 *
 * It returns a STRING rather than a boolean on purpose. The obvious form,
 * `hit?.closest(sel) !== null`, is `true` when `hit` is null — so a coordinate
 * outside the viewport passes every assertion vacuously. This test measured
 * exactly that on its first run: the disclosure sits below the fold in a
 * scrolling dialog, so an unscrolled `boundingBox()` produced off-screen
 * coordinates, `elementFromPoint` answered null, and the whole hit-testing
 * section proved nothing while reporting green. `"nothing"` is therefore a
 * distinct, failing answer rather than an accidental pass.
 */
async function hitOwner(
	page: import("@playwright/test").Page,
	x: number,
	y: number,
	selector = "[data-collapsible-trigger]",
): Promise<"trigger" | "other" | "nothing"> {
	return page.evaluate(
		({ px, py, sel }) => {
			const hit = document.elementFromPoint(px, py);
			if (hit === null) return "nothing" as const;
			return hit.closest(sel) === null ? ("other" as const) : ("trigger" as const);
		},
		{ px: x, py: y, sel: selector },
	);
}

test.describe("modem Advanced disclosure — hit target", { tag: "@functional" }, () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"pointer hit-testing is a single-browser proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the modem config dialog",
		);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	test("the toggle owns its own pixels, and the collapsed body owns none", async ({
		page,
	}) => {
		await page.getByTestId("open-modem-config-dialog").first().click();
		const dialog = page.getByRole("dialog").first();
		const toggle = dialog.getByTestId("modem-advanced-toggle");
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");

		// ── 1. The collapsed body advertises nothing reachable ──────────────────
		// This is the assertion the fix turns green. Before it, these controls
		// reported non-empty rects with `visibility: visible`, so Playwright
		// called them visible while no pointer could land on them.
		const body = dialog.getByTestId("modem-advanced-body");
		await expect(body).toBeHidden();
		await expect(dialog.getByTestId("modem-sms-toggle")).toBeHidden();
		await expect(dialog.getByTestId("modem-usb-mode-card")).toBeHidden();

		// …and the escaping layout box is still THERE, which is the point: the
		// guard withdraws it from hit testing rather than from layout, so a
		// coordinate inside it must resolve to something else entirely.
		const clipped = await dialog
			.getByTestId("modem-sms-toggle")
			.evaluate((el) => {
				const rect = el.getBoundingClientRect();
				const x = rect.left + rect.width / 2;
				const y = rect.top + rect.height / 2;
				const hit = document.elementFromPoint(x, y);
				return {
					hasBox: rect.width > 0 && rect.height > 0,
					ownsItsPoint: hit !== null && (hit === el || el.contains(hit)),
				};
			});
		expect(
			clipped.hasBox,
			"the collapsed control still occupies layout — that is the trap",
		).toBe(true);
		expect(
			clipped.ownsItsPoint,
			"a collapsed control must NOT answer a hit test at its own centre",
		).toBe(false);

		// ── 2. The trigger answers a hit test at its measured centre ────────────
		// `boundingBox()` does NOT scroll, and the dialog body is taller than the
		// viewport — an unscrolled measurement lands off-screen, where
		// `elementFromPoint` answers null and a mouse click reaches nothing.
		await toggle.scrollIntoViewIfNeeded();
		const triggerBox = await toggle.boundingBox();
		expect(triggerBox, "the toggle must have rendered bounds").not.toBeNull();
		if (triggerBox === null) return;
		const cx = triggerBox.x + triggerBox.width / 2;
		const cy = triggerBox.y + triggerBox.height / 2;

		expect(
			await hitOwner(page, cx, cy),
			"nothing may overlay the disclosure trigger at its own centre",
		).toBe("trigger");

		// A touch target is only real if its EDGES work too — a dead zone at the
		// end of a full-width header is exactly what an operator's thumb finds.
		const inset = 6;
		for (const [label, x, y] of [
			["start edge", triggerBox.x + inset, cy],
			["end edge", triggerBox.x + triggerBox.width - inset, cy],
			["top edge", cx, triggerBox.y + inset],
			["bottom edge", cx, triggerBox.y + triggerBox.height - inset],
		] as const) {
			expect(
				await hitOwner(page, x, y),
				`${label} of the trigger must hit the trigger`,
			).toBe("trigger");
		}

		// ── 3. A real pointer at those pixels opens it ──────────────────────────
		await page.mouse.click(cx, cy);
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(body).toBeVisible();

		// ── 4. …and what was clipped is now reachable at ITS pixels ─────────────
		const smsToggle = dialog.getByTestId("modem-sms-toggle");
		await expect(smsToggle).toBeVisible();
		await smsToggle.scrollIntoViewIfNeeded();
		const smsBox = await smsToggle.boundingBox();
		expect(smsBox).not.toBeNull();
		if (smsBox === null) return;
		const smsX = smsBox.x + smsBox.width / 2;
		const smsY = smsBox.y + smsBox.height / 2;

		expect(
			await hitOwner(page, smsX, smsY, '[data-testid="modem-sms-toggle"]'),
			"an expanded body's control must answer its own hit test",
		).toBe("trigger");

		await page.mouse.click(smsX, smsY);
		await expect(smsToggle).toHaveAttribute("aria-expanded", "true");
	});

	test("closing it withdraws the body from hit testing again", async ({
		page,
	}) => {
		await page.getByTestId("open-modem-config-dialog").first().click();
		const dialog = page.getByRole("dialog").first();
		const toggle = dialog.getByTestId("modem-advanced-toggle");
		const body = dialog.getByTestId("modem-advanced-body");

		await toggle.click();
		await expect(body).toBeVisible();

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		// The close is TRANSITIONED, so the assertion has to be the settled state
		// rather than the next frame — `toBeHidden` retries, which is exactly the
		// right shape here.
		await expect(body).toBeHidden();
		await expect(dialog.getByTestId("modem-sms-toggle")).toBeHidden();
	});
});
