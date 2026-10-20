import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import {
	type AptRoutingStore,
	aptRoutingFileStore,
	entryKey,
} from "../../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../../modules/system/apt-routing-ownership.ts";
import { rankTransports } from "../../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../../modules/system/update-transport/pin.ts";
import { PINNED_CAPABILITIES, sample } from "./apt-transport-fixture.ts";
import { routingFake } from "./d13-fix-routing-fake.ts";

async function scenario() {
	const dir = await mkdtemp(join(tmpdir(), "d13-routing-"));
	const fake = await routingFake(join(dir, "kernel.json"));
	const disk = aptRoutingFileStore(join(dir, "journal.json"));
	const fault = {
		deletion: "none",
		write: 0,
		afterWrite: false,
		lostAck: false,
	};
	let writes = 0;
	let journaled = true;
	const commands: string[] = [];
	const store: AptRoutingStore = {
		read: disk.read,
		save(entries) {
			writes++;
			if (fault.write === writes && !fault.afterWrite)
				throw new Error("journal write failed");
			disk.save(entries);
			if (fault.write === writes && fault.afterWrite)
				throw new Error("journal acknowledgement lost");
		},
	};
	const pin = createUpdatePinController({
		readCapabilities: async () =>
			updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
		run: async (bin, args) => {
			commands.push(args.join(" "));
			if (args.includes("add")) {
				const family: 4 | 6 = args[0] === "-6" ? 6 : 4;
				const entry = { family, args: args.filter((arg) => arg !== "-6") };
				journaled &&= (await disk.read()).some(
					(row) => entryKey(row) === entryKey(entry),
				);
			}
			if (
				args.includes("del") &&
				args.includes("prohibit") &&
				fault.deletion !== "none"
			) {
				if (fault.deletion === "transient") fault.deletion = "none";
				throw new Error("delete failed");
			}
			const result = await fake.runner(bin, args);
			if (fault.lostAck && args.includes("add") && args.includes("lookup"))
				throw new Error("add acknowledgement lost");
			return result;
		},
	});
	await pin.sweep();
	commands.length = 0;
	let ownership = createAptRoutingOwnership(store);
	const run = (work: () => Promise<string> = async () => "ok") =>
		pin.run("apt", rankTransports([sample("eth0", "ethernet", 4)]), work, {
			aptOwnership: ownership,
		});
	return {
		dir,
		fake,
		disk,
		fault,
		commands,
		run,
		journaled: () => journaled,
		restart: () => {
			ownership = createAptRoutingOwnership(store);
		},
	};
}

export async function withRoutingScenario(
	work: (h: Awaited<ReturnType<typeof scenario>>) => Promise<void>,
): Promise<void> {
	const h = await scenario();
	try {
		await work(h);
	} finally {
		await rm(h.dir, { recursive: true, force: true });
	}
}
