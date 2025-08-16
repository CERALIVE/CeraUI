import { toast } from 'svelte-sonner';

type Properties = {
  inputMode: string | undefined;
  encoder: string | undefined;
  resolution: string | undefined;
  framerate: string | undefined;
  bitrate: number | undefined;
  relayServer: string | undefined;
  srtlaServerAddress: string | undefined;
  srtlaServerPort: number | undefined;
};

export interface ValidationResult {
  isValid: boolean;
  errors: Record<string, string>;
}

export function validateStreamingForm(properties: Properties, t: (key: string) => string): ValidationResult {
  const formErrors: Record<string, string> = {};
  let hasErrors = false;
  const errorMessages: string[] = [];

  // Validate Input Mode
  if (!properties.inputMode) {
    formErrors.inputMode = t('settings.errors.inputModeRequired');
    errorMessages.push(t('settings.errors.inputModeRequired'));
    hasErrors = true;
  }

  // Validate Encoding Format
  if (!properties.encoder) {
    formErrors.encoder = t('settings.errors.encoderRequired');
    errorMessages.push(t('settings.errors.encoderRequired'));
    hasErrors = true;
  }

  // Validate Encoding Resolution
  if (!properties.resolution) {
    formErrors.resolution = t('settings.errors.resolutionRequired');
    errorMessages.push(t('settings.errors.resolutionRequired'));
    hasErrors = true;
  }

  // Validate Framerate
  if (!properties.framerate) {
    formErrors.framerate = t('settings.errors.framerateRequired');
    errorMessages.push(t('settings.errors.framerateRequired'));
    hasErrors = true;
  }

  // Validate Bitrate
  if (!properties.bitrate || properties.bitrate < 2000 || properties.bitrate > 12000) {
    formErrors.bitrate = t('settings.errors.bitrateInvalid');
    errorMessages.push(t('settings.errors.bitrateInvalid'));
    hasErrors = true;
  }

  // Validate Receiver Server Configuration
  if (properties.relayServer === '-1' || properties.relayServer === undefined) {
    // Manual Configuration - validate SRTLA server settings
    if (!properties.srtlaServerAddress || properties.srtlaServerAddress.trim() === '') {
      formErrors.srtlaServerAddress = t('settings.errors.srtlaServerAddressRequired');
      errorMessages.push(t('settings.errors.srtlaServerAddressRequired'));
      hasErrors = true;
    }

    if (!properties.srtlaServerPort || properties.srtlaServerPort <= 0) {
      formErrors.srtlaServerPort = t('settings.errors.srtlaServerPortRequired');
      errorMessages.push(t('settings.errors.srtlaServerPortRequired'));
      hasErrors = true;
    }
  } else {
    // Automatic Configuration - validate relay server selection
    if (!properties.relayServer || properties.relayServer === '') {
      formErrors.relayServer = t('settings.errors.relayServerRequired');
      errorMessages.push(t('settings.errors.relayServerRequired'));
      hasErrors = true;
    }
  }

  // Show toast messages - single error toast for all errors or success
  if (hasErrors) {
    // Show a single toast with the first error (to avoid spam)
    toast.error(errorMessages[0], {
      description: errorMessages.length > 1 ? `${errorMessages.length} validation errors found` : undefined
    });
  } else {
    toast.success(t('settings.validation.allFieldsValid'));
  }

  return {
    isValid: !hasErrors,
    errors: formErrors,
  };
}
