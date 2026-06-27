// @vitest-environment jsdom
/**
 * ServerDialog — always-visible transport-protocol selector (T21).
 *
 * T21 promotes the transport-protocol radiogroup to a primary control ABOVE the
 * endpoint section (ProtocolSelector), reversing the T8/T9 "Advanced disclosure"
 * demotion. On open the radiogroup is present in the DOM with no interaction
 * required — there is no Advanced trigger to expand.
 *
 * Inside that group: SRTLA is always selectable; RIST is capability-gated
 * (disabled-with-reason until the engine advertises the `rist` transport); and
 * plain-SRT is a calm, INERT ComingSoon affordance — never a fake-interactive
 * radio (the old reserved disabled-button treatment is replaced).
 *
 * Coverage:
 *  1. On open the transport radiogroup is present — by testid AND by a
 *     role-agnostic named-role backstop — alongside the destination radiogroup.
 *  2. SRTLA always enabled; SRT is an inert ComingSoon cell (not a button/radio).
 *  3. RIST disabled-with-reason without the rist transport; enabled with it.
 *  4. Protocol persistence: picking RIST persists relay_protocol=rist; the
 *     untouched SRTLA default persists relay_protocol=srtla.
 *  5. DOM order: the radiogroup precedes #srtla-addr (custom endpoint) so the
 *     transport choice is promoted above the endpoint fields.
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
	getManagedIngestAccounts: () => [],
	getSelectedIngestEndpoint: () => undefined,
}));

// Protocol behaviour is tested with a paired managed device; the pairing gate
// itself lives in pairing.svelte.test.ts.
vi.mock("$lib/stores/pairing.svelte", () => ({
	isPairedToManagedCloud: () => true,
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

// The transport radiogroup's accessible name (aria-labelledby → visible heading)
// — distinct from the destination radiogroup, so a named-role query targets ONLY
// the transport one without depending on its data-testid (the role-agnostic
// backstop).
const TRANSPORT_GROUP = "Transport Protocol";

const ristButton = () =>
	screen.getByTestId("protocol-rist") as HTMLButtonElement;
const srtlaButton = () =>
	screen.getByTestId("protocol-srtla") as HTMLButtonElement;

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} });
});

describe("ServerDialog — always-visible transport protocol (T21)", () => {
	it("renders the transport radiogroup on open, above #srtla-addr, with no Advanced trigger", () => {
		render(ServerDialog, { props: { open: true } });

		// Promoted (T21): the radiogroup is present on open — proven by its testid
		// AND a role-agnostic named-role backstop — alongside the destination
		// radiogroup, with no Advanced disclosure to expand.
		const group = screen.getByTestId("transport-protocol");
		expect(group).toBeTruthy();
		expect(
			screen.getByRole("radiogroup", { name: TRANSPORT_GROUP }),
		).toBeTruthy();
		expect(
			screen.getByRole("radiogroup", { name: "Destination" }),
		).toBeTruthy();
		expect(
			document.querySelector('[aria-controls="transport-protocol"]'),
		).toBeNull();

		// DOM order: the promoted radiogroup precedes the custom endpoint address.
		const addr = document.getElementById("srtla-addr");
		expect(addr).not.toBeNull();
		expect(
			group.compareDocumentPosition(addr as Node) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders SRTLA enabled and SRT as an inert ComingSoon affordance (not a radio)", () => {
		render(ServerDialog, { props: { open: true } });

		// SRTLA is always selectable.
		expect(srtlaButton().disabled).toBe(false);
		expect(srtlaButton().getAttribute("role")).toBe("radio");

		// SRT is no longer a disabled button — it is a calm ComingSoon cell that
		// performs no action: not a <button>, no radio role, and carrying the
		// roadmap data-debt-id its ComingSoon pill renders.
		const srt = screen.getByTestId("protocol-srt");
		expect(srt.tagName).not.toBe("BUTTON");
		expect(srt.getAttribute("role")).not.toBe("radio");
		expect(srt.querySelector("[data-debt-id]")).not.toBeNull();
		expect(
			srt.querySelector('[data-debt-id="TD-plain-srt-egress"]'),
		).not.toBeNull();
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
