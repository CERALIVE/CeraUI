// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";

import StreamStatePill from "./StreamStatePill.svelte";

const hud = vi.hoisted(() => ({ isStreaming: false, isFullyStale: false }));
vi.mock("$lib/stores/hud.svelte", () => ({ getHudState: () => hud }));

afterEach(() => {
	cleanup();
});

function pill(streaming: boolean, stale: boolean): HTMLElement {
	hud.isStreaming = streaming;
	hud.isFullyStale = stale;
	render(StreamStatePill);
	return screen.getByTestId("system-logs-stream-pill");
}

function dot(node: HTMLElement): HTMLElement {
	const found = node.querySelector<HTMLElement>("[data-pill-dot]");
	if (!found) throw new Error("pill has no dot");
	return found;
}

describe("StreamStatePill", () => {
	it("reads Live with the HUD's live styling while streaming", () => {
		const node = pill(true, false);

		expect(node.dataset.state).toBe("live");
		expect(node.textContent?.trim()).toBe(en.hud.live);
		expect(node.className).toContain("bg-(--status-live)");
		expect(node.className).toContain("text-primary-foreground");
		expect(dot(node).className).toBe(
			"size-2 rounded-full bg-current motion-safe:animate-pulse",
		);
	});

	it("reads Idle as a neutral pill with a still dot", () => {
		const node = pill(false, false);

		expect(node.dataset.state).toBe("idle");
		expect(node.textContent?.trim()).toBe(en.hud.idle);
		expect(node.className).toContain("text-muted-foreground");
		expect(node.className).not.toContain("--status-live");
		expect(dot(node).className).toBe("bg-(--status-idle) size-2 rounded-full");
		expect(dot(node).className).not.toContain("animate-pulse");
	});

	it.each([true, false])(
		"reads Offline, never Live, when the connection is stale (streaming=%s)",
		(streaming) => {
			const node = pill(streaming, true);

			expect(node.dataset.state).toBe("offline");
			expect(node.textContent?.trim()).toBe(en.hud.offline);
			expect(node.className).toContain("bg-muted");
			expect(node.className).not.toContain("--status-live");
			expect(node.querySelector("[data-pill-dot]")).toBeNull();
			const icon = node.querySelector("svg");
			expect(icon?.getAttribute("aria-hidden")).toBe("true");
			expect(icon?.getAttribute("class")).toContain("size-3");
		},
	);

	it("shares one pill anatomy across states", () => {
		for (const [streaming, stale] of [
			[true, false],
			[false, false],
			[false, true],
		] as const) {
			const node = pill(streaming, stale);
			for (const token of [
				"inline-flex",
				"shrink-0",
				"items-center",
				"gap-1.5",
				"rounded-full",
				"px-2.5",
				"py-1",
				"text-[0.7rem]",
				"uppercase",
				"tracking-wider",
				"font-semibold",
			]) {
				expect(node.className).toContain(token);
			}
			cleanup();
		}
	});
});
