/**
 * The core count only ever reaches a client through the POST-AUTH INITIAL PUSH.
 *
 * Every other device signal has a periodic loop behind it, so a missed initial
 * push self-corrects within a tick. This one is a boot fact with no loop, so the
 * push IS the delivery — and getting that wrong is not hypothetical: the first
 * cut wired `modules/ui/status.ts::sendInitialStatus` (the LEGACY relay path)
 * and left `rpc/adapter.ts::sendInitialStatusToClient` (the path every browser
 * actually uses) untouched. The whole suite was green and the deployed board
 * rendered the bare load average it was meant to replace.
 *
 * These cases pin BOTH halves of that wire so the same class of miss reddens a
 * test instead of shipping.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { setup } from "../modules/setup.ts";
import { CPU_UNKNOWN, initCpu } from "../modules/system/cpu.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

describe("CPU topology reaches a newly authenticated client", () => {
	// buildInitialStatus() fires getSshStatus(), which rejects on a malformed
	// setup.ssh_user a sibling test file may have left in the shared setup object.
	let savedSshUser: string | undefined;
	beforeAll(() => {
		savedSshUser = setup.ssh_user;
		setup.ssh_user = undefined;
	});
	afterAll(() => {
		setup.ssh_user = savedSshUser;
	});

	test("the post-login snapshot carries the count boot resolved", () => {
		// Before boot resolves it the snapshot is honestly unknown, never a guess.
		expect(buildInitialStatus().cpu).toEqual(CPU_UNKNOWN);

		initCpu({ cpuCount: () => 8 });

		expect(buildInitialStatus().cpu).toEqual({ cores: 8 });
	});

	test("the RPC adapter actually SENDS it — a snapshot field nobody emits is dead", async () => {
		const adapter = await Bun.file(
			new URL("../rpc/adapter.ts", import.meta.url).pathname,
		).text();

		expect(adapter).toContain("initialStatus.cpu");
	});
});
