import type { Pipelines, Resolution, Framerate } from "@ceraui/rpc/schemas";
import { toast } from "svelte-sonner";

type Properties = {
	source: string | undefined;
	resolution: Resolution | undefined;
	framerate: Framerate | undefined;
	bitrate: number | undefined;
	relayServer: string | undefined;
	srtlaServerAddress: string | undefined;
	srtlaServerPort: number | undefined;
	pipeline: keyof Pipelines | undefined;
	audioSource: string | undefined;
	audioCodec: string | undefined;
};

type ValidationOptions = {
	pipelines: Pipelines | undefined;
};

export interface ValidationResult {
	isValid: boolean;
	errors: Record<string, string>;
}

export function validateStreamingForm(
	properties: Properties,
	t: (key: string) => string,
	options?: ValidationOptions,
): ValidationResult {
	const formErrors: Record<string, string> = {};
	let hasErrors = false;
	const errorMessages: string[] = [];

	// Validate Video Source
	if (!properties.source) {
		formErrors.source = t("settings.errors.inputModeRequired");
		errorMessages.push(t("settings.errors.inputModeRequired"));
		hasErrors = true;
	}

	// Validate Bitrate
	if (
		!properties.bitrate ||
		properties.bitrate < 2000 ||
		properties.bitrate > 12000
	) {
		formErrors.bitrate = t("settings.errors.bitrateInvalid");
		errorMessages.push(t("settings.errors.bitrateInvalid"));
		hasErrors = true;
	}

	// Validate Audio Settings (when pipeline requires them)
	if (options?.pipelines && properties.pipeline) {
		const pipelineData = options.pipelines[properties.pipeline];
		if (pipelineData?.supportsAudio) {
			// Validate audio source when pipeline supports audio
			if (!properties.audioSource) {
				formErrors.audioSource = t("settings.errors.audioSourceRequired");
				errorMessages.push(t("settings.errors.audioSourceRequired"));
				hasErrors = true;
			}

			// Validate audio codec when pipeline supports audio
			if (!properties.audioCodec) {
				formErrors.audioCodec = t("settings.errors.audioCodecRequired");
				errorMessages.push(t("settings.errors.audioCodecRequired"));
				hasErrors = true;
			}
		}
	}

	// Validate Receiver Server Configuration
	if (properties.relayServer === "-1" || properties.relayServer === undefined) {
		// Manual Configuration - validate SRTLA server settings
		if (
			!properties.srtlaServerAddress ||
			properties.srtlaServerAddress.trim() === ""
		) {
			formErrors.srtlaServerAddress = t(
				"settings.errors.srtlaServerAddressRequired",
			);
			errorMessages.push(t("settings.errors.srtlaServerAddressRequired"));
			hasErrors = true;
		}

		if (
			!properties.srtlaServerPort ||
			!Number.isInteger(properties.srtlaServerPort) ||
			properties.srtlaServerPort < 1 ||
			properties.srtlaServerPort > 65535
		) {
			formErrors.srtlaServerPort = t("settings.errors.srtlaServerPortRequired");
			errorMessages.push(t("settings.errors.srtlaServerPortRequired"));
			hasErrors = true;
		}
	} else {
		// Automatic Configuration - validate relay server selection
		if (!properties.relayServer || properties.relayServer === "") {
			formErrors.relayServer = t("settings.errors.relayServerRequired");
			errorMessages.push(t("settings.errors.relayServerRequired"));
			hasErrors = true;
		}
	}

	// Show toast messages - single error toast for all errors or success
	if (hasErrors) {
		toast.error(errorMessages[0], {
			description:
				errorMessages.length > 1
					? `${errorMessages.length} validation errors found`
					: undefined,
		});
	} else {
		toast.success(t("settings.validation.allFieldsValid"));
	}

	return {
		isValid: !hasErrors,
		errors: formErrors,
	};
}
