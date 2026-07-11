import type { RelayProtocol, RelayValidateInput } from "@ceraui/rpc/schemas";
import {
	manualSaveEnabled,
	type Validation,
} from "$lib/components/streaming/relay-validation";
import { isPortValid } from "$lib/components/streaming/ValidationAdapter";
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

interface ServerSaveGate {
	readonly destination: "managed" | "custom";
	readonly isStreaming: boolean;
	readonly addr: string;
	readonly portStr: string;
	readonly hasPortError: boolean;
	readonly validation: Validation;
	readonly selectedManagedActive: boolean;
	readonly hasManagedSlots: boolean;
	readonly hasActiveSlot: boolean;
	readonly relayServer: string;
}

export function canSaveServer(input: ServerSaveGate): boolean {
	if (input.destination === "custom") {
		return manualSaveEnabled(input);
	}
	if (input.isStreaming || !input.selectedManagedActive) return false;
	return input.hasManagedSlots ? input.hasActiveSlot : input.relayServer !== "";
}

export function serverEndpointErrors(input: {
	readonly destination: "managed" | "custom";
	readonly portStr: string;
	readonly port: number | undefined;
	readonly draftAddr: string | undefined;
	readonly portRangeMessage: string;
	readonly addressRequiredMessage: string;
}): { readonly port?: string; readonly address?: string } {
	const port =
		input.destination === "custom" &&
		input.portStr.trim() !== "" &&
		!isPortValid(input.port)
			? input.portRangeMessage
			: undefined;
	const address =
		input.destination === "custom" &&
		input.draftAddr !== undefined &&
		input.draftAddr.trim() === ""
			? input.addressRequiredMessage
			: undefined;
	return { port, address };
}
