/**
 * Relay ORPC Contract
 */
import { oc } from '@orpc/contract';

import { relayValidateInputSchema, relayValidateOutputSchema } from '../schemas';

export const relayContract = oc.router({
	/**
	 * Validate a manual custom-relay endpoint without starting a stream.
	 * Returns the first failing stage (input → protocol → endpoint → dns) or ok.
	 */
	validate: oc.input(relayValidateInputSchema).output(relayValidateOutputSchema),
});
