// @vitest-environment jsdom
/**
 * DestinationSection — destination-as-provider tiles (receiver-coherence).
 *
 * Three tiles (CeraLive Cloud / BELABOX Cloud / Custom). The active managed cloud
 * shows its servers description (or the D6 waiting/none hint); any other managed
 * cloud shows the "add your key" prompt. No nested provider dropdown.
 */
import { LL } from "@ceraui/i18n/svelte";
import type { RelayMessage } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import DestinationSection from "./DestinationSection.svelte";

const t = get(LL);

const relaysWithServer: RelayMessage = {
	accounts: {},
	servers: { fra: { name: "Frankfurt", protocol: "srtla" } },
};

describe("DestinationSection — three destination tiles", () => {
	it("renders CeraLive, BELABOX, and Custom tiles", () => {
		const { container } = render(DestinationSection, {
			props: {
				selected: "ceralive",
				activeProvider: "ceralive",
				isStreaming: false,
				relays: relaysWithServer,
				onSelect: () => {},
			},
		});
		expect(
			container.querySelector('[data-testid="destination-ceralive"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="destination-belabox"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="destination-custom"]'),
		).not.toBeNull();
	});

	it("never renders a nested provider dropdown (guards the nesting regression)", () => {
		const { container } = render(DestinationSection, {
			props: {
				selected: "ceralive",
				activeProvider: "ceralive",
				isStreaming: false,
				relays: relaysWithServer,
				onSelect: () => {},
			},
		});
		expect(
			container.querySelector('[data-testid="relay-provider"]'),
		).toBeNull();
	});

	it("the active cloud shows its servers hint; an inactive cloud shows the add-key hint", () => {
		const { container } = render(DestinationSection, {
			props: {
				selected: "ceralive",
				activeProvider: "ceralive",
				isStreaming: false,
				relays: relaysWithServer,
				onSelect: () => {},
			},
		});
		const ceralive = container.querySelector(
			'[data-testid="destination-ceralive"]',
		);
		const belabox = container.querySelector(
			'[data-testid="destination-belabox"]',
		);
		expect(ceralive?.textContent).toContain(
			t.settings.destinationManagedHint(),
		);
		expect(belabox?.textContent).toContain(
			t.settings.destinationNeedsKey({ cloud: "BELABOX Cloud" }),
		);
	});

	it("selecting BELABOX fires onSelect('belabox')", async () => {
		const onSelect = vi.fn();
		const { container } = render(DestinationSection, {
			props: {
				selected: "ceralive",
				activeProvider: "ceralive",
				isStreaming: false,
				relays: relaysWithServer,
				onSelect,
			},
		});
		const belabox = container.querySelector(
			'[data-testid="destination-belabox"]',
		) as HTMLButtonElement;
		await fireEvent.click(belabox);
		expect(onSelect).toHaveBeenCalledWith("belabox");
	});

	it("gates the active cloud with the waiting hint while the catalog is loading (D6)", () => {
		const { container } = render(DestinationSection, {
			props: {
				selected: "ceralive",
				activeProvider: "ceralive",
				isStreaming: false,
				relays: undefined,
				onSelect: () => {},
			},
		});
		const ceralive = container.querySelector(
			'[data-testid="destination-ceralive"]',
		) as HTMLButtonElement;
		expect(ceralive.disabled).toBe(true);
		expect(ceralive.textContent).toContain(t.notifications.relayWaiting());
	});
});
