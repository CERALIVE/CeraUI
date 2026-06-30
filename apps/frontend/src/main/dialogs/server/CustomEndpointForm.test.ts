// @vitest-environment jsdom
/**
 * CustomEndpointForm — SRTLA-only minimal endpoint (receiver-coherence).
 *
 * SRTLA is the only egress transport, so the custom receiver is always an SRTLA
 * endpoint: address + port + optional stream id + optional secret + validate.
 * This suite locks that the SRTLA fields render and the removed RIST even-port
 * hint is gone.
 */
import { LL } from "@ceraui/i18n/svelte";
import { render } from "@testing-library/svelte";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

import type { Validation } from "$lib/components/streaming/relay-validation";

import CustomEndpointForm from "./CustomEndpointForm.svelte";

const t = get(LL);

function baseProps() {
	return {
		isStreaming: false,
		addr: "fra.example",
		portStr: "5000",
		streamId: "",
		passphrase: "",
		port: { min: 1, max: 65535 },
		validation: { state: "idle" } as Validation,
		canValidate: true,
		onAddr: () => {},
		onPort: () => {},
		onStreamId: () => {},
		onPassphrase: () => {},
		onValidate: () => {},
	};
}

describe("CustomEndpointForm — SRTLA-only minimal endpoint", () => {
	it("renders the SRTLA address/port/streamid/secret + validate, SRTLA-named labels", () => {
		const { container } = render(CustomEndpointForm, { props: baseProps() });

		expect(container.querySelector("#srtla-addr")).not.toBeNull();
		expect(container.querySelector("#srtla-port")).not.toBeNull();
		expect(container.querySelector("#srt-streamid")).not.toBeNull();
		expect(container.querySelector("#srtla-passphrase")).not.toBeNull();
		expect(container.querySelector("#relay-validate")).not.toBeNull();

		const addrLabel = container.querySelector('label[for="srtla-addr"]');
		expect(addrLabel?.textContent?.trim()).toBe(
			t.settings.srtlaServerAddress(),
		);
	});

	it("never shows the RIST even-port hint (RIST is coming-soon, not selectable here)", () => {
		const { container } = render(CustomEndpointForm, { props: baseProps() });
		expect(
			container.querySelector('[data-testid="rist-even-port-hint"]'),
		).toBeNull();
	});
});
