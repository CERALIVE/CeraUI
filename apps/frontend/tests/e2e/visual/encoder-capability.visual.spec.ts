import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "../fixtures/index.js";

import { evidencePath, navigateTo } from "../helpers/index.js";

/**
 * Capability-driven encoder options, end-to-end (@visual — produces evidence
 * screenshots, so it lives under tests/e2e/visual and is excluded from the
 * functional `--grep-invert @visual` run).
 *
 * It drives the REAL EncoderDialog against a deterministic capability snapshot
 * injected over the dev `sources` broadcast: a `generic` (software, 1080p
 * ceiling) board with an override-capable HDMI source, made active through
 * `config.source` (the Live Source section picks the input; the dialog only
 * reflects it). The Source section must list only the offered source(s), and the
 * dialog must then:
 *   • render 2160p / 1440p DISABLED with aria-disabled + a "not supported"
 *     reason tooltip — not hidden;
 *   • leave 1080p selectable.
 *
 * Auth + injection reuse the field-lock / input-picker WebSocket harness.
 */

const TOKEN: string = (() => {
	const tokenPath = path.resolve(
		import.meta.dirname,
		"../../../../backend/.e2e-auth-token",
	);
	let token: string;
	try {
		token = fs.readFileSync(tokenPath, "utf8").trim();
	} catch {
		throw new Error(`No persistent auth token at ${tokenPath}`);
	}
	if (token.length === 0) {
		throw new Error(`Empty persistent auth token at ${tokenPath}`);
	}
	return token;
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

// The dialog's capability axes key off the board in the `sources` snapshot and the
// source `config.source` names; this HDMI input is that source.
const GENERIC_SOURCES = {
	hardware: "generic",
	sources: [
		{
			origin: "capture",
			id: "hdmi",
			pipelineId: "hdmi",
			kind: "hdmi",
			displayName: "HDMI Capture",
			devicePath: "/dev/video0",
			modes: [
				{ width: 3840, height: 2160, framerates: [30, 60] },
				{ width: 1920, height: 1080, framerates: [30, 60] },
				{ width: 1280, height: 720, framerates: [30, 60] },
			],
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
			defaultResolution: "1080p",
			defaultFramerate: 30,
			audioKind: "selectable",
			available: true,
		},
	],
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

function resolutionOption(page: Page, value: string) {
	return page.locator(`[data-testid="resolution-option"][data-value="${value}"]`);
}

test.describe("@visual capability-driven encoder options", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser capability proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the encoder dialog dropdowns",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		await navigateTo(page, "live");
		// Inject a server config (leaves the Live empty state so the encoder edit
		// row renders) naming the active source (Edit stays disabled-with-reason
		// without one) + the deterministic capability snapshot. Re-emit until they
		// land — post-login the backend pushes its own snapshots once.
		await expect
			.poll(
				async () => {
					await emit(page, "config", {
						srtla_addr: "127.0.0.1",
						srtla_port: 5000,
						srt_streamid: "e2e",
						max_br: 5000,
						pipeline: "hdmi",
						source: "hdmi",
					});
					await emit(page, "pipelines", GENERIC_PIPELINES);
					await emit(page, "sources", GENERIC_SOURCES);
					const edit = page.getByTestId("open-encoder-dialog");
					return (await edit.isVisible()) && (await edit.isEnabled());
				},
				{
					timeout: 10_000,
					message: "encoder edit row should be present and enabled",
				},
			)
			.toBe(true);
	});

	test("incompatible resolutions render disabled with a reason; compatible ones stay selectable @visual", async ({
		page,
	}) => {
		// The Live Source section lists only the offered source, selected — capture
		// it as evidence (the dialog has no source picker since #137).
		const hdmiRow = page.getByTestId("source-row-hdmi");
		await expect(hdmiRow).toBeVisible();
		await expect(hdmiRow).toHaveAttribute("data-selected", "true");
		await page.screenshot({ path: evidencePath("encoder-source-list.png") });

		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByTestId("encoder-active-source")).toHaveAttribute(
			"data-source-id",
			"hdmi",
		);

		await page.locator("#encoder-resolution").click();

		const uhd = resolutionOption(page, "2160p");
		await expect(uhd).toBeVisible();
		await expect(uhd).toHaveAttribute("aria-disabled", "true");
		await expect(uhd).toHaveAttribute("title", /not supported/i);

		// 1440p is also above the 1080p ceiling — disabled too.
		await expect(resolutionOption(page, "1440p")).toHaveAttribute(
			"aria-disabled",
			"true",
		);

		// 1080p is within the offered set — selectable, no disabled marker.
		const fhd = resolutionOption(page, "1080p");
		await expect(fhd).toBeVisible();
		await expect(fhd).not.toHaveAttribute("aria-disabled", "true");
		await expect(fhd).not.toHaveAttribute("data-disabled", "");

		await page.screenshot({ path: evidencePath("encoder-disabled-reason.png") });
	});
});
