import { afterEach, describe, expect, test } from "bun:test";

import { routeCommand } from "../modules/remote-control/command-router.ts";
import type { Command, Result } from "../modules/remote-control/protocol.ts";
import {
	type NonRevertibleOp,
	type RevertibleOp,
	resetSelfFencingState,
	type SelfFencingOps,
} from "../modules/remote-control/self-fencing.ts";

function capture(): { sink: (frame: Result) => boolean; frames: Result[] } {
	const frames: Result[] = [];
	return {
		frames,
		sink: (frame: Result) => {
			frames.push(frame);
			return true;
		},
	};
}

function makeCommand(overrides: Partial<Command>): Command {
	return {
		v: 1,
		kind: "command",
		type: "streaming.getConfig",
		cid: "c1",
		role: "owner",
		...overrides,
	};
}

afterEach(() => {
	resetSelfFencingState();
});

describe("control command routing", () => {
	test("getConfig command dispatches to the procedure and returns ok result echoing cid", async () => {
		const { sink, frames } = capture();

		await routeCommand(
			makeCommand({ type: "streaming.getConfig", cid: "c1" }),
			{
				sendResult: sink,
			},
		);

		expect(frames).toHaveLength(1);
		const result = frames[0];
		expect(result?.v).toBe(1);
		expect(result?.kind).toBe("result");
		expect(result?.type).toBe("streaming.getConfig");
		expect(result?.cid).toBe("c1");
		expect(result?.role).toBe("owner");
		expect(result?.payload.ok).toBe(true);
		expect(result?.payload).toHaveProperty("applied");
	});

	test("never-remote auth.setPassword is rejected with not_remote_invokable and never executed", async () => {
		const { sink, frames } = capture();
		let dispatched = false;

		await routeCommand(makeCommand({ type: "auth.setPassword", cid: "c2" }), {
			sendResult: sink,
			dispatch: {
				"auth.setPassword": async () => {
					dispatched = true;
					return { success: true };
				},
			},
		});

		expect(dispatched).toBe(false);
		expect(frames[0]?.cid).toBe("c2");
		expect(frames[0]?.payload).toEqual({
			ok: false,
			applied: null,
			error: "not_remote_invokable",
		});
	});

	test("unknown command type is rejected with unknown_command", async () => {
		const { sink, frames } = capture();

		await routeCommand(makeCommand({ type: "streaming.teleport", cid: "c3" }), {
			sendResult: sink,
		});

		expect(frames[0]?.cid).toBe("c3");
		expect(frames[0]?.payload).toEqual({
			ok: false,
			applied: null,
			error: "unknown_command",
		});
	});

	test("non-owner role is rejected with unauthorized", async () => {
		const { sink, frames } = capture();
		let dispatched = false;

		await routeCommand(
			makeCommand({ type: "streaming.getConfig", cid: "c4", role: "viewer" }),
			{
				sendResult: sink,
				dispatch: {
					"streaming.getConfig": async () => {
						dispatched = true;
						return {};
					},
				},
			},
		);

		expect(dispatched).toBe(false);
		expect(frames[0]?.cid).toBe("c4");
		expect(frames[0]?.payload).toEqual({
			ok: false,
			applied: null,
			error: "unauthorized",
		});
	});

	test("self_fencing op routes to the commit-confirm watchdog (applied, awaiting confirm)", async () => {
		const { sink, frames } = capture();
		const reverts: unknown[] = [];
		const revertible: RevertibleOp = {
			revertible: true,
			snapshot: async () => ({ dhcp: true }),
			apply: async () => ({ dhcp: false }),
			revert: async (snapshot) => {
				reverts.push(snapshot);
			},
		};
		const unexpected: NonRevertibleOp = {
			revertible: false,
			execute: async () => {
				throw new Error("unexpected op invocation");
			},
		};
		const ops: SelfFencingOps = {
			"network.reconfig": revertible,
			"modem.reconfig": unexpected,
			"device.remoteKeyChange": unexpected,
			"system.reboot": unexpected,
			"device.factoryReset": unexpected,
		};

		await routeCommand(makeCommand({ type: "network.reconfig", cid: "c5" }), {
			sendResult: sink,
			selfFencing: {
				ops,
				setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
				clearTimer: () => {},
			},
		});

		expect(frames).toHaveLength(1);
		expect(frames[0]?.cid).toBe("c5");
		expect(frames[0]?.self_fencing).toBe(true);
		expect(frames[0]?.payload).toEqual({ ok: true, applied: { dhcp: false } });
		expect(reverts).toEqual([]);
	});
});
