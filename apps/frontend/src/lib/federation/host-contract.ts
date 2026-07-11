import type {
	ConfigMessage,
	RelayValidateInput,
	RelayValidateOutput,
	StreamingConfigInput,
	StreamingSetConfigOutput,
} from "@ceraui/rpc/schemas";

export const FEDERATION_ABI_VERSION = 1 as const;

export interface FederationHostAdapter {
	setConfig(input: StreamingConfigInput): Promise<StreamingSetConfigOutput>;
	validateRelay(input: RelayValidateInput): Promise<RelayValidateOutput>;
}

export interface FederationMountOptions {
	readonly host: FederationHostAdapter;
	readonly config?: ConfigMessage;
}

export interface FederationMountHandle {
	destroy(): Promise<void>;
}
