// @vitest-environment jsdom
/**
 * CustomEndpointForm — top-down reshape from the selected protocol (T22).
 *
 * The ProtocolSelector above writes the transport; ServerDialog resolves it to a
 * receiver `kind` and passes it here. This suite locks that the field set AND the
 * labels reshape reactively when the kind flips between the two custom transports
 * the operator can pick directly:
 *   • srtla_custom → secret input present (#srtla-passphrase), SRTLA-named labels,
 *     no even-port hint.
 *   • rist_custom  → secret input GONE (RIST simple-profile has no passphrase),
 *     receiver-named labels, even-port hint present.
 * The labels and field set are driven by `receiverKindManifest(kind)`, so a kind
 * change must switch both in lock-step — that is the regression this guards.
 */
import { LL } from "@ceraui/i18n/svelte";
import type { ReceiverKind } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

import type { Validation } from "$lib/components/streaming/relay-validation";

import CustomEndpointForm from "./CustomEndpointForm.svelte";

const t = get(LL);

function baseProps(kind: ReceiverKind) {
	return {
		kind,
		isStreaming: false,
		addr: "",
		portStr: "",
		streamId: "",
		passphrase: "",
		port: { min: 1, max: 65535 },
		validation: { state: "idle" } as Validation,
		canValidate: false,
		onAddr: () => {},
		onPort: () => {},
		onStreamId: () => {},
		onPassphrase: () => {},
		onValidate: () => {},
	};
}

function addressLabelText(container: HTMLElement): string {
	const label = container.querySelector('label[for="srtla-addr"]');
	expect(label, "address label must render").not.toBeNull();
	return label?.textContent?.trim() ?? "";
}

describe("CustomEndpointForm — protocol-driven field set + labels (T22)", () => {
	it("SRTLA custom: shows the secret input, SRTLA address label, no even-port hint", () => {
		const { container } = render(CustomEndpointForm, {
			props: baseProps("srtla_custom"),
		});

		expect(container.querySelector("#srtla-passphrase")).not.toBeNull();
		expect(addressLabelText(container)).toBe(t.settings.srtlaServerAddress());
		expect(
			container.querySelector('[data-testid="rist-even-port-hint"]'),
		).toBeNull();
	});

	it("RIST custom: hides the secret input, receiver address label, shows even-port hint", () => {
		const { container } = render(CustomEndpointForm, {
			props: baseProps("rist_custom"),
		});

		expect(container.querySelector("#srtla-passphrase")).toBeNull();
		expect(addressLabelText(container)).toBe(t.settings.receiverAddress());
		expect(
			container.querySelector('[data-testid="rist-even-port-hint"]'),
		).not.toBeNull();
	});

	it("switching SRTLA -> RIST toggles #srtla-passphrase off and flips the address label reactively", async () => {
		const { container, rerender } = render(CustomEndpointForm, {
			props: baseProps("srtla_custom"),
		});

		// Given the SRTLA transport: secret present, SRTLA-named address label.
		expect(container.querySelector("#srtla-passphrase")).not.toBeNull();
		expect(addressLabelText(container)).toBe(t.settings.srtlaServerAddress());

		// When the protocol above flips to RIST (kind prop changes).
		await rerender(baseProps("rist_custom"));

		// Then the passphrase field is gone and the label re-derives to receiver naming.
		expect(container.querySelector("#srtla-passphrase")).toBeNull();
		expect(addressLabelText(container)).toBe(t.settings.receiverAddress());
		expect(
			container.querySelector('[data-testid="rist-even-port-hint"]'),
		).not.toBeNull();
	});

	it("switching RIST -> SRTLA toggles #srtla-passphrase back on and flips the address label reactively", async () => {
		const { container, rerender } = render(CustomEndpointForm, {
			props: baseProps("rist_custom"),
		});

		// Given the RIST transport: no secret, receiver-named address label.
		expect(container.querySelector("#srtla-passphrase")).toBeNull();
		expect(addressLabelText(container)).toBe(t.settings.receiverAddress());

		// When the protocol above flips back to SRTLA.
		await rerender(baseProps("srtla_custom"));

		// Then the passphrase field returns and the label re-derives to SRTLA naming.
		expect(container.querySelector("#srtla-passphrase")).not.toBeNull();
		expect(addressLabelText(container)).toBe(t.settings.srtlaServerAddress());
		expect(
			container.querySelector('[data-testid="rist-even-port-hint"]'),
		).toBeNull();
	});
});
