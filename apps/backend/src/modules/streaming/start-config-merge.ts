import {
	type StreamingConfigInput,
	streamingConfigInputSchema,
} from "@ceraui/rpc/schemas";

function definedFields(input: StreamingConfigInput): StreamingConfigInput {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	) as StreamingConfigInput;
}

export function mergePersistedStartConfig(
	persistedConfig: unknown,
	requestedConfig: unknown,
): StreamingConfigInput {
	const persisted = streamingConfigInputSchema.parse(persistedConfig);
	const requested = definedFields(
		streamingConfigInputSchema.parse(requestedConfig),
	);
	const effective: StreamingConfigInput = { ...persisted, ...requested };

	const requestsManualEndpoint =
		requested.srtla_addr !== undefined || requested.srtla_port !== undefined;
	if (requested.relay_server !== undefined) {
		effective.srtla_addr = undefined;
		effective.srtla_port = undefined;
	} else if (requestsManualEndpoint) {
		effective.relay_server = undefined;
		effective.relay_account = undefined;
	}

	if (!requestsManualEndpoint && requested.relay_account !== undefined) {
		effective.srt_streamid = undefined;
	} else if (requested.srt_streamid !== undefined) {
		effective.relay_account = undefined;
	}

	return effective;
}
