import { afterEach, expect, test } from "bun:test";
import {
	type LogFollowMessage,
	logAroundOutputSchema,
	logExportOutputSchema,
	logFollowStartOutputSchema,
	logQueryOutputSchema,
} from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import {
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { locateAround, queryLogs } from "../modules/device-logs/query.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import { bootId } from "./helpers/device-query.ts";
import { historyFixture, turn } from "./helpers/history-clear.ts";

let fixtureToDispose: ReturnType<typeof historyFixture> | undefined;
afterEach(async () => {
	const fixture = fixtureToDispose;
	fixtureToDispose = undefined;
	await fixture?.dispose();
});
const boundaries = [
	"follow",
	"export",
	"query",
	"rotate",
	"vacuum",
	"unlink",
	"persist",
	"readout",
] as const;
const kinds = ["export", "query", "around", "follow"] as const;
for (const mock of [false, true]) {
	for (const boundary of boundaries.filter(
		(name) => !mock || (name !== "rotate" && name !== "vacuum"),
	)) {
		for (const kind of kinds) {
			const nativeRotateExport =
				!mock && boundary === "rotate" && kind === "export";
			// A 1.5 s CI stall tripped the watchdog; the latch still drives ordering.
			const eventTimeoutMs = nativeRotateExport ? 6_000 : undefined;
			const verify = async (h: ReturnType<typeof historyFixture>) => {
				const messages: LogFollowMessage[] = [];
				const conn = h.socket(messages);
				let settled = false;
				let attempt: Promise<unknown> | undefined;
				const admit = () => {
					const call =
						kind === "export"
							? createExport({}, { filter: {} })
							: kind === "query"
								? queryLogs({}, {})
								: kind === "around"
									? locateAround({}, { bootId, at: Date.now() })
									: h.start(conn).then(({ result }) => result);
					attempt = h.own(
						call.then(
							(value) => {
								settled = true;
								return value;
							},
							(error: unknown) => {
								settled = true;
								throw error;
							},
						),
					);
				};
				let gate: ReturnType<typeof h.ownedLatch>;
				let entered: Promise<void>;
				if (boundary === "follow") {
					const held = await h.holdFollow();
					gate = held.gate;
					entered = gate.entered;
				} else if (boundary === "export") {
					const held = await h.holdExport();
					gate = held.gate;
					entered = held.entered;
				} else if (boundary === "query") {
					const held = await h.holdQuery();
					gate = held.gate;
					entered = gate.entered;
				} else {
					gate =
						boundary === "rotate"
							? h.holdRotate()
							: boundary === "vacuum"
								? h.holdVacuum()
								: boundary === "unlink"
									? h.holdUnlink()
									: h.holdReadout();
					entered = gate.entered;
					if (boundary === "persist") h.onPersist(admit);
				}
				const clearing = h.own(clearAll());
				try {
					await h.wait(entered, `enter ${boundary}`);
					if (boundary !== "persist") admit();
					await turn(eventTimeoutMs);
					expect(settled).toBe(false);
					gate.release();
					expect((await h.wait(clearing, "clear completion")).ok).toBe(true);
					if (!attempt) throw new Error("admission was not attempted");
					const result = await h.wait(attempt, `${kind} admission`);
					if (kind === "export") {
						const ticket = logExportOutputSchema.parse(result);
						expect(ticket.ok).toBe(true);
						if (!ticket.ok) throw new Error(ticket.error);
						const response = await handleLogExportRequest(
							new Request(`http://device${ticket.url}`),
						);
						const text = await h.wait(response.text(), "export body");
						expect(text).not.toContain("before-clear");
						expect(text).toContain("device logs cleared");
						expect(text).toEndWith("# complete: 1 entries\n");
						expect((await createExport({}, { filter: {} })).ok).toBe(true);
					} else if (kind === "query") {
						const page = logQueryOutputSchema.parse(result);
						expect(page.ok).toBe(true);
						if (!page.ok) throw new Error(page.error);
						expect(page.historyEpoch).toBe(1);
						expect(page.entries.map((entry) => entry.message)).toEqual([
							"[device-logs] device logs cleared",
						]);
					} else if (kind === "around") {
						const around = logAroundOutputSchema.parse(result);
						expect(around.ok).toBe(true);
						if (!around.ok) throw new Error(around.error);
						expect(
							[...around.older.entries, ...around.newer.entries].map(
								(entry) => entry.message,
							),
						).toEqual(["[device-logs] device logs cleared"]);
						expect(around.older.historyEpoch).toBe(1);
						expect(around.newer.historyEpoch).toBe(1);
					} else {
						expect(logFollowStartOutputSchema.parse(result).ok).toBe(true);
						logger.info("post-clear");
						await turn();
						h.time.advance(250);
						expect(
							messages.flatMap((message) =>
								message.entries.map((entry) => entry.message),
							),
						).toEqual(["post-clear"]);
					}
				} finally {
					gate.release();
					await h.wait(
						Promise.allSettled([clearing, ...(attempt ? [attempt] : [])]),
						"clear and admission settlement",
					);
				}
			};
			test(
				`${kind} waits through ${mock ? "mock" : "native"} clear ${boundary} and reads the new history`,
				async () => {
					const fixture = historyFixture(mock, eventTimeoutMs);
					if (!nativeRotateExport) {
						fixtureToDispose = fixture;
						await verify(fixture);
						return;
					}
					// Bun's separate hook timeout would preempt this row's watchdog.
					try {
						await verify(fixture);
					} finally {
						await fixture.dispose();
					}
				},
				// Leave room for a phase watchdog and bounded settlement before Bun fails.
				nativeRotateExport ? 15_000 : undefined,
			);
		}
	}
}
