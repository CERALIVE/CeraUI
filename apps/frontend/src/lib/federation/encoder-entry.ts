import { m } from "@ceraui/i18n/svelte";
import type {
	ConfigMessage,
	Framerate,
	Resolution,
	VideoCodec,
} from "@ceraui/rpc/schemas";
import { mount, unmount } from "svelte";
import { toast } from "svelte-sonner";
import "../../app.css";
import { buildEncoderSetConfig } from "$lib/streaming/encoderConfig";
import { encoderSaveErrorMessage } from "$lib/streaming/encoderSaveError";
import EncoderDialog, {
	type FailoverRatePolicy,
} from "$main/dialogs/EncoderDialog.svelte";
import {
	FEDERATION_ABI_VERSION,
	type FederationMountHandle,
	type FederationMountOptions,
	requireAppliedConfig,
} from "./host-contract";
import { applyFederationLocale, registerFederationMessages } from "./messages";
import { mountFederationToastHost } from "./toast-host";

registerFederationMessages();

export const federationAbiVersion = FEDERATION_ABI_VERSION;

type HostedEncoderConfig = {
	readonly source?: string;
	readonly resolution: Resolution | undefined;
	readonly framerate: Framerate | undefined;
	readonly bitrate: number | undefined;
	readonly bitrateOverlay: boolean | undefined;
	readonly codec?: VideoCodec;
	readonly failoverRatePolicy?: FailoverRatePolicy;
};

function encoderConfig(config: ConfigMessage | undefined): HostedEncoderConfig {
	const policy = config?.failover_rate_policy;
	return {
		resolution: config?.resolution,
		framerate: config?.framerate,
		bitrate: config?.max_br,
		bitrateOverlay: config?.bitrate_overlay,
		codec: config?.video_codec,
		...(policy === undefined ? {} : { failoverRatePolicy: policy }),
	};
}

async function saveEncoderConfig(
	options: FederationMountOptions,
	draft: HostedEncoderConfig,
): Promise<void> {
	try {
		const result = await options.host.setConfig(
			buildEncoderSetConfig(draft, undefined),
		);
		// Named BEFORE `requireAppliedConfig` throws: it collapses every refusal
		// into one opaque Error, so the typed reason has to be read off the result.
		if (!result.success) {
			toast.error(encoderSaveErrorMessage(result.error, m));
			return;
		}
		requireAppliedConfig(result);
	} catch {
		toast.error(m["notifications.saveFailed"]());
	}
}

export function mountDialog(
	target: Element,
	options: FederationMountOptions,
): FederationMountHandle {
	applyFederationLocale(options.locale);
	const destroyToastHost = mountFederationToastHost(target);
	const component = mount(EncoderDialog, {
		target,
		props: {
			open: true,
			config: encoderConfig(options.config),
			capabilities: options.capabilities,
			onSave: (draft: HostedEncoderConfig) => {
				void saveEncoderConfig(options, draft);
			},
		},
	});
	return {
		destroy: async () => {
			await unmount(component);
			await destroyToastHost();
		},
	};
}
