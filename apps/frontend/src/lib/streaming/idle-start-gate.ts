/**
 * The idle Live bar's Start gate as one pure call.
 *
 * `StreamSetupChain` decides whether Start is allowed from the readiness
 * verdict, after folding in the implicit sole camera and the gateway verdict
 * for the effective source's pipeline. A Start that does not come from that
 * button (Try again on a refusal toast) must make the same decision from the
 * same inputs at the moment it fires, or it could start a stream the bar
 * would refuse. This is that decision, with the same building blocks.
 */
import type { NetworkIngest, Pipelines } from "@ceraui/rpc/schemas";

import {
	deriveEffectiveSource,
	type EffectiveSource,
} from "./effective-source";
import {
	deriveGoLiveReadiness,
	type GoLiveReadiness,
	type GoLiveReadinessInput,
} from "./go-live-readiness";
import { pipelineAvailability } from "./pipelineAvailability";

interface IdleStartGateInput
	extends Omit<GoLiveReadinessInput, "gatewayStatus"> {
	readonly networkIngest: NetworkIngest | null | undefined;
	readonly pipelines: Pipelines | undefined;
}

export interface IdleStartGate {
	readonly effective: EffectiveSource;
	readonly readiness: GoLiveReadiness;
}

export function idleStartGate(input: IdleStartGateInput): IdleStartGate {
	const { config, sources, pipelines, networkIngest } = input;
	const effective = deriveEffectiveSource(config, sources);
	const source = effective.soleCamera?.id;
	const entry = effective.effectiveSourceId
		? sources?.sources.find(
				(candidate) => candidate.id === effective.effectiveSourceId,
			)
		: undefined;
	const readiness = deriveGoLiveReadiness({
		...input,
		config: source !== undefined && config ? { ...config, source } : config,
		gatewayStatus: pipelineAvailability(
			entry && pipelines?.[entry.pipelineId],
			networkIngest,
		),
	});
	return { effective, readiness };
}
