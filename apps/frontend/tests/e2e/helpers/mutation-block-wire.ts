/**
 * The reference mock with a mutation journal in front of it.
 *
 * The mock never blocks a modem, so the four recovery RPCs are answered here by
 * `MutationBlockDevice`, which keeps the backend's own transitions. Everything
 * else is the live mock backend. Two modems get known ports: the first
 * directly managed one is `MODEM`, the first router dongle is `DONGLE`.
 */
import type { Page, WebSocketRoute } from '@playwright/test';

import { MutationBlockDevice } from '../../../src/tests/helpers/mutation-block-device';
import { isBackendSocket } from './backend-socket.js';

export const MODEM = 'e2e-port-modem';
export const DONGLE = 'e2e-port-dongle';

type Frame = Record<string, unknown>;
type Roster = Record<string, Frame>;

export interface MutationBlockWire {
	readonly device: MutationBlockDevice;
	/** The modem at this port leaves the roster, now and in every later frame. */
	unplug(port: string): void;
	/** Fields the dongle's row reports beyond the mock's. */
	readonly dongle: Frame;
	/** The next recovery request waits until `release` is called. */
	hold(): () => void;
	/** Drop the socket; the page reconnects by itself. */
	drop(): Promise<void>;
}

function withPorts(roster: Roster, unplugged: ReadonlySet<string>, extra: Frame): Roster {
	let modem = false;
	let dongle = false;
	const entries: [string, Frame][] = [];
	for (const [id, entry] of Object.entries(roster)) {
		let stable_key: string | undefined;
		if (entry.device_class === 'router-ethernet' && !dongle) {
			dongle = true;
			stable_key = DONGLE;
		} else if (entry.device_class !== 'router-ethernet' && !modem) {
			modem = true;
			stable_key = MODEM;
		}
		if (stable_key !== undefined && unplugged.has(stable_key)) continue;
		entries.push([
			id,
			stable_key === undefined
				? entry
				: { ...entry, ...(stable_key === DONGLE ? extra : {}), stable_key },
		]);
	}
	return Object.fromEntries(entries);
}

function patchModems(frame: Frame, unplugged: ReadonlySet<string>, extra: Frame): Frame {
	let next = frame;
	for (const key of ['status', 'result'] as const) {
		const inner = next[key] as Frame | undefined;
		if (inner && typeof inner === 'object' && inner.modems)
			next = { ...next, [key]: { ...inner, modems: withPorts(inner.modems as Roster, unplugged, extra) } };
	}
	if (next.modems) next = { ...next, modems: withPorts(next.modems as Roster, unplugged, extra) };
	return next;
}

/** Before any navigation. Pages that share a `device` are two browsers on one box. */
export async function attachMutationBlocks(
	page: Page,
	device = new MutationBlockDevice(),
	respond?: (path: string, frame: Frame) => unknown,
): Promise<MutationBlockWire> {
	let route: WebSocketRoute | null = null;
	const unplugged = new Set<string>();
	const dongle: Frame = {};
	let gate: Promise<void> | undefined;
	let roster: Roster | undefined;

	const answer = (path: string, input: Frame): unknown => {
		switch (path) {
			case 'modems.listMutationBlocks':
				return device.list();
			case 'modems.acknowledgeMutation':
				return device.acknowledge(input as Parameters<typeof device.acknowledge>[0]);
			case 'modems.decommissionMutation':
				return device.decommission(String(input.stableKey));
			case 'modems.rebaselineMutation':
				return device.rebaseline(String(input.stableKey));
			default:
				return undefined;
		}
	};

	await page.routeWebSocket(isBackendSocket, (ws) => {
		if (new URL(ws.url()).pathname !== '/ws') {
			ws.connectToServer();
			return;
		}
		route = ws;
		const server = ws.connectToServer();
		ws.onMessage(async (message) => {
			let frame: Frame | undefined;
			try {
				frame = JSON.parse(message.toString()) as Frame;
			} catch {
				server.send(message);
				return;
			}
			const path = Array.isArray(frame.path) ? frame.path.join('.') : '';
			const reply =
				respond?.(path, frame) ?? answer(path, (frame.input ?? {}) as Frame);
			if (reply === undefined) {
				server.send(message);
				return;
			}
			if (path !== 'modems.listMutationBlocks') await gate;
			ws.send(JSON.stringify({ id: frame.id, result: reply }));
		});
		server.onMessage((message) => {
			try {
				const frame = JSON.parse(message.toString()) as Frame;
				const status = frame.status as Frame | undefined;
				roster = ((frame.modems ?? status?.modems) as Roster | undefined) ?? roster;
				ws.send(JSON.stringify(patchModems(frame, unplugged, dongle)));
			} catch {
				ws.send(message);
			}
		});
	});

	return {
		device,
		unplug: (port) => {
			unplugged.add(port);
			route?.send(JSON.stringify({ modems: withPorts(roster ?? {}, unplugged, dongle) }));
		},
		dongle,
		hold: () => {
			let open = () => {};
			gate = new Promise((resolve) => {
				open = resolve;
			});
			return () => {
				gate = undefined;
				open();
			};
		},
		drop: async () => {
			await route?.close({ code: 1012, reason: 'e2e link drop' });
		},
	};
}
