import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { orphanHarness } from "./helpers/os-stage-orphan-harness.ts";
import {
	finishOrphanScopes,
	orphanBody,
	orphanScope,
} from "./helpers/os-stage-orphan-scope.ts";

test("fixture teardown cancels and joins the body and its real lock before root removal", async () => {
	// Given a still-running body with a registered real lock and contender lifecycle.
	const ready = Promise.withResolvers<void>();
	let directory = "";
	let joined = false;
	const body = orphanBody(async () => {
		const h = await orphanHarness("directory");
		directory = h.directory;
		await h.acquireLock();
		expect(await h.contender()).toBe(75);
		const { signal } = orphanScope().cancel;
		const cancelled = new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		ready.resolve();
		await cancelled;
		expect((await stat(directory)).isDirectory()).toBe(true);
		joined = true;
	})();
	await ready.promise;
	// When teardown aborts and drains its resource scope.
	await finishOrphanScopes();
	await body;
	// Then the body finished while its root existed, before the root was removed.
	expect(joined).toBe(true);
	await expect(stat(directory)).rejects.toHaveProperty("code", "ENOENT");
});
