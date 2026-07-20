// @vitest-environment jsdom
/**
 * NetifDialog — link-local (169.254/16) clarity (plan Todo 52).
 *
 * The dialog pre-fills its "Static IP" field from the live interface IP. On a
 * CeraLive device the wired port always carries an automatic 169.254.x.x
 * link-local address, so echoing it into the Static IP box makes it look like a
 * saved static config the operator set — and "can't clear" (clearing + save just
 * reverts to DHCP; the OS re-adds the link-local on reconnect). This suite proves:
 *  - a link-local live IP does NOT seed the Static IP field (blank = DHCP) and the
 *    dialog shows the calm explanatory notice.
 *  - a normal routable address still seeds the field and shows no notice.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";

import NetifDialog from "./NetifDialog.svelte";

// Hermetic RPC: NetifDialog imports the `rpc` barrel, so mock `$lib/rpc`.
vi.mock("$lib/rpc", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

function iface(overrides: Partial<NetifEntry> = {}): NetifEntry {
	return { ip: "", tp: 0, enabled: true, ...overrides };
}

const ipInput = () => screen.getByPlaceholderText(/./) as HTMLInputElement;

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("NetifDialog — link-local address clarity (Todo 52)", () => {
	it("does NOT seed the Static IP field with a link-local address and shows the notice", async () => {
		render(NetifDialog, {
			props: {
				open: true,
				name: "eth0",
				iface: iface({ ip: "169.254.149.160" }),
			},
		});

		// The Static IP field stays blank (link-local is not a saved static config).
		await waitFor(() => expect(ipInput().value).toBe(""));
		// The calm explanatory notice is shown.
		expect(screen.getByTestId("netif-link-local-notice")).toBeTruthy();
	});

	it("seeds the Static IP field with a normal routable address and shows no notice", async () => {
		render(NetifDialog, {
			props: {
				open: true,
				name: "eth0",
				iface: iface({ ip: "192.168.78.131" }),
			},
		});

		// A real routable address still pre-fills (existing behaviour preserved).
		await waitFor(() => expect(ipInput().value).toBe("192.168.78.131"));
		expect(screen.queryByTestId("netif-link-local-notice")).toBeNull();
	});
});
