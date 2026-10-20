import { expect } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import { run } from "../../helpers/run.ts";
import type { AptRoutingEntry } from "../../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../../modules/system/apt-routing-ownership.ts";
import {
	openPinnedAptTransaction,
	setAptTransportDepsForTest,
} from "../../modules/system/apt-transport.ts";
import { rankTransports } from "../../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../../modules/system/update-transport/pin.ts";
import { PINNED_CAPABILITIES, sample } from "./apt-transport-fixture.ts";

const state = async () => ({
	rules4: await run("ip", ["rule", "show"]),
	rules6: await run("ip", ["-6", "rule", "show"]),
	table4: await run("ip", ["route", "show", "table", "100000"]).catch(
		(error: unknown) => {
			if (error instanceof Error && "stderr" in error) return error.stderr;
			throw error;
		},
	),
	table6: await run("ip", ["-6", "route", "show", "table", "100000"]).catch(
		(error: unknown) => {
			if (error instanceof Error && "stderr" in error) return error.stderr;
			throw error;
		},
	),
});

export async function kernelCase(name: string): Promise<void> {
	// Given a dedicated user/network namespace with a usable dummy uplink.
	const before = await state();
	let entries: readonly AptRoutingEntry[] =
		name === "K3"
			? [
					{
						family: 4,
						args: [
							"route",
							"add",
							"unreachable",
							"default",
							"table",
							"100000",
							"metric",
							"4278198272",
						],
					},
					{
						family: 6,
						args: [
							"route",
							"add",
							"unreachable",
							"default",
							"table",
							"100000",
							"metric",
							"4278198272",
						],
					},
				]
			: [];
	const owner = createAptRoutingOwnership({
		read: async () => entries,
		save: (next) => {
			entries = next;
		},
	});
	if (name === "K2")
		for (const family of [[], ["-6"]]) {
			await run("ip", [
				...family,
				"route",
				"add",
				"unreachable",
				"default",
				"table",
				"100000",
				"metric",
				"4278198272",
			]);
			await run("ip", [...family, "route", "flush", "table", "100000"]);
		}
	const pin = createUpdatePinController({
		readCapabilities: async () =>
			updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
	});
	await pin.sweep();
	const ranked = rankTransports([sample("eth0", "ethernet", 4)]);
	let during: Awaited<ReturnType<typeof state>> | undefined;
	// When the control, normal admission, or reboot reconciliation runs.
	if (name === "K3") {
		await expect(owner.acquire(run, 42042)).rejects.toMatchObject({
			reason: "cleanup-pending",
		});
		const lease = await owner.acquire(run, 42042);
		lease.release();
	} else if (name === "K0") {
		expect(
			await pin.run("apt", ranked, async () => {
				during = await state();
				return "ran";
			}),
		).toBe("ran");
	} else {
		setAptTransportDepsForTest({
			select: async () => ranked,
			pin,
			ownership: owner,
		});
		try {
			const tx = await openPinnedAptTransaction();
			expect(
				await tx.transfer(async () => {
					during = await state();
					return { exitCode: 0, stdout: "fetched", stderr: "" };
				}),
			).toEqual({ exitCode: 0, stdout: "fetched", stderr: "" });
		} finally {
			setAptTransportDepsForTest(null);
		}
	}
	const after = await state();
	process.stdout.write(
		`${name} ${JSON.stringify({ before, during, after, entries })}\n`,
	);
	// Then actual kernel pinning is visible during work and ownership is retired.
	if (name !== "K3")
		expect(during?.rules4).toContain("uidrange 42042-42042 lookup 100000");
	expect(after.rules4 + after.rules6).not.toMatch(/^120:/m);
	expect(entries).toEqual([]);
}
