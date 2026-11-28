import type { Locator, Page } from "@playwright/test";

import { type BackendRpc, expect, test } from "./fixtures/index.js";
import { runAxe } from "./helpers/axe.js";
import { endStream, ensureAuthenticated, navigateTo } from "./helpers/index.js";
import { installMixerWire, type MixerWire } from "./helpers/mixer-wire.js";

/**
 * The Audio card's mixer, against the mock engine.
 *
 * `caps-full` advertises `audio_mix` (4 inputs, 4 tracks, -60..12 dB, 2000 ms)
 * and three audio devices; the backend also lists the sound cards of the host
 * it runs on, so strips are counted against its own list. (`audio-mixer-absent.spec.ts` covers `multi-modem-wifi`,
 * which advertises no mix; a scenario is per worker, so per file). The page's
 * socket is proxied, never rewritten, so every save and every live change
 * reaches the real mock backend and its mock engine. The proxy
 * (`helpers/mixer-wire.ts`) records the RPC frames, injects the bridged
 * `audio-level` frames the mock does not publish on the main socket (its meter
 * bridge is skipped under mocks), forces a backend or engine refusal where a
 * scenario needs it, and holds a live answer until the test releases it.
 */

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

	async function liveMixCard(page: Page, inputId: string): Promise<Locator> {
		const card = page.getByTestId("live-cockpit").getByTestId("audio-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		// Start mounts the cockpit optimistically; live mix readiness is a separate device fact.
		await expect
			.poll(async () => {
				const start = wire.calls("streaming.start").at(-1);
				return start?.result?.success === true && (await wire.pageHasReply(start.id));
			}, { timeout: 15_000 })
			.toBe(true);
		await expect(card.getByTestId("audio-mixer-next-start")).toBeVisible();
		await expect(stripOf(card, inputId).getByTestId("audio-level-meter")).toBeVisible();
		return card;
	}

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
		const card = await liveMixCard(page, SECOND);
		await expect(strips(card)).toHaveCount((await selectableDevices(backendRpc)).length);
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
			{ id: SECOND, include: true },
			{ id: SECOND, track: { number: 2, on: true } },
			{ id: SECOND, track: { number: 1, on: false } },
			{ id: SECOND, gain_db: -1 },
		]);
		expect(
			wire.calls("streaming.setConfig").filter((call) => "audio_inputs" in call.input),
		).toHaveLength(0);
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

		await endStream(page);
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
		const beforeMix = wire.calls("streaming.setAudioMix").length;
		await page.getByTestId(`audio-strip-track-${MAIN}-1`).click();
		await expect(page.getByTestId(`audio-strip-error-${MAIN}`)).toContainText(
			"Every input needs at least one track.",
		);
		await expect(page.getByTestId(`audio-strip-track-${MAIN}-1`)).toHaveAttribute("aria-pressed", "true");
		expect(wire.calls("streaming.setConfig")).toHaveLength(before);
		expect(wire.calls("streaming.setAudioMix")).toHaveLength(beforeMix);
	});

	test("idle mute then unmute of the main input ends unmuted once the device answers, and after a reload", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: null });
		const mute = page.getByTestId(`audio-strip-mute-${MAIN}`);
		await expect(mute).toHaveAttribute("aria-pressed", "false");
		// What the strip shows once the device's answer has settled the click, not
		// the preview it shows while that answer is on its way.
		const settled = async () => {
			const reply = wire.holdAudioMix();
			await mute.click();
			const held = await reply.held;
			reply.release();
			await wire.pageReply(held.id);
			await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
			return mute.getAttribute("aria-pressed");
		};

		expect(await settled()).toBe("true");
		// Unmuted, the main input is back at its defaults, which the device saves as no mix at all.
		expect(await settled()).toBe("false");
		expect(
			await backendRpc.call<{ audio_inputs?: unknown }>(["streaming", "getConfig"]),
		).not.toHaveProperty("audio_inputs");

		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		await expect(page.getByTestId(`audio-strip-mute-${MAIN}`)).toHaveAttribute("aria-pressed", "false");
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
		const card = await liveMixCard(page, THIRD);
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

		await endStream(page);
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
		const card = await liveMixCard(page, THIRD);
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
		await endStream(page);
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

	test("a pick retains an unplugged saved input and Start admits the new main input first", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		const setSecondAttached = (attached: boolean) =>
			backendRpc.call<{ success: boolean }>(["streaming", "setMockDeviceAttached"], {
				input_id: "audio_elgato_wave3",
				attached,
			});
		expect((await setSecondAttached(false)).success).toBe(true);
		try {
			await pickThird(page);
			await expect
				.poll(() => backendRpc.call<{ asrc?: string; audio_inputs?: unknown[] }>(["streaming", "getConfig"]))
				.toMatchObject({
					asrc: THIRD,
					audio_inputs: [{ ...savedTwo[0], id: THIRD }, ...savedTwo],
				});
			expect(wire.calls("streaming.setConfig").map(({ input }) => input)).toEqual([
				{ asrc: THIRD, audio_pick: true },
			]);
		} finally {
			expect((await setSecondAttached(true)).success).toBe(true);
		}
		await startButton(page).click();
		await thirdGainIsAdmittedLive(page);
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("an unavailable pick is not retried as an unvalidated save", async ({ page, backendRpc }) => {
		wire.refuseAudioInputs("audio_source_unavailable");
		await pickThird(page);
		await expect(page.getByText("The selected audio input is not available.", { exact: true })).toBeVisible();
		await expect(page.getByTestId("audio-source-select")).toContainText(MAIN);
		expect(wire.calls("streaming.setConfig").map((call) => call.input)).toEqual([
			{ asrc: THIRD, audio_pick: true },
		]);
		expect(await backendRpc.call(["streaming", "getConfig"])).toMatchObject({ asrc: MAIN });
	});

	const mixEntry = (id: string, tracks = [1], gain_db = 0) => ({ id, tracks, gain_db, mute: false, delay_ms: 0 });
	const savedConfig = (backendRpc: BackendRpc) =>
		backendRpc.call<{ asrc?: string; audio_inputs?: unknown[] }>(["streaming", "getConfig"]);

	test("a picker capacity refusal keeps the previous mix editable after the unplugged input returns", async ({
		page,
		backendRpc,
	}) => {
		expect(await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo })).toMatchObject({
			success: true,
		});
		const attach = (attached: boolean) =>
			backendRpc.call(["streaming", "setMockDeviceAttached"], {
				input_id: "audio_elgato_wave3",
				attached,
			});
		await attach(false);
		const second = stripOf(page, SECOND);
		await expect(second.getByRole("button", { name: `Remove ${SECOND}` })).toBeVisible();

		// The backend RPC suite exercises a real full roster; this browser fixture has three mics.
		wire.refuseAudioInputs("audio_inputs_too_many");
		await pickThird(page);
		await expect(page.getByText("The mix is full. Turn another input off first.", { exact: true })).toBeVisible();
		await expect(page.getByTestId("audio-source-select")).toContainText(MAIN);
		expect(wire.calls("streaming.setConfig").map(({ input }) => input)).toEqual([
			{ asrc: THIRD, audio_pick: true },
		]);
		wire.refuseAudioInputs(null);

		await attach(true);
		await expect(second.getByRole("switch")).toBeChecked();
		const mute = wire.nextAnswer("streaming.setAudioMix");
		await page.getByTestId(`audio-strip-mute-${MAIN}`).click();
		expect((await mute).result).toMatchObject({ success: true, applied: { id: MAIN, mute: true } });
		expect(await savedConfig(backendRpc)).toMatchObject({
			asrc: MAIN,
			audio_inputs: [{ ...savedTwo[0], mute: true }, savedTwo[1]],
		});
	});

	for (const [refusal, message] of [
		["audio_inputs_too_many", "The mix is full. Turn another input off first."],
		["audio_source_unavailable", "The selected audio input is not available."],
	] as const) {
		test(`Start waits for the pick and cancels on ${refusal}`, async ({ page, backendRpc }) => {
			const saved = [savedTwo[0], { ...savedTwo[1], tracks: [1] }];
			expect(await backendRpc.call(["streaming", "setConfig"], { audio_inputs: saved })).toMatchObject({
				success: true,
			});
			const attach = (attached: boolean) =>
				backendRpc.call(["streaming", "setMockDeviceAttached"], { input_id: "audio_elgato_wave3", attached });
			await attach(false);
			const second = stripOf(page, SECOND);
			await expect(second.getByRole("button", { name: `Remove ${SECOND}` })).toBeVisible();

			// Capacity admission itself is covered by the backend suite with a full roster.
			wire.refuseAudioInputs(refusal);
			const pick = wire.holdAudioPick(THIRD);
			await pickThird(page);
			const held = await pick.held;
			await startButton(page).click();
			expect(await wire.pageHasReply(held.id)).toBe(false);
			wire.refuseAudioInputs(null);
			pick.release();

			await expect(page.getByText(message, { exact: true })).toBeVisible();
			expect(wire.calls("streaming.start").map(({ input }) => input.asrc)).toEqual([]);
			await expect(startButton(page)).toBeEnabled();
			await expect(page.getByTestId("audio-source-select")).toContainText(MAIN);
			expect(wire.calls("streaming.setConfig").map(({ input }) => input)).toEqual([{ asrc: THIRD, audio_pick: true }]);
			expect(await savedConfig(backendRpc)).toMatchObject({ asrc: MAIN, audio_inputs: saved });

			await attach(true);
			await expect(second.getByRole("switch")).toBeChecked();
			const mute = wire.nextAnswer("streaming.setAudioMix");
			await page.getByTestId(`audio-strip-mute-${MAIN}`).click();
			expect((await mute).result).toMatchObject({ success: true, applied: { id: MAIN, mute: true } });
			expect(await savedConfig(backendRpc)).toMatchObject({
				asrc: MAIN,
				audio_inputs: [{ ...saved[0], mute: true }, saved[1]],
			});
		});

		test(`queued Start honors an intermediate ${refusal} even when the third pick saves`, async ({
			page,
			backendRpc,
		}) => {
			const main = mixEntry(MAIN, [1], -3);
			await backendRpc.call(["streaming", "setConfig"], { audio_inputs: [main] });

			const first = wire.holdAudioPick(SECOND);
			await pickDevice(page, /Elgato Wave:3/);
			const firstReply = await first.held;
			expect(firstReply.result).toMatchObject({ success: true });
			await startButton(page).click();
			await expect(page.getByTestId("live-bar")).toHaveAttribute("data-state", "pending");

			wire.refuseAudioInputs(refusal);
			const middle = wire.holdAudioPick(THIRD);
			await pickThird(page);
			const middleReply = await middle.held;
			wire.refuseAudioInputs(null);

			const last = wire.holdAudioPick(MAIN);
			await pickDevice(page, /RØDE AI-Micro/);
			const lastReply = await last.held;
			expect(lastReply.result).toMatchObject({ success: true, applied: { asrc: MAIN } });
			expect(await wire.pageHasReply(firstReply.id)).toBe(false);

			middle.release();
			await receiveReply(middleReply.id);
			await expect(page.getByText(message, { exact: true })).toBeVisible();
			last.release();
			await receiveReply(lastReply.id);
			first.release();
			await receiveReply(firstReply.id);

			await expect.soft(startButton(page)).toBeEnabled();
			expect(wire.calls("streaming.start").map(({ input }) => input.asrc)).toEqual([]);
			expect(wire.calls("streaming.setConfig").map(({ input }) => input)).toEqual([
				{ asrc: SECOND, audio_pick: true },
				{ asrc: THIRD, audio_pick: true },
				{ asrc: MAIN, audio_pick: true },
			]);
			expect(await savedConfig(backendRpc)).toMatchObject({
				asrc: MAIN,
				audio_inputs: [mixEntry(SECOND), main],
			});
			await expect(page.getByTestId("audio-source-select")).toContainText(MAIN);
		});

		test(`Start launches the new pick after an already shown ${refusal}`, async ({ page, backendRpc }) => {
			const main = mixEntry(MAIN, [1], -3);
			await backendRpc.call(["streaming", "setConfig"], { audio_inputs: [main] });

			const first = wire.holdAudioPick(SECOND);
			await pickDevice(page, /Elgato Wave:3/);
			const firstReply = await first.held;
			expect(firstReply.result).toMatchObject({ success: true });

			wire.refuseAudioInputs(refusal);
			await pickThird(page);
			await expect(page.getByText(message, { exact: true })).toBeVisible();
			wire.refuseAudioInputs(null);

			const last = wire.holdAudioPick(MAIN);
			await pickDevice(page, /RØDE AI-Micro/);
			const lastReply = await last.held;
			expect(lastReply.result).toMatchObject({ success: true, applied: { asrc: MAIN } });
			await expect(page.getByTestId("audio-source-select")).toContainText(MAIN);
			const start = wire.nextAnswer("streaming.start");
			await startButton(page).click();
			await expect(page.getByTestId("live-bar")).toHaveAttribute("data-state", "pending");
			expect(await wire.pageHasReply(firstReply.id)).toBe(false);
			expect(wire.calls("streaming.start")).toEqual([]);

			last.release();
			await receiveReply(lastReply.id);
			first.release();
			await receiveReply(firstReply.id);

			expect(await savedConfig(backendRpc)).toMatchObject({ asrc: MAIN, audio_inputs: [mixEntry(SECOND), main] });
			await expect.soft(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 10_000 });
			expect(wire.calls("streaming.start").map(({ input }) => input.asrc)).toEqual([MAIN]);
			expect(await start).toMatchObject({ input: { asrc: MAIN }, result: { success: true } });

			await endAndWait(page);
			await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
		});
	}

	async function pickDevice(page: Page, name: RegExp): Promise<void> {
		await page.getByTestId("audio-source-select").click();
		await page.getByRole("option", { name }).click();
	}

	test("two picks made before either answer arrives both stay in the mix", async ({ page, backendRpc }) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: [mixEntry(MAIN, [1], -3)] });
		await expect(page.getByTestId(`audio-strip-enable-${MAIN}`)).toBeDisabled();
		wire.delayServer(300);
		await pickDevice(page, /Elgato Wave:3/);
		await pickThird(page);
		wire.delayServer(0);
		await expect
			.poll(() => savedConfig(backendRpc))
			.toMatchObject({ asrc: THIRD, audio_inputs: [mixEntry(THIRD), mixEntry(SECOND), mixEntry(MAIN, [1], -3)] });
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("a second tab that has not heard another tab's pick keeps it when it picks", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: [mixEntry(MAIN, [1], -3)] });
		const { other, hold, release } = await openSecondTab(page, workerBackend.port);
		await expect(other.getByTestId(`audio-strip-enable-${MAIN}`)).toHaveAttribute("aria-checked", "true");
		hold();
		await pickDevice(page, /Elgato Wave:3/);
		await expect
			.poll(() => savedConfig(backendRpc))
			.toMatchObject({ asrc: SECOND, audio_inputs: [mixEntry(SECOND), mixEntry(MAIN, [1], -3)] });
		await pickDevice(other, /HDMI Input/);
		await expect
			.poll(() => savedConfig(backendRpc))
			.toMatchObject({ asrc: THIRD, audio_inputs: [mixEntry(THIRD), mixEntry(SECOND), mixEntry(MAIN, [1], -3)] });
		release();
		await other.close();
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});
	// A second tab on the same device whose device answers can be held, so its view goes stale.
	async function openSecondTab(page: Page, port: number) {
		const other = await page.context().newPage();
		let holding = false;
		const held: Array<() => void> = [];
		await other.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((message) => server.send(message));
			server.onMessage((message) => {
				if (holding) held.push(() => ws.send(message));
				else ws.send(message);
			});
		});
		await other.addInitScript((socketPort: number) => {
			(window as { __ceraSocketPort?: number }).__ceraSocketPort = socketPort;
		}, port);
		await openLive(other);
		return {
			other,
			hold: () => {
				holding = true;
			},
			release: () => {
				holding = false;
				for (const send of held.splice(0)) send();
			},
		};
	}

	test("pick B, edit A, pick C before any answer arrives: the saved and running mix is C, B and A at -3 dB", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: [mixEntry(MAIN, [1], -2)] });
		const mainGain = page.getByTestId(`audio-strip-gain-${MAIN}`).getByRole("slider");
		await expect(mainGain).toHaveAttribute("aria-valuenow", "-2");
		wire.delayServer(300);
		await pickDevice(page, /Elgato Wave:3/);
		await mainGain.focus();
		await mainGain.press("ArrowLeft");
		await pickThird(page);
		wire.delayServer(0);
		await expect
			.poll(() => savedConfig(backendRpc))
			.toMatchObject({ asrc: THIRD, audio_inputs: [mixEntry(THIRD), mixEntry(SECOND), mixEntry(MAIN, [1], -3)] });
		await startButton(page).click();
		const card = await liveMixCard(page, MAIN);
		await expect(card.getByTestId(`audio-strip-gain-${MAIN}`).getByRole("slider")).toHaveAttribute(
			"aria-valuenow",
			"-3",
		);
		// Every input is in the running session: each admits a live level change.
		for (const [id, level] of [
			[THIRD, 0],
			[SECOND, 0],
			[MAIN, -3],
		] as const) {
			const thumb = card.getByTestId(`audio-strip-gain-${id}`).getByRole("slider");
			await thumb.focus();
			await thumb.press("ArrowLeft");
			await expect.poll(() => wire.calls("streaming.setAudioMix").at(-1)?.result).toMatchObject({
				success: true,
				applies_next_start: false,
				applied: { id, gain_db: level - 1 },
			});
		}
		await endStream(page);
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("a stale second tab's level edit keeps the input another tab picked", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: [mixEntry(MAIN, [1], -2)] });
		const { other, hold, release } = await openSecondTab(page, workerBackend.port);
		const otherGain = other.getByTestId(`audio-strip-gain-${MAIN}`).getByRole("slider");
		await expect(otherGain).toHaveAttribute("aria-valuenow", "-2");
		hold();
		await pickDevice(page, /Elgato Wave:3/);
		await expect
			.poll(() => savedConfig(backendRpc))
			.toMatchObject({ asrc: SECOND, audio_inputs: [mixEntry(SECOND), mixEntry(MAIN, [1], -2)] });
		await otherGain.focus();
		await otherGain.press("ArrowLeft");
		await expect
			.poll(() => savedConfig(backendRpc))
			.toMatchObject({ asrc: SECOND, audio_inputs: [mixEntry(SECOND), mixEntry(MAIN, [1], -3)] });
		release();
		await other.close();
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("five rapid live Mute clicks settle on the last choice with replies held", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		await startButton(page).click();
		const card = await liveMixCard(page, SECOND);
		const mute = card.getByTestId(`audio-strip-mute-${SECOND}`);
		await expect(mute).toHaveAttribute("aria-pressed", "false");
		const before = (await workerBackend.mockEngine()).audioInputs;
		const holds = Array.from({ length: 5 }, () => wire.holdAudioMix());

		// No socket frame (reply or echo) can interleave with this burst of clicks.
		await mute.evaluate((button: HTMLButtonElement) => {
			for (let i = 0; i < 5; i++) button.click();
		});
		try {
			const calls = await test.step("the mock answers all five writes", () =>
				Promise.all(holds.map(({ held }) => held)), { timeout: 10_000 });
			expect(calls.map(({ input }) => input)).toEqual(
				[true, false, true, false, true].map((mute) => ({ id: SECOND, mute })),
			);
			expect(before).toHaveLength(2);
			expect((await workerBackend.mockEngine()).audioInputs).toEqual(
				before.map((input, index) => index === 1 ? { ...input, mute: true } : input),
			);
			for (const [index, hold] of holds.entries()) {
				const delivered = wire.pageReply(calls[index]?.id);
				hold.release();
				await delivered;
			}
			await expect(mute).toHaveAttribute("aria-pressed", "true");
			await expect(card.getByTestId(`audio-strip-error-${SECOND}`)).toBeEmpty();
		} finally {
			for (const hold of holds) hold.release();
		}
		await endStream(page);
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: null });
	});

	test("a live mute whose answer is held shows the device's echo while held, and settles once released", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		await startButton(page).click();
		const card = await liveMixCard(page, SECOND);
		const mute = card.getByTestId(`audio-strip-mute-${SECOND}`);
		await expect(mute).toHaveAttribute("aria-pressed", "false");
		const savedMute = async () =>
			(
				await backendRpc.call<{ audio_inputs?: Array<{ id: string; mute: boolean }> }>(["streaming", "getConfig"])
			).audio_inputs?.find((input) => input.id === SECOND)?.mute;

		const reply = wire.holdAudioMix();
		await mute.click();
		const held = await reply.held;
		// The device applied the change on arrival and answered; the page has not seen that answer.
		expect(held.input).toEqual({ id: SECOND, mute: true });
		expect(held.result).toMatchObject({ success: true, applies_next_start: false, applied: { id: SECOND, mute: true } });
		expect(await savedMute()).toBe(true);
		// While the answer is held, the strip shows the device's saved echo and nothing is refused.
		await expect(mute).toHaveAttribute("aria-pressed", "true");
		await expect(card.getByTestId(`audio-strip-error-${SECOND}`)).toBeEmpty();
		// The strip drops a successful answer its config echo overtook, so the page's own
		// socket is the witness: it has not received this call's answer.
		expect(await wire.pageHasReply(held.id)).toBe(false);

		reply.release();
		const delivered = await test.step(
			"the page's socket receives the released answer",
			() => wire.pageReply(held.id),
			{ timeout: 10_000 },
		);
		expect(delivered.id).toBe(held.id);
		expect(delivered.result).toEqual(held.result);
		// Settled: the next press starts from the muted state and its answer arrives unheld.
		await mute.click();
		await expect(mute).toHaveAttribute("aria-pressed", "false");
		await expect(card.getByTestId(`audio-strip-error-${SECOND}`)).toBeEmpty();
		expect(wire.calls("streaming.setAudioMix").map((call) => call.input)).toEqual([
			{ id: SECOND, mute: true },
			{ id: SECOND, mute: false },
		]);
		expect(await savedMute()).toBe(false);

		await endStream(page);
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("a live mute the engine refuses with its own token shows the plain refusal and changes nothing", async ({
		page,
		backendRpc,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		await startButton(page).click();
		const card = await liveMixCard(page, SECOND);
		const mute = card.getByTestId(`audio-strip-mute-${SECOND}`);
		await expect(mute).toHaveAttribute("aria-pressed", "false");

		wire.refuseAudioMixWithEngineToken("audio-mix-inactive");
		await mute.click();
		const error = card.getByTestId(`audio-strip-error-${SECOND}`);
		await expect(error).toContainText("The device refused this change, so nothing changed.");
		await expect(error).not.toContainText("audio-mix-inactive");
		await expect(mute).toHaveAttribute("aria-pressed", "false");
		const calls = wire.calls("streaming.setAudioMix");
		expect(calls.map((call) => call.input)).toEqual([{ id: SECOND, mute: true }]);
		const id = calls[0]?.id;
		// The engine's refusal is the very frame the page's own socket received for that call.
		const received = await test.step(
			"the page's socket receives the refusal for that call",
			() => wire.pageReply(id),
			{ timeout: 10_000 },
		);
		expect(received).toEqual({
			id,
			result: {
				success: false,
				error: "cerastream.params.invalid",
				engine_error: {
					code: -32602,
					message: "invalid params: audio-mix-inactive: invalid audio mix configuration",
					data: { code: "cerastream.params.invalid" },
				},
			},
		});
		const saved = await backendRpc.call<{ audio_inputs?: Array<{ id: string; mute: boolean }> }>([
			"streaming",
			"getConfig",
		]);
		expect(saved.audio_inputs?.find((input) => input.id === SECOND)?.mute).toBe(false);

		wire.refuseAudioMixWithEngineToken(null);
		await endStream(page);
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	const chooseAudio = async (page: Page, name: string | RegExp) => {
		await page.getByTestId("audio-source-select").click();
		await page.getByRole("option", typeof name === "string" ? { name, exact: true } : { name }).click();
	};
	const receiveReply = (id: unknown) =>
		test.step("the page's socket receives the answer to that save", () => wire.pageReply(id), { timeout: 10_000 });

	async function pressStart(page: Page): Promise<void> {
		const answer = wire.nextAnswer("streaming.start");
		await startButton(page).click();
		expect((await answer).result).toMatchObject({ success: true });
	}

	async function endAndWait(page: Page): Promise<void> {
		await endStream(page);
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
	}

	test("an unplugged saved input stays visible while another input is muted and Start succeeds", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		const secondary = stripOf(page, SECOND);
		const include = wire.nextAnswer("streaming.setAudioMix");
		await secondary.getByRole("switch").click();
		expect((await include).result?.success).toBe(true);
		await expect(secondary.getByRole("switch")).toBeChecked();
		const attach = (attached: boolean) =>
			backendRpc.call(["streaming", "setMockDeviceAttached"], {
				input_id: "audio_elgato_wave3",
				attached,
			});
		try {
			await attach(false);
			await expect(secondary.getByText("Unplugged", { exact: true })).toBeVisible();
			const remove = secondary.getByRole("button", { name: `Remove ${SECOND}` });
			await remove.evaluate((button) => button.scrollIntoView({ block: "center" }));
			await expect(remove).toBeInViewport();
			await expect(remove).toBeEnabled();
			const mute = wire.nextAnswer("streaming.setAudioMix");
			await page.getByTestId(`audio-strip-mute-${MAIN}`).click();
			expect((await mute).result).toMatchObject({ success: true, applied: { id: MAIN, mute: true } });
			await pressStart(page);
			await expect(page.getByTestId("live-cockpit").getByText("Unplugged", { exact: true })).toBeVisible();
			expect((await workerBackend.mockEngine()).lastStartParams?.audio).toMatchObject({
				mode: "default",
				inputs: [{ input_id: "audio_rode_ai_micro", tracks: [1], mute: true }],
			});
			await endAndWait(page);
		} finally {
			await attach(true);
			await backendRpc.call(["streaming", "setConfig"], { audio_inputs: null });
		}
	});

	test("unplugging the sole saved microphone leaves Start enabled and shows typed recovery", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		const saved = [{ id: MAIN, tracks: [1], gain_db: -3, mute: false, delay_ms: 0 }];
		expect(await backendRpc.call(["streaming", "setConfig"], { audio_inputs: saved })).toMatchObject({
			success: true,
		});
		await expect(page.getByTestId(`audio-strip-gain-${MAIN}`).getByRole("slider")).toHaveAttribute("aria-valuenow", "-3");
		await backendRpc.call(["streaming", "setMockDeviceAttached"], {
			input_id: "audio_rode_ai_micro",
			attached: false,
		});
		await expect(stripOf(page, MAIN).getByRole("button", { name: `Remove ${MAIN}` })).toBeVisible();

		const button = startButton(page);
		await expect(button).toBeEnabled();
		const answer = wire.nextAnswer("streaming.start");
		await button.click();
		expect((await answer).result).toMatchObject({
			success: false,
			failure: { class: "audio_source_unavailable" },
		});
		const recovery = page.locator("[data-sonner-toast]").filter({ hasText: /selected audio input is not available/i });
		await expect(recovery.getByRole("button", { name: "View logs", exact: true })).toBeVisible();
		expect(await workerBackend.mockEngine()).toMatchObject({
			streaming: false,
			audioInputs: [],
		});
		expect(await backendRpc.call(["streaming", "getConfig"])).toMatchObject({
			asrc: MAIN,
			audio_inputs: saved,
		});
	});

	test("No audio picked over a saved two-input mix: Start sends no audio, the summary says so, and the next microphone pick brings the mix back", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		await page.getByTestId(`audio-strip-enable-${SECOND}`).click();
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");
		await page.getByTestId(`audio-strip-track-${SECOND}-2`).click();
		await expect(page.getByTestId(`audio-strip-track-${SECOND}-2`)).toHaveAttribute("aria-pressed", "true");
		await page.getByTestId(`audio-strip-track-${SECOND}-1`).click();
		await expect(page.getByTestId(`audio-strip-track-${SECOND}-1`)).toHaveAttribute("aria-pressed", "false");

		await chooseAudio(page, "No audio");
		await pressStart(page);
		expect((await workerBackend.mockEngine()).lastStartParams?.audio).toEqual({ mode: "none" });
		const cockpit = page.getByTestId("live-cockpit");
		await expect(cockpit).toBeVisible({ timeout: 15_000 });
		await expect(cockpit.locator('[data-live-value="audio"]')).toHaveText("No audio");
		expect(await backendRpc.call(["streaming", "getConfig"])).toMatchObject({
			asrc: "No audio",
			audio_inputs: savedTwo,
		});
		await endAndWait(page);

		await openLive(page);
		const save = wire.holdAudioPick(MAIN);
		await chooseAudio(page, new RegExp(MAIN));
		const saved = await save.held;
		save.release();
		expect((await receiveReply(saved.id)).result).toMatchObject({ success: true });
		expect(await backendRpc.call(["streaming", "getConfig"])).toMatchObject({ asrc: MAIN, audio_inputs: savedTwo });
		await pressStart(page);
		const audio = (await workerBackend.mockEngine()).lastStartParams?.audio as
			| { mode?: string; inputs?: Array<{ tracks: number[] }> }
			| undefined;
		expect(audio?.mode).toBe("default");
		expect(audio?.inputs?.map((input) => input.tracks)).toEqual([[1], [2]]);
		await expect(cockpit).toBeVisible({ timeout: 15_000 });
		await endAndWait(page);
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("queued Start stays pending through a second pick and sends only the settled selection", async ({
		page,
		backendRpc,
	}) => {
		const first = wire.holdAudioPick(SECOND);
		await pickDevice(page, /Elgato Wave:3/);
		const firstReply = await first.held;
		const start = wire.nextAnswer("streaming.start");
		const bar = page.getByTestId("live-bar");
		await startButton(page).click();
		await expect(bar).toHaveAttribute("data-state", "pending");

		const second = wire.holdAudioPick(THIRD);
		await pickThird(page);
		const secondReply = await second.held;
		expect(firstReply.result).toMatchObject({ success: true, applied: { asrc: SECOND } });
		expect(secondReply.result).toMatchObject({ success: true, applied: { asrc: THIRD } });
		expect(await wire.pageHasReply(firstReply.id)).toBe(false);
		expect(wire.calls("streaming.start")).toEqual([]);

		first.release();
		expect((await receiveReply(firstReply.id)).result).toEqual(firstReply.result);
		expect(await wire.pageHasReply(secondReply.id)).toBe(false);
		expect(wire.calls("streaming.start")).toEqual([]);
		await expect.soft(bar, "Start must not go back to Ready while the second pick is held").toHaveAttribute(
			"data-state",
			"pending",
		);

		second.release();
		expect((await receiveReply(secondReply.id)).result).toEqual(secondReply.result);
		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 10_000 });
		expect(await start).toMatchObject({ input: { asrc: THIRD }, result: { success: true } });
		expect(wire.calls("streaming.start").map(({ input }) => input.asrc)).toEqual([THIRD]);

		await endAndWait(page);
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});

	test("Start pressed during a No audio pick waits for its answer, then sends no audio", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		await backendRpc.call(["streaming", "setConfig"], { audio_inputs: savedTwo });
		await expect(page.getByTestId(`audio-strip-enable-${SECOND}`)).toHaveAttribute("aria-checked", "true");

		const save = wire.holdAudioPick("No audio");
		await chooseAudio(page, "No audio");
		const held = await save.held;
		const start = wire.nextAnswer("streaming.start");
		try {
			expect(held.input).toEqual({ asrc: "No audio", audio_pick: true });
			expect(held.result).toMatchObject({ success: true, applied: { asrc: "No audio" } });
			await startButton(page).click();
			expect(await wire.pageHasReply(held.id)).toBe(false);
			expect(wire.calls("streaming.start")).toEqual([]);
		} finally {
			save.release();
		}
		expect((await receiveReply(held.id)).result).toEqual(held.result);
		expect(await start).toMatchObject({ input: { asrc: "No audio" }, result: { success: true } });
		expect((await workerBackend.mockEngine()).lastStartParams?.audio).toEqual({ mode: "none" });
		const cockpit = page.getByTestId("live-cockpit");
		await expect(cockpit).toBeVisible({ timeout: 15_000 });
		await expect(cockpit.locator('[data-live-value="audio"]')).toHaveText("No audio");
		expect(await backendRpc.call(["streaming", "getConfig"])).toMatchObject({
			asrc: "No audio",
			audio_inputs: savedTwo,
		});
		await endAndWait(page);
		await backendRpc.call(["streaming", "setConfig"], { asrc: MAIN, audio_inputs: null });
	});
});
