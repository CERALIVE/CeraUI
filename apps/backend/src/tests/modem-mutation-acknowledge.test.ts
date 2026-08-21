/**
 * Acknowledging a failed modem mutation — both typed paths, and everything that
 * must NOT unblock.
 *
 * The suite exists because the dangerous failure mode here is silent: an
 * acknowledgement that merely clears a badge leaves the operator streaming over a
 * modem whose real state nobody established. So the negatives (a mismatch, a
 * mode-less dismissal, an absent device) get as much coverage as the happy paths,
 * and the crash injection between the acknowledgement write and the archive is
 * asserted to RESUME rather than to lose the operator's decision.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	type ModemMutationState,
	modemMutationAckInputSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	acknowledgeMutation,
	decommissionMutation,
	rebaselineMutation,
} from "../modules/modems/mutation-acknowledge.ts";
import {
	refreshMutationBlocks as refreshBlocks,
	resetMutationBlockDeps,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	listMutationEntries,
	type MutationJournalFs,
	readMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	clearMutationRollbacks,
	resetMutationCaptureDeps,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import {
	resetLifecycleInterlock,
	streamingBlockingMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { acknowledgeMutationProcedure } from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const PRE_STATE = {
	vidPid: "2c7c:0801",
	model: "RM520N-GL",
	firmwareRevision: "RM520NGLAAR01A07M4G",
	mode: "qmi",
	ifname: "wwan0",
};

const QMI = [
	{
		interfaceClass: 0xff,
		interfaceSubClass: 0xff,
		interfaceProtocol: 0xff,
		driver: "qmi_wwan",
	},
];
const MBIM = [
	{
		interfaceClass: 0x02,
		interfaceSubClass: 0x0e,
		interfaceProtocol: 0x00,
		driver: "cdc_mbim",
	},
];

let dir: string;

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function useDevice(mode: "qmi" | "mbim" | "absent", model = "RM520N-GL"): void {
	setMutationCaptureDeps({
		enumerate: () =>
			Promise.resolve(
				mode === "absent"
					? []
					: ([
							{
								vendorId: "2c7c",
								productId: "0801",
								model,
								firmwareRevision: "RM520NGLAAR01A07M4G",
								bDeviceClass: 0,
								ifname: "wwan0",
								physicalUid: KEY,
								interfaces: mode === "qmi" ? QMI : MBIM,
							},
						] as never),
			),
	});
	setMutationBlockDeps({
		listEntries: () => listMutationEntries(),
		presentStableKeys: () =>
			Promise.resolve(mode === "absent" ? new Set<string>() : new Set([KEY])),
	});
}

async function seed(state: ModemMutationState): Promise<ModemMutationEntry> {
	const entry: ModemMutationEntry = {
		version: MODEM_MUTATION_JOURNAL_VERSION,
		stableKey: KEY,
		kind: "usb-mode",
		state,
		attemptId: "attempt-ack",
		startedAt: 1_000,
		updatedAt: 1_000,
		preState: PRE_STATE,
		detail: "rollback did not restore the journaled pre-state",
		history: [{ state, at: 1_000 }],
	};
	await commitMutationEntry(entry);
	return entry;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceraui-mutation-ack-"));
	setMutationJournalDeps({
		fs: defaultMutationJournalFs,
		dir,
		now: () => 2_000,
	});
	clearMutationRollbacks();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
});

afterEach(async () => {
	resetMutationJournalDeps();
	resetMutationCaptureDeps();
	resetMutationBlockDeps();
	clearMutationRollbacks();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	await rm(dir, { recursive: true, force: true });
});

describe("5a — VERIFIED-ROLLBACK", () => {
	test("a device restored externally is confirmed, archived and unblocked", async () => {
		await seed("failed");
		useDevice("qmi");
		await initMutationRecovery();
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);

		const result = await acknowledgeMutation(KEY, "verified-rollback");
		expect(result).toEqual({ success: true, state: "acknowledged" });
		expect(await readdir(dir)).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
	});
});

describe("5b — VERIFIED-ROLLBACK MISMATCH", () => {
	test("a device that does NOT match the pre-state refuses and stays blocked", async () => {
		await seed("failed");
		useDevice("mbim");
		await initMutationRecovery();

		const result = await acknowledgeMutation(KEY, "verified-rollback");
		expect(result).toEqual({ success: false, error: "state_mismatch" });
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);
	});
});

describe("5c — FORCE-REBASELINE", () => {
	test("the operator's accepted CURRENT state becomes the journaled baseline", async () => {
		await seed("failed");
		useDevice("mbim");
		await initMutationRecovery();

		const result = await acknowledgeMutation(KEY, "force-rebaseline");
		expect(result).toEqual({ success: true, state: "acknowledged" });
		expect(await readdir(dir)).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
	});

	test("an INCOHERENT read is refused — a baseline must be a real reading", async () => {
		await seed("failed");
		setMutationCaptureDeps({
			enumerate: () =>
				Promise.resolve([
					{
						vendorId: "",
						productId: "",
						bDeviceClass: 0,
						physicalUid: KEY,
						interfaces: MBIM,
					},
				] as never),
		});
		expect(await acknowledgeMutation(KEY, "force-rebaseline")).toEqual({
			success: false,
			error: "read_failed",
		});
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});
});

describe("5d — a crash between the acknowledgement write and the archive", () => {
	test("replay RESUMES the archive and the unblock", async () => {
		await seed("failed");
		useDevice("mbim");
		await initMutationRecovery();

		// Inject the crash exactly at the archive: the acknowledgement commits and
		// the durable delete never runs.
		const noDelete: MutationJournalFs = {
			...defaultMutationJournalFs,
			unlink: () => Promise.reject(new Error("crash before archive")),
		};
		setMutationJournalDeps({ fs: noDelete, dir, now: () => 3_000 });
		await acknowledgeMutation(KEY, "force-rebaseline");
		setMutationJournalDeps({
			fs: defaultMutationJournalFs,
			dir,
			now: () => 4_000,
		});

		const survived = await readMutationEntry(KEY);
		expect(survived?.state).toBe("acknowledged");
		expect(survived?.acknowledgedMode).toBe("force-rebaseline");
		// The rebaselined state — not the pre-state — is what was journaled.
		expect(survived?.preState["mode"]).toBe("mbim");

		await initMutationRecovery();
		expect(await readdir(dir)).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
	});
});

describe("5e — nothing else may unblock a failed mutation", () => {
	test("a mode-less acknowledgement cannot even be EXPRESSED on the wire", () => {
		expect(
			modemMutationAckInputSchema.safeParse({
				stableKey: KEY,
				confirm: true,
			}).success,
		).toBe(false);
		// …nor an unconfirmed one, nor one carrying an unknown extra key.
		expect(
			modemMutationAckInputSchema.safeParse({
				stableKey: KEY,
				mode: "verified-rollback",
			}).success,
		).toBe(false);
		expect(
			modemMutationAckInputSchema.safeParse({
				stableKey: KEY,
				mode: "verified-rollback",
				confirm: true,
				dismiss: true,
			}).success,
		).toBe(false);
	});

	test("acknowledging a device that is not blocked is refused", async () => {
		await seed("armed");
		useDevice("qmi");
		expect(await acknowledgeMutation(KEY, "force-rebaseline")).toEqual({
			success: false,
			error: "not_blocked",
		});
	});

	test("acknowledging an unknown device is refused", async () => {
		useDevice("qmi");
		expect(await acknowledgeMutation("usb-0:9.9", "force-rebaseline")).toEqual({
			success: false,
			error: "no_entry",
		});
	});

	test("an ABSENT device quarantines instead of unblocking", async () => {
		await seed("failed");
		useDevice("absent");
		expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
			success: false,
			error: "device_absent",
		});
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
	});

	test("the REAL procedure is the same code path", async () => {
		await seed("failed");
		useDevice("qmi");
		await initMutationRecovery();
		expect(
			await call(
				acknowledgeMutationProcedure,
				{ stableKey: KEY, mode: "verified-rollback", confirm: true },
				{ context: makeContext() },
			),
		).toEqual({ success: true, state: "acknowledged" });
	});
});

describe("decommission and rebaseline", () => {
	test("a decommission releases GLOBAL streaming and blocks only that identity", async () => {
		await seed("failed");
		useDevice("absent");
		await initMutationRecovery();
		// The replay table leaves a `failed` entry alone; quarantine is entered
		// when an ACKNOWLEDGEMENT finds the device gone, which is the moment the
		// operator learns it and the only moment a decommission can follow.
		await acknowledgeMutation(KEY, "verified-rollback");
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
		await refreshBlocks();
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);

		expect(await decommissionMutation(KEY)).toEqual({
			success: true,
			state: "decommissioned",
		});
		expect(streamingBlockingMutation()).toBeUndefined();
	});

	test("a decommission is refused for anything but a quarantined device", async () => {
		await seed("failed");
		useDevice("qmi");
		expect(await decommissionMutation(KEY)).toEqual({
			success: false,
			error: "not_blocked",
		});
	});

	test("a rebaseline adopts the device now occupying the identity", async () => {
		await seed("failed");
		useDevice("absent");
		await acknowledgeMutation(KEY, "verified-rollback");
		await decommissionMutation(KEY);

		// A REPLACEMENT unit appears in the same port.
		useDevice("mbim", "SIM7600G-H");
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");

		expect(await rebaselineMutation(KEY)).toEqual({
			success: true,
			state: "acknowledged",
		});
		expect(await readdir(dir)).toEqual([]);
	});

	test("a rebaseline is refused while the identity is not awaiting one", async () => {
		await seed("failed");
		useDevice("qmi");
		expect(await rebaselineMutation(KEY)).toEqual({
			success: false,
			error: "not_blocked",
		});
	});
});
