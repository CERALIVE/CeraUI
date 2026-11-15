import type { Locator, Page } from "@playwright/test";

import type { MockEngineState } from "./fixtures/backend.js";
import { type BackendRpc, expect, test } from "./fixtures/index.js";
import { runAxe } from "./helpers/axe.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * The layout designer: the second picture input placed on the preview, against
 * the mock engine.
 *
 * `caps-full` advertises `composition` and `composition-geometry`, so the
 * designer renders over the preview and the layout radios gain `custom`
 * (`layout-designer-absent.spec.ts` covers `multi-modem-wifi`, which advertises
 * neither; a scenario is per worker, so per file). The page's socket is
 * proxied, never rewritten: every placement reaches the real mock backend and,
 * live, its mock engine. The proxy records the RPC frames and can delay or
 * hold the device's answers (held frames are the device's own, released in
 * order, never fabricated) to check that writes made before an answer arrives
 * still compose: placements in order, and a newer card change winning over a
 * placement still waiting.
 */

interface RpcCall {
	path: string;
	input: Record<string, unknown>;
	result?: Record<string, unknown>;
	/** Where the request and its answer fell in one order of frames, as the page sent and saw them. */
	sent: number;
	delivered?: number;
}

interface DesignerWire {
	calls(path: string): RpcCall[];
	/** Hold every device frame this long before the page sees it, in order; 0 stops. */
	delayServer(ms: number): void;
	/** Keep every device frame from the page until `releaseServer`, then send them in order. */
	holdServer(): void;
	releaseServer(): void;
	/** Run `read` when the page next sends `path`, before the device gets it. */
	beforeSending(path: string, read: () => Promise<void>): void;
}

type Rect = { x: number; y: number; width: number; height: number };

async function installDesignerWire(
	page: Page,
	pageRpc: {
		bindConnectionLifecycle(browser: unknown, server: unknown): void;
		acceptServerMessage(message: string | Buffer): void;
	},
): Promise<DesignerWire> {
	const byId = new Map<unknown, RpcCall>();
	const all: RpcCall[] = [];
	let delayMs = 0;
	let held = 0;
	let tail: Promise<void> = Promise.resolve();
	let holding = false;
	const heldFrames: Array<{ message: string | Buffer; call: RpcCall | undefined }> = [];
	let page_: { send(message: string | Buffer): void } | undefined;
	let order = 0;
	const beforeSend = new Map<string, () => Promise<void>>();
	const deliver = (message: string | Buffer, call: RpcCall | undefined) => {
		page_?.send(message);
		if (call) call.delivered = ++order;
	};

	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		const server = ws.connectToServer();
		pageRpc.bindConnectionLifecycle(ws, server);
		page_ = ws;
		ws.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			let call: RpcCall | undefined;
			try {
				const frame = JSON.parse(text) as { id?: unknown; path?: unknown; input?: Record<string, unknown> };
				if (Array.isArray(frame.path) && frame.id !== undefined) {
					call = { path: frame.path.join("."), input: frame.input ?? {}, sent: ++order };
					all.push(call);
					byId.set(frame.id, call);
				}
			} catch {
				/* non-RPC frame */
			}
			const read = call === undefined ? undefined : beforeSend.get(call.path);
			if (call !== undefined && read !== undefined) {
				beforeSend.delete(call.path);
				void read().then(() => server.send(message));
				return;
			}
			server.send(message);
		});
		server.onMessage((message) => {
			pageRpc.acceptServerMessage(message);
			const text = typeof message === "string" ? message : message.toString();
			let call: RpcCall | undefined;
			try {
				const frame = JSON.parse(text) as { id?: unknown; result?: Record<string, unknown> };
				call = frame.id === undefined ? undefined : byId.get(frame.id);
				if (call) call.result = frame.result;
			} catch {
				/* non-JSON / binary frame */
			}
			if (holding) {
				heldFrames.push({ message, call });
				return;
			}
			if (delayMs === 0 && held === 0) {
				deliver(message, call);
				return;
			}
			const due = Date.now() + delayMs;
			held += 1;
			tail = tail.then(async () => {
				const wait = due - Date.now();
				if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
				deliver(message, call);
				held -= 1;
			});
		});
	});

	return {
		calls: (path) => all.filter((call) => call.path === path),
		delayServer: (ms) => {
			delayMs = ms;
		},
		holdServer: () => {
			holding = true;
		},
		releaseServer: () => {
			holding = false;
			for (const { message, call } of heldFrames.splice(0)) deliver(message, call);
		},
		beforeSending: (path, read) => {
			beforeSend.set(path, read);
		},
	};
}

async function openLive(page: Page): Promise<void> {
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "live");
}

const savedComposition = async (backendRpc: BackendRpc) =>
	(
		await backendRpc.call<{ composition?: Record<string, unknown> & { rect?: Rect } }>([
			"streaming",
			"getConfig",
		])
	).composition;

const near = (actual: Rect | undefined, expected: Rect) =>
	actual !== undefined &&
	(["x", "y", "width", "height"] as const).every(
		(side) => Math.abs(actual[side] - expected[side]) <= 0.01,
	);

/** The inset as rendered, in fractions of the picture. */
async function shownRect(inset: Locator): Promise<Rect> {
	return inset.evaluate((element) => {
		const style = (element as HTMLElement).style;
		return {
			x: Number.parseFloat(style.left) / 100,
			y: Number.parseFloat(style.top) / 100,
			width: Number.parseFloat(style.width) / 100,
			height: Number.parseFloat(style.height) / 100,
		};
	});
}

/** Drag from the centre of `grip` by fractions of the picture area. */
async function dragBy(page: Page, inset: Locator, grip: Locator, fx: number, fy: number) {
	await inset.scrollIntoViewIfNeeded();
	const picture = await inset.locator("..").boundingBox();
	const from = await grip.boundingBox();
	if (picture === null || from === null) throw new Error("designer is not on screen");
	const x = from.x + from.width / 2;
	const y = from.y + from.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + fx * picture.width, y + fy * picture.height, { steps: 8 });
	await page.mouse.up();
}

test.use({ backendScenario: "caps-full" });

// The desktop layout drives the program desk.
test.describe("layout designer — caps-full", { tag: "@desktop-only" }, () => {
	let wire: DesignerWire;

	test.beforeEach(async ({ page, pageRpc, backendRpc }) => {
		await backendRpc.call(["streaming", "setConfig"], {
			source: "usb",
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			composition: null,
		});
		wire = await installDesignerWire(page, pageRpc);
		await openLive(page);
		await page.getByTestId("composition-enable").click();
		await expect(page.getByTestId("composition-layout-selector")).toBeVisible();
	});

	test.afterEach(async ({ backendRpc }) => {
		await backendRpc.call(["streaming", "setConfig"], { composition: null });
	});

	test("choose custom, drag the inset to the bottom left, resize it from a corner, reload, and see the same rectangle", async ({
		page,
		backendRpc,
	}) => {
		await expect(page.getByTestId("composition-layout-selector").getByRole("radio")).toHaveCount(7);
		const inset = page.getByTestId("program-desk").getByTestId("layout-inset");
		await expect(inset).toBeVisible();

		await page.getByTestId("composition-layout-custom").click();
		await expect(page.getByTestId("composition-layout-custom")).toHaveAttribute("aria-checked", "true");
		await expect
			.poll(async () => (await savedComposition(backendRpc))?.rect)
			.toEqual({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 });

		await dragBy(page, inset, inset, -0.4, 0.4);
		await expect
			.poll(async () => near((await savedComposition(backendRpc))?.rect, { x: 0.05, y: 0.45, width: 0.5, height: 0.5 }))
			.toBe(true);

		await dragBy(page, inset, page.getByTestId("layout-inset-handle-bottom-right"), -0.2, -0.15);
		await expect
			.poll(async () => near((await savedComposition(backendRpc))?.rect, { x: 0.05, y: 0.45, width: 0.3, height: 0.35 }))
			.toBe(true);
		const saved = (await savedComposition(backendRpc))?.rect;
		expect(wire.calls("streaming.setConfig").filter((call) => "composition_rect" in call.input)).toHaveLength(2);

		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		const reloaded = page.getByTestId("program-desk").getByTestId("layout-inset");
		await expect(reloaded).toBeVisible();
		await expect.poll(async () => near(await shownRect(reloaded), saved as Rect)).toBe(true);
		await expect(page.getByTestId("composition-layout-custom")).toHaveAttribute("aria-checked", "true");

		expect(
			await runAxe(page, { include: ['[data-testid="preview"]', '[data-testid="composition-layout-selector"]'] }),
		).toEqual([]);
	});

	test("dragging past the right edge leaves it inside the frame, and a size below the minimum is held at the minimum", async ({
		page,
		backendRpc,
	}) => {
		const inset = page.getByTestId("program-desk").getByTestId("layout-inset");
		await dragBy(page, inset, inset, 0.9, 0);
		await expect
			.poll(async () => (await savedComposition(backendRpc))?.rect)
			.toEqual({ x: 0.5, y: 0.05, width: 0.5, height: 0.5 });

		await dragBy(page, inset, page.getByTestId("layout-inset-handle-top-left"), 0.9, 0.9);
		await expect
			.poll(async () => (await savedComposition(backendRpc))?.rect)
			.toEqual({ x: 0.875, y: 0.425, width: 0.125, height: 0.125 });
	});

	test("arrow keys move the focused inset by 1%, and the change is saved once", async ({ page, backendRpc }) => {
		const inset = page.getByTestId("program-desk").getByTestId("layout-inset");
		await inset.focus();
		await inset.press("ArrowLeft");
		await inset.press("Shift+ArrowDown");
		await expect
			.poll(async () => (await savedComposition(backendRpc))?.rect)
			.toEqual({ x: 0.44, y: 0.1, width: 0.5, height: 0.5 });
		await expect(inset).toHaveAccessibleName(/.+/);
		await expect(inset).toHaveAccessibleDescription(/44.*10.*50.*50/);
	});

	test("live: moving it changes the running stream, and two moves made before either answer both arrive in order", async ({
		page,
		backendRpc,
	}) => {
		await page.getByTestId("composition-layout-custom").click();
		await expect.poll(async () => (await savedComposition(backendRpc))?.layout).toBe("custom");
		await page.getByTestId("live-bar").getByRole("button", { name: "Start stream" }).click();
		const cockpit = page.getByTestId("live-cockpit");
		await expect(cockpit).toBeVisible({ timeout: 15_000 });
		const inset = cockpit.getByTestId("program-desk").getByTestId("layout-inset");
		await expect(inset).toBeVisible();

		await dragBy(page, inset, inset, -0.4, 0.4);
		await expect
			.poll(() => wire.calls("streaming.setConfig").at(-1)?.result)
			.toMatchObject({ success: true, configChange: { result: "applied" } });
		const live = wire.calls("streaming.setConfig").at(-1);
		expect(live?.input).toMatchObject({ apply_now: true });
		expect(near(live?.input.composition_rect as Rect, { x: 0.05, y: 0.45, width: 0.5, height: 0.5 })).toBe(true);
		expect(near((await savedComposition(backendRpc))?.rect, live?.input.composition_rect as Rect)).toBe(true);

		wire.delayServer(300);
		await dragBy(page, inset, inset, 0.2, 0);
		await dragBy(page, inset, inset, 0, -0.2);
		wire.delayServer(0);
		await expect
			.poll(() => wire.calls("streaming.setConfig").filter((call) => "composition_rect" in call.input).length)
			.toBe(3);
		const [first, second] = wire
			.calls("streaming.setConfig")
			.filter((call) => "composition_rect" in call.input)
			.slice(-2)
			.map((call) => call.input.composition_rect as Rect);
		expect(near(first, { x: 0.25, y: 0.45, width: 0.5, height: 0.5 })).toBe(true);
		expect(near(second, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })).toBe(true);
		await expect.poll(async () => near((await savedComposition(backendRpc))?.rect, second as Rect)).toBe(true);
		await expect.poll(async () => near(await shownRect(inset), second as Rect)).toBe(true);

		await page.getByTestId("live-bar").getByRole("button", { name: "Stop stream" }).click();
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
	});

	test("a layout tap made while drags wait for the device wins, and the drag still waiting is never sent", async ({
		page,
		backendRpc,
	}) => {
		await page.getByTestId("composition-layout-custom").click();
		await expect.poll(async () => (await savedComposition(backendRpc))?.layout).toBe("custom");
		const inset = page.getByTestId("program-desk").getByTestId("layout-inset");
		// The page has the answer to its own custom tap before any frame is held.
		await expect(page.getByTestId("composition-layout-pbp-left-right")).toBeEnabled();
		await expect.poll(async () => shownRect(inset)).toEqual({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 });
		const before = wire.calls("streaming.setConfig").length;

		wire.holdServer();
		await dragBy(page, inset, inset, -0.15, 0.1);
		await dragBy(page, inset, inset, -0.1, 0.1);
		await page.getByTestId("composition-layout-pbp-left-right").click();
		await expect.poll(() => wire.calls("streaming.setConfig").length).toBe(before + 1);
		wire.releaseServer();

		await expect.poll(async () => (await savedComposition(backendRpc))?.layout).toBe("pbp-left-right");
		await expect.poll(() => wire.calls("streaming.setConfig").at(-1)?.result).toMatchObject({ success: true });
		const writes = wire
			.calls("streaming.setConfig")
			.slice(before)
			.map((call) => call.input);
		expect(writes).toHaveLength(2);
		expect(Object.keys(writes[0] ?? {})).toEqual(["composition_rect"]);
		expect(near(writes[0]?.composition_rect as Rect, { x: 0.3, y: 0.15, width: 0.5, height: 0.5 })).toBe(true);
		expect(writes[1]).toEqual({ composition_patch: { layout: "pbp-left-right" } });
		const saved = await savedComposition(backendRpc);
		expect(saved?.layout).toBe("pbp-left-right");
		expect(saved).not.toHaveProperty("rect");
		await expect(page.getByTestId("composition-layout-pbp-left-right")).toHaveAttribute("aria-checked", "true");
	});

	test("Start pressed while idle placements wait for the device runs the newest of them, and a later move changes the running stream", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		await page.getByTestId("composition-layout-custom").click();
		await expect.poll(async () => (await savedComposition(backendRpc))?.layout).toBe("custom");
		const idle = page.getByTestId("program-desk").getByTestId("layout-inset");
		await expect(page.getByTestId("composition-layout-pbp-left-right")).toBeEnabled();
		await expect.poll(async () => shownRect(idle)).toEqual({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 });
		const before = wire.calls("streaming.setConfig").length;

		// Device frames held in order, two idle drags, Start, then the frames released.
		wire.holdServer();
		await dragBy(page, idle, idle, -0.1, 0.1);
		await dragBy(page, idle, idle, -0.1, 0.1);
		await page.getByTestId("live-bar").getByRole("button", { name: "Start stream" }).click();
		await expect.poll(() => wire.calls("streaming.setConfig").length).toBe(before + 1);
		wire.releaseServer();

		const cockpit = page.getByTestId("live-cockpit");
		await expect(cockpit).toBeVisible({ timeout: 15_000 });
		const [first, second] = wire.calls("streaming.setConfig").slice(before);
		const [start] = wire.calls("streaming.start");
		expect(Object.keys(first?.input ?? {})).toEqual(["composition_rect"]);
		expect(Object.keys(second?.input ?? {})).toEqual(["composition_rect"]);
		expect(near(first?.input.composition_rect as Rect, { x: 0.35, y: 0.15, width: 0.5, height: 0.5 })).toBe(true);
		const newest = second?.input.composition_rect as Rect;
		expect(near(newest, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })).toBe(true);
		// Start left only once the newest placement was saved, so Start ran it.
		expect(second?.delivered).toBeLessThan(start?.sent ?? 0);
		expect(near((await savedComposition(backendRpc))?.rect, newest)).toBe(true);
		const live = cockpit.getByTestId("program-desk").getByTestId("layout-inset");
		await expect.poll(async () => near(await shownRect(live), newest)).toBe(true);
		// What the engine runs is what is saved and shown.
		const started = await workerBackend.mockEngine();
		expect(started.streaming).toBe(true);
		expect(started.composition).toEqual(await savedComposition(backendRpc));

		await dragBy(page, live, live, 0.2, 0);
		await expect
			.poll(() => wire.calls("streaming.setConfig").at(-1)?.result)
			.toMatchObject({ success: true, configChange: { result: "applied" } });
		const moved = wire.calls("streaming.setConfig").at(-1);
		expect(moved?.input).toMatchObject({ apply_now: true });
		expect(moved?.sent).toBeGreaterThan(start?.delivered ?? Number.POSITIVE_INFINITY);
		const running = moved?.input.composition_rect as Rect;
		expect(near(running, { x: 0.45, y: 0.25, width: 0.5, height: 0.5 })).toBe(true);
		expect(near((await savedComposition(backendRpc))?.rect, running)).toBe(true);
		await expect.poll(async () => near(await shownRect(live), running)).toBe(true);
		expect((await workerBackend.mockEngine()).composition).toEqual(await savedComposition(backendRpc));

		await page.getByTestId("live-bar").getByRole("button", { name: "Stop stream" }).click();
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
	});

	test("Stop pressed while live placements wait for the device ends the stream on the newest of them, and the next move only saves", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		await page.getByTestId("composition-layout-custom").click();
		await expect.poll(async () => (await savedComposition(backendRpc))?.layout).toBe("custom");
		await page.getByTestId("live-bar").getByRole("button", { name: "Start stream" }).click();
		const cockpit = page.getByTestId("live-cockpit");
		await expect(cockpit).toBeVisible({ timeout: 15_000 });
		const live = cockpit.getByTestId("program-desk").getByTestId("layout-inset");
		await expect.poll(async () => shownRect(live)).toEqual({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 });
		const before = wire.calls("streaming.setConfig").length;
		// What the engine runs at the moment Stop reaches the device.
		let atStop: MockEngineState | undefined;
		wire.beforeSending("streaming.stop", async () => {
			atStop = await workerBackend.mockEngine();
		});

		wire.holdServer();
		await dragBy(page, live, live, -0.1, 0.1);
		await dragBy(page, live, live, -0.1, 0.1);
		await page.getByTestId("live-bar").getByRole("button", { name: "Stop stream" }).click();
		await expect.poll(() => wire.calls("streaming.setConfig").length).toBe(before + 1);
		wire.releaseServer();

		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
		const [first, second] = wire.calls("streaming.setConfig").slice(before);
		const stop = wire.calls("streaming.stop").at(-1);
		for (const placement of [first, second]) {
			expect(placement?.input).toMatchObject({ apply_now: true });
			expect(placement?.result).toMatchObject({ success: true, configChange: { result: "applied" } });
		}
		const newest = second?.input.composition_rect as Rect;
		expect(near(newest, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })).toBe(true);
		// The stream ended on the newest placement: Stop left only after the engine applied it.
		expect(second?.delivered).toBeLessThan(stop?.sent ?? 0);
		expect(near((await savedComposition(backendRpc))?.rect, newest)).toBe(true);
		expect(atStop?.streaming).toBe(true);
		expect(atStop?.composition).toEqual(await savedComposition(backendRpc));
		await expect.poll(async () => (await workerBackend.mockEngine()).streaming).toBe(false);

		// The ended session's summary first; Done returns to the idle cockpit.
		await page.getByTestId("summary-done").click();
		const inset = page.getByTestId("idle-cockpit").getByTestId("program-desk").getByTestId("layout-inset");
		await expect.poll(async () => near(await shownRect(inset), newest)).toBe(true);
		await dragBy(page, inset, inset, 0.1, 0);
		await expect.poll(() => wire.calls("streaming.setConfig").at(-1)?.result).toMatchObject({ success: true });
		const after = wire.calls("streaming.setConfig").at(-1);
		expect(after?.sent).toBeGreaterThan(stop?.delivered ?? Number.POSITIVE_INFINITY);
		expect(after?.input).not.toHaveProperty("apply_now");
		expect(after?.result).not.toHaveProperty("configChange");
		expect(near((await savedComposition(backendRpc))?.rect, after?.input.composition_rect as Rect)).toBe(true);

		// The next Start begins from the newest saved composition.
		await page.getByTestId("live-bar").getByRole("button", { name: "Start stream" }).click();
		const again = page.getByTestId("live-cockpit");
		await expect(again).toBeVisible({ timeout: 15_000 });
		const restarted = await workerBackend.mockEngine();
		expect(restarted.streaming).toBe(true);
		expect(restarted.composition).toEqual(await savedComposition(backendRpc));
		const shownAgain = again.getByTestId("program-desk").getByTestId("layout-inset");
		await expect
			.poll(async () => near(await shownRect(shownAgain), after?.input.composition_rect as Rect))
			.toBe(true);
		await page.getByTestId("live-bar").getByRole("button", { name: "Stop stream" }).click();
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
	});

	test("Escape during a pointer drag puts the inset back and sends nothing", async ({ page, backendRpc }) => {
		const inset = page.getByTestId("program-desk").getByTestId("layout-inset");
		await backendRpc.call(["streaming", "setConfig"], {
			composition_rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
		});
		await expect.poll(async () => shownRect(inset)).toEqual({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 });
		const before = wire.calls("streaming.setConfig").length;

		const from = await inset.boundingBox();
		if (from === null) throw new Error("designer is not on screen");
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(from.x + from.width / 2 + 120, from.y + from.height / 2 + 60, { steps: 6 });
		await expect.poll(async () => near(await shownRect(inset), { x: 0.2, y: 0.2, width: 0.4, height: 0.4 })).toBe(false);
		await page.keyboard.press("Escape");
		await expect.poll(async () => shownRect(inset)).toEqual({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 });
		await page.mouse.move(from.x + from.width / 2 + 200, from.y + from.height / 2, { steps: 3 });
		await page.mouse.up();

		// The next placement is the first one sent since the cancelled drag.
		await inset.press("ArrowRight");
		await expect.poll(() => wire.calls("streaming.setConfig").length).toBe(before + 1);
		expect(wire.calls("streaming.setConfig").at(-1)?.input).toEqual({
			composition_rect: { x: 0.21, y: 0.2, width: 0.4, height: 0.4 },
		});
	});

	test("a stale second tab's placement keeps the opacity another tab saved", async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		const { other, hold, release } = await openSecondTab(page, workerBackend.port);
		const otherInset = other.getByTestId("program-desk").getByTestId("layout-inset");
		await expect(otherInset).toBeVisible();
		hold();
		const opacity = page.getByTestId("composition-alpha-control").getByRole("slider");
		await opacity.focus();
		await opacity.press("Home");
		await expect.poll(async () => (await savedComposition(backendRpc))?.alpha).toBe(0);

		await dragBy(other, otherInset, otherInset, -0.4, 0.4);
		await expect
			.poll(async () => savedComposition(backendRpc))
			.toMatchObject({ layout: "custom", alpha: 0 });
		expect(near((await savedComposition(backendRpc))?.rect, { x: 0.05, y: 0.45, width: 0.5, height: 0.5 })).toBe(true);
		release();
		await other.close();
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
});

test.describe("layout designer — caps-full, on a 375 x 812 phone", { tag: "@mobile-only" }, () => {
	test.use({ viewport: { width: 375, height: 812 } });

	const MINIMUM: Rect = { x: 0.4, y: 0.4, width: 0.125, height: 0.125 };
	let wire: DesignerWire;

	test.beforeEach(async ({ page, pageRpc, backendRpc }) => {
		await backendRpc.call(["streaming", "setConfig"], {
			source: "usb",
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			composition: null,
		});
		await page.addInitScript(() => localStorage.setItem("ceraui.live.previewOpen", "true"));
		wire = await installDesignerWire(page, pageRpc);
		await openLive(page);
		await page.getByTestId("composition-enable").click();
		await expect.poll(async () => (await savedComposition(backendRpc))?.layout).toBe("pip-top-right");
		await backendRpc.call(["streaming", "setConfig"], { composition_rect: MINIMUM });
	});

	test.afterEach(async ({ backendRpc }) => {
		await backendRpc.call(["streaming", "setConfig"], { composition: null });
	});

	test("at the smallest size most of the inset still moves it, each corner keeps a 44 px resize box, and a drag from its middle moves it", async ({
		page,
		backendRpc,
	}) => {
		const inset = page.getByTestId("layout-inset");
		await expect.poll(async () => shownRect(inset)).toEqual(MINIMUM);
		await inset.scrollIntoViewIfNeeded();

		// Every whole pixel of the inset, hit-tested the way a finger or a pointer lands.
		const grid = await inset.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const move: Array<{ x: number; y: number }> = [];
			const resize = new Set<string>();
			let points = 0;
			for (let y = 0.5; y < box.height; y += 1)
				for (let x = 0.5; x < box.width; x += 1) {
					points += 1;
					const hit = document.elementFromPoint(box.left + x, box.top + y);
					const corner = hit?.closest<HTMLElement>("[data-corner], [data-corner-cap]");
					if (corner) resize.add(corner.dataset.corner ?? corner.dataset.cornerCap ?? "");
					else if (hit?.closest('[data-testid="layout-inset"]') === element) move.push({ x, y });
				}
			const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
			return {
				points,
				move,
				resize: [...resize].sort(),
				centreMoves:
					centre?.closest("[data-corner], [data-corner-cap]") === null &&
					centre?.closest('[data-testid="layout-inset"]') === element,
			};
		});
		expect(grid.centreMoves).toBe(true);
		expect(grid.move.length).toBeGreaterThanOrEqual(grid.points / 2);
		expect(grid.resize).toEqual(["bottom-left", "bottom-right", "top-left", "top-right"]);
		const boxes = await page
			.locator("[data-corner]")
			.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()));
		expect(boxes).toHaveLength(4);
		for (const box of boxes) {
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);
		}

		const before = wire.calls("streaming.setConfig").length;
		const picture = await inset.locator("..").boundingBox();
		const from = await inset.boundingBox();
		if (picture === null || from === null) throw new Error("designer is not on screen");
		const x = from.x + from.width / 2;
		const y = from.y + from.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + 0.2 * picture.width, y + 0.1 * picture.height, { steps: 8 });
		await page.mouse.up();
		await expect.poll(() => wire.calls("streaming.setConfig").length).toBe(before + 1);
		const placed = wire.calls("streaming.setConfig").at(-1)?.input.composition_rect as Rect;
		expect(near(placed, { x: 0.6, y: 0.5, width: 0.125, height: 0.125 })).toBe(true);
		expect([placed.width, placed.height]).toEqual([0.125, 0.125]);
		await expect.poll(async () => near((await savedComposition(backendRpc))?.rect, placed)).toBe(true);

		expect(
			await runAxe(page, { include: ['[data-testid="preview"]', '[data-testid="composition-layout-selector"]'] }),
		).toEqual([]);
	});
});
