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
import type {
	CapabilitiesMessage,
	ConfigMessage,
	NetifMessage,
	NetworkIngest,
	Pipelines,
	RelayMessage,
	SourcesMessage,
} from "@ceraui/rpc/schemas";

import { deriveEffectiveSource } from "./effective-source";
import { deriveGoLiveReadiness } from "./go-live-readiness";
import { pipelineAvailability } from "./pipelineAvailability";
import type { ManagedIngestAccount } from "./receiver-experience";

export interface IdleStartGateInput {
	readonly config: ConfigMessage | undefined;
	readonly caps: CapabilitiesMessage | undefined;
	readonly sources: SourcesMessage | undefined;
	readonly netif: NetifMessage | undefined;
	readonly isConnected: boolean;
	readonly networkIngest: NetworkIngest | null | undefined;
	readonly pipelines: Pipelines | undefined;
	readonly relays?: RelayMessage | undefined;
	readonly managedSlots?: readonly ManagedIngestAccount[] | undefined;
}

export interface IdleStartGate {
	/** Whether the Live bar would let Start through right now. */
	readonly canStart: boolean;
	/** The implicit sole camera to fold into the Start payload, as the bar does. */
	readonly source: string | undefined;
}

export function idleStartGate(input: IdleStartGateInput): IdleStartGate {
	const effective = deriveEffectiveSource(input.config, input.sources);
	const entry = effective.effectiveSourceId
		? input.sources?.sources.find(
				(source) => source.id === effective.effectiveSourceId,
			)
		: undefined;
	const gatewayStatus = pipelineAvailability(
		entry ? input.pipelines?.[entry.pipelineId] : undefined,
		input.networkIngest,
	);
	const config =
		effective.soleCamera && input.config
			? { ...input.config, source: effective.soleCamera.id }
			: input.config;
	const readiness = deriveGoLiveReadiness({
		config,
		caps: input.caps,
		sources: input.sources,
		netif: input.netif,
		isConnected: input.isConnected,
		gatewayStatus,
		relays: input.relays,
		managedSlots: input.managedSlots,
	});
	return { canStart: !readiness.blocking, source: effective.soleCamera?.id };
}
