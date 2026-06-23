/**
 * Pairing & remote-control store (Task 8 / N1).
 *
 * Covers the 3-state remote-control rollup, the multi-cloud-safe pairing reads
 * (NEVER a `=== 'ceralive'` gate), the managed-cloud gate (custom/self-hosted
 * always reachable), and the presence of the new i18n keys in every locale.
 */
import type { ProviderSelection } from "@ceraui/rpc/schemas";
import { existingLocales, loadLocale } from "@ceraui/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";

const subs = vi.hoisted(() => ({
	config: undefined as
		| { remote_key?: string; remote_provider?: ProviderSelection }
		| undefined,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => subs.config,
}));

import {
	deriveRemoteControlStatus,
	getRemoteControlStatus,
	getRemoteProvider,
	isManagedProvider,
	isPairedToCloud,
	isPairedToManagedCloud,
	resetPairingState,
	setControlChannelConnected,
} from "./pairing.svelte";

afterEach(() => {
	subs.config = undefined;
	resetPairingState();
	vi.restoreAllMocks();
});

describe("deriveRemoteControlStatus — the 3 states (pure)", () => {
	it("is not-paired when there is no remote_key (control channel ignored)", () => {
		expect(deriveRemoteControlStatus(false, false)).toBe("not-paired");
		expect(deriveRemoteControlStatus(false, true)).toBe("not-paired");
	});

	it("is paired-disconnected when paired but the control channel is down", () => {
		expect(deriveRemoteControlStatus(true, false)).toBe("paired-disconnected");
	});

	it("is connected when paired and the control channel is up", () => {
		expect(deriveRemoteControlStatus(true, true)).toBe("connected");
	});
});

describe("getRemoteControlStatus — end-to-end over config + control channel", () => {
	it("reports not-paired with no remote_key regardless of channel state", () => {
		subs.config = undefined;
		setControlChannelConnected(true);
		expect(getRemoteControlStatus()).toBe("not-paired");
	});

	it("reports paired-disconnected with a remote_key while the channel is down", () => {
		subs.config = { remote_key: "abc", remote_provider: "ceralive" };
		setControlChannelConnected(false);
		expect(getRemoteControlStatus()).toBe("paired-disconnected");
	});

	it("reports connected with a remote_key once the channel comes up", () => {
		subs.config = { remote_key: "abc", remote_provider: "belabox" };
		setControlChannelConnected(true);
		expect(getRemoteControlStatus()).toBe("connected");
	});
});

describe("pairing reads — multi-cloud safe", () => {
	it("treats any remote_key as paired, independent of provider", () => {
		subs.config = { remote_key: "k" };
		expect(isPairedToCloud()).toBe(true);
		subs.config = { remote_key: "k", remote_provider: "belabox" };
		expect(isPairedToCloud()).toBe(true);
		subs.config = undefined;
		expect(isPairedToCloud()).toBe(false);
	});

	it("never defaults the provider to ceralive when it is absent", () => {
		subs.config = { remote_key: "k" };
		expect(getRemoteProvider()).toBeUndefined();
		subs.config = { remote_key: "k", remote_provider: "belabox" };
		expect(getRemoteProvider()).toBe("belabox");
	});

	it("classifies managed providers without a single-provider gate", () => {
		expect(isManagedProvider("ceralive")).toBe(true);
		expect(isManagedProvider("belabox")).toBe(true);
		expect(isManagedProvider("custom")).toBe(false);
		expect(isManagedProvider(undefined)).toBe(false);
	});
});

describe("isPairedToManagedCloud — managed-cloud surface gate", () => {
	it("is true for a managed provider pairing (ceralive or belabox)", () => {
		subs.config = { remote_key: "k", remote_provider: "ceralive" };
		expect(isPairedToManagedCloud()).toBe(true);
		subs.config = { remote_key: "k", remote_provider: "belabox" };
		expect(isPairedToManagedCloud()).toBe(true);
	});

	it("is false for custom/self-hosted pairing (custom path stays available)", () => {
		subs.config = { remote_key: "k", remote_provider: "custom" };
		expect(isPairedToManagedCloud()).toBe(false);
	});

	it("is false when unpaired, and never gates on remote_provider alone", () => {
		subs.config = undefined;
		expect(isPairedToManagedCloud()).toBe(false);
		// A provider with no remote_key is NOT paired (e.g. stale config field).
		subs.config = { remote_provider: "ceralive" };
		expect(isPairedToManagedCloud()).toBe(false);
	});
});

describe("i18n — remote-control status keys in all 10 locales", () => {
	const KEYS = [
		"title",
		"notPaired",
		"notPairedHint",
		"disconnected",
		"disconnectedHint",
		"connected",
		"connectedHint",
	] as const;

	it("has all 10 locales registered", () => {
		expect(existingLocales).toHaveLength(10);
	});

	for (const { code } of existingLocales) {
		it(`provides every settings.remoteControl key for "${code}"`, async () => {
			const translation = (await loadLocale(code)) as {
				settings: { remoteControl: Record<string, unknown> };
			};
			const remoteControl = translation.settings.remoteControl;
			for (const key of KEYS) {
				expect(typeof remoteControl[key]).toBe("string");
				expect((remoteControl[key] as string).length).toBeGreaterThan(0);
			}
		});
	}
});
