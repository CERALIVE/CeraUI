import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import { aptRoutingFileStore } from "../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../modules/system/apt-routing-ownership.ts";
import {
	openPinnedAptTransaction,
	setAptTransportDepsForTest,
} from "../modules/system/apt-transport.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import {
	PINNED_CAPABILITIES,
	sample,
} from "./helpers/apt-transport-fixture.ts";
import { routingFake } from "./helpers/d13-fix-routing-fake.ts";

afterEach(() => setAptTransportDepsForTest(null));

test("refuses new work when prohibit deletion leaves unresolved ownership", async () => {
	// Given the reviewer's one-command transient deletion fault and stateful kernel port.
	const dir = await mkdtemp(join(tmpdir(), "d13-fix-leak-"));
	try {
		const fake = await routingFake(join(dir, "state"));
		let fault = true;
		const pin = createUpdatePinController({
			readCapabilities: async () =>
				updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
			run: async (bin, args) => {
				if (fault && args.includes("del") && args.includes("prohibit")) {
					fault = false;
					throw new Error("ip delete failed");
				}
				return fake.runner(bin, args);
			},
		});
		await pin.sweep();
		setAptTransportDepsForTest({
			select: async () => rankTransports([sample("eth0", "ethernet", 4)]),
			pin,
			ownership: createAptRoutingOwnership(
				aptRoutingFileStore(join(dir, "journal.json")),
			),
		});
		const tx = await openPinnedAptTransaction();
		// When teardown fails and the next transaction attempts network work.
		const result = await tx.transfer(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const leaked = [...fake.state.rules];
		const next = await openPinnedAptTransaction();
		let calls = 0;
		await next.transfer(async () => {
			calls++;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		process.stdout.write(
			`${JSON.stringify({ result, leaked, nextDispatched: calls })}\n`,
		);
		// Then reconciliation removes residue without admitting that next transaction.
		expect({ rules: fake.state.rules, nextDispatched: calls }).toEqual({
			rules: [],
			nextDispatched: 0,
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
