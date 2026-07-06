/**
 * Device-wide source-visibility flags (config-only, NOT a service gate).
 *
 * This is a LEAF schema module: it imports nothing but `zod`, so both
 * `streaming.schema.ts` (which folds `sourcesVisibilitySchema` into
 * `configMessageSchema` for the frontend echo) and `sources.schema.ts` can import
 * it without a circular dependency. Keep it dependency-free.
 *
 * `hide_test_pattern` toggles the VIRTUAL (test-pattern) source's visibility.
 * When true, the backend still EMITS the virtual row (never drops it) but marks it
 * `available:false` with the existing `live.education.reason.disabledInSettings`
 * reason — the SAME reason the operator-disabled network-ingest rows carry. The
 * frontend owns fail-visible rendering (filter when unselected, show
 * disabled-with-hint when selected). This is config-only row visibility — it is
 * NOT routed through the gateway/three-mirror service predicate.
 */
import { z } from 'zod';

/**
 * The persisted `sources_visibility` config value. `hide_test_pattern` defaults to
 * `false` (all-visible) so an absent inner key parses cleanly. The OUTER config key
 * itself is `.optional()` at each consumer (runtimeConfigSchema / configMessageSchema)
 * so a legacy config with no `sources_visibility` at all still parses.
 */
export const sourcesVisibilitySchema = z.object({
	hide_test_pattern: z.boolean().default(false),
});
export type SourcesVisibility = z.infer<typeof sourcesVisibilitySchema>;

/**
 * Input for `streaming.setSourceVisibility`. `hide_test_pattern` is REQUIRED here
 * (no default) — the single mutation path is an explicit operator toggle, so a
 * malformed/absent value must be rejected by Zod, never silently defaulted.
 */
export const setSourceVisibilityInputSchema = z.object({
	hide_test_pattern: z.boolean(),
});
export type SetSourceVisibilityInput = z.infer<
	typeof setSourceVisibilityInputSchema
>;

/**
 * Output for `streaming.setSourceVisibility` — the applied-state envelope every
 * setter returns. `applied` reflects the value actually persisted so the frontend
 * locks its toggle to the server truth, not the raw input.
 */
export const setSourceVisibilityOutputSchema = z.object({
	success: z.boolean(),
	applied: setSourceVisibilityInputSchema.optional(),
	error: z.string().optional(),
});
export type SetSourceVisibilityOutput = z.infer<
	typeof setSourceVisibilityOutputSchema
>;
