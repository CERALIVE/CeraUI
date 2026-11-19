// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";

import { setHudFeed } from "./__fixtures__/hud-feed.svelte";
import StreamStatePill from "./StreamStatePill.svelte";

vi.mock("$lib/stores/hud.svelte", async () => ({
	getHudState: (await import("./__fixtures__/hud-feed.svelte")).getHudFeed,
}));

afterEach(() => {
	cleanup();
	setHudFeed(false, false);
});

it("follows the HUD state while mounted: idle, live, offline, idle", () => {
	setHudFeed(false, false);
	render(StreamStatePill);
	const pill = () => screen.getByTestId("system-logs-stream-pill");
	const seen: Array<[string | undefined, string | undefined]> = [];
	const observe = () =>
		seen.push([pill().dataset.state, pill().textContent?.trim()]);

	observe();
	setHudFeed(true, false);
	flushSync();
	observe();
	setHudFeed(true, true);
	flushSync();
	observe();
	setHudFeed(false, false);
	flushSync();
	observe();

	expect(seen).toEqual([
		["idle", en.hud.idle],
		["live", en.hud.live],
		["offline", en.hud.offline],
		["idle", en.hud.idle],
	]);
});
