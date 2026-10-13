// @vitest-environment jsdom
/**
 * EVERY interleaving of up to BOUND events of an update-settings save, replayed
 * against the REAL surface, settings owner, `osCommand`, `RPCClient` (30 s call
 * timeout, reset-on-close, reconnect loop) and the production binder step, on a
 * scripted socket and Vitest's fake clock (round-3 review C, C3-3).
 *
 * There is no model of the code here. The oracle is the CONTRACT, stated from
 * what the DEVICE saw and what the screen says:
 *
 *   S1 at most one settings write is ever awaited at a time;
 *   S2 a write changes at most one field from the device's settings when it
 *      arrives, and only a field an operator control sets (a stale snapshot
 *      never overwrites a newer remote change);
 *   S3 "not sent" only when no write of the latest accepted click reached the
 *      device; "not confirmed" only when one did;
 *   S4 the controls are released only once no write is awaited (never by a
 *      valve that lapses before the client's own timeout);
 *   S5 a restored session reads the settings again.
 */
import type { UpdateSettings } from "@ceraui/rpc/schemas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	answer,
	CAPABLE,
	connectDevice,
	disconnectDevice,
	dropLink,
	elapse,
	FakeWebSocket,
	flush,
	OFFERED,
	outstanding,
	restoreLink,
	SETTINGS,
	sentCount,
	socket,
} from "../../tests/helpers/update-device";
import { destroyAsyncOperations } from "../rpc/async-operation.svelte";
import { rpcClient } from "../rpc/client";
import { type DeviceFrame, followStep } from "./update-device-follow.svelte";
import {
	createUpdateSurface,
	type UpdateSurface,
} from "./update-surface.svelte";

const BOUND = 6;

const EVENTS = [
	"click-auto",
	"click-channel",
	"answer-read",
	"apply",
	"apply-lost",
	"elapse-16",
	"timeout",
	"remote",
	"restart",
] as const;
type SaveEvent = (typeof EVENTS)[number];

/** Explored, pinned: a shrinking alphabet must not pass silently. */
const PATHS = 22_892;

let quiet: { mockRestore(): void } | undefined;
beforeAll(() => {
	quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => {
	quiet?.mockRestore();
});

interface Run {
	readonly surface: UpdateSurface;
	device: UpdateSettings;
	seen: DeviceFrame;
	/** Writes the device received, in order. */
	readonly writes: string[];
	checked: number;
	/** `writes.length` when the latest ACCEPTED click was made. */
	writesAtClick: number;
}

function awaited(path: string): number {
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	const pending = rpcClient["pendingRequests"] as Map<
		string,
		{ readonly path: readonly string[] }
	>;
	return [...pending.values()].filter((entry) => entry.path.join(".") === path)
		.length;
}

const OPERATOR_FIELDS = new Set(["packagesAuto", "channel"]);

function changedFields(from: UpdateSettings, to: UpdateSettings): string[] {
	return (Object.keys(to) as (keyof UpdateSettings)[]).filter(
		(key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]),
	);
}

/** The oracle: the contract, from device-side facts and the screen. */
function violation(r: Run): string | undefined {
	const log = FakeWebSocket.log.filter(
		(request) => request.path === "system.setUpdateSettings",
	);
	for (const request of log.slice(r.checked)) {
		const fields = changedFields(r.device, request.input as UpdateSettings);
		if (fields.length > 1 || fields.some((key) => !OPERATOR_FIELDS.has(key)))
			return `S2 write changed ${fields.join(",")}`;
		r.writes.push(request.id);
	}
	r.checked = log.length;
	if (awaited("system.setUpdateSettings") > 1) return "S1 two writes awaited";
	const outcome = r.surface.saveOutcome?.kind;
	if (outcome === "not-sent" && r.writes.length > r.writesAtClick)
		return "S3 'not sent' for a write the device received";
	if (outcome === "unconfirmed" && r.writes.length === r.writesAtClick)
		return "S3 'not confirmed' for a write never sent";
	if (!r.surface.saving && awaited("system.setUpdateSettings") > 0)
		return "S4 controls released while a write is awaited";
	return undefined;
}

function frame(r: Run, patch: Partial<DeviceFrame>): void {
	const next = { ...r.seen, ...patch };
	const move = followStep(r.seen, next);
	r.seen = next;
	if (move.kind === "reread") void r.surface.reread();
	if (move.kind === "phase") void r.surface.observePhase(move.phase);
}

async function click(r: Run, patch: Partial<UpdateSettings>): Promise<void> {
	if (!r.surface.saving && r.surface.settings !== undefined)
		r.writesAtClick = r.writes.length;
	void r.surface.save(patch);
	await flush();
}

function takeWrite(): { id: string; input: UpdateSettings } {
	const request = outstanding("system.setUpdateSettings")[0];
	if (request === undefined) throw new Error("no write");
	socket().answered.add(request.id);
	return { id: request.id, input: request.input as UpdateSettings };
}

async function perform(r: Run, event: SaveEvent): Promise<string | undefined> {
	const shown = r.surface.settings ?? SETTINGS;
	switch (event) {
		case "click-auto":
			await click(r, { packagesAuto: !shown.packagesAuto });
			return undefined;
		case "click-channel":
			await click(r, {
				channel: shown.channel === "stable" ? "beta" : "stable",
			});
			return undefined;
		case "answer-read":
			answer("system.getUpdateSettings", r.device);
			break;
		case "apply": {
			const write = takeWrite();
			r.device = write.input;
			socket().deliver({ id: write.id, result: write.input });
			break;
		}
		case "apply-lost":
			r.device = takeWrite().input;
			break;
		case "elapse-16":
			await elapse(16_000);
			break;
		case "timeout":
			await elapse(31_000);
			break;
		case "remote":
			r.device = { ...r.device, systemAuto: !r.device.systemAuto };
			break;
		case "restart": {
			const reads = sentCount("system.getUpdateSettings");
			dropLink();
			await restoreLink();
			frame(r, { restored: r.seen.restored + 1 });
			await flush();
			if (sentCount("system.getUpdateSettings") === reads)
				return "S5 a restored session did not read the settings";
			break;
		}
		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
	await flush();
	return undefined;
}

function applicable(path: readonly SaveEvent[]): SaveEvent[] {
	return EVENTS.filter((event) => {
		switch (event) {
			case "answer-read":
				return outstanding("system.getUpdateSettings").length > 0;
			case "apply":
			case "apply-lost":
				return outstanding("system.setUpdateSettings").length > 0;
			case "elapse-16":
			case "timeout":
				return (
					awaited("system.getUpdateSettings") +
						awaited("system.setUpdateSettings") >
					0
				);
			case "remote":
			case "restart":
				return !path.includes(event);
			default:
				return true;
		}
	});
}

async function replay(
	path: readonly SaveEvent[],
): Promise<{ failure: string | undefined; next: SaveEvent[] }> {
	connectDevice();
	const surface = createUpdateSurface();
	const opening = surface.load();
	answer("system.getUpdateCapabilities", CAPABLE);
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", OFFERED);
	await opening;
	const r: Run = {
		surface,
		device: { ...SETTINGS },
		seen: { open: true, phase: undefined, restored: 0 },
		writes: [],
		checked: 0,
		writesAtClick: 0,
	};
	let failure: string | undefined;
	for (const [index, event] of path.entries()) {
		failure = (await perform(r, event)) ?? violation(r);
		if (failure !== undefined) {
			failure = `${failure} after [${path.slice(0, index + 1).join(", ")}]`;
			break;
		}
	}
	const next = failure === undefined ? applicable(path) : [];
	rpcClient.disconnect();
	await flush();
	disconnectDevice();
	destroyAsyncOperations();
	FakeWebSocket.current = undefined;
	return { failure, next };
}

describe("every interleaving of an update-settings save", () => {
	it(`keeps S1–S5 up to ${BOUND} events on the real stack`, async () => {
		// Given every path of applicable events up to the bound.
		const failures: string[] = [];
		let paths = 0;
		const visit = async (path: SaveEvent[]): Promise<void> => {
			const { failure, next } = await replay(path);
			if (failure !== undefined) {
				if (failures.length < 3) failures.push(failure);
				return;
			}
			if (path.length === BOUND || next.length === 0) {
				paths += 1;
				return;
			}
			for (const event of next) await visit([...path, event]);
		};

		// When each prefix is replayed from a fresh surface.
		await visit([]);

		// Then no state violated the contract, and the whole space was explored.
		expect(failures).toEqual([]);
		expect(paths).toBe(PATHS);
	}, 600_000);
});
