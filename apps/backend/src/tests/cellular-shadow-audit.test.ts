/**
 * Shadow mode is MUTATION-FREE, and this suite is the proof.
 *
 * The assertion is BEHAVIORAL, not textual. A grep for `Signal.Setup` is wrong by
 * construction here: `dbus-audit-transport.ts` must NAME that member in order to
 * refuse it by name rather than by omission, so the string is legitimately in the
 * tree. What matters is that across a full shadow session — start, several
 * observation cycles, a heartbeat, stop — ZERO non-allowlisted members and ZERO
 * `Signal.Setup` calls are EXECUTED against the bus.
 *
 * That is measurable only because the recording fake sits BELOW the production
 * audit wrapper: `startModemShadow` applies `createAuditingDbusTransport` itself,
 * to whatever `createTransport` returns. The fake therefore records exactly the
 * traffic the real system bus would have seen.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
	CELLULAR_READ_ONLY_MEMBERS,
	type CellularAuditRefusal,
	CellularAuditRefusalError,
	NAMED_MUTATING_MEMBERS,
	REFUSAL_NAMED_MUTATION,
} from "../modules/cellular/dbus-audit-transport.ts";
import {
	isModemShadowRunning,
	peekShadowSession,
	resetModemShadow,
	startModemShadow,
	startModemShadowIfEnabled,
	stopModemShadow,
} from "../modules/cellular/shadow.ts";
import {
	collectShadowStates,
	mmcliModemToShadowState,
	type ShadowStateSet,
} from "../modules/cellular/shadow-divergence.ts";
import type { ShadowEvidenceInput } from "../modules/cellular/shadow-evidence.ts";
import { getConfig } from "../modules/config.ts";
import {
	observerRow,
	okList,
	type RecordingTransport,
	recordingTransport,
	type ScriptedObserver,
	SIGNAL_SETUP_MEMBER,
	scriptedObserver,
} from "./helpers/shadow-harness.ts";

function mmcliSide(...ifnames: string[]): () => ShadowStateSet {
	return () =>
		collectShadowStates(
			ifnames.map((ifname) => ({ ifname })),
			mmcliModemToShadowState,
		);
}

interface Session {
	readonly transport: RecordingTransport;
	readonly observer: ScriptedObserver;
	readonly records: ShadowEvidenceInput[];
	readonly refusals: CellularAuditRefusal[];
	readonly heartbeat: () => void;
}

async function runSession(
	options: {
		readonly ifnames?: string[];
		readonly rows?: unknown[];
		readonly onConstructed?: (t: {
			callMethod: (call: {
				destination: string;
				path: string;
				interface: string;
				member: string;
			}) => Promise<unknown>;
		}) => void | Promise<void>;
	} = {},
): Promise<Session> {
	const transport = recordingTransport();
	const records: ShadowEvidenceInput[] = [];
	const refusals: CellularAuditRefusal[] = [];
	let heartbeat = (): void => undefined;
	let observer: ScriptedObserver | undefined;

	const build = scriptedObserver(
		okList(options.rows ?? [observerRow("wwan0")]),
		options.onConstructed as
			| ((transport: unknown) => void | Promise<void>)
			| undefined,
	);

	await startModemShadow({
		createTransport: () => transport,
		createObserver: (audited) => {
			observer = build(audited);
			return observer;
		},
		readMmcliStates: mmcliSide(...(options.ifnames ?? ["wwan0"])),
		appendEvidence: (record) => records.push(record),
		log: () => undefined,
		onRefusal: (refusal) => refusals.push(refusal),
		schedule: (fn) => {
			heartbeat = fn;
			return () => undefined;
		},
	});

	if (observer === undefined) {
		throw new Error("observer was never constructed");
	}
	return {
		transport,
		observer,
		records,
		refusals,
		heartbeat: () => heartbeat(),
	};
}

afterEach(async () => {
	await stopModemShadow();
	resetModemShadow();
	delete getConfig().modem_shadow;
});

describe("a full shadow session executes ZERO mutating D-Bus traffic", () => {
	test("no non-allowlisted member and no Signal.Setup ever reaches the bus", async () => {
		const session = await runSession({ ifnames: ["wwan0", "wwan1"] });

		session.observer.emit(okList([observerRow("wwan0"), observerRow("wwan1")]));
		session.observer.emit(okList([observerRow("wwan0")]));
		session.heartbeat();
		await stopModemShadow();

		const executed = session.transport.calls;
		expect(executed.filter((m) => !CELLULAR_READ_ONLY_MEMBERS.has(m))).toEqual(
			[],
		);
		expect(executed).not.toContain(SIGNAL_SETUP_MEMBER);
		for (const mutating of NAMED_MUTATING_MEMBERS) {
			expect(executed).not.toContain(mutating);
		}
	});

	test("the session really did work — records were produced, so zero calls is not zero activity", async () => {
		const session = await runSession({ ifnames: ["wwan0", "wwan2"] });
		session.observer.emit(okList([observerRow("wwan0")]));
		session.heartbeat();

		const divergences = session.records.filter((r) => r.kind === "divergence");
		const heartbeats = session.records.filter((r) => r.kind === "heartbeat");
		expect(divergences.length).toBeGreaterThan(0);
		expect(heartbeats.length).toBeGreaterThan(0);
	});
});

describe("a mutating call attempted through the wiring is refused, and shadow survives it", () => {
	test("Signal.Setup is refused BY NAME and never forwarded", async () => {
		let refusal: unknown;
		const session = await runSession({
			onConstructed: async (audited) => {
				try {
					await audited.callMethod({
						destination: "org.freedesktop.ModemManager1",
						path: "/org/freedesktop/ModemManager1/Modem/0",
						interface: "org.freedesktop.ModemManager1.Modem.Signal",
						member: "Setup",
					});
				} catch (err) {
					refusal = err;
				}
			},
		});

		expect(refusal).toBeInstanceOf(CellularAuditRefusalError);
		expect((refusal as CellularAuditRefusalError).member).toBe(
			SIGNAL_SETUP_MEMBER,
		);
		expect((refusal as CellularAuditRefusalError).reason).toBe(
			REFUSAL_NAMED_MUTATION,
		);
		expect(session.transport.calls).not.toContain(SIGNAL_SETUP_MEMBER);
		expect(session.refusals).toHaveLength(1);
	});

	test("shadow KEEPS RUNNING after a refusal and counts it in the evidence", async () => {
		const session = await runSession({
			onConstructed: async (audited) => {
				await audited
					.callMethod({
						destination: "org.freedesktop.ModemManager1",
						path: "/org/freedesktop/ModemManager1/Modem/0",
						interface: "org.freedesktop.ModemManager1.Modem",
						member: "Enable",
					})
					.catch(() => undefined);
			},
		});

		expect(isModemShadowRunning()).toBe(true);
		session.observer.emit(okList([observerRow("wwan0")]));
		session.heartbeat();

		const heartbeats = session.records.filter((r) => r.kind === "heartbeat");
		const last = heartbeats.at(-1) as { refusals: number };
		expect(last.refusals).toBe(1);
		expect(peekShadowSession()?.refusals).toBe(1);
	});

	test("an allowlisted read still passes through the same wrapper", async () => {
		const session = await runSession({
			onConstructed: async (audited) => {
				await audited.callMethod({
					destination: "org.freedesktop.DBus",
					path: "/org/freedesktop/DBus",
					interface: "org.freedesktop.DBus",
					member: "GetNameOwner",
				});
			},
		});
		expect(session.transport.calls).toEqual([
			"org.freedesktop.DBus.GetNameOwner",
		]);
		expect(session.refusals).toEqual([]);
	});
});

describe("shadow starts ONLY on modem_shadow === true", () => {
	test("an ABSENT key never starts shadow", async () => {
		delete getConfig().modem_shadow;
		await startModemShadowIfEnabled();
		expect(isModemShadowRunning()).toBe(false);
	});

	test("an explicit FALSE never starts shadow", async () => {
		getConfig().modem_shadow = false;
		await startModemShadowIfEnabled();
		expect(isModemShadowRunning()).toBe(false);
	});

	test("a non-boolean truthy value never starts shadow either", async () => {
		(getConfig() as Record<string, unknown>).modem_shadow = "true";
		await startModemShadowIfEnabled();
		expect(isModemShadowRunning()).toBe(false);
	});
});

describe("session lifecycle", () => {
	test("a second start while one runs is a no-op", async () => {
		const session = await runSession();
		const before = session.transport.calls.length;
		await startModemShadow({
			createTransport: () => {
				throw new Error("a second start must not build a transport");
			},
			createObserver: () => {
				throw new Error("a second start must not build an observer");
			},
			readMmcliStates: mmcliSide("wwan0"),
			appendEvidence: () => undefined,
			schedule: () => () => undefined,
		});
		expect(session.transport.calls.length).toBe(before);
	});

	test("stop releases the observer AND the transport, and is idempotent", async () => {
		const session = await runSession();
		await stopModemShadow();
		await stopModemShadow();
		expect(session.observer.stopped.count).toBe(1);
		expect(session.transport.disconnects.count).toBe(1);
		expect(isModemShadowRunning()).toBe(false);
	});
});
