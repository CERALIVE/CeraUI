/**
 * Dev-only RPC schemas (NOT registered in production).
 *
 * `dev.emit` lets a test client trigger an arbitrary backend broadcast on demand
 * so Playwright can inject a conflicting `config`/`status` echo at a known time
 * (deterministic QA of the field-lock race-condition fix).
 *
 * The backend hard-gates this procedure on `NODE_ENV !== 'production'` at router
 * registration time — see apps/backend/src/rpc/router.ts.
 */
import { z } from 'zod';

export const devEmitInputSchema = z.object({
	type: z.string(),
	payload: z.unknown(),
});
export type DevEmitInput = z.infer<typeof devEmitInputSchema>;

export const devEmitOutputSchema = z.object({
	success: z.boolean(),
});
export type DevEmitOutput = z.infer<typeof devEmitOutputSchema>;
