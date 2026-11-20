import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { call } from "@orpc/server";
import { appendBoot, appendEvent } from "../modules/events/store.ts";
import { appRouter } from "../rpc/router.ts";
import { boot, event, fixture, line } from "./events-store.fixtures.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";

test("clearing events reports a failed unlink and still removes other generations", async () => {
	using deps = fixture();
	const retained = join(deps.baseDir, "events.1.jsonl");
	fs.writeFileSync(retained, line(event(2)));
	fs.writeFileSync(join(deps.baseDir, "events.2.jsonl"), line(event(1)));
	appendEvent(event(3), { ...deps, sync: false });
	appendBoot(boot(), deps);
	const sockets = await logsSockets();
	const previousDir = process.env.CERALIVE_EVENTS_DIR;
	process.env.CERALIVE_EVENTS_DIR = deps.baseDir;
	const remove = fs.rmSync;
	const unlink = spyOn(fs, "rmSync").mockImplementation((path, options) => {
		if (path === retained) throw new Error("injected unlink failure");
		remove(path, options);
	});
	try {
		const { context } = sockets;
		expect(await call(appRouter.events.clear, undefined, { context })).toEqual({
			success: false,
		});
		expect((await call(appRouter.events.list, {}, { context })).events).toEqual(
			[event(2)],
		);
		expect(await call(appRouter.events.boots, undefined, { context })).toEqual([
			boot(),
		]);
	} finally {
		unlink.mockRestore();
		sockets.close();
		if (previousDir === undefined) delete process.env.CERALIVE_EVENTS_DIR;
		else process.env.CERALIVE_EVENTS_DIR = previousDir;
	}
});
