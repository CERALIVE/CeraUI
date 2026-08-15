import { registerAllNamespaces } from "../generated/eager.js";

/**
 * Load the message catalog before any gate renders through it.
 *
 * Every namespace is a lazily-imported chunk (`EAGER_NAMESPACES` in
 * `scripts/generate-registry.ts`) so the ten-locale Paraglide catalog stays out
 * of the SPA's entry chunk. Nothing here runs the app entry that awaits
 * `ensureAllNamespaces()`, so without this every `m["ns.key"]()` would return
 * its own dotted key and the render gates would diff a key against the oracle.
 */
registerAllNamespaces();
