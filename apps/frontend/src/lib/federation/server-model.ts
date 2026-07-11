import type { RelayProtocol, RelayValidateInput } from "@ceraui/rpc/schemas";

import type { ReceiverDestinationChoice } from "$lib/streaming/receiver-experience";

export type ServerDraft = {
	destination_choice?: ReceiverDestinationChoice;
	srtla_addr?: string;
	srtla_port?: string;
	srt_streamid?: string;
	srt_latency?: number;
	relay_server?: string;
	relay_account?: string;
	relay_streamid?: string;
	passphrase?: string;
	selected_slot?: string;
};

type ProviderTagged = {
	readonly provider?: { readonly kind?: ReceiverDestinationChoice };
};

export function filterProviderEntries<T extends ProviderTagged>(
	entries: [string, T][],
	provider: ReceiverDestinationChoice,
): [string, T][] {
	return entries.filter(
		([, info]) => (info.provider?.kind ?? provider) === provider,
	);
}

export function relayEndpoint(
	info: { readonly addr?: string; readonly port?: number } | undefined,
) {
	return info?.addr && info.port ? `${info.addr}:${info.port}` : undefined;
}

export function buildRelayValidationInput(
	addr: string,
	port: number | undefined,
	streamId: string,
	passphrase: string,
	protocol: RelayProtocol,
): RelayValidateInput {
	return {
		addr: addr.trim(),
		port: port ?? 0,
		...(streamId.trim() === "" ? {} : { streamid: streamId.trim() }),
		...(passphrase.trim() === "" ? {} : { passphrase: passphrase.trim() }),
		protocol,
	};
}
