import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "../helpers/index.js";

/**
 * Mode-preset-led EncoderDialog, end-to-end (@visual — produces the Task-7
 * evidence screenshot, so it lives under tests/e2e/visual and is excluded from
 * the functional `--grep-invert @visual` run).
 *
 * It drives the REAL refactored EncoderDialog against a deterministic capability
 * snapshot injected over the dev `pipelines` broadcast: a `generic` (software,
 * 1080p ceiling) board with an override-capable HDMI source. With presets
 * leading, the dialog must then:
 *   • render the 4K / H.265 preset DISABLED with aria-disabled + a "not
 *     supported" reason tooltip — never hidden;
 *   • apply a universal H.264 preset on click: the card becomes the active
 *     (phosphor-lime) selection and the field-sync indicator confirms it;
 *   • keep the full granular controls reachable under the Advanced / Custom
 *     expander.
 *
 * Auth + injection reuse the field-lock / encoder-capability WebSocket harness.
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(
		import.meta.dirname,
		"../../../../backend/auth_tokens.json",
	);
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
	).filter((key) => key !== "placeholder");
	if (tokens.length === 0) {
		throw new Error(`No persistent auth tokens in ${tokensPath}`);
	}
	return tokens[0] as string;
})();

const GENERIC_PIPELINES = {
	hardware: "generic",
	pipelines: {
		hdmi: {
			name: "HDMI Capture",
			description: "Deterministic capability fixture",
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
			defaultResolution: "1080p",
			defaultFramerate: 30,
		},
	},
};

function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;
	w.__cera = {
		socket: null,
		_seq: 0,
		emit(type: string, payload: unknown) {
			const s = w.__cera.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `emit-${++w.__cera._seq}`,
						path: ["dev", "emit"],
						input: { type, payload },
					}),
				);
		},
	};
	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__cera.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}
		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				if (Array.isArray(msg.path) && msg.path.join(".") === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}
			} catch {
				/* non-RPC frame */
			}
			return this.__realSend(data);
		}
	}
	w.WebSocket = HookedWS;
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* storage unavailable */
	}
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) =>
			(
				window as { __cera: { emit: (t: string, p: unknown) => void } }
			).__cera.emit(t, p),
		[type, payload] as const,
	);
}

function presetCard(page: Page, id: string) {
	return page.locator(`[data-testid="mode-preset"][data-preset-id="${id}"]`);
}

test.describe("@visual mode-preset-led encoder dialog", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser capability proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the encoder dialog",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		await navigateTo(page, "live");
		// Inject a server config (leaves the Live empty state so the encoder edit
		// row renders) + the deterministic capability snapshot. Re-emit until they
		// land — post-login the backend pushes its own snapshots once.
		await expect
			.poll(
				async () => {
					await emit(page, "config", {
						srtla_addr: "127.0.0.1",
						srtla_port: 5000,
						srt_streamid: "e2e",
						max_br: 5000,
					});
					await emit(page, "pipelines", GENERIC_PIPELINES);
					return page
						.getByTestId("open-encoder-dialog")
						.isVisible()
						.catch(() => false);
				},
				{ timeout: 10_000, message: "encoder edit row should be present" },
			)
			.toBe(true);
	});

	test("presets lead: a supported preset applies; the 4K/H.265 preset is disabled with a reason @visual", async ({
		page,
	}) => {
		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible();

		// Select the offered HDMI source so the offered set resolves to the board.
		await page.locator("#encoder-source").click();
		await page.locator('[role="option"][data-value="hdmi"]').click();

		// The 4K / H.265 preset is above the generic 1080p ceiling → disabled with
		// a reason tooltip, never hidden.
		const fourK = presetCard(page, "4k30-h265");
		await expect(fourK).toBeVisible();
		await expect(fourK).toBeDisabled();
		await expect(fourK).toHaveAttribute("aria-disabled", "true");
		await expect(fourK).toHaveAttribute("title", /not supported/i);
		await expect(fourK).toHaveAttribute("data-supported", "false");

		// A universal H.264 preset is selectable — apply it.
		const preset = presetCard(page, "1080p60-h264");
		await expect(preset).toBeEnabled();
		await preset.click();

		// Active (phosphor-lime) selection + field-sync applied confirmation.
		await expect(preset).toHaveAttribute("data-active", "true");
		await expect(page.getByTestId("preset-sync")).toBeVisible();

		// The full granular controls remain reachable under Advanced / Custom.
		await expect(
			page.getByTestId("encoder-advanced-summary"),
		).toBeVisible();

		await page.screenshot({ path: evidencePath("task-7-preset-apply.png") });
	});
});
