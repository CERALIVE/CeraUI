import {
	createDbusSmsPort,
	createSmsInboxStore,
	type SmsInboxResult,
	type SmsObservationPort,
} from "@ceralive/modem-control";
import type { DbusTransport } from "@ceralive/modem-control/transport";
import { MODEM_PATH_RE } from "./mmcli.ts";
import type { DbusModemView } from "./modem-wire-adapters.ts";

type SmsModemView = Pick<DbusModemView, "runtimeId" | "idPath">;

interface SmsRegistryEntry {
	readonly runtimeId: number;
	readonly port: SmsObservationPort;
	readonly store: ReturnType<typeof createSmsInboxStore>;
	readonly ready: Promise<SmsInboxResult>;
}

const modemPath = (runtimeId: number): string =>
	`/org/freedesktop/ModemManager1/Modem/${runtimeId}`;

function selectorRuntimeId(selector: string): number | undefined {
	if (!MODEM_PATH_RE.test(selector)) {
		return undefined;
	}
	const raw = selector.slice(selector.lastIndexOf("/") + 1);
	const value = Number.parseInt(raw, 10);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function registryKey(epoch: string, view: SmsModemView): string {
	return view.idPath !== undefined && view.idPath.length > 0
		? `id:${view.idPath}`
		: `epoch:${epoch}:mm:${view.runtimeId}`;
}

/**
 * One registry per live D-Bus backend generation.
 *
 * A package SMS port captures one immutable ModemManager object path. MM object
 * paths renumber across owner epochs, so an epoch transition first stops every
 * old port, then recreates only entries whose ID_PATH matches a fresh modem.
 * A path-only row is deliberately not carried across epochs.
 */
export class DbusSmsPortRegistry {
	readonly #transport: DbusTransport;
	#epoch: string | undefined;
	#views: readonly SmsModemView[] = [];
	#entries = new Map<string, SmsRegistryEntry>();
	#transition: Promise<void> = Promise.resolve();
	#stopped = false;

	constructor(transport: DbusTransport) {
		this.#transport = transport;
	}

	noteEpoch(epoch: string, views: readonly SmsModemView[]): void {
		if (this.#stopped) return;
		this.#transition = this.#transition.then(() =>
			this.#applyEpoch(epoch, views),
		);
	}

	settle(): Promise<void> {
		return this.#transition;
	}

	async read(selector: string): Promise<SmsInboxResult> {
		const runtimeId = selectorRuntimeId(selector);
		if (runtimeId === undefined) {
			return { ok: false, reason: "unknown_modem" };
		}

		while (!this.#stopped) {
			const transition = this.#transition;
			await transition;
			if (transition !== this.#transition) continue;

			const epoch = this.#epoch;
			const view = this.#views.find(
				(candidate) => candidate.runtimeId === runtimeId,
			);
			if (epoch === undefined || view === undefined) {
				return { ok: false, reason: "unknown_modem" };
			}
			const key = registryKey(epoch, view);
			const entry = this.#entries.get(key) ?? this.#createEntry(key, view);
			const initial = await entry.ready;
			if (
				epoch !== this.#epoch ||
				entry !== this.#entries.get(key) ||
				transition !== this.#transition
			) {
				continue;
			}
			if (!initial.ok) {
				this.#entries.delete(key);
				await stopPorts([entry.port]);
				return initial;
			}
			return { ok: true, messages: entry.store.snapshot() };
		}
		return { ok: false, reason: "read_failed" };
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		await this.#transition;
		const entries = [...this.#entries.values()];
		this.#entries.clear();
		this.#views = [];
		this.#epoch = undefined;
		await stopPorts(entries.map((entry) => entry.port));
	}

	#createEntry(key: string, view: SmsModemView): SmsRegistryEntry {
		const port = createDbusSmsPort({
			transport: this.#transport,
			modemPath: modemPath(view.runtimeId),
		});
		const store = createSmsInboxStore();
		port.observe((event) => {
			store.apply(event);
		});
		const ready = port.list().then(
			(result) => {
				if (result.ok) {
					store.apply({ kind: "resynced", messages: result.messages });
				}
				return result;
			},
			(): SmsInboxResult => ({ ok: false, reason: "read_failed" }),
		);
		const entry: SmsRegistryEntry = {
			runtimeId: view.runtimeId,
			port,
			store,
			ready,
		};
		this.#entries.set(key, entry);
		return entry;
	}

	async #applyEpoch(
		epoch: string,
		views: readonly SmsModemView[],
	): Promise<void> {
		if (this.#stopped) return;
		if (epoch === this.#epoch) {
			this.#views = [...views];
			const nextViews = new Map(
				views.map((view) => [registryKey(epoch, view), view]),
			);
			for (const [key, entry] of [...this.#entries]) {
				const view = nextViews.get(key);
				if (view !== undefined && view.runtimeId === entry.runtimeId) continue;
				this.#entries.delete(key);
				await stopPorts([entry.port]);
				if (view !== undefined) await this.#createEntry(key, view).ready;
			}
			return;
		}

		const previous = this.#entries;
		this.#entries = new Map();
		await stopPorts([...previous.values()].map((entry) => entry.port));
		if (this.#stopped) return;

		this.#epoch = epoch;
		this.#views = [...views];
		const carriedKeys = new Set(
			[...previous.keys()].filter((key) => key.startsWith("id:")),
		);
		for (const view of views) {
			const key = registryKey(epoch, view);
			if (carriedKeys.has(key)) {
				await this.#createEntry(key, view).ready;
			}
		}
	}
}

async function stopPorts(ports: readonly SmsObservationPort[]): Promise<void> {
	await Promise.allSettled(ports.map((port) => port.stop()));
}

let activeRegistry: DbusSmsPortRegistry | undefined;

export function setActiveDbusSmsPortRegistry(
	registry: DbusSmsPortRegistry | null,
	expected?: DbusSmsPortRegistry,
): void {
	if (expected !== undefined && activeRegistry !== expected) return;
	activeRegistry = registry ?? undefined;
}

export function readDbusSmsInbox(selector: string): Promise<SmsInboxResult> {
	return (
		activeRegistry?.read(selector) ??
		Promise.resolve({ ok: false, reason: "read_failed" })
	);
}
