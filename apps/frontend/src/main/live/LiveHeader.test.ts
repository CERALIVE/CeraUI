// @vitest-environment jsdom
import { getLL } from "@ceraui/i18n/svelte";
import type { ReceiverKind } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import LiveHeader from "./LiveHeader.svelte";

type HeaderProps = {
	isStreaming: boolean;
	hasServer: boolean;
	destination: "managed" | "custom" | undefined;
	kind: ReceiverKind | undefined;
	providerName: string | undefined;
	slotLabel: string | undefined;
	endpoint: string | undefined;
	onEditServer: () => void;
};

const base: HeaderProps = {
	isStreaming: false,
	hasServer: true,
	destination: "managed",
	kind: "srtla_relay",
	providerName: "CeraLive Cloud",
	slotLabel: undefined,
	endpoint: undefined,
	onEditServer: () => {},
};

function chipText(container: HTMLElement): string {
	return (
		container
			.querySelector('[data-testid="live-server-chip-text"]')
			?.textContent?.trim() ?? ""
	);
}

describe("LiveHeader — destination/kind-aware chip (T12)", () => {
	it("managed renders '<provider> · <kind badge>'", () => {
		const { container } = render(LiveHeader, { props: base });
		// "SRTLA · Bonded" is the en live.server.kind.srtlaRelay badge.
		expect(chipText(container)).toBe("CeraLive Cloud · SRTLA · Bonded");
	});

	it("managed RIST relay uses the RIST · Managed badge + provider", () => {
		const { container } = render(LiveHeader, {
			props: {
				...base,
				kind: "rist_relay",
				providerName: "BELABOX Cloud",
			},
		});
		expect(chipText(container)).toBe("BELABOX Cloud · RIST · Managed");
	});

	it("custom renders '<addr>:<port> · <kind badge>'", () => {
		const { container } = render(LiveHeader, {
			props: {
				...base,
				destination: "custom",
				kind: "srtla_custom",
				providerName: undefined,
				endpoint: "192.168.1.50:5000",
			},
		});
		expect(chipText(container)).toBe("192.168.1.50:5000 · SRTLA · Custom");
	});

	it("custom SRT renders the SRT · Custom badge", () => {
		const { container } = render(LiveHeader, {
			props: {
				...base,
				destination: "custom",
				kind: "srt_custom",
				providerName: undefined,
				endpoint: "host.example:4000",
			},
		});
		expect(chipText(container)).toBe("host.example:4000 · SRT · Custom");
	});

	it("an active managed slot names the instance ahead of the provider", () => {
		const { container } = render(LiveHeader, {
			props: { ...base, slotLabel: "Studio A" },
		});
		expect(chipText(container)).toBe("Studio A · SRTLA · Bonded");
	});

	it("none (no server) renders the calm 'Not configured' chip", () => {
		const { container } = render(LiveHeader, {
			props: {
				...base,
				hasServer: false,
				destination: undefined,
				kind: undefined,
				providerName: undefined,
				endpoint: undefined,
			},
		});
		expect(chipText(container)).toBe("Not configured");
		const chip = container.querySelector<HTMLElement>(
			'[data-testid="live-server-chip"]',
		);
		expect(chip?.getAttribute("data-destination")).toBe("none");
	});
});

describe("LiveHeader — edit affordance (T12)", () => {
	it("keeps a >=44px touch target and fires onEditServer on click", async () => {
		const onEditServer = vi.fn();
		const { container } = render(LiveHeader, {
			props: { ...base, onEditServer },
		});
		const chip = container.querySelector<HTMLButtonElement>(
			'[data-testid="live-server-chip"]',
		);
		if (!chip) throw new Error("server chip not rendered");
		// 44px minimum touch target preserved (kiosk/touch contract).
		expect(chip.className).toContain("min-h-[44px]");
		await fireEvent.click(chip);
		expect(onEditServer).toHaveBeenCalledTimes(1);
	});
});

describe("LiveView empty state — destination-first copy contract (T12)", () => {
	it("uses destination-first English copy keys", () => {
		// LiveView's empty state renders these two keys; asserted via the app's
		// en-backed $LL proxy (LiveView itself is too dep-heavy to mount in a unit).
		const L = getLL();
		expect(L.live.chooseDestination()).toBe("Choose a destination");
		expect(L.settings.destinationCustomHint()).toBe(
			"Enter your own receiver address and port.",
		);
	});
});
