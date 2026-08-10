import type { WebSocketRoute } from "@playwright/test";

import { expect, type Page, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * T13 — dev-parity for the signals device-stats-observability added.
 *
 * The claim under test is narrow and worth stating plainly: **every element the
 * new signals render is reachable in mock mode**. A field that only ever appears
 * on a board is a field no agent, reviewer, or designer can look at, and the
 * whole point of the mock subsystem is that dev mode exercises the same parse
 * and render path a device does.
 *
 * The two halves have DIFFERENT mock architectures, deliberately kept apart:
 *
 *  - memory / swap / CPU frequency / DDR / GPU ride the real `device-stats`
 *    broadcast, seeded by the BACKEND provider
 *    (`apps/backend/src/mocks/providers/device-stats.ts`), whose raw outputs are
 *    parsed by the real collectors. The expected strings below are that
 *    fixture's values, formatted by the panel — if a serializer is removed the
 *    element disappears and these assertions fail.
 *  - decoder cores ride the FRONTEND `?health-mock=` fixture
 *    (`src/lib/streaming/encoder-load-mock.ts`), because the backend collector
 *    that publishes them is `isRealDevice()`-gated and says nothing on a dev
 *    host.
 *
 * That second fixture is pruned from a production bundle by design, and CI runs
 * these specs against `vite preview` — so its case is gated on a REAL detection
 * of the dev server rather than an assumption, and the same rendering is proven
 * environment-independently by pushing a genuine `encoder-load` broadcast.
 *
 * PLAYBOOK.md: functional spec — no screenshots, no fixed delays.
 */

/** Values from `MOCK_DEVICE_STATS`, as the panels format them. */
const EXPECTED = {
	memory: "25 %",
	swap: "0.0 GiB / 2.0 GiB",
	cpuFreq: {
		policy0: "1.01 GHz / 1.80 GHz",
		policy4: "1.42 GHz / 2.40 GHz",
		policy6: "2.02 GHz / 2.40 GHz",
	},
	ddr: "37 %",
	gpu: "61 %",
	// The health readouts print the same figures in the panel's own tighter
	// percent format — asserted verbatim rather than normalized, because a
	// formatter drifting between the two surfaces is a real defect.
	health: { ddr: "37%", gpu: "61%" },
} as const;

/** A vendor-kernel reading carrying decoder rows, in the wire shape. */
const ENCODER_LOAD_WITH_DECODE = {
	source: "mpp-service",
	cores: [
		{ core: "rkvenc0", kind: "percent", percent: 11.34 },
		{ core: "rkvenc1", kind: "percent", percent: 0 },
	],
	decodeCores: [
		{ core: "rkvdec0", kind: "percent", percent: 23.1 },
		{ core: "rkvdec1", kind: "unavailable" },
	],
	updatedAt: Date.now(),
	simulated: false,
};

/** The mainline reading: decode is ABSENT, never an empty array. */
const ENCODER_LOAD_WITHOUT_DECODE = {
	source: "clk-enable-count",
	cores: [
		{ core: "rkvenc0", kind: "active", active: true },
		{ core: "rkvenc1", kind: "active", active: false },
	],
	updatedAt: Date.now(),
	simulated: false,
};

async function openDeviceHealth(page: Page): Promise<void> {
	await page
		.getByRole("button", { name: /Device Health/i })
		.first()
		.click();
	await expect(page.getByTestId("device-health")).toBeVisible({
		timeout: 15_000,
	});
}

test.describe("device-stats observability — mock parity", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "settings");
		await expect(page.getByTestId("device-stats")).toBeVisible({
			timeout: 15_000,
		});
	});

	test("Device Stats renders every new signal from the backend fixture", async ({
		page,
	}) => {
		const stats = page.getByTestId("device-stats");

		await expect(stats.getByTestId("device-stat-memory-value")).toHaveText(
			EXPECTED.memory,
		);
		await expect(stats.getByTestId("device-stat-memory-bar")).toBeVisible();

		await expect(stats.getByTestId("device-stat-swap-value")).toHaveText(
			EXPECTED.swap,
		);

		// One row per policy the fixture publishes — three, and named by their
		// sysfs directory rather than by position.
		for (const [policy, value] of Object.entries(EXPECTED.cpuFreq)) {
			await expect(
				stats.getByTestId(`cpufreq-policy-value-${policy}`),
			).toHaveText(value);
		}
		await expect(
			stats.getByTestId("cpufreq-policies").getByTestId(/^cpufreq-policy-p/),
		).toHaveCount(3);

		await expect(stats.getByTestId("device-stat-ddr-value")).toHaveText(
			EXPECTED.ddr,
		);
		await expect(stats.getByTestId("device-stat-gpu-value")).toHaveText(
			EXPECTED.gpu,
		);
	});

	test("Device Health renders the memory trace and the GPU/DDR readouts", async ({
		page,
	}) => {
		await openDeviceHealth(page);
		const panel = page.getByTestId("device-health");

		// The memory lane exists as a THIRD trace beside temperature and load.
		await expect(panel.getByTestId("health-lane-label-memory")).toBeVisible();
		await expect(panel.getByTestId("health-lane-scale-memory")).toBeVisible();

		await expect(panel.getByTestId("device-health-loads")).toBeVisible();
		await expect(panel.getByTestId("health-load-gpu-value")).toHaveText(
			EXPECTED.health.gpu,
		);
		await expect(panel.getByTestId("health-load-ddr-value")).toHaveText(
			EXPECTED.health.ddr,
		);
		// The fixture's GPU and DDR both carry frequencies, so both details are
		// real strings — a kbase-shaped GPU would have none, which is why this
		// asserts content rather than mere presence.
		await expect(panel.getByTestId("health-load-gpu-detail")).not.toBeEmpty();
		await expect(panel.getByTestId("health-load-ddr-detail")).not.toBeEmpty();
	});
});

/**
 * A 200 on `/@vite/client` proves nothing — Vite's default SPA `appType` answers
 * every unmatched route with `index.html` at status 200, so `vite preview` also
 * returns 200 here and a status-only probe reports "dev" everywhere. The content
 * type is the discriminator: only a real dev server serves it as an ES module.
 */
async function isViteDevServer(
	page: Page,
	baseURL: string | undefined,
): Promise<boolean> {
	const response = await page.request
		.get(`${baseURL}/@vite/client`)
		.catch(() => null);
	if (response === null || !response.ok()) return false;
	const contentType = response.headers()["content-type"] ?? "";
	return /^(?:text|application)\/javascript\b/.test(contentType);
}

test.describe("decoder cores — the dev fixture's rows", () => {
	test.beforeEach(async ({ page, baseURL }) => {
		// The `?health-mock=` fixture lives behind `import.meta.env.DEV`, so a
		// production bundle prunes it entirely. Probing for the Vite dev client is
		// the honest discriminator; guessing from CI env vars is not.
		test.skip(
			!(await isViteDevServer(page, baseURL)),
			"the ?health-mock fixture is pruned from a production bundle (CI serves `vite preview`); the broadcast-driven spec below covers this rendering in every environment",
		);

		await page.goto("/?health-mock=vendor");
		await ensureAuthenticated(page);
		await navigateTo(page, "settings");
	});

	test("the vendor flavour populates rkvdec rows, keeping the refused slot", async ({
		page,
	}) => {
		await openDeviceHealth(page);
		const decoders = page.getByTestId("decoder-cores");

		await expect(decoders).toBeVisible();
		await expect(decoders.getByTestId("decoder-core-rkvdec0")).toBeVisible();
		await expect(
			decoders.getByTestId("decoder-core-value-rkvdec0"),
		).not.toBeEmpty();
		// The refused row keeps its slot rather than renumbering rkvdec1 away.
		await expect(decoders.getByTestId("decoder-core-rkvdec1")).toBeVisible();
	});
});

test.describe("decoder cores — driven by a real encoder-load broadcast", () => {
	let socket: WebSocketRoute | null = null;

	test.beforeEach(async ({ page }) => {
		socket = null;
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			socket = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => ws.send(m));
		});
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "settings");
	});

	/** Push a broadcast frame and let the store's effect settle on a DOM signal. */
	async function push(frame: Record<string, unknown>): Promise<void> {
		socket?.send(JSON.stringify(frame));
	}

	test("decode rows render when present and vanish when the key is absent", async ({
		page,
	}) => {
		await openDeviceHealth(page);
		const panel = page.getByTestId("device-health");

		await expect
			.poll(
				async () => {
					await push({ "encoder-load": ENCODER_LOAD_WITH_DECODE });
					return panel.getByTestId("decoder-core-rkvdec0").count();
				},
				{ timeout: 10_000, message: "decoder rows should render" },
			)
			.toBe(1);
		await expect(panel.getByTestId("decoder-core-rkvdec1")).toBeVisible();

		// A mainline reading omits the key. ABSENT is not an empty measurement, so
		// the whole section goes — it does not linger showing nothing.
		await expect
			.poll(
				async () => {
					await push({ "encoder-load": ENCODER_LOAD_WITHOUT_DECODE });
					return panel.getByTestId("decoder-cores").count();
				},
				{ timeout: 10_000, message: "decoder section should disappear" },
			)
			.toBe(0);
	});
});
