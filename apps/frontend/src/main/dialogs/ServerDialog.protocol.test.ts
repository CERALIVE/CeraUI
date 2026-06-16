// @vitest-environment jsdom
/**
 * ServerDialog — transport-protocol selector (Task 20 / RIST promotion).
 *
 * The dialog exposes SRTLA / SRT / RIST as protocols. SRTLA is always
 * selectable; RIST is capability-gated (only selectable when the engine
 * advertises the `rist` transport); SRT is a reserved placeholder. Unavailable
 * options stay visible but disabled with a reason — never hidden.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import ServerDialog from "./ServerDialog.svelte";

const state = vi.hoisted(() => ({
	config: undefined as { relay_protocol?: string } | undefined,
	relays: undefined as
		| {
				accounts: Record<string, { name: string }>;
				servers: Record<string, { name: string; rtt?: number; default?: true }>;
		  }
		| undefined,
	isStreaming: false,
	capabilities: undefined as { transports?: string[] } | undefined,
}));

const setConfig = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
	getRelays: () => state.relays,
	getIsStreaming: () => state.isStreaming,
	getCapabilities: () => state.capabilities,
}));

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig }, relay: { validate: vi.fn() } },
}));

vi.mock("$lib/rpc/dirty-registry.svelte", () => ({
	markPending: vi.fn(),
	onRpcResolved: vi.fn(),
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

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
});

const ristButton = () =>
	screen.getByTestId("protocol-rist") as HTMLButtonElement;
const srtlaButton = () =>
	screen.getByTestId("protocol-srtla") as HTMLButtonElement;
const srtButton = () => screen.getByTestId("protocol-srt") as HTMLButtonElement;

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} });
});

describe("ServerDialog — transport protocol selector (Task 20)", () => {
	it("always renders SRTLA enabled and SRT reserved (disabled with reason)", () => {
		render(ServerDialog, { props: { open: true } });

		expect(srtlaButton().disabled).toBe(false);
		expect(srtButton().disabled).toBe(true);
		expect(srtButton().getAttribute("title")).toBe("Not yet available");
	});

	it("disables RIST with a reason when the engine advertises no rist transport", () => {
		state.capabilities = { transports: ["srtla"] };

		render(ServerDialog, { props: { open: true } });

		expect(ristButton().disabled).toBe(true);
		expect(ristButton().getAttribute("title")).toBe(
			"RIST is not available on this device",
		);
	});

	it("enables RIST when the engine advertises the rist transport", () => {
		state.capabilities = { transports: ["srtla", "rist"] };

		render(ServerDialog, { props: { open: true } });

		expect(ristButton().disabled).toBe(false);
		expect(ristButton().getAttribute("title")).toBeNull();
	});

	it("selects RIST and persists relay_protocol=rist on save when available", async () => {
		state.capabilities = { transports: ["srtla", "rist"] };
		state.config = { relay_protocol: "srtla" };

		render(ServerDialog, { props: { open: true } });

		await fireEvent.click(ristButton());
		expect(ristButton().getAttribute("aria-checked")).toBe("true");

		const addr = document.getElementById("srtla-addr") as HTMLInputElement;
		const port = document.getElementById("srtla-port") as HTMLInputElement;
		await fireEvent.input(addr, { target: { value: "rist.example.com" } });
		await fireEvent.input(port, { target: { value: "5000" } });

		const save = screen.getByRole("button", { name: "Save" });
		await waitFor(() =>
			expect((save as HTMLButtonElement).disabled).toBe(false),
		);
		await fireEvent.click(save);

		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
		expect(setConfig.mock.calls[0]?.[0]).toMatchObject({
			relay_protocol: "rist",
		});
	});

	it("keeps SRTLA selected and persists relay_protocol=srtla (unaffected)", async () => {
		state.capabilities = { transports: ["srtla", "rist"] };

		render(ServerDialog, { props: { open: true } });

		expect(srtlaButton().getAttribute("aria-checked")).toBe("true");

		const addr = document.getElementById("srtla-addr") as HTMLInputElement;
		const port = document.getElementById("srtla-port") as HTMLInputElement;
		await fireEvent.input(addr, { target: { value: "srtla.example.com" } });
		await fireEvent.input(port, { target: { value: "5000" } });

		const save = screen.getByRole("button", { name: "Save" });
		await waitFor(() =>
			expect((save as HTMLButtonElement).disabled).toBe(false),
		);
		await fireEvent.click(save);

		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
		expect(setConfig.mock.calls[0]?.[0]).toMatchObject({
			relay_protocol: "srtla",
		});
	});
});
