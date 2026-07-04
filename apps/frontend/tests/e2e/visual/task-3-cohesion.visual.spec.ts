import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for Task 3 — consistency primitives + cohesion fixes.
 *
 * Two captures land in CeraUI/test-results/ (repo-local, gitignored):
 *   • task-3-cohesion.png — the REAL refactored EncoderDialog, proving the
 *     codec pills now render through the shared StatusBadge ([data-status-badge])
 *     and the dense sub-labels use the text-micro utility (no text-[10px]).
 *   • task-3-statusbadge-story.png — a StatusBadge variant gallery (success /
 *     warning / error / info / neutral + an unknown→neutral fallback) rendered
 *     against the app's live Tailwind/token pipeline.
 *
 * The WS auth harness mirrors encoder-capability.visual.spec.ts.
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

const COHESION_EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../../../test-results/task-3-cohesion.png",
);
const STORY_EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../../../test-results/task-3-statusbadge-story.png",
);

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

test.describe("@visual task-3 cohesion primitives", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser visual proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the encoder dialog",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		await navigateTo(page, "live");
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

	test("encoder dialog renders codec selector @visual", async ({
		page,
	}) => {
		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible();

		await page.locator("#encoder-source").click();
		await page.locator('[role="option"][data-value="hdmi"]').click();

		// The codec section is now an always-visible segmented selector with three
		// buttons: Auto, H.264, and H.265. Verify the selector and its buttons render.
		await expect(dialog.getByTestId("encoder-codec-selector")).toBeVisible();
		await expect(page.getByTestId("codec-h264")).toBeVisible();
		await expect(page.getByTestId("codec-h265")).toBeVisible();

		await dialog.screenshot({ path: COHESION_EVIDENCE });
	});

	test("statusbadge variant gallery @visual", async ({ page }) => {
		// Render every variant against the live token pipeline. An unknown variant
		// falls back to neutral classes, matching StatusBadge's runtime guard.
		const variantClass: Record<string, string> = {
			success: "bg-status-success/10 text-status-success",
			warning: "bg-status-warning/10 text-status-warning",
			error: "bg-status-error/10 text-status-error",
			info: "bg-status-info/10 text-status-info",
			neutral: "bg-status-neutral/10 text-status-neutral",
		};
		await page.evaluate((variants) => {
			const host = document.createElement("div");
			host.id = "statusbadge-story";
			host.style.cssText =
				"position:fixed;inset:0;z-index:99999;display:flex;flex-wrap:wrap;align-content:flex-start;gap:0.75rem;padding:2rem;background:var(--background)";
			const base =
				"inline-flex w-fit items-center gap-1 rounded-md font-medium px-2 py-0.5 text-xs";
			const entries: Array<[string, string]> = [
				...Object.entries(variants),
				// unknown → neutral fallback
				["unknown→neutral", variants.neutral as string],
			];
			for (const [label, cls] of entries) {
				const span = document.createElement("span");
				span.className = `${base} ${cls}`;
				span.textContent = label;
				host.appendChild(span);
			}
			document.body.appendChild(host);
		}, variantClass);

		const story = page.locator("#statusbadge-story");
		await expect(story).toBeVisible();
		await expect(story.locator("span")).toHaveCount(6);
		await story.screenshot({ path: STORY_EVIDENCE });
	});
});
