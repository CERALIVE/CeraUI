import type {
	RelayProtocol,
	RelayValidateInput,
	StreamingConfigInput,
} from "@ceraui/rpc/schemas";
import { toast } from "svelte-sonner";
import {
	reduceValidateError,
	reduceValidateResult,
	type Validation,
} from "$lib/components/streaming/relay-validation";
import type { FederationHostAdapter } from "$lib/federation/host-contract";
import { rpc } from "$lib/rpc";
import { markPending, onRpcResolved } from "$lib/rpc/dirty-registry.svelte";
import type { ManagedIngestAccount } from "$lib/streaming/receiver-experience";
import {
	buildManagedSlotConfig,
	buildServerSetConfig,
} from "$lib/streaming/receiver-experience";

export async function validateServerEndpoint(
	hostAdapter: FederationHostAdapter | undefined,
	input: RelayValidateInput,
): Promise<Validation> {
	try {
		const result = await (hostAdapter?.validateRelay(input) ??
			rpc.relay.validate(input));
		return reduceValidateResult(result);
	} catch (error) {
		return reduceValidateError(error);
	}
}

export type SaveServerResult =
	| { readonly kind: "close" }
	| { readonly kind: "failed" }
	| { readonly kind: "applied-latency"; readonly value: number };

interface ServerInputOptions {
	readonly managedSlot?: ManagedIngestAccount;
	readonly latency: number;
	readonly protocol: RelayProtocol;
	readonly addr: string;
	readonly portStr: string;
	readonly streamId: string;
	readonly relayStreamId: string;
	readonly relayServer: string;
	readonly relayAccount: string;
	readonly destination: "managed" | "custom";
}

export function buildServerDialogInput(
	options: ServerInputOptions,
): StreamingConfigInput {
	return options.managedSlot
		? buildManagedSlotConfig(options.managedSlot, options.latency)
		: buildServerSetConfig(
				{
					latency: options.latency,
					protocol: options.protocol,
					addr: options.addr,
					portStr: options.portStr,
					streamId: options.streamId,
					relayStreamId: options.relayStreamId,
					relayServer: options.relayServer,
					relayAccount: options.relayAccount,
				},
				{ destination: options.destination },
			);
}

interface SaveServerOptions {
	readonly hostAdapter?: FederationHostAdapter;
	readonly input: StreamingConfigInput;
	readonly onSaved: () => void;
	readonly savedMessage: string;
	readonly failedMessage: string;
}

export async function saveServerConfig(
	options: SaveServerOptions,
): Promise<SaveServerResult> {
	const fields = Object.entries(options.input);
	for (const [field, value] of fields) markPending(field, value);
	try {
		const result = await (options.hostAdapter?.setConfig(options.input) ??
			rpc.streaming.setConfig(options.input));
		toast.success(options.savedMessage);
		options.onSaved();
		const requested = options.input.srt_latency;
		const applied = result?.applied?.srt_latency;
		return requested !== undefined &&
			typeof applied === "number" &&
			applied !== requested
			? { kind: "applied-latency", value: applied }
			: { kind: "close" };
	} catch {
		toast.error(options.failedMessage);
		return { kind: "failed" };
	} finally {
		for (const [field] of fields) onRpcResolved(field);
	}
}
