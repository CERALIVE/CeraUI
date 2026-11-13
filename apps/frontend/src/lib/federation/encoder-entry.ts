import { m } from "@ceraui/i18n/svelte";
import type {
	ConfigMessage,
	Framerate,
	Resolution,
	VideoCodec,
	VideoPassthrough,
} from "@ceraui/rpc/schemas";
import { mount, unmount } from "svelte";
import { toast } from "svelte-sonner";
import "../../app.css";
import { buildEncoderSetConfig } from "$lib/streaming/encoderConfig";
import { encoderSaveErrorMessage } from "$lib/streaming/encoderSaveError";
import type { BalancerAlgorithm } from "$lib/streaming/outputFormat";
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
	readonly codec?: VideoCodec | null;
	readonly balancer?: BalancerAlgorithm;
	readonly passthrough?: VideoPassthrough;
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
		balancer: config?.balancer,
		passthrough: config?.video_passthrough,
		...(policy === undefined ? {} : { failoverRatePolicy: policy }),
	};
}

// The saved-passthrough notice's reset, written through the host like any save.
async function resetPassthrough(
	options: FederationMountOptions,
): Promise<boolean> {
	try {
		const result = await options.host.setConfig({ video_passthrough: "auto" });
		if (!result.success) {
			toast.error(encoderSaveErrorMessage(result.error, m));
			return false;
		}
		return true;
	} catch {
		toast.error(m["notifications.saveFailed"]());
		return false;
	}
}

async function saveEncoderConfig(
	options: FederationMountOptions,
	draft: HostedEncoderConfig,
): Promise<void> {
	const input = buildEncoderSetConfig(draft, undefined);
	// An untouched Save carries nothing: write nothing through the host.
	if (Object.keys(input).length === 0) return;
	try {
		const result = await options.host.setConfig(input);
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
			onResetPassthrough: () => resetPassthrough(options),
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
