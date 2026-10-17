import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	cachePreparedArtifact,
	publishPreparedArtifact,
} from "../modules/addons/artifact-publication.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { sysextTailFixture } from "./sysext-tail-fixture.ts";

let f: ReturnType<typeof sysextTailFixture>;
beforeEach(() => {
	f = sysextTailFixture();
});
afterEach(() => f.reset());

for (const previous of [false, true]) {
	test(`real publication rollback restores scan identity (${previous ? "replacement" : "new"})`, async () => {
		// Given real private files and an optionally existing payload.
		await mkdir(f.scan, { recursive: true });
		if (previous) await Bun.write(f.raw, "prior-payload");
		await Bun.write(f.prepared, "replacement-payload");
		// When a submitted publication is rolled back twice.
		const publication = await publishPreparedArtifact(f.prepared, f.raw);
		await publication.rollback();
		await publication.rollback();
		// Then new raw is absent or the prior bytes are exact, with no scan temp residue.
		if (previous) expect(await f.readRaw()).toBe("prior-payload");
		else expect(await Bun.file(f.raw).exists()).toBe(false);
		expect(await readdir(f.scan)).toEqual(previous ? ["cog-display.raw"] : []);
	});
}

test("real publication refuses before rename and leaves the old scan bytes", async () => {
	// Given a new private prepared file while the stream is already live.
	await mkdir(f.scan, { recursive: true });
	await Bun.write(f.raw, "prior-payload");
	await Bun.write(f.prepared, "replacement-payload");
	updateStatus(true);
	// When the final publication boundary is reached after its copy awaits.
	await expect(publishPreparedArtifact(f.prepared, f.raw)).rejects.toThrow(
		"streaming",
	);
	// Then the prior payload is untouched and no raw/temp replacement is discoverable.
	expect(await f.readRaw()).toBe("prior-payload");
	expect(await readdir(f.scan)).toEqual(["cog-display.raw"]);
});

test("signed cache preparation does not publish into the sysext scan directory", async () => {
	// Given real raw/signature preparation and an empty scan directory.
	await mkdir(f.scan, { recursive: true });
	await Bun.write(f.prepared, "replacement-payload");
	await Bun.write(`${f.prepared}.sig`, "detached-signature");
	// When the actual cache pair publisher completes.
	const publication = await cachePreparedArtifact(
		f.prepared,
		join(f.root, "cache", "cog-display.raw"),
	);
	await publication.commit();
	// Then the helper sees its pair but a global sysext refresh sees no raw.
	expect(await readdir(f.scan)).toEqual([]);
	expect(await Bun.file(join(f.root, "cache", "cog-display.raw")).text()).toBe(
		"replacement-payload",
	);
	expect(
		await Bun.file(join(f.root, "cache", "cog-display.raw.sig")).text(),
	).toBe("detached-signature");
});
