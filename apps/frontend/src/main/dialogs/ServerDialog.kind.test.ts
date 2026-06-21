// @vitest-environment jsdom
/**
 * ServerDialog — receiver kinds, field-lock coverage, and completeness (T10).
 *
 * The destination-first dialog (T9) derives a receiver KIND (transport ×
 * destination) and persists exactly the field set `buildServerSetConfig` (T5)
 * returns. This suite locks three things the older suites never asserted:
 *
 *  (ii) Lock-coverage — the field set locked via `markPending` BEFORE the RPC is
 *       EXACTLY `Object.keys(buildServerSetConfig(draft, derived))` for the
 *       manual / relay / override branches (including the empty
 *       `relay_streamid_override: ''` case). Proves lock set == sent set, so a
 *       stale server echo can never revert a saved field and no field is left
 *       permanently locked.
 *  - Streaming-lock — a live stream disables every control (NEW).
 *  - Kind behaviour — `srt_custom` blocks Save; SRTLA saves without a stream id;
 *    a managed RIST endpoint badges as `rist_relay`; a multi-transport server's
 *    `protocols[]` round-trips the chosen protocol; per-kind field visibility.
 *  - Completeness (a–f) — override-reload config, a11y roles + Advanced
 *    aria-expanded, save-failure lock release, engine-offline neutrality, and
 *    legacy (no `relay_protocol`) configs.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildServerSetConfig,
	type ServerSetDerived,
	type ServerSetDraft,
} from "$lib/streaming/receiver-experience";
import ServerDialog from "./ServerDialog.svelte";

type ServerInfo = {
	name: string;
	rtt?: number;
	default?: true;
	addr?: string;
	port?: number;
	protocol?: string;
	protocols?: string[];
};

const state = vi.hoisted(() => ({
	config: undefined as
		| {
				relay_server?: string;
				relay_protocol?: string;
				relay_account?: string;
				relay_streamid_override?: string;
				srtla_addr?: string;
				srtla_port?: number;
				srt_streamid?: string;
				srt_latency?: number;
				remote_provider?: string;
		  }
		| undefined,
	relays: undefined as
		| {
				accounts: Record<string, { name: string }>;
				servers: Record<string, ServerInfo>;
		  }
		| undefined,
	isStreaming: false,
	capabilities: undefined as { transports?: string[] } | undefined,
}));

const setConfig = vi.hoisted(() => vi.fn());
const relayValidate = vi.hoisted(() => vi.fn());
const markPending = vi.hoisted(() => vi.fn());
const onRpcResolved = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
	getRelays: () => state.relays,
	getIsStreaming: () => state.isStreaming,
	getCapabilities: () => state.capabilities,
	getManagedIngestAccounts: () => [],
	getSelectedIngestEndpoint: () => undefined,
}));

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig }, relay: { validate: relayValidate } },
}));

vi.mock("$lib/rpc/dirty-registry.svelte", () => ({
	markPending,
	onRpcResolved,
}));

vi.mock("svelte-sonner", () => ({ toast }));

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

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} });
	relayValidate.mockReset();
	relayValidate.mockResolvedValue({ valid: true, stage: "probe" });
	markPending.mockReset();
	onRpcResolved.mockReset();
	toast.success.mockReset();
	toast.error.mockReset();
});

// Field names a mock (markPending / onRpcResolved) was called with, sorted.
const lockedFields = (fn: ReturnType<typeof vi.fn>): string[] =>
	fn.mock.calls.map((call) => call[0] as string).sort();

const saveButton = () =>
	screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

const advancedTrigger = () =>
	document.querySelector(
		'[aria-controls="transport-protocol"]',
	) as HTMLButtonElement;

async function expandAdvanced() {
	await fireEvent.click(advancedTrigger());
	await waitFor(() =>
		expect(screen.getByTestId("transport-protocol")).toBeTruthy(),
	);
}

async function typeInto(id: string, value: string) {
	const el = document.getElementById(id) as HTMLInputElement;
	await fireEvent.input(el, { target: { value } });
}

// A complete in-test draft mirroring the dialog's handleSave draftValues; each
// scenario overrides only the fields its branch reads. `latency` is irrelevant to
// the KEY set (srt_latency is always present), so a fixed value is fine.
function draftOf(overrides: Partial<ServerSetDraft> = {}): ServerSetDraft {
	return {
		latency: 2000,
		protocol: "srtla",
		addr: "",
		portStr: "",
		streamId: "",
		overrideAddr: "",
		overridePortStr: "",
		relayStreamId: "",
		relayServer: "",
		relayAccount: "",
		...overrides,
	};
}

describe("ServerDialog — field-lock coverage (T10 ii)", () => {
	it("locks EXACTLY the manual-branch keys buildServerSetConfig sends", async () => {
		render(ServerDialog, { props: { open: true } });

		await typeInto("srtla-addr", "custom.example");
		await typeInto("srtla-port", "5000");

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());
		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));

		const derived: ServerSetDerived = {
			destination: "custom",
			relayOverride: false,
		};
		const expected = buildServerSetConfig(
			draftOf({ addr: "custom.example", portStr: "5000" }),
			derived,
		);
		const expectedKeys = Object.keys(expected).sort();

		// Lock set == buildServerSetConfig keys == the set actually sent.
		expect(lockedFields(markPending)).toEqual(expectedKeys);
		expect(Object.keys(setConfig.mock.calls[0]?.[0]).sort()).toEqual(
			expectedKeys,
		);
		// Released after settle — no permanent lock.
		expect(lockedFields(onRpcResolved)).toEqual(expectedKeys);
	});

	it("locks EXACTLY the relay-branch keys (incl. empty relay_streamid_override)", async () => {
		state.relays = {
			accounts: {},
			servers: { "srv-eu": { name: "EU West", default: true } },
		};
		state.config = { relay_server: "srv-eu" };

		render(ServerDialog, { props: { open: true } });

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());
		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));

		const derived: ServerSetDerived = {
			destination: "managed",
			relayOverride: false,
		};
		const expected = buildServerSetConfig(
			draftOf({ relayServer: "srv-eu" }),
			derived,
		);
		const expectedKeys = Object.keys(expected).sort();

		// The relay branch carries relay_streamid_override even though it is '',
		// and omits relay_account because none is selected.
		expect(expected).toHaveProperty("relay_streamid_override", "");
		expect(expected).not.toHaveProperty("relay_account");

		expect(lockedFields(markPending)).toEqual(expectedKeys);
		expect(Object.keys(setConfig.mock.calls[0]?.[0]).sort()).toEqual(
			expectedKeys,
		);
		expect(lockedFields(onRpcResolved)).toEqual(expectedKeys);
	});

	it("locks EXACTLY the override-branch keys (incl. empty relay_streamid_override)", async () => {
		state.relays = {
			accounts: {},
			servers: {
				"srv-eu": { name: "EU West", addr: "eu.relay", port: 5000 },
			},
		};
		state.config = { relay_server: "srv-eu" };

		render(ServerDialog, { props: { open: true } });

		// Flip the managed endpoint into manual-override and type a fresh endpoint.
		await fireEvent.click(
			document.getElementById("relay-manual-override") as HTMLElement,
		);
		await typeInto("relay-override-addr", "ovr.example");
		await typeInto("relay-override-port", "7000");

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());
		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));

		const derived: ServerSetDerived = {
			destination: "managed",
			relayOverride: true,
		};
		const expected = buildServerSetConfig(
			draftOf({ overrideAddr: "ovr.example", overridePortStr: "7000" }),
			derived,
		);
		const expectedKeys = Object.keys(expected).sort();

		expect(expected).toHaveProperty("relay_streamid_override", "");
		expect(lockedFields(markPending)).toEqual(expectedKeys);
		expect(Object.keys(setConfig.mock.calls[0]?.[0]).sort()).toEqual(
			expectedKeys,
		);
		expect(lockedFields(onRpcResolved)).toEqual(expectedKeys);
	});
});

describe("ServerDialog — kind behaviour (T10)", () => {
	it("disables every control while a stream is live (streaming-lock)", () => {
		state.isStreaming = true;

		render(ServerDialog, { props: { open: true } });

		expect(
			(screen.getByTestId("destination-managed") as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(screen.getByTestId("destination-custom") as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(document.getElementById("srtla-addr") as HTMLInputElement).disabled,
		).toBe(true);
		expect(saveButton().disabled).toBe(true);
		// The stop-to-change banner explains the lock.
		expect(screen.getByText("Stop stream to change")).toBeTruthy();
	});

	it("blocks Save for the reserved srt_custom kind even with a valid endpoint", async () => {
		state.config = { relay_protocol: "srt" };

		render(ServerDialog, { props: { open: true } });

		await typeInto("srtla-addr", "srt.example");
		await typeInto("srtla-port", "5000");

		// A valid addr/port would normally enable Save — but srt_custom is reserved.
		expect(saveButton().disabled).toBe(true);
	});

	it("saves an SRTLA custom endpoint WITHOUT a stream id (no regression)", async () => {
		render(ServerDialog, { props: { open: true } });

		await typeInto("srtla-addr", "srtla.example");
		await typeInto("srtla-port", "5000");
		// Deliberately leave the stream id empty.

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());

		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
		const sent = setConfig.mock.calls[0]?.[0];
		expect(sent).toMatchObject({
			relay_protocol: "srtla",
			srtla_addr: "srtla.example",
			srt_streamid: "",
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("badges a managed RIST endpoint as rist_relay", () => {
		state.capabilities = { transports: ["srtla", "rist"] };
		state.relays = {
			accounts: {},
			servers: {
				"srv-eu": { name: "EU West", protocol: "rist", addr: "eu", port: 5000 },
			},
		};
		state.config = { relay_server: "srv-eu", relay_protocol: "rist" };

		render(ServerDialog, { props: { open: true } });

		const badge = screen.getByTestId("transport-badge");
		expect(badge.textContent).toContain("RIST · Managed");
	});

	it("round-trips a multi-transport server's chosen protocol (protocols[] → relay_protocol)", async () => {
		state.capabilities = { transports: ["srtla", "rist"] };
		state.relays = {
			accounts: {},
			servers: {
				"srv-multi": {
					name: "Multi",
					protocol: "srtla",
					protocols: ["srtla", "rist"],
					addr: "multi",
					port: 5000,
				},
			},
		};
		state.config = { relay_server: "srv-multi", relay_protocol: "srtla" };

		render(ServerDialog, { props: { open: true } });

		// The per-server transport chooser only shows for multi-transport servers.
		const ristChoice = screen.getByTestId("relay-protocol-rist");
		await fireEvent.click(ristChoice);
		expect(ristChoice.getAttribute("aria-checked")).toBe("true");

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());

		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
		expect(setConfig.mock.calls[0]?.[0]).toMatchObject({
			relay_protocol: "rist",
		});
	});

	it("passes the derived protocol (not a hardcoded 'srtla') to relay.validate for a RIST custom endpoint", async () => {
		state.capabilities = { transports: ["srtla", "rist"] };
		state.config = { relay_protocol: "rist" };

		render(ServerDialog, { props: { open: true } });

		await typeInto("srtla-addr", "rist.example");
		await typeInto("srtla-port", "5000");

		const validateBtn = document.getElementById(
			"relay-validate",
		) as HTMLButtonElement;
		await waitFor(() => expect(validateBtn.disabled).toBe(false));
		await fireEvent.click(validateBtn);

		await waitFor(() => expect(relayValidate).toHaveBeenCalledTimes(1));
		expect(relayValidate.mock.calls[0]?.[0]).toMatchObject({
			addr: "rist.example",
			protocol: "rist",
		});
	});

	it("passes protocol 'srtla' to relay.validate for an SRTLA custom endpoint (no regression)", async () => {
		render(ServerDialog, { props: { open: true } });

		await typeInto("srtla-addr", "srtla.example");
		await typeInto("srtla-port", "5000");

		const validateBtn = document.getElementById(
			"relay-validate",
		) as HTMLButtonElement;
		await waitFor(() => expect(validateBtn.disabled).toBe(false));
		await fireEvent.click(validateBtn);

		await waitFor(() => expect(relayValidate).toHaveBeenCalledTimes(1));
		expect(relayValidate.mock.calls[0]?.[0]).toMatchObject({
			protocol: "srtla",
		});
	});

	it("labels the address/port generically for rist_custom and SRTLA-specifically for srtla_custom", () => {
		// srtla_custom: SRTLA-specific labels.
		const srtla = render(ServerDialog, { props: { open: true } });
		expect(
			document.querySelector('label[for="srtla-addr"]')?.textContent?.trim(),
		).toBe("SRTLA receiver server address");
		expect(
			document.querySelector('label[for="srtla-port"]')?.textContent?.trim(),
		).toBe("SRTLA receiver port");
		srtla.unmount();

		// rist_custom: generic receiver labels (a RIST receiver is not SRTLA).
		state.capabilities = { transports: ["srtla", "rist"] };
		state.config = { relay_protocol: "rist" };
		render(ServerDialog, { props: { open: true } });
		expect(
			document.querySelector('label[for="srtla-addr"]')?.textContent?.trim(),
		).toBe("Receiver address");
		expect(
			document.querySelector('label[for="srtla-port"]')?.textContent?.trim(),
		).toBe("Receiver port");
	});

	it("shows a generic 'receiver address' required error for rist_custom (not the SRTLA one)", async () => {
		state.capabilities = { transports: ["srtla", "rist"] };
		state.config = { relay_protocol: "rist" };

		render(ServerDialog, { props: { open: true } });

		// Type then clear the address to trigger the required error.
		await typeInto("srtla-addr", "x");
		await typeInto("srtla-addr", "");

		await waitFor(() =>
			expect(
				screen.getByText("Please enter the receiver address"),
			).toBeTruthy(),
		);
		expect(
			screen.queryByText("Please enter the SRTLA server address"),
		).toBeNull();
	});

	it("shows the secret field for srtla_custom and hides it (with even-port hint) for rist_custom", () => {
		// srtla_custom: addr/port/streamid/secret all present.
		const srtla = render(ServerDialog, { props: { open: true } });
		expect(document.getElementById("srtla-addr")).not.toBeNull();
		expect(document.getElementById("srtla-port")).not.toBeNull();
		expect(document.getElementById("srt-streamid")).not.toBeNull();
		expect(document.getElementById("srtla-passphrase")).not.toBeNull();
		expect(screen.queryByTestId("rist-even-port-hint")).toBeNull();
		srtla.unmount();

		// rist_custom: no SRT passphrase, but an even-port hint.
		state.capabilities = { transports: ["srtla", "rist"] };
		state.config = { relay_protocol: "rist" };
		render(ServerDialog, { props: { open: true } });
		expect(document.getElementById("srtla-addr")).not.toBeNull();
		expect(document.getElementById("srt-streamid")).not.toBeNull();
		expect(document.getElementById("srtla-passphrase")).toBeNull();
		expect(screen.getByTestId("rist-even-port-hint")).toBeTruthy();
	});
});

describe("ServerDialog — completeness (T10 a–f)", () => {
	it("(a) preselects custom and prefills the addr for an override-reload config (no relay_server)", () => {
		state.config = { srtla_addr: "1.2.3.4", srtla_port: 5000 };

		render(ServerDialog, { props: { open: true } });

		expect(
			screen.getByTestId("destination-custom").getAttribute("aria-checked"),
		).toBe("true");
		expect(
			(document.getElementById("srtla-addr") as HTMLInputElement).value,
		).toBe("1.2.3.4");
		// No relay selector while custom is the destination.
		expect(document.getElementById("relay-server")).toBeNull();
	});

	it("(b) exposes radio/radiogroup roles and toggles the Advanced trigger aria-expanded", async () => {
		render(ServerDialog, { props: { open: true } });

		expect(
			screen.getByRole("radiogroup", { name: "Destination" }),
		).toBeTruthy();
		expect(screen.getByTestId("destination-managed").getAttribute("role")).toBe(
			"radio",
		);
		expect(screen.getByTestId("destination-custom").getAttribute("role")).toBe(
			"radio",
		);

		expect(advancedTrigger().getAttribute("aria-expanded")).toBe("false");
		await expandAdvanced();
		expect(advancedTrigger().getAttribute("aria-expanded")).toBe("true");
	});

	it("(c) shows relayNone (empty catalog) — distinct from relayWaiting (undefined)", () => {
		state.relays = { accounts: {}, servers: {} };

		render(ServerDialog, { props: { open: true } });

		expect(screen.getByText("No relay servers available")).toBeTruthy();
		expect(screen.queryByText("Waiting for relay servers\u2026")).toBeNull();
	});

	it("(d) on save failure shows toast.error, releases every locked field, and keeps the dialog open", async () => {
		setConfig.mockReset();
		setConfig.mockRejectedValueOnce(new Error("boom"));

		render(ServerDialog, { props: { open: true } });

		await typeInto("srtla-addr", "custom.example");
		await typeInto("srtla-port", "5000");

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());

		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));

		// Every field locked before the RPC is released in the finally block, so
		// nothing stays permanently locked after a failed save.
		const sentKeys = Object.keys(setConfig.mock.calls[0]?.[0]).sort();
		expect(lockedFields(markPending)).toEqual(sentKeys);
		expect(lockedFields(onRpcResolved)).toEqual(sentKeys);

		// The dialog stays open so the operator can retry.
		expect(screen.getByTestId("destination")).toBeTruthy();
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("(e) drops to a neutral badge and disables RIST-with-reason while the engine is offline", async () => {
		state.capabilities = undefined;

		render(ServerDialog, { props: { open: true } });

		const badge = screen.getByTestId("transport-badge");
		expect(badge.getAttribute("data-engine-online")).toBe("false");
		// Neutral = bare acronym, never a stale "SRTLA · Bonded/Custom" claim.
		expect(badge.textContent).toContain("SRTLA");
		expect(badge.textContent).not.toContain("\u00b7");

		await expandAdvanced();
		const rist = screen.getByTestId("protocol-rist") as HTMLButtonElement;
		expect(rist.disabled).toBe(true);
		expect(rist.getAttribute("title")).toBe(
			"RIST is not available on this device",
		);
	});

	it("(f) treats a legacy config with no relay_protocol as custom srtla", () => {
		state.capabilities = { transports: ["srtla"] };
		state.config = {};

		render(ServerDialog, { props: { open: true } });

		expect(
			screen.getByTestId("destination-custom").getAttribute("aria-checked"),
		).toBe("true");
		// Legacy (no relay_protocol) coerces to SRTLA → srtla_custom badge label.
		expect(screen.getByTestId("transport-badge").textContent).toContain(
			"SRTLA",
		);
		// srtla_custom exposes the secret field.
		expect(document.getElementById("srtla-passphrase")).not.toBeNull();
	});
});
