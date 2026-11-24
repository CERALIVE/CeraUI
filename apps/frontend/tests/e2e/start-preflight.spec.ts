import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

type Frame = Record<string, unknown>;
type Scenario = {
	source?: "test" | "missing";
	soleCamera?: string;
	destination?: "manual" | "missing" | "slot" | "revoked";
	engineOffline?: boolean;
	noLinks?: boolean;
	omit?: "capabilities" | "sources" | "netif" | "lifecycle";
	lifecycle?: "idle" | "starting" | "reconciling" | "stopping";
};

const preset = { source: "test", destination: "manual" } as const;

function frame(value: unknown): Frame | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return Object.fromEntries(Object.entries(value));
	}
}

export async function seedStart(page: Page, initial: Scenario = {}) {
	let active: WebSocketRoute | undefined;
	let scenario = { ...preset, ...initial };
	const observed = new Map<string, Frame>();
	const starts: unknown[] = [];
	let holdStart = false;
	const slots = [{ endpointId: "test-slot", host: "127.0.0.1", port: 5000, protocol: "srtla", key: "test" }];

	function project(kind: string, data: Frame) {
		if (kind === scenario.omit) return;
		if (kind === "config") {
			const destination = scenario.destination === "manual" ? "127.0.0.1" : "";
			active?.send(JSON.stringify({
				"ingest.slots": scenario.destination === "slot" ? slots : [],
			}));
			data = {
				...data,
				source: scenario.soleCamera ? undefined : scenario.source === "test" ? "test" : "e2e-unknown-source",
				pipeline: "test",
				relay_server: "",
				srtla_addr: destination,
				selected_ingest_endpoint: scenario.destination === "slot" || scenario.destination === "revoked" ? "test-slot" : "",
			};
		} else if (kind === "status") {
			const { stream_lifecycle: _, ...rest } = data;
			data = scenario.omit === "lifecycle"
				? rest
				: { ...rest, stream_lifecycle: scenario.lifecycle ?? "idle" };
		} else if (kind === "capabilities") {
			data = { ...data, engineUnavailable: scenario.engineOffline === true };
		} else if (kind === "sources" && scenario.soleCamera) {
			data = { ...data, sources: [{
				id: "e2e-sole-hdmi",
				pipelineId: "test",
				origin: "capture",
				kind: "hdmi",
				displayName: scenario.soleCamera,
				devicePath: "/dev/video0",
				modes: [],
				available: true,
			}] };
		} else if (kind === "netif" && scenario.noLinks) {
			data = Object.fromEntries(Object.keys(data).map((key) => [key, { tp: 0, enabled: false }]));
		}
		return data;
	}

	await page.routeWebSocket((url) => url.pathname === "/ws", (client) => {
		active = client;
		const server = client.connectToServer();
		client.onMessage((raw) => {
			const request = frame(JSON.parse(raw.toString()));
			if (Array.isArray(request?.path) && request.path.join(".") === "streaming.start") {
				starts.push(request.input);
				if (holdStart) return;
			}
			server.send(raw);
		});
		server.onMessage((raw) => {
			const message = frame(JSON.parse(raw.toString()));
			const kind = ["config", "status", "netif", "capabilities", "sources"]
				.find((key) => message && key in message);
			const data = kind && frame(message?.[kind]);
			if (kind && data) {
				observed.set(kind, data);
				const projected = project(kind, data);
				if (projected) client.send(JSON.stringify({ [kind]: projected }));
			} else if (!message || !("ingest.slots" in message)) {
				client.send(raw);
			}
		});
	});

	return {
		async open() {
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "live");
			await expect(page.getByTestId("live-bar")).toBeVisible();
		},
		update(next: Scenario) {
			scenario = { ...scenario, ...next };
			// One device frame replaces the blocker set without a transient
			// intermediate count. Other tests exercise separate two-to-one updates.
			const snapshot: Frame = {};
			for (const [kind, data] of observed) {
				const projected = project(kind, data);
				if (projected) snapshot[kind] = projected;
			}
			active?.send(JSON.stringify(snapshot));
		},
		pushStatus(status: Frame) {
			active?.send(JSON.stringify({ status }));
		},
		holdStart() { holdStart = true; },
		starts,
	};
}

const ui = (page: Page) => {
	const bar = page.getByTestId("live-bar");
	return {
		bar,
		start: bar.getByRole("button", { name: "Start Stream", exact: true }),
		show: bar.getByRole("button", { name: "Show all", exact: true }),
		list: bar.getByRole("list", { name: "Before you go live", exact: true }),
	};
};

const cameraLabel = "HDMI UltraStudio4KProCaptureStationNorthEntrance001";
const narrowCopy = [
	["pt-BR", "Selecionado automaticamente:", "Alterar", "Este slot de ingestão não está mais disponível — escolha outro destino", "Iniciar transmissão"],
	["de", "Automatisch ausgewählt:", "Ändern", "Dieser Ingest-Slot ist nicht mehr verfügbar — wähle ein anderes Ziel", "Stream starten"],
	["ja", "自動選択:", "変更", "このインジェストスロットは利用できなくなりました。別の宛先を選択してください", "ストリーム開始"],
] as const;

async function isPaintedWhole(text: Locator) {
	await text.scrollIntoViewIfNeeded();
	return text.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		const range = document.createRange();
		range.selectNodeContents(element);
		const lines = [...range.getClientRects()];
		return lines.length > 0 && lines.every(({ left, right, top, bottom }) => {
			const y = (top + bottom) / 2;
			return y >= bounds.top && y <= bounds.bottom &&
				left >= Math.max(0, bounds.left) - 1 &&
				right <= Math.min(innerWidth, bounds.right) + 1 &&
				element.contains(document.elementFromPoint((left + right) / 2, y));
		});
	});
}

for (const [locale, auto, change, reason, start] of narrowCopy) {
	test(`320 px Live paints the camera sentence and blocked reason whole in ${locale}`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await page.addInitScript((code) => localStorage.setItem("locale", JSON.stringify({ code })), locale);
		const fixture = await seedStart(page, { soleCamera: cameraLabel, destination: "revoked" });
		await fixture.open();
		const bar = page.getByTestId("live-bar");
		const cameraRow = page.getByTestId("sole-camera-auto");
		const changeButton = cameraRow.getByRole("button", { name: change, exact: true });
		await expect(page.locator("html")).toHaveAttribute("lang", locale);
		await expect(changeButton).toBeEnabled();
		await expect(bar.getByRole("button", { name: start, exact: true })).toBeDisabled();
		const sentence = cameraRow.getByText(`${auto} ${cameraLabel}`, { exact: true });
		const blocker = bar.locator("p").filter({ hasText: reason });
		await expect(sentence).toHaveText(`${auto} ${cameraLabel}`);
		await expect(blocker).toHaveText(reason);
		await expect.poll(async () => ({
			blocker: await isPaintedWhole(blocker),
			camera: await isPaintedWhole(sentence),
			change: await isPaintedWhole(changeButton),
		})).toEqual({ blocker: true, camera: true, change: true });
		expect(fixture.starts).toEqual([]);
	});
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
	test(`confirmed-live push hands off focus to a painted heading at ${viewport.width}×${viewport.height}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		const fixture = await seedStart(page);
		await fixture.open();
		const { start } = ui(page);
		await start.focus();
		await expect(start).toBeFocused();
		fixture.pushStatus({ is_streaming: true, stream_lifecycle: "streaming" });

		const heading = page.getByRole("heading", { name: "Live", exact: true });
		await expect(heading).toBeFocused();
		await expect.poll(() => heading.evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			const { left, right, top, bottom, width, height } = range.getBoundingClientRect();
			const middle = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
			return width > 1 && height > 1 && left >= 0 && top >= 0 &&
				right <= innerWidth && bottom <= innerHeight && element.contains(middle);
		})).toBe(true);
		expect(fixture.starts).toEqual([]);
	});
}

test("a slot without an assembled server target is a Destination blocker", async ({ page }) => {
	const fixture = await seedStart(page, { destination: "slot" });
	await fixture.open();
	const { bar, start } = ui(page);
	await expect(start).toHaveJSProperty("disabled", true);
	await expect(start).toHaveAccessibleDescription("Configure a server before starting the stream");
	await expect(bar.getByRole("button", { name: "Choose destination" })).toBeEnabled();
	await start.evaluate((button: HTMLButtonElement) => button.click());
	expect(fixture.starts).toEqual([]);
});

for (const omit of ["capabilities", "sources", "netif", "lifecycle"] as const) {
	test(`unknown ${omit} leaves Start checking without inventing a blocker`, async ({ page }) => {
		const fixture = await seedStart(page, { omit });
		await fixture.open();
		const { bar, start } = ui(page);
		await expect(bar.getByRole("status")).toHaveText("Checking readiness…");
		await expect(start).toHaveJSProperty("disabled", true);
		await start.evaluate((button: HTMLButtonElement) => button.click());
		expect(fixture.starts).toEqual([]);
	});
}

test("another client's pending Start disables this client's otherwise ready Start", async ({ page }) => {
	const fixture = await seedStart(page, { lifecycle: "starting" });
	await fixture.open();
	const { bar } = ui(page);
	const starting = bar.getByRole("button", { name: "Starting..." });
	await expect(starting).toHaveJSProperty("disabled", true);
	await starting.evaluate((button: HTMLButtonElement) => button.click());
	await expect(bar.getByText("Ready to go live", { exact: true })).toHaveCount(0);
	expect(fixture.starts).toEqual([]);
});

test("Starting with known blockers suppresses the checklist until the device returns to idle", async ({ page }) => {
	const fixture = await seedStart(page, { source: "missing", destination: "missing", lifecycle: "starting" });
	await fixture.open();
	const { bar, show } = ui(page);
	await expect(bar.getByRole("button", { name: "Starting..." })).toHaveJSProperty("disabled", true);
	await expect(bar.getByRole("button")).toHaveCount(1);
	fixture.update({ lifecycle: "idle" });
	await expect(show).toBeEnabled();
	await show.click();
	await expect(ui(page).list.getByRole("listitem")).toHaveCount(2);
});

test("local Start keeps its transient when a blocker arrives under the outstanding request", async ({ page }) => {
	const fixture = await seedStart(page);
	fixture.holdStart();
	await fixture.open();
	const { start, bar } = ui(page);
	await expect(start).toBeEnabled();
	await start.click();
	await expect.poll(() => fixture.starts.length).toBe(1);
	fixture.update({ lifecycle: "starting", destination: "missing", engineOffline: true });
	await expect(page.locator("main").getByText("Streaming engine offline", { exact: true }).first()).toBeVisible();
	await expect(bar.getByRole("button", { name: "Starting..." })).toHaveJSProperty("disabled", true);
	await expect(bar.getByRole("button", { name: "Choose destination" })).toHaveCount(0);
	await expect(bar.getByRole("list")).toHaveCount(0);
});

test("blocked Start is native disabled, described, and cannot shift focus", async ({ page }) => {
	const fixture = await seedStart(page, { source: "missing" });
	await fixture.open();
	const { bar, start } = ui(page);
	const fix = bar.getByRole("button", { name: "Choose source" });
	await expect(start).toHaveJSProperty("disabled", true);
	await expect(start).not.toHaveAttribute("aria-disabled", "true");
	await expect(start).toHaveAccessibleDescription("Select a video source before starting the stream");
	await fix.focus();
	await start.evaluate((node: HTMLButtonElement) => node.click());
	await expect(fix).toBeFocused();
	expect(fixture.starts).toEqual([]);
});

test("list updates preserve the surviving fix, then recover from two to one and one to zero", async ({ page }) => {
	const fixture = await seedStart(page, { source: "missing", destination: "missing" });
	await fixture.open();
	const { bar, list, show, start } = ui(page);
	await show.press("Enter");
	const destination = list.getByRole("button", { name: "Choose destination" });
	await destination.focus();
	fixture.update({ source: "test", noLinks: true });
	await expect(list.getByRole("button", { name: "Set up network" })).toBeVisible();
	await expect(destination).toBeFocused();
	fixture.update({ noLinks: false });
	await expect(list).toHaveCount(0);
	await expect(bar.getByRole("button", { name: "Choose destination" })).toBeFocused();
	fixture.update({ destination: "manual" });
	await expect(start).toBeEnabled();
	await expect(start).toBeFocused();
	fixture.update({ source: "missing", destination: "missing" });
	await expect(show).toHaveAttribute("aria-expanded", "false");
	await expect(bar.getByRole("button", { name: "Choose source" })).toBeFocused();
});

test("a live push replaces a focused Start without losing focus or focusing Stop", async ({ page }) => {
	const fixture = await seedStart(page);
	await fixture.open();
	const { start, bar } = ui(page);
	await expect(start).toBeEnabled();
	await start.focus();
	fixture.pushStatus({ is_streaming: true, stream_lifecycle: "streaming" });
	await expect(bar.getByRole("button", { name: "Stop Stream" })).toBeVisible();
	await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
	expect(fixture.starts).toEqual([]);
});

test("preflight does not interrupt focus after the operator tabs outside the bar", async ({ page }) => {
	const fixture = await seedStart(page, { source: "missing", destination: "missing" });
	await fixture.open();
	const { bar, list, show, start } = ui(page);
	await show.press("Enter");
	await expect(bar.getByRole("heading", { name: "Before you go live" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(list.getByRole("button", { name: "Choose source" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(list.getByRole("button", { name: "Choose destination" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(bar.getByRole("button", { name: "Choose source" }).last()).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(bar.getByRole("button", { name: "Close", exact: true })).toBeFocused();
	await page.keyboard.press("Tab");
	const outside = await page.evaluateHandle(() => document.activeElement);
	expect(await outside.evaluate((el) => el !== document.body && !el?.closest('[data-testid="live-bar"]'))).toBe(true);

	fixture.update({ source: "test", destination: "manual" });
	await expect(start).toBeEnabled();
	expect(await outside.evaluate((el) => document.activeElement === el)).toBe(true);
});

test("Escape from the checklist returns focus to Show all", async ({ page }) => {
	const fixture = await seedStart(page, { source: "missing", destination: "missing" });
	await fixture.open();
	const { bar, list, show } = ui(page);
	await expect(show).toHaveAccessibleDescription("2 things to fix");
	await show.press("Enter");
	await expect(bar.getByRole("heading", { name: "Before you go live" })).toBeFocused();
	await list.getByRole("button", { name: "Choose destination" }).press("Escape");
	await expect(list).toHaveCount(0);
	await expect(show).toBeFocused();
});

for (const { locale, show, dual, plural } of [
	{ locale: "en", show: "Show all", dual: "2 things to fix", plural: "3 things to fix" },
	{ locale: "es", show: "Ver todo", dual: "2 cosas por resolver", plural: "3 cosas por resolver" },
	{ locale: "ar", show: "عرض الكل", dual: "أمران يحتاجان إلى إصلاح", plural: "3 أمور تحتاج إلى إصلاح" },
]) {
	test(`localized counts in ${locale} reflect the actual number of blockers`, async ({ page }) => {
		await page.addInitScript((code) => {
			localStorage.setItem("locale", JSON.stringify({ code }));
		}, locale);
		const fixture = await seedStart(page, { source: "missing", destination: "missing" });
		await fixture.open();
		const trigger = page.getByTestId("live-bar").getByRole("button", { name: show });
		await expect(trigger).toHaveAccessibleDescription(dual);
		fixture.update({ engineOffline: true });
		await expect(trigger).toHaveAccessibleDescription(plural);
	});
}

test("touch ownership rejects a second contact, clears on cancel, and permits a fresh refresh", async ({ page }) => {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
	const fixture = await seedStart(page);
	await fixture.open();
	const firstDocument = await page.evaluate(() => performance.timeOrigin);
	const header = page.getByRole("banner");
	async function gesture(events: { name: string; touches: number[][]; changed?: number[][] }[]) {
		await header.evaluate((target, steps) => {
			function contacts(values: number[][]) {
				return values.map(([identifier, clientY]) =>
					new Touch({ identifier, clientY, clientX: 20, target }),
				);
			}
			for (const { name, touches, changed = touches } of steps) {
				target.dispatchEvent(new TouchEvent(name, {
					bubbles: true, cancelable: true, touches: contacts(touches), changedTouches: contacts(changed),
				}));
			}
		}, events);
	}
	const begin = { name: "touchstart", touches: [[1, 60]] };
	const drag = { name: "touchmove", touches: [[1, 175]] };
	const release = { name: "touchend", touches: [], changed: [[1, 175]] };
	// A second finger arrives while armed; the remaining finger may not re-arm.
	await gesture([
		begin, drag,
		{ name: "touchstart", touches: [[1, 175], [2, 180]], changed: [[2, 180]] },
		{ name: "touchend", touches: [[1, 175]], changed: [[2, 180]] },
		{ name: "touchmove", touches: [[1, 285]] },
		release,
	]);
	await expect(page.getByText("Release to refresh", { exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => performance.timeOrigin)).toBe(firstDocument);
	await gesture([begin, drag]);
	await expect(page.getByText("Release to refresh", { exact: true })).toHaveCount(1);
	await gesture([{ ...release, name: "touchcancel" }]);
	await expect(page.getByText("Release to refresh", { exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => performance.timeOrigin)).toBe(firstDocument);
	const loaded = page.waitForEvent("load");
	await gesture([begin, drag, release]);
	await loaded;
	expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(firstDocument);
});
