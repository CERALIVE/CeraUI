import type { Locator, Page } from "@playwright/test";

import { type BackendRpc, expect, test } from "./fixtures/index.js";
import { runAxe } from "./helpers/axe.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * The Audio card's mixer, against the mock engine.
 *
 * `caps-full` advertises `audio_mix` (4 inputs, 4 tracks, -60..12 dB, 2000 ms)
 * and three audio devices; the backend also lists the sound cards of the host
 * it runs on, so strips are counted against its own list. (`audio-mixer-absent.spec.ts` covers `multi-modem-wifi`,
 * which advertises no mix; a scenario is per worker, so per file). The page's
 * socket is proxied, never rewritten, so every save and every live change
 * reaches the real mock backend and its mock engine. The proxy only records
 * the RPC frames, injects the bridged `audio-level` frames the mock does not
 * publish on the main socket (its meter bridge is skipped under mocks), and
 * forces one backend refusal where a scenario needs it.
 */

interface RpcCall {
	path: string;
	input: Record<string, unknown>;
	result?: Record<string, unknown>;
}

interface MixerWire {
	calls(path: string): RpcCall[];
	inject(frame: Record<string, unknown>): void;
	/** Answer the next audio_inputs saves with this backend token instead. */
	refuseAudioInputs(token: string | null): void;
	/** Hold every device frame this long before the page sees it, in order; 0 stops. */
	delayServer(ms: number): void;
}

async function installMixerWire(
	page: Page,
	pageRpc: {
		bindConnectionLifecycle(browser: unknown, server: unknown): void;
		acceptServerMessage(message: string | Buffer): void;
	},
): Promise<MixerWire> {
	const byId = new Map<unknown, RpcCall>();
	const all: RpcCall[] = [];
	let refusal: string | null = null;
	let route: { send: (data: string) => void } | null = null;
	let delayMs = 0;
	let held = 0;
	let tail: Promise<void> = Promise.resolve();

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
				if (Array.isArray(frame.path) && frame.id !== undefined) {
					const call: RpcCall = { path: frame.path.join("."), input: frame.input ?? {} };
					all.push(call);
					byId.set(frame.id, call);
					if (call.path === "streaming.setConfig" && refusal !== null && "audio_inputs" in call.input) {
						call.result = { success: false, error: refusal, applied: {} };
						ws.send(JSON.stringify({ id: frame.id, result: call.result }));
						return;
					}
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
				const frame = JSON.parse(text) as { id?: unknown; result?: Record<string, unknown> };
				const call = frame.id === undefined ? undefined : byId.get(frame.id);
				if (call) call.result = frame.result;
			} catch {
				/* non-JSON / binary frame */
			}
			if (delayMs === 0 && held === 0) {
				ws.send(message);
				return;
			}
			const due = Date.now() + delayMs;
			held += 1;
			tail = tail.then(async () => {
				const wait = due - Date.now();
				if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
				ws.send(message);
				held -= 1;
			});
		});
	});

	return {
		calls: (path) => all.filter((call) => call.path === path),
		inject: (frame) => route?.send(JSON.stringify(frame)),
		refuseAudioInputs: (token) => {
			refusal = token;
		},
		delayServer: (ms) => {
			delayMs = ms;
		},
	};
}

const MAIN = "RØDE AI-Micro";
const SECOND = "Elgato Wave:3";

const strips = (scope: Page | Locator) => scope.locator("[data-audio-strip]");

// The selectable devices the backend lists: caps-full's three, plus any sound
// card of the host running the mock, so the strip count is the backend's own.
async function selectableDevices(backendRpc: BackendRpc): Promise<string[]> {
	const status = await backendRpc.call<{
		audio_sources?: Array<{ id: string; kind: string; unavailable_reason?: string }>;
	}>(["status", "getStatus"]);
	const ids = (status.audio_sources ?? [])
		.filter((source) => source.kind === "device" && source.unavailable_reason === undefined)
		.map((source) => source.id);
	expect(ids).toEqual(expect.arrayContaining([MAIN, SECOND, "HDMI Input"]));
	return ids;
}
const stripOf = (scope: Page | Locator, id: string) => scope.getByTestId(`audio-strip-${id}`);

async function openLive(page: Page): Promise<void> {
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "live");
}

test.use({ backendScenario: "caps-full" });

test.describe("audio mixer — caps-full", () => {
	let wire: MixerWire;

	test.beforeEach(async ({ page, pageRpc, backendRpc }) => {
		// A known main input, a capture source and a destination, so Start is ready
		// whatever config the worker backend was seeded with.
		await backendRpc.call(["streaming", "setConfig"], {
			asrc: MAIN,
			source: "usb",
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
		});
		wire = await installMixerWire(page, pageRpc);
		await openLive(page);
	});

	test("idle: one strip per audio device under the picker, the main one carrying today's meter", async ({
		page,
		backendRpc,
	}) => {
		const card = page.getByTestId("idle-cockpit").getByTestId("audio-card");
		const mixer = card.getByTestId("audio-mixer");
		await expect(mixer).toBeVisible();
		const devices = await selectableDevices(backendRpc);
		await expect(strips(mixer)).toHaveCount(devices.length);
		for (const id of devices) await expect(stripOf(mixer, id)).toBeVisible();
		await expect(card.getByTestId("source-audio")).toBeVisible();
		await expect(card.getByTestId("live-audio-meter")).toHaveCount(1);
		await expect(stripOf(mixer, MAIN).getByTestId("live-audio-meter")).toBeVisible();
		await expect(page.getByTestId(`audio-strip-enable-${MAIN}`)).toBeDisabled();
		await expect(page.getByTestId(`audio-strip-enable-${MAIN}`)).toHaveAttribute("aria-checked", "true");
		await expect(mixer.getByTestId("audio-mixer-track-hint")).toContainText("Track 1");

		expect(await runAxe(page, { include: ['[data-testid="audio-card"]'] })).toEqual([]);
	});

	test("after Start with two inputs saved, the strips are in the live cockpit and a level change reaches the mock engine", async ({
		page,
		backendRpc,
	}) => {
		await page.getByTestId(`audio-strip-enable-${SECOND}`).click();
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		await page.getByTestId(`audio-strip-track-${SECOND}-2`).click();
		await expect(page.getByTestId(`audio-strip-track-${SECOND}-2`)).toHaveAttribute("aria-pressed", "true");
		await page.getByTestId(`audio-strip-track-${SECOND}-1`).click();
		await expect(page.getByTestId(`audio-strip-track-${SECOND}-1`)).toHaveAttribute("aria-pressed", "false");

		const saved = await backendRpc.call<{ audio_inputs?: Array<Record<string, unknown>> }>([
			"streaming",
			"getConfig",
		]);
		expect(saved.audio_inputs).toEqual([
			{ id: MAIN, tracks: [1], gain_db: 0, mute: false, delay_ms: 0 },
			{ id: SECOND, tracks: [2], gain_db: 0, mute: false, delay_ms: 0 },
		]);

		await page.getByTestId("live-bar").getByRole("button", { name: "Start stream" }).click();
		const cockpit = page.getByTestId("live-cockpit");
		await expect(cockpit).toBeVisible({ timeout: 15_000 });
		const card = cockpit.getByTestId("audio-card");
		await expect(strips(card)).toHaveCount((await selectableDevices(backendRpc)).length);
		await expect(card.getByTestId("audio-mixer-next-start")).toBeVisible();
		await expect(page.getByTestId(`audio-strip-track-${SECOND}-2`)).toBeDisabled();
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toBeDisabled();

		const thumb = page.getByTestId(`audio-strip-gain-${SECOND}`).getByRole("slider");
		await expect(thumb).toBeEnabled();
		await thumb.focus();
		await thumb.press("ArrowLeft");

		await expect.poll(() => wire.calls("streaming.setAudioMix").at(-1)?.result).toMatchObject({
			success: true,
			applies_next_start: false,
			applied: { id: SECOND, gain_db: -1 },
		});
		expect(wire.calls("streaming.setAudioMix").map((call) => call.input)).toEqual([
			{ id: SECOND, gain_db: -1 },
		]);
		expect(
			wire.calls("streaming.setConfig").filter((call) => "audio_inputs" in call.input),
		).toHaveLength(3);
		await expect(thumb).toHaveAttribute("aria-valuenow", "-1");

		// The mock publishes no level on the main socket: inject the bridge's frame,
		// which names inputs by CeraUI id, and only that input's meter moves.
		wire.inject({
			"audio-level": {
				source: { owner: "streaming" },
				channels: 2,
				rms_db: [-24, -24],
				peak_db: [-20, -20],
				inputs: [
					{ input_id: MAIN, channels: 2, rms_db: [-1e6, -1e6], peak_db: [-1e6, -1e6] },
					{ input_id: SECOND, channels: 2, rms_db: [-25, -25], peak_db: [-21, -21] },
				],
			},
		});
		await expect(stripOf(card, SECOND).getByTestId("audio-level-meter")).toHaveAttribute("data-silent", "false");
		await expect(stripOf(card, MAIN).getByTestId("audio-level-meter")).toHaveAttribute("data-silent", "true");

		expect(await runAxe(page, { include: ['[data-testid="audio-card"]'] })).toEqual([]);

		await page.getByTestId("live-bar").getByRole("button", { name: "Stop stream" }).click();
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
	});

	test("a save the backend refuses shows its reason beside the strip and leaves the chips as they were", async ({
		page,
	}) => {
		await page.getByTestId(`audio-strip-enable-${SECOND}`).click();
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");

		wire.refuseAudioInputs("audio_tracks_gap");
		await page.getByTestId(`audio-strip-track-${SECOND}-2`).click();

		const error = page.getByTestId(`audio-strip-error-${SECOND}`);
		await expect(error).toContainText("Use tracks in order from Track 1");
		await expect(error).not.toContainText("audio_tracks_gap");
		await expect(page.getByTestId(`audio-strip-track-${SECOND}-2`)).toHaveAttribute("aria-pressed", "false");
		await expect(page.getByTestId(`audio-strip-track-${SECOND}-1`)).toHaveAttribute("aria-pressed", "true");
	});

	test("touch mode at the kiosk size: every mixer control is at least 44 px with room between chips", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1024, height: 600 });
		// The layout mode must be set before first paint, so load with it.
		await page.goto("/?mode=touch");
		await ensureAuthenticated(page);
		await expect(page.locator("html")).toHaveAttribute("data-layout-mode", "touch");
		await navigateTo(page, "live");

		const targets = [
			page.getByTestId(`audio-strip-gain-reset-${MAIN}`),
			page.getByTestId(`audio-strip-mute-${MAIN}`),
			page.getByTestId(`audio-strip-delay-${MAIN}`),
			...[1, 2, 3, 4].map((n) => page.getByTestId(`audio-strip-track-${MAIN}-${n}`)),
		];
		for (const target of targets) {
			const box = await target.boundingBox();
			expect(box, "rendered").not.toBeNull();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
			if (!(await target.evaluate((el) => el.tagName === "INPUT"))) {
				expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
			}
		}
		const first = await page.getByTestId(`audio-strip-track-${MAIN}-1`).boundingBox();
		const second = await page.getByTestId(`audio-strip-track-${MAIN}-2`).boundingBox();
		expect(Math.abs((second?.x ?? 0) - ((first?.x ?? 0) + (first?.width ?? 0)))).toBeGreaterThanOrEqual(8);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
	});

	test("a chip that would leave an input with no track is refused on screen and never sent", async ({ page }) => {
		const before = wire.calls("streaming.setConfig").length;
		await page.getByTestId(`audio-strip-track-${MAIN}-1`).click();
		await expect(page.getByTestId(`audio-strip-error-${MAIN}`)).toContainText(
			"Every input needs at least one track.",
		);
		await expect(page.getByTestId(`audio-strip-track-${MAIN}-1`)).toHaveAttribute("aria-pressed", "true");
		expect(wire.calls("streaming.setConfig")).toHaveLength(before);
	});

	test("picking a main input outside the saved mix saves it first on Track 1, and live its level change is applied", async ({
		page,
		backendRpc,
	}) => {
		const THIRD = "HDMI Input";
		expect(await selectableDevices(backendRpc)).toContain(THIRD);
		const saved = [
			{ id: MAIN, tracks: [1], gain_db: 0, mute: false, delay_ms: 0 },
			{ id: SECOND, tracks: [2], gain_db: 0, mute: false, delay_ms: 0 },
		];
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: saved });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");

		await page.getByTestId("audio-source-select").click();
		await page.getByRole("option", { name: /HDMI Input/ }).click();
		await expect
			.poll(() => backendRpc.call<{ asrc?: string; audio_inputs?: unknown[] }>(["streaming", "getConfig"]))
			.toMatchObject({
				asrc: THIRD,
				audio_inputs: [{ id: THIRD, tracks: [1], gain_db: 0, mute: false, delay_ms: 0 }, ...saved],
			});
		await expect(page.getByTestId(`audio-strip-enable-${THIRD}`)).toBeDisabled();
		await expect(page.getByTestId(`audio-strip-enable-${MAIN}`)).toBeEnabled();
		await expect(page.getByTestId(`audio-strip-enable-${MAIN}`)).toHaveAttribute("aria-checked", "true");

		await page.getByTestId("live-bar").getByRole("button", { name: "Start stream" }).click();
		const card = page.getByTestId("live-cockpit").getByTestId("audio-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		const thumb = card.getByTestId(`audio-strip-gain-${THIRD}`).getByRole("slider");
		await expect(thumb).toBeEnabled();
		await thumb.focus();
		await thumb.press("ArrowLeft");
		await expect.poll(() => wire.calls("streaming.setAudioMix").at(-1)?.result).toMatchObject({
			success: true,
			applies_next_start: false,
			applied: { id: THIRD, gain_db: -1 },
		});
		await expect(card.getByTestId(`audio-strip-error-${THIRD}`)).toBeEmpty();

		await page.getByTestId("live-bar").getByRole("button", { name: "Stop stream" }).click();
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});
	const THIRD = "HDMI Input";
	const savedTwo = [
		{ id: MAIN, tracks: [1], gain_db: 0, mute: false, delay_ms: 0 },
		{ id: SECOND, tracks: [2], gain_db: 0, mute: false, delay_ms: 0 },
	];
	const startButton = (page: Page) => page.getByTestId("live-bar").getByRole("button", { name: "Start stream" });

	async function pickThird(page: Page): Promise<void> {
		await page.getByTestId("audio-source-select").click();
		await page.getByRole("option", { name: /HDMI Input/ }).click();
	}

	// Live, the new main input's level change is admitted by the session Start launched.
	async function thirdGainIsAdmittedLive(page: Page): Promise<void> {
		const card = page.getByTestId("live-cockpit").getByTestId("audio-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		const thumb = card.getByTestId(`audio-strip-gain-${THIRD}`).getByRole("slider");
		await expect(thumb).toBeEnabled();
		await thumb.focus();
		await thumb.press("ArrowLeft");
		await expect.poll(() => wire.calls("streaming.setAudioMix").at(-1)?.result).toMatchObject({
			success: true,
			applies_next_start: false,
			applied: { id: THIRD, gain_db: -1 },
		});
		await expect(card.getByTestId(`audio-strip-error-${THIRD}`)).toBeEmpty();
		await page.getByTestId("live-bar").getByRole("button", { name: "Stop stream" }).click();
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
	}

	test("Start pressed right after picking a main input outside the saved mix sends it first and admits its live level", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		await pickThird(page);
		await startButton(page).click();
		await thirdGainIsAdmittedLive(page);
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("Start pressed while every device answer is held 300 ms, in order, still sends the new main input first", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		wire.delayServer(300);
		await pickThird(page);
		await startButton(page).click();
		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 15_000 });
		wire.delayServer(0);
		await thirdGainIsAdmittedLive(page);
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("opening Live with a saved mix that lacks the main input saves nothing, and Start still sends it first", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { asrc: THIRD, audio_inputs: savedTwo });
		await openLive(page);
		await expect(page.getByTestId(`audio-strip-enable-${THIRD}`)).toHaveAttribute("aria-checked", "true");
		await expect(page.getByTestId(`audio-strip-enable-${MAIN}`)).toHaveAttribute("aria-checked", "true");
		await startButton(page).click();
		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 15_000 });
		expect(wire.calls("streaming.setConfig").filter((call) => "audio_inputs" in call.input)).toEqual([]);
		expect(
			(await backendRpc.call<{ audio_inputs?: unknown[] }>(["streaming", "getConfig"])).audio_inputs,
		).toEqual(savedTwo);
		await thirdGainIsAdmittedLive(page);
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("a pick whose mix the device refuses still saves the pick, and Start still sends the new main input first", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		wire.refuseAudioInputs("audio_input_unknown");
		await pickThird(page);
		await expect
			.poll(() => backendRpc.call<{ asrc?: string; audio_inputs?: unknown[] }>(["streaming", "getConfig"]))
			.toMatchObject({ asrc: THIRD, audio_inputs: savedTwo });
		wire.refuseAudioInputs(null);
		await startButton(page).click();
		await thirdGainIsAdmittedLive(page);
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});
});
