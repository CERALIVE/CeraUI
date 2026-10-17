import { expect } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import { run } from "../../helpers/run.ts";
import type { AptRoutingEntry } from "../../modules/system/apt-routing-journal.ts";
import { aptRoutingEntrySchema } from "../../modules/system/apt-routing-journal.ts";
import {
	AptRoutingRefusal,
	createAptRoutingOwnership,
} from "../../modules/system/apt-routing-ownership.ts";
import {
	openPinnedAptTransaction,
	setAptTransportDepsForTest,
} from "../../modules/system/apt-transport.ts";
import { rankTransports } from "../../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../../modules/system/update-transport/pin.ts";
import capturedJournal from "../fixtures/apt-routing-captured-journal.json";
import { PINNED_CAPABILITIES, sample } from "./apt-transport-fixture.ts";

export async function vanishedDeviceCase(name: string): Promise<void> {
	// Given the real transfer's crash journal, or a second modem-like live uplink.
	let entries: readonly AptRoutingEntry[] =
		name === "A3"
			? []
			: capturedJournal.map((row) => aptRoutingEntrySchema.parse(row));
	const owner = createAptRoutingOwnership({
		read: async () => entries,
		save: (next) => {
			entries = next;
		},
	});
	const links = await run("ip", ["-o", "link", "show"]);
	if (name === "A2") expect(links.trim().split("\n")).toHaveLength(1);
	let transfer: unknown;
	if (name === "A3") {
		const pin = createUpdatePinController({
			readCapabilities: async () =>
				updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
		});
		await pin.sweep();
		setAptTransportDepsForTest({
			select: async () => rankTransports([sample("eth1", "ethernet", 4)]),
			pin,
			ownership: owner,
		});
		try {
			const tx = await openPinnedAptTransaction();
			// When the selected modem disappears inside the actual transfer step.
			transfer = await tx.transfer(async () => {
				await run("ip", ["link", "del", "eth1"]);
				return { exitCode: 0, stdout: "fetched", stderr: "" };
			});
		} finally {
			setAptTransportDepsForTest(null);
		}
	}
	const retained = entries;
	const outcomes: string[] = [];
	// When admission reconciles the same journal three times without restoring the device.
	for (let i = 0; i < 3; i += 1) {
		try {
			(await owner.acquire(run, 42042)).release();
			outcomes.push("admitted");
		} catch (error) {
			if (!(error instanceof AptRoutingRefusal)) throw error;
			outcomes.push(error.reason);
		}
	}
	const rules4 = await run("ip", ["rule", "show"]);
	const rules6 = await run("ip", ["-6", "rule", "show"]);
	process.stdout.write(
		`${name} ${JSON.stringify({ links, transfer, retained, outcomes, entries, rules4, rules6 })}\n`,
	);
	// Then recovery refuses at most once and future APT requests are not wedged.
	if (name === "A3")
		expect(transfer).toEqual({ exitCode: 0, stdout: "fetched", stderr: "" });
	expect(outcomes).toEqual(
		name === "A3"
			? ["admitted", "admitted", "admitted"]
			: ["cleanup-pending", "admitted", "admitted"],
	);
	expect(entries).toEqual([]);
	expect(rules4 + rules6).not.toMatch(/^120:/m);
}
