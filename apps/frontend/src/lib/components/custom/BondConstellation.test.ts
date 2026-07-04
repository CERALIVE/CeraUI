// @vitest-environment jsdom
/**
 * BondConstellation — stable animation lifecycle (T17).
 *
 * Proves the timeline is rebuilt ONLY when the topology fingerprint changes,
 * not on every status push that hands the component a fresh `links` array of
 * identical topology. A mid-flight rebuild is the reported "weird movement".
 */

import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gsap } from "gsap";

import type { LinkSignal } from "$lib/types/hud";

import BondConstellation from "./BondConstellation.svelte";

// Each build arms exactly PULSE_COUNT outbound-pulse tweens (independent of how
// many packets are connected), so counting pulse tweens counts builds exactly.
const PULSE_COUNT = 2;

function link(id: string, index: number, isConnected = true): LinkSignal {
	return {
		id,
		type: "modem",
		linkIndex: index,
		signal: 70 + index,
		label: id,
		isConnected,
		isStale: false,
		throughputKbps: 5000,
		enabled: true,
		connectionState: isConnected ? "connected" : "disconnected",
	};
}

// A same-topology snapshot: NEW array + NEW element identities, identical
// {id, isConnected} — exactly what a 5s status push delivers (signal ticks).
function sameTopology(links: LinkSignal[]): LinkSignal[] {
	return links.map((l) => ({ ...l, signal: (l.signal ?? 0) + 1 }));
}

function root(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>('[data-testid="bond-constellation"]');
	expect(el).not.toBeNull();
	return el as HTMLElement;
}

let fromToSpy: ReturnType<typeof vi.spyOn>;

// A pulse tween is `fromTo(el, {scale:0.4}, {scale:3,...})`; a packet tween uses
// `keyframes`. Counting `scale:3` targets ÷ PULSE_COUNT yields the build count.
function buildCount(): number {
	const pulseCalls = fromToSpy.mock.calls.filter(
		(call) => (call[2] as { scale?: number } | undefined)?.scale === 3,
	).length;
	return pulseCalls / PULSE_COUNT;
}

beforeEach(() => {
	// gsap.matchMedia reads window.matchMedia(query).matches; force the
	// no-preference branch so the timeline builder runs in jsdom.
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	);
	// Count builds without spinning gsap's real rAF ticker (repeat:-1 tweens).
	fromToSpy = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
});

afterEach(() => {
	fromToSpy.mockRestore();
	vi.unstubAllGlobals();
});

describe("BondConstellation — stable animation lifecycle (T17)", () => {
	it("live + frozen → no timeline, data-animated='false'", () => {
		const { container } = render(BondConstellation, {
			props: { links: [link("usb0", 0)], live: true, frozen: true },
		});
		flushSync();

		expect(root(container).getAttribute("data-animated")).toBe("false");
		expect(fromToSpy).not.toHaveBeenCalled();
	});

	it("two successive same-topology pushes do NOT rebuild the timeline (no restart)", () => {
		const links = [link("usb0", 0)];
		const { container, rerender } = render(BondConstellation, {
			props: { links, live: true, frozen: false },
		});
		flushSync();

		expect(root(container).getAttribute("data-animated")).toBe("true");
		expect(buildCount()).toBe(1);

		// Fresh arrays + fresh element identities, identical topology (signal ticks).
		rerender({ links: sameTopology(links), live: true, frozen: false });
		flushSync();
		rerender({ links: sameTopology(links), live: true, frozen: false });
		flushSync();

		// The fingerprint is unchanged, so the effect never re-runs — still 1 build.
		expect(buildCount()).toBe(1);
	});

	it("a topology change triggers exactly one rebuild", () => {
		const links = [link("usb0", 0), link("usb1", 1)];
		const { container, rerender } = render(BondConstellation, {
			props: { links, live: true, frozen: false },
		});
		flushSync();

		expect(buildCount()).toBe(1);

		// usb1 drops (isConnected flips) → the fingerprint changes → one rebuild.
		rerender({ links: [link("usb0", 0), link("usb1", 1, false)], live: true, frozen: false });
		flushSync();

		expect(buildCount()).toBe(2);
		expect(root(container).getAttribute("data-animated")).toBe("true");
	});

	it("idle (!live) hides packets — no parked topology implying an active bond", () => {
		const { container } = render(BondConstellation, {
			props: { links: [link("usb0", 0)], live: false, frozen: false },
		});
		flushSync();

		expect(root(container).getAttribute("data-animated")).toBe("false");
		expect(fromToSpy).not.toHaveBeenCalled();
		const packet = container.querySelector<SVGCircleElement>('[data-testid="bond-packet"]');
		expect(packet).not.toBeNull();
		expect(packet?.getAttribute("opacity")).toBe("0");
	});
});
