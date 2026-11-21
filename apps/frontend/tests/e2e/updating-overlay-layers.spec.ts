import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, setLocale } from "./helpers/index.js";

test("shows activity for a silent single-package download before counting install steps", async ({
	page,
	pageRpc,
}) => {
	await page.goto("/");
	await ensureAuthenticated(page);
	const sendProgress = (total: number, downloading: number, unpacking: number, setting_up = 0) =>
		pageRpc.call(["dev", "emit"], {
			type: "status",
			payload: { updating: { total, downloading, unpacking, setting_up } },
		});
	const overlay = page.getByTestId("updating-overlay");
	const phase = overlay.getByTestId("update-phase");
	const bar = overlay.getByRole("progressbar");

	await sendProgress(0, 0, 0);
	await expect(phase).toHaveText("Preparing or downloading packages");
	await expect(bar).toHaveAttribute("data-state", "indeterminate");
	await expect(bar).toHaveCSS("background-image", /repeating-linear-gradient/);

	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.locator("html").evaluate((root) => root.setAttribute("data-display", "eink"));
	await sendProgress(0, 0, 1, 1);
	await expect(phase).toHaveText("Installing");
	await expect(bar).toHaveAttribute("data-state", "indeterminate");
	await expect(bar).not.toHaveAttribute("aria-valuenow");
	await expect(bar).toHaveCSS("background-image", /repeating-linear-gradient/);
	await expect(bar).toHaveCSS("animation-name", "none");
	await expect(overlay.getByText("1/0", { exact: true })).toHaveCount(0);

	await sendProgress(1, 1, 0);
	await expect(phase).toHaveText("Downloading");
	await expect(bar).toHaveAttribute("data-state", "indeterminate");
	await expect(overlay.getByText("1/1", { exact: true })).toHaveCount(0);

	await sendProgress(1, 1, 1);
	await expect(phase).toHaveText("Unpacking");
	await expect(bar).toHaveAttribute("aria-valuenow", "1");
	await expect(bar).toHaveAttribute("aria-valuemax", "3");
	await expect(bar).toHaveCSS("background-image", "none");

	await sendProgress(1, 1, 1, 1);
	await expect(phase).toHaveText("Installing");
	await expect(bar).toHaveAttribute("aria-valuenow", "2");
	await expect(bar).toHaveAttribute("aria-valuetext", "66%");
	await expect(overlay.getByText("2 of 3 steps")).toBeVisible();
	await expect(overlay.getByText("1/1", { exact: true })).toHaveCount(0);
	await expect(overlay.getByText("100%", { exact: true })).toHaveCount(0);
});

// The update takeover once carried a decorative wash: an overflow-hidden layer
// of blurred circles larger than the sheet, which a script could scroll. Neither
// the sheet nor its direct children may scroll (nested content such as the
// progress track is out of scope here), and the sheet must still cover the app
// with its phase and progress on screen.
for (const { code, dir } of [
	{ code: "en", dir: "ltr" },
	{ code: "ar", dir: "rtl" },
] as const) {
	test(`no direct layer of the update overlay can be script-scrolled, and it still blocks the app (${dir})`, async ({
		page,
		pageRpc,
	}) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await setLocale(page, code);
		await page.goto("/");
		await ensureAuthenticated(page);
		await expect(page.locator("html")).toHaveAttribute("dir", dir);

		// A mid-flight frame: no `result`, so neither terminal state is shown.
		await pageRpc.call(["dev", "emit"], {
			type: "status",
			payload: { updating: { downloading: 2, unpacking: 0, setting_up: 0, total: 6 } },
		});
		const overlay = page.getByTestId("updating-overlay");
		await expect(overlay.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
		// The sheet slides in; measure it at rest.
		await page.evaluate(() =>
			Promise.all(
				document
					.getAnimations()
					.filter(
						(animation) =>
							animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY,
					)
					.map((animation) => animation.finished.catch(() => undefined)),
			),
		);
		await expect(overlay.getByTestId("update-phase")).toBeInViewport({ ratio: 1 });
		await expect(overlay.getByRole("progressbar")).toBeVisible();

		const layout = await overlay.evaluate((root) => {
			const box = (selector: string) => {
				const element = root.querySelector(selector);
				if (!element) throw new Error(`${selector} is missing from the overlay`);
				const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
				return { left, top, right, bottom, width, height };
			};
			const onScreen = () => ({
				phase: box('[data-testid="update-phase"]'),
				progress: box('[role="progressbar"]'),
			});
			const atRest = onScreen();
			const scrollableLayers = [root, ...root.children].flatMap((layer) => {
				layer.scrollTo({ left: 1e6, top: 1e6, behavior: "instant" });
				const ahead = { left: layer.scrollLeft, top: layer.scrollTop };
				layer.scrollTo({ left: -1e6, top: 0, behavior: "instant" });
				const behind = layer.scrollLeft;
				return ahead.left || ahead.top || behind
					? [{ layer: layer.getAttribute("class"), ahead, behind }]
					: [];
			});

			// `scrollbar-gutter: stable` reserves a strip beside <html> that no element
			// receives, so the hit-testable viewport is <html>'s box, not innerWidth.
			const documentBox = document.documentElement.getBoundingClientRect();
			const viewport = {
				left: documentBox.left,
				right: documentBox.right,
				top: 0,
				bottom: document.documentElement.clientHeight,
			};
			const backdrop = document.querySelector('[data-slot="drawer-overlay"]');
			const owner = (x: number, y: number) => {
				const hit = document.elementFromPoint(x, y);
				if (!hit) return "nothing";
				if (root.contains(hit)) return "sheet";
				if (backdrop?.contains(hit)) return "backdrop";
				return `app ${hit.tagName} ${hit.getAttribute("class")}`;
			};
			const fifths = [0.1, 0.3, 0.5, 0.7, 0.9];
			const samples = fifths.flatMap((fx) =>
				fifths.map((fy) => {
					const x = viewport.left + fx * (viewport.right - viewport.left);
					const y = fy * viewport.bottom;
					return { x, y, owner: owner(x, y) };
				}),
			);
			const gutter = [
				[0, viewport.left],
				[viewport.right, window.innerWidth],
			]
				.filter(([from, to]) => to > from)
				.flatMap(([from, to]) =>
					fifths.map((fy) => {
						const x = (from + to) / 2;
						const y = fy * viewport.bottom;
						return { x, y, owner: owner(x, y) };
					}),
				);

			return { scrollableLayers, viewport, samples, gutter, atRest, afterScroll: onScreen() };
		});
		const detail = JSON.stringify(layout);
		const owned = (name: string) => layout.samples.filter((sample) => sample.owner === name).length;
		expect(layout.scrollableLayers, detail).toEqual([]);
		// Every sample lands on the sheet or its backdrop, and enough of them do that
		// an empty or misplaced grid cannot pass.
		expect(
			layout.samples.filter((sample) => sample.owner !== "sheet" && sample.owner !== "backdrop"),
			detail,
		).toEqual([]);
		expect(owned("sheet"), detail).toBeGreaterThanOrEqual(16);
		expect(owned("backdrop"), detail).toBeGreaterThanOrEqual(4);
		expect(
			layout.gutter.filter((sample) => sample.owner.startsWith("app")),
			detail,
		).toEqual([]);
		for (const { width, height, left, right, top, bottom } of [
			layout.atRest.phase,
			layout.atRest.progress,
			layout.afterScroll.phase,
			layout.afterScroll.progress,
		]) {
			expect(
				width > 0 &&
					height > 0 &&
					left >= layout.viewport.left &&
					right <= layout.viewport.right &&
					top >= layout.viewport.top &&
					bottom <= layout.viewport.bottom,
				detail,
			).toBe(true);
		}
	});
}
