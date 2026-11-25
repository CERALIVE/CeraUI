import { beforeEach, expect, test } from "bun:test";
import { type AnyProcedure, call } from "@orpc/server";
import {
	CELLULAR_STACK_INITIALIZING,
	getCellularStack,
	initCellularStack,
	resetCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { refreshMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import { appRouter } from "../rpc/router.ts";
import type { RPCContext } from "../rpc/types.ts";
import {
	deferred,
	useJournalReconciliationHarness,
} from "./helpers/journal-reconciliation-harness.ts";

useJournalReconciliationHarness();
// Publish this test's empty journal over any list another file left behind.
beforeEach(async () => {
	await refreshMutationBlocks();
});

const methods = appRouter.modems;
const target = { stableKey: "usb:missing", confirm: true } as const;
const recovery = {
	listMutationBlocks: [undefined, { replayComplete: true, blocks: [] }],
	acknowledgeMutation: [
		{ ...target, mode: "verified-rollback" },
		{ success: false, error: "no_entry" },
	],
	decommissionMutation: [target, { success: false, error: "no_entry" }],
	rebaselineMutation: [target, { success: false, error: "no_entry" }],
} as const;
const alreadyUngated = new Set([
	"getCapabilities",
	"setCapabilities",
	"setCredentials",
	"clearCredentials",
	"verifyCredentials",
]);

function context(authenticated: boolean): RPCContext {
	return {
		ws: Object.create(null),
		isAuthenticated: () => authenticated,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

async function whileInitializing(run: () => Promise<void>): Promise<void> {
	const hold = deferred();
	const initializing = initCellularStack({
		backend: "dbus",
		createDbusBackend: () => ({
			start: async () => {
				await hold.promise;
				return { ok: true };
			},
			stop: async () => {},
		}),
	});
	try {
		expect(getCellularStack().ready).toBe(false);
		await run();
	} finally {
		hold.release();
		await initializing;
		resetCellularStack();
	}
}

for (const key of Object.keys(recovery) as (keyof typeof recovery)[]) {
	const procedure: AnyProcedure = methods[key];
	const [input, expected] = recovery[key];
	test(`${key} reaches the journal while the signed-in cellular stack is not ready`, () =>
		whileInitializing(async () => {
			await expect(
				call(procedure, input, { context: context(true) }),
			).resolves.toEqual(expected);
		}));
	test(`${key} refuses a signed-out caller while cellular is not ready`, () =>
		whileInitializing(async () => {
			await expect(
				call(procedure, input, { context: context(false) }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		}));
}

for (const [key, procedure] of Object.entries<AnyProcedure>(methods)) {
	if (Object.hasOwn(recovery, key) || alreadyUngated.has(key)) continue;
	test(`${key} still stops at the cellular readiness gate`, () =>
		whileInitializing(async () => {
			await expect(
				call(procedure, undefined, { context: context(true) }),
			).rejects.toMatchObject({
				code: CELLULAR_STACK_INITIALIZING,
			});
		}));
}
