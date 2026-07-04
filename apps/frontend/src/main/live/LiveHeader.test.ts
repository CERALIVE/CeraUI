// @vitest-environment jsdom
import { getLL } from "@ceraui/i18n/svelte";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import LiveHeader from "./LiveHeader.svelte";

describe("LiveHeader — demoted to title + live-state chip (T12)", () => {
	it("renders the not-streaming chip + title when idle, with NO server chip", () => {
		const { container, getByText } = render(LiveHeader, {
			props: { isStreaming: false },
		});
		const L = getLL();
		expect(getByText(L.live.notStreaming())).toBeTruthy();
		expect(getByText(L.live.title())).toBeTruthy();
		// The server-edit chip was removed — destination now lives in the
		// GoLiveCard traffic-light row (T10/T12).
		expect(
			container.querySelector('[data-testid="live-server-chip"]'),
		).toBeNull();
	});

	it("renders the active streaming chip when live", () => {
		const { getByText } = render(LiveHeader, { props: { isStreaming: true } });
		const L = getLL();
		expect(getByText(L.live.streamingActive())).toBeTruthy();
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
