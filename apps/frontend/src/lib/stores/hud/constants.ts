/**
 * HUD constants — shared by the HUD sub-stores.
 *
 * Rune-free so every pure derivation module and the unit tests can import the
 * one global staleness threshold and link cap without pulling the reactive layer.
 */

/** Data older than this (ms) without a refresh is considered stale. */
export const STALE_THRESHOLD_MS = 5000;

/** Maximum bonded links the HUD renders (maps to --link-1..--link-6). */
export const MAX_LINKS = 6;

/** How often the reactive clock ticks to re-evaluate staleness (ms). */
export const CLOCK_INTERVAL_MS = 1000;
