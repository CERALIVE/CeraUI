import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	buildManagedSlotConfig,
	buildServerSummary,
	deriveDestination,
	obsInstanceAssociation,
	parseIngestSlots,
	resolveReceiverKind,
	type ServerSummaryLabels,
} from "./receiver-experience";

function loadFixture(name: string): unknown {
	const url = new URL(`../../../tests/fixtures/${name}`, import.meta.url);
	return JSON.parse(readFileSync(url, "utf8"));
}

const FEEDS_PREFIX = "feeds cloud OBS instance: ";

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
	providerLabel: () => undefined,
	feedsCloudObsInstance: (label) => `${FEEDS_PREFIX}${label}`,
};

/**
 * Build the Live server summary the way the dialog does: derive destination/kind
 * from the slot's persisted config, then pass the resolved slot as the active one.
 */
function summaryForSlot(
	account: ReturnType<typeof parseIngestSlots>[number],
): string {
	const config = buildManagedSlotConfig(account, 2000);
	const destination = deriveDestination(config);
	const kind = resolveReceiverKind({ protocol: "srtla", destination });
	return buildServerSummary(config, kind, 0, LABELS, account);
}

describe("OBS-instance ingest association (T17) — wire fixture contract", () => {
	it("parses a BOUND slot and surfaces the cloud-OBS association line", () => {
		const accounts = parseIngestSlots(loadFixture("managed-slot-bound.json"));
		expect(accounts).toHaveLength(1);
		const account = accounts[0];
		if (!account) throw new Error("expected a parsed bound slot");

		// Wire metadata carried through the real parse.
		expect(account.endpointId).toBe("ep-studio-alpha");
		expect(account.key).toBe("publish/studio-alpha");
		expect(account.obsInstanceId).toBe("obs-7c1f2a9e");
		expect(account.instanceLabel).toBe("Studio Alpha");

		expect(obsInstanceAssociation(account)).toEqual({ label: "Studio Alpha" });

		const summary = summaryForSlot(account);
		expect(summary).toContain(`${FEEDS_PREFIX}Studio Alpha`);
		expect(summary).not.toContain("undefined");
	});

	it("parses an UNBOUND slot and renders NO association line (no 'undefined')", () => {
		const accounts = parseIngestSlots(loadFixture("managed-slot-unbound.json"));
		expect(accounts).toHaveLength(1);
		const account = accounts[0];
		if (!account) throw new Error("expected a parsed unbound slot");

		// Unbound: obsInstanceId null, no instanceLabel; label falls back to id.
		expect(account.obsInstanceId).toBeNull();
		expect(account.instanceLabel).toBeUndefined();
		expect(account.label).toBe("ep-unbound-1");

		expect(obsInstanceAssociation(account)).toBeUndefined();

		const summary = summaryForSlot(account);
		expect(summary).not.toContain(FEEDS_PREFIX);
		expect(summary).not.toContain("undefined");
	});
});
