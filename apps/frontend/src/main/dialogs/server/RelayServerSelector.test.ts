// @vitest-environment jsdom
/**
 * RelayServerSelector — fetched servers only (receiver-coherence).
 *
 * The destination IS the provider, so this no longer hosts a provider picker, a
 * manual-endpoint override, or a transport chooser. It renders the fetched server
 * selector, the read-only auto endpoint, the optional account, and the stream id.
 */
import type { RelayServer } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import RelayServerSelector from "./RelayServerSelector.svelte";

function baseProps() {
	const serverEntries: [string, RelayServer][] = [
		[
			"fra",
			{ name: "Frankfurt", protocol: "srtla", addr: "fra.example", port: 5000 },
		],
	];
	return {
		isStreaming: false,
		relaysUnavailable: false,
		relayServer: "fra",
		relayServerName: "Frankfurt",
		relayServerEndpoint: "fra.example:5000",
		serverEntries,
		accountEntries: [] as [string, { name: string }][],
		relayAccount: "",
		relayStreamId: "",
		onServer: () => {},
		onAccount: () => {},
		onRelayStreamId: () => {},
	};
}

describe("RelayServerSelector — fetched servers only", () => {
	it("renders the server selector, auto endpoint, and stream-id input", () => {
		const { container } = render(RelayServerSelector, { props: baseProps() });
		expect(container.querySelector("#relay-server")).not.toBeNull();
		expect(container.querySelector("#relay-endpoint")?.textContent).toContain(
			"fra.example:5000",
		);
		expect(container.querySelector("#relay-streamid")).not.toBeNull();
	});

	it("never renders the provider picker, manual-override toggle, or transport chooser", () => {
		const { container } = render(RelayServerSelector, { props: baseProps() });
		expect(
			container.querySelector('[data-testid="relay-provider"]'),
		).toBeNull();
		expect(container.querySelector("#relay-manual-override")).toBeNull();
		expect(
			container.querySelector('[data-testid="relay-transport-kind"]'),
		).toBeNull();
	});
});
