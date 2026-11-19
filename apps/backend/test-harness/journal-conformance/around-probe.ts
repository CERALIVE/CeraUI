import { deepStrictEqual, equal } from "node:assert/strict";
import { formatProdEntry } from "../../src/helpers/logger.ts";
import { locatePagesAround } from "../../src/modules/device-logs/around.ts";
import {
	emitEvent,
	resetEventEmitterForTest,
} from "../../src/modules/events/emit.ts";

const [action, bootId, rawAt, cursor] = process.argv.slice(2);
if (!bootId) throw new TypeError("expected the fixture boot");
const eventId = `${bootId.slice(0, 8)}-1`;

if (action === "emit") {
	resetEventEmitterForTest({
		bootId: () => bootId,
		tailSeq: () => 0,
		appendEvent: () => undefined,
		log(level, message, meta) {
			console.log(formatProdEntry({ level, message, ...meta }));
		},
	});
	emitEvent("service_stopping", { signal: "SIGTERM" });
	console.log(
		formatProdEntry({
			level: "info",
			message: "event",
			module: "events",
			event_id: `${eventId}0`,
		}),
	);
	console.log(`free-text mention of ${eventId}`);
} else if (action === "lookup" && rawAt !== undefined && cursor) {
	const located = await locatePagesAround(
		{ bootId, at: Number(rawAt), eventId },
		{ epoch: 0, signal: new AbortController().signal },
	);
	if (!located.ok) throw new Error(located.error);
	equal(located.approximate, false);
	equal(located.anchor?.cursor, cursor);
	deepStrictEqual(
		located.newer.entries
			.filter(({ source }) => source === "app")
			.map(({ message }) => message),
		[`[events] event {"event_id":"${eventId}0"}`, `free-text mention of ${eventId}`],
	);
	console.log("PASS live: exact event producer anchor survives suffix and free-text collisions");
} else {
	throw new TypeError("expected emit or lookup with the fixture anchor");
}
