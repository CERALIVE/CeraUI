import type { StatusResponse } from "@ceraui/rpc/schemas";
import {
	admitStatusFrame,
	getLinkEpoch,
	type Receipt,
	statusFrameIsCurrent,
} from "./session-epoch.svelte";

// Settlement reads is_streaming and stream_lifecycle as ONE unit. New fields
// must acquire an explicit unrelated classification, never silently escape it.
const unrelatedFields: ReadonlySet<string> = new Set([
	"available_updates",
	"updating",
	"update_state",
	"update_orchestrator",
	"ssh",
	"wifi",
	"modems",
	"asrcs",
	"audio_sources",
	"resolved_asrc",
	"resolved_asrc_reason",
	"resolved_asrc_candidates",
	"pending_audio_follow_asrc",
	"set_password",
	"remote",
	"linkTelemetry",
	"bond_mapping",
	"buffering",
	"active_encode",
	"engine_bitrate",
	"preview_encoder_realized",
	"network_ingest",
	"cellular_initializing",
	"unclaimed_adapters",
] satisfies readonly (keyof StatusResponse)[]);

function isStreamFact(field: string): boolean {
	return !unrelatedFields.has(field);
}

interface FieldDelivery {
	readonly link: number;
	readonly at: number;
	readonly pushedAt: number;
	readonly dispatchedAt: number;
}

// Page-clock ordering survives resetState; a new link ignores old-link marks.
const deliveries = new Map<string, FieldDelivery>();

/** Select admissible fields independently; stream facts share one horizon. */
export function selectStatusFields(
	status: StatusResponse,
	receipt: Receipt,
	wasStreaming: boolean,
): StatusResponse | undefined {
	if (
		receipt.link !== getLinkEpoch() ||
		(receipt.dispatch !== undefined && receipt.dispatch.link !== receipt.link)
	)
		return undefined;
	const streamCurrent = statusFrameIsCurrent(receipt);
	// Implicit stop retractions obey the same per-field ordering as supplied data.
	const incoming =
		streamCurrent && wasStreaming && status.is_streaming === false
			? {
					...status,
					linkTelemetry: null,
					active_encode: null,
					engine_bitrate: null,
					preview_encoder_realized: null,
					bond_mapping: null,
				}
			: status;
	const fields = Object.entries(incoming).filter(([field]) => {
		if (isStreamFact(field)) return streamCurrent;
		const previous = deliveries.get(field);
		return (
			previous === undefined ||
			previous.link !== receipt.link ||
			(receipt.at >= previous.at &&
				(receipt.dispatch === undefined ||
					(receipt.dispatch.at >= previous.pushedAt &&
						receipt.dispatch.at >= previous.dispatchedAt)))
		);
	});
	if (fields.some(([field]) => isStreamFact(field))) admitStatusFrame(receipt);
	for (const [field] of fields) {
		const previous = deliveries.get(field);
		const sameLink = previous?.link === receipt.link;
		deliveries.set(field, {
			link: receipt.link,
			at: receipt.at,
			pushedAt:
				receipt.dispatch === undefined
					? receipt.at
					: sameLink
						? previous.pushedAt
						: 0,
			dispatchedAt:
				receipt.dispatch?.at ?? (sameLink ? previous.dispatchedAt : 0),
		});
	}
	return Object.fromEntries(fields);
}
