import {
	eventBootsOutputSchema,
	eventListInputSchema,
	eventListOutputSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import {
	clearEvents,
	readBoots,
	readEvents,
} from "../../modules/events/store.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const authedProcedure = os.$context<RPCContext>().use(authMiddleware);

export const listEventsProcedure = authedProcedure
	.input(eventListInputSchema)
	.output(eventListOutputSchema)
	.handler(({ input }) => {
		const retained = readEvents().sort((a, b) => b.seq - a.seq);
		const matches = retained.filter(
			(event) =>
				(input.beforeSeq === undefined || event.seq < input.beforeSeq) &&
				(input.bootId === undefined || event.bootId === input.bootId) &&
				(!input.families?.length || input.families.includes(event.family)) &&
				(!input.problemsOnly ||
					event.severity === "error" ||
					event.severity === "warning"),
		);
		const events = matches.slice(0, input.limit);
		return {
			events,
			nextBeforeSeq:
				matches.length > events.length ? (events.at(-1)?.seq ?? null) : null,
			headSeq: retained[0]?.seq ?? 0,
			retainedFromSeq: retained.at(-1)?.seq ?? 0,
		};
	});

export const eventBootsProcedure = authedProcedure
	.output(eventBootsOutputSchema)
	.handler(() => readBoots());

export const clearEventsProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(() => ({ success: clearEvents() }));
