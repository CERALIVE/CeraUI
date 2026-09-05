import { expect, type Page, test } from "./fixtures/index.js";

import { ensureAuthenticated, navigateTo } from "./helpers";

/**
 * PiP/PbP composition, feature-gated on the engine's `composition` token.
 *
 * The engine is MOCKED with the suite's established drop-and-inject shape (the
 * one `truthfulness.spec.ts` and `helpers/bluetooth-wire.ts` both use): a
 * `routeWebSocket` proxy DROPS the backend's own `capabilities` / `config` /
 * `sources` echoes so only the test's frames ever populate those surfaces, and
 * answers `streaming.setConfig` client-side so the write can be asserted.
 *
 * Dropping is not optional here. The real dev backend pushes its own snapshot at
 * login and re-broadcasts on its own cadence, so an injected frame that merely
 * races it is overwritten and the test measures the backend rather than the UI.
 *
 * The two tests are the halves of one contract: with the token the card renders
 * and filling it in sends the `composition` object; without it the card is
 * ABSENT FROM THE DOM — not disabled, not hidden-but-present — and a config that
 * still carries a saved composition says so instead of silently applying it.
 */

interface CompositionWire {
	/** Replace the injected capability/config/sources snapshot and push it. */
	publish(next: Partial<WireState>): Promise<void>;
	/** Every `streaming.setConfig` input the UI has sent, oldest first. */
	setConfigCalls(): Record<string, unknown>[];
}

interface WireState {
	capabilities: Record<string, unknown>;
	config: Record<string, unknown>;
	sources: Record<string, unknown>;
}

const DROPPED_BROADCASTS = ["capabilities", "config", "sources"] as const;

function captureSource(id: string, displayName: string) {
	return {
		origin: "capture",
		id,
		pipelineId: "hdmi",
		kind: "hdmi",
		displayName,
		devicePath: id,
		modes: [
			{ width: 1920, height: 1080, media_type: "video/x-raw", framerates: [30] },
		],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
	};
}

const BASE_CONFIG = {
	srtla_addr: "10.0.0.1",
	srtla_port: 5000,
	pipeline: "hdmi",
	source: "/dev/video0",
	max_br: 6000,
};

const SAVED_COMPOSITION = {
	secondary_input_id: "/dev/video1",
	layout: "pip-top-right",
	alpha: 1,
};

// Two capture devices: the primary the config names, and the one the card must
// offer as the secondary leg.
const TWO_SOURCES = {
	hardware: "rk3588",
	sources: [
		captureSource("/dev/video0", "QA Primary Cam"),
		captureSource("/dev/video1", "QA Secondary Cam"),
	],
};

function capsWith(features: string[]) {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "2160p",
		},
		encoder: {
			codecs: ["H264", "H265"],
			bitrate_range: { min: 500, max: 12000, unit: "kbps" },
		},
		sources: [],
		engineUnavailable: false,
		features,
	};
}

/**
 * The broad route below OVERRIDES the `pageRpc` fixture's own `/ws` handler
 * (only one handler wins), so this proxy has to reproduce what that fixture
 * does: bind the connection lifecycle and feed server frames back to it. Without
 * that the page never completes login and no destination ever renders.
 */
async function installCompositionWire(
	page: Page,
	pageRpc: {
		bindConnectionLifecycle(browser: unknown, server: unknown): void;
		acceptServerMessage(message: string | Buffer): void;
	},
): Promise<CompositionWire> {
	const state: WireState = {
		capabilities: capsWith([]),
		config: { ...BASE_CONFIG },
		sources: TWO_SOURCES,
	};
	const setConfigCalls: Record<string, unknown>[] = [];
	let route: { send: (data: string) => void } | null = null;

	const push = (): void => {
		for (const type of DROPPED_BROADCASTS) {
			route?.send(JSON.stringify({ [type]: state[type] }));
		}
	};

	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		route = ws;
		const server = ws.connectToServer();
		pageRpc.bindConnectionLifecycle(ws, server);

		ws.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const frame = JSON.parse(text) as {
					id?: unknown;
					path?: unknown;
					input?: Record<string, unknown>;
				};
				const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
				if (rpc === "streaming.setConfig" && frame.id !== undefined) {
					const input = frame.input ?? {};
					setConfigCalls.push(input);
					// Echo the write back as the device would, so the card renders
					// APPLIED config rather than optimistic local state.
					if ("composition" in input) {
						state.config = {
							...state.config,
							composition: input.composition ?? undefined,
						};
						if (input.composition == null) delete state.config.composition;
					}
					ws.send(
						JSON.stringify({ id: frame.id, result: { success: true, applied: input } }),
					);
					push();
					return;
				}
			} catch {
				/* non-RPC frame */
			}
			server.send(message);
		});

		server.onMessage((message) => {
			pageRpc.acceptServerMessage(message);
			const text = typeof message === "string" ? message : message.toString();
			try {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				// The backend's own echoes for these three would race the injection.
				if (DROPPED_BROADCASTS.some((type) => type in parsed)) return;
			} catch {
				/* non-JSON / binary frame */
			}
			ws.send(message);
		});
	});

	return {
		publish(next) {
			Object.assign(state, next);
			push();
			return Promise.resolve();
		},
		setConfigCalls: () => setConfigCalls,
	};
}

test.describe("PiP/PbP composition — feature-gated on the engine token", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser capability proof",
	);

	let wire: CompositionWire;

	test.beforeEach(async ({ page, pageRpc }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the idle cockpit",
		);
		// Installed BEFORE `goto`, like every other WS harness here: a route
		// installed after boot misses the initial-state push it has to drop.
		wire = await installCompositionWire(page, pageRpc);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	test("token present — the card renders, and filling it in sends `composition`", async ({
		page,
	}) => {
		await wire.publish({
			capabilities: capsWith(["composition"]),
			config: { ...BASE_CONFIG },
		});

		const card = page.getByTestId("composition-card");
		await expect(card).toBeVisible();

		// Six preset nicks are the whole offering — `custom` is deliberately not on
		// the wire, so it must not be offered as a seventh.
		await page.getByTestId("composition-enable").click();
		const layouts = page.getByTestId("composition-layout-selector");
		await expect(layouts).toBeVisible();
		await expect(layouts.getByRole("radio")).toHaveCount(6);
		await expect(page.getByTestId("composition-layout-custom")).toHaveCount(0);

		// The secondary picker is seeded from the capture list, not invented.
		await expect(page.getByTestId("composition-secondary")).toContainText(
			"QA Secondary Cam",
		);

		await page.getByTestId("composition-layout-pbp-left-right").click();
		await expect(
			page.getByTestId("composition-layout-pbp-left-right"),
		).toHaveAttribute("aria-checked", "true");

		const written = wire
			.setConfigCalls()
			.map((input) => input.composition)
			.filter((c): c is Record<string, unknown> => c != null);

		expect(written.length).toBeGreaterThan(0);
		expect(written.at(-1)).toMatchObject({
			secondary_input_id: "/dev/video1",
			layout: "pbp-left-right",
		});
	});

	test("token absent — the card is completely absent, and a stale config says so", async ({
		page,
	}) => {
		// An engine that advertises OTHER features but not `composition`: the gate
		// is the token, never the presence of the array.
		await wire.publish({
			capabilities: capsWith(["video-passthrough", "input-mode"]),
			config: { ...BASE_CONFIG, composition: SAVED_COMPOSITION },
		});

		await expect(page.getByTestId("idle-cockpit")).toBeVisible();

		// The saved setup is neither silently applied nor silently kept.
		const notice = page.getByTestId("composition-stale-notice");
		await expect(notice).toBeVisible();
		await expect(notice).toHaveAttribute("role", "status");

		// ABSENT, not disabled — the whole subtree, not merely the toggle.
		await expect(page.getByTestId("composition-card")).toHaveCount(0);
		await expect(page.getByTestId("composition-enable")).toHaveCount(0);
		await expect(page.getByTestId("composition-layout-selector")).toHaveCount(0);
	});
});
