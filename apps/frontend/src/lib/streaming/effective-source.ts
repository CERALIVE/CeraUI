/**
 * Effective-source derivation — SINGLE SOURCE OF TRUTH for the "which source is
 * actually selected right now" question, shared by every Live surface (C1).
 *
 * Two surfaces disagreed on this before: `StreamSetupChain.svelte` folded an
 * implicit sole-camera into its Start payload, while `SourceSection.svelte` had
 * no notion of it at all. Extracting the predicate here means the two can NEVER
 * diverge — both consume `deriveEffectiveSource` and `hasEffectiveSource`.
 *
 * The rule (carried over VERBATIM from StreamSetupChain's readiness wiring):
 *   • effective = the explicit `config.source`, else the implicit sole camera.
 *   • sole camera = ONLY when `config.source` is unset AND there is EXACTLY one
 *     capture-origin source. No config is written for it — it is a derived id the
 *     readiness + Start use; the row never renders once `config.source` is set.
 *
 * Pure + rune-free (no `$state`, no RPC, no Svelte): fully unit-testable without
 * mounting a component.
 */
import type {
	CaptureStreamSource,
	ConfigMessage,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";

/** The resolved effective-source view. All fields absent-safe. */
export interface EffectiveSource {
	/** Every capture-origin source, in broadcast order. */
	readonly captureSources: readonly CaptureStreamSource[];
	/**
	 * The implicit sole camera — set ONLY when `config.source` is unset AND there
	 * is exactly one capture-origin source. `undefined` otherwise.
	 */
	readonly soleCamera: CaptureStreamSource | undefined;
	/** The explicit `config.source`, else the implicit sole camera's id. */
	readonly effectiveSourceId: string | undefined;
}

/**
 * Derive the effective source from a config + sources snapshot. Mirrors
 * `StreamSetupChain.svelte`'s `captureSources` / `soleCamera` / `effectiveSourceId`
 * derivation exactly — the ONE place that logic lives.
 */
export function deriveEffectiveSource(
	config: ConfigMessage | undefined,
	sources: SourcesMessage | undefined,
): EffectiveSource {
	const captureSources = (sources?.sources.filter(
		(source) => source.origin === "capture",
	) ?? []) as CaptureStreamSource[];

	const soleCamera =
		!config?.source && captureSources.length === 1
			? captureSources[0]
			: undefined;

	const effectiveSourceId = config?.source ?? soleCamera?.id;

	return { captureSources, soleCamera, effectiveSourceId };
}

/**
 * FAIL-OPEN visibility gate for surfaces that should only render once an
 * effective source exists.
 *
 * Returns `true` (render) when EITHER:
 *   • `sources` is `undefined` — a standalone / federation mount where the source
 *     list is genuinely unknown; the gate must never hide in that case, or the
 *     dialog would render blank outside the cockpit.
 *   • an effective source exists (`config.source` set, OR the implicit sole
 *     camera resolves).
 *
 * Returns `false` (hide) ONLY when sources are KNOWN and no source is selected
 * or implied — the empty-of-selection idle state.
 */
export function hasEffectiveSource(
	config: ConfigMessage | undefined,
	sources: SourcesMessage | undefined,
): boolean {
	if (sources === undefined) return true;
	return deriveEffectiveSource(config, sources).effectiveSourceId !== undefined;
}

function resolveEffectiveSourceEntry(
	config: ConfigMessage | undefined,
	sources: SourcesMessage,
): StreamSource | undefined {
	const { effectiveSourceId } = deriveEffectiveSource(config, sources);
	if (effectiveSourceId === undefined) return undefined;
	return sources.sources.find((source) => source.id === effectiveSourceId);
}

/**
 * Stamp the start-config base onto the EFFECTIVE SOURCE so the TWO Start gates
 * cannot disagree.
 *
 * The readiness source gate resolves `config.source` against the sources snapshot
 * and enables Start; `buildStartConfig`'s recognition gate reads the persisted,
 * DERIVED `config.pipeline` and refuses with `unknownPipeline`. When those two
 * drift the Start button renders enabled and then toasts a refusal on click — a
 * control that lies about being actionable.
 *
 * Resolving ⇒ `source` + `pipeline` come from THAT row (a stale pipeline can never
 * reach the payload). Not resolving ⇒ `pipeline` is DROPPED, so the start refuses
 * for exactly the reason readiness blocks, and a recognized-but-unrelated
 * persisted pipeline cannot smuggle a start past an unofferable source.
 *
 * An absent `sources` snapshot is fail-open: a federation / standalone mount does
 * not know the source list, and reconciling against nothing would refuse every
 * start there.
 */
export function reconcileStartSource(
	config: ConfigMessage | undefined,
	sources: SourcesMessage | undefined,
): ConfigMessage | undefined {
	if (config === undefined || sources === undefined) return config;

	const entry = resolveEffectiveSourceEntry(config, sources);
	if (entry === undefined) {
		const { pipeline: _unresolvable, ...rest } = config;
		return rest as ConfigMessage;
	}

	return { ...config, source: entry.id, pipeline: entry.pipelineId };
}
