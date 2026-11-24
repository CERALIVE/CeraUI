// @vitest-environment jsdom
/**
 * NetworkRow — a focused action keeps focus when the row crosses 36rem.
 *
 * The row moves its actions in the DOM at that width, so Tab follows the reading
 * order; the move remounts them. The ResizeObserver is stubbed so the test drives
 * the edge the browser would.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import EthernetSection from "./EthernetSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const callbacks = new Map<Element, ResizeObserverCallback>();
class StubObserver {
	constructor(private readonly callback: ResizeObserverCallback) {}
	observe(target: Element): void {
		callbacks.set(target, this.callback);
	}
	unobserve(): void {}
	disconnect(): void {}
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubObserver);
});
afterEach(() => {
	vi.unstubAllGlobals();
	callbacks.clear();
});

const ETH0: NetifEntry = { tp: 0, enabled: true, ip: "192.168.1.2" };

function renderRow() {
	const { container } = render(EthernetSection, {
		props: {
			wiredEntries: [["eth0", ETH0]],
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
	const row = container.querySelector<HTMLElement>("[data-net-row]");
	const sentinel = row?.querySelector("[data-net-row-wide]");
	const resize = sentinel ? callbacks.get(sentinel) : undefined;
	if (!row || !resize) throw new Error("the row did not observe its sentinel");
	return {
		crossTo: (width: number) =>
			Reflect.apply(resize, undefined, [
				[{ contentRect: { width } }],
				undefined,
			]),
		configure: () =>
			row.querySelector<HTMLButtonElement>('[data-testid="open-netif-dialog"]'),
	};
}

it("keeps a focused action focused across both edges of the breakpoint", () => {
	const { crossTo, configure } = renderRow();
	const phone = configure();
	phone?.focus();

	crossTo(600);
	const wide = configure();
	expect(wide).not.toBe(phone);
	expect(document.activeElement).toBe(wide);

	crossTo(0);
	expect(configure()).not.toBe(wide);
	expect(document.activeElement).toBe(configure());
});

it("does not pull focus into the actions when it was elsewhere", () => {
	const { crossTo, configure } = renderRow();
	expect(document.activeElement).toBe(document.body);

	crossTo(600);
	expect(configure()).not.toBeNull();
	expect(document.activeElement).toBe(document.body);
});
