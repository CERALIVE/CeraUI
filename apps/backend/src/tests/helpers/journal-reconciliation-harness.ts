import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resetMutationBlockDeps,
	setMutationBlockDeps,
} from "../../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../../modules/modems/mutation-journal.ts";
import {
	resetMutationCaptureDeps,
	setMutationCaptureDeps,
} from "../../modules/modems/mutation-rollback.ts";
import { resetLifecycleInterlock } from "../../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../../modules/streaming/recovery-barrier.ts";
import { useSessionOwnerForFile } from "./bind-session-owner.ts";

export function deferred() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** A held clock: each pass must explicitly release its own wait. */
export class JournalRetryClock {
	readonly waits: number[] = [];
	readonly #holds: ReturnType<typeof deferred>[] = [];
	readonly #arrivals = new Map<number, ReturnType<typeof deferred>>();
	readonly sleep = (ms: number, signal: AbortSignal): Promise<void> => {
		const hold = deferred();
		this.waits.push(ms);
		this.#holds.push(hold);
		signal.addEventListener("abort", hold.release, { once: true });
		this.#arrivals.get(this.waits.length)?.release();
		return hold.promise;
	};
	at(n: number): Promise<void> {
		if (this.waits.length >= n) return Promise.resolve();
		const arrival = this.#arrivals.get(n) ?? deferred();
		this.#arrivals.set(n, arrival);
		return arrival.promise;
	}
	advance(): void {
		this.#holds[this.#holds.length - 1]?.release();
	}
}

export async function seedFailedMutation(key = "usb:a"): Promise<void> {
	await commitMutationEntry({
		version: 1,
		stableKey: key,
		kind: "usb-mode",
		state: "failed",
		attemptId: "retained",
		startedAt: 1,
		updatedAt: 1,
		preState: {
			vidPid: "2c7c:0801",
			model: "fixture",
			firmwareRevision: "one",
			mode: "qmi",
		},
		history: [{ state: "failed", at: 1 }],
	});
}

const hardware = [
	{
		vendorId: "2c7c",
		productId: "0801",
		physicalUid: "usb:a",
		model: "fixture",
		firmwareRevision: "one",
		ifname: "wwan0",
		bDeviceClass: 0,
		interfaces: [
			{
				interfaceClass: 255,
				interfaceSubClass: 255,
				interfaceProtocol: 255,
				driver: "qmi_wwan",
			},
		],
	},
];

export function useJournalReconciliationHarness() {
	useSessionOwnerForFile();
	let root = "";
	const holds: ReturnType<typeof deferred>[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "journal-revision-"));
		resetRecoveryBarrier();
		resetLifecycleInterlock();
		setMutationJournalDeps({ dir: root, now: () => 2 });
		setMutationBlockDeps({
			presentStableKeys: async () => new Set(["usb:a", "usb:b"]),
		});
		setMutationCaptureDeps({ enumerate: async () => hardware });
	});
	afterEach(() => {
		resetRecoveryBarrier();
		for (const hold of holds.splice(0)) hold.release();
		resetLifecycleInterlock();
		resetMutationJournalDeps();
		resetMutationBlockDeps();
		resetMutationCaptureDeps();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root: () => root,
		pausePresence: () => {
			const entered = deferred();
			const hold = deferred();
			holds.push(hold);
			setMutationBlockDeps({
				presentStableKeys: async () => {
					entered.release();
					await hold.promise;
					return new Set(["usb:a", "usb:b"]);
				},
			});
			return { entered: entered.promise, release: hold.release };
		},
		pauseCapture: () => {
			const entered = deferred();
			const hold = deferred();
			holds.push(hold);
			setMutationCaptureDeps({
				enumerate: async () => {
					entered.release();
					await hold.promise;
					return hardware;
				},
			});
			return { entered: entered.promise, release: hold.release };
		},
	};
}
