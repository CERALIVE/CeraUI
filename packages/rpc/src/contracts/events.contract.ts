import { oc } from '@orpc/contract';
import { successResponseSchema } from '../schemas/common.schema';
import {
	eventBootsOutputSchema,
	eventListInputSchema,
	eventListOutputSchema,
} from '../schemas/events-wire.schema';

export const eventsContract = oc.router({
	list: oc.input(eventListInputSchema).output(eventListOutputSchema),
	boots: oc.output(eventBootsOutputSchema),
	clear: oc.output(successResponseSchema),
});
