// @vitest-environment jsdom
/**
 * StreamSettingsCard — rendered Live server row (T11).
 *
 * Complements the pure `buildServerSummary` unit tests: this suite renders the
 * actual config-row card and asserts the kind-aware summary string reaches the
 * server row's DOM text for each shape (managed / custom / RIST / none). It
 * guards the wiring between the pure helper and the rendered row, not just the
 * helper in isolation.
 */
import type { ReceiverKind } from "@ceraui/rpc/schemas";
import { Server } from "@lucide/svelte";
import { render, within } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import {
	buildServerSummary,
	type ServerSummaryConfig,
	type ServerSummaryLabels,
} from "$lib/streaming/receiver-experience";
import StreamSettingsCard, {
	type ConfigRow,
} from "./StreamSettingsCard.svelte";

const LABELS: ServerSummaryLabels = {
	notConfigured: "Not configured",
	kindLabel: (kind) =>
		({
			srtla_relay: "SRTLA · Bonded",
			srtla_custom: "SRTLA · Custom",
			rist_relay: "RIST · Managed",
			rist_custom: "RIST · Custom",
			srt_custom: "SRT · Custom",
		})[kind],
	bondedAcross: (count) => `Bonded across ${count} links`,
	singleLink: "Single link",
	providerLabel: (provider) =>
		provider === "ceralive"
			? "CeraLive Cloud"
			: provider === "belabox"
				? "BELABOX Cloud"
				: undefined,
};

function renderServerRow(
	config: ServerSummaryConfig | undefined,
	kind: ReceiverKind | undefined,
	linkCount: number,
): HTMLElement {
	const rows: ConfigRow[] = [
		{
			icon: Server,
			label: "Server",
			value: buildServerSummary(config, kind, linkCount, LABELS),
			section: "server",
			onEdit: () => {},
			testId: "open-server-dialog",
		},
	];
	const { container } = render(StreamSettingsCard, {
		configRows: rows,
		isStreaming: false,
	});
	return container;
}

describe("StreamSettingsCard — rendered Live server row (T11)", () => {
	it("renders the managed SRTLA relay summary while streaming", () => {
		const container = renderServerRow(
			{ relay_server: "fra", remote_provider: "ceralive" },
			"srtla_relay",
			3,
		);
		const expected = "CeraLive Cloud · SRTLA · Bonded · Bonded across 3 links";
		expect(within(container).getByText(expected)).toBeTruthy();
		expect(container.textContent).toContain(expected);
	});

	it("renders the custom SRTLA endpoint summary", () => {
		const container = renderServerRow(
			{ srtla_addr: "custom.example", srtla_port: 5000 },
			"srtla_custom",
			0,
		);
		expect(
			within(container).getByText("custom.example:5000 · SRTLA · Custom"),
		).toBeTruthy();
	});

	it("renders the managed RIST summary with no bonding claim", () => {
		const container = renderServerRow(
			{ relay_server: "fra", remote_provider: "belabox" },
			"rist_relay",
			4,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("BELABOX Cloud · RIST · Managed");
		expect(text).not.toContain("Bonded");
	});

	it("renders 'Not configured' when no receiver is set", () => {
		const container = renderServerRow({}, undefined, 0);
		expect(within(container).getByText("Not configured")).toBeTruthy();
	});
});
