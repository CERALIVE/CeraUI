import {
	BLUEALSA_BINARIES,
	BLUEALSA_PACKAGE_MARKER,
	PIPEWIRE_BLUETOOTH_PACKAGE_MARKER,
} from "./bluetooth-constants.ts";

export const BLUETOOTH_AUDIO_PROVIDERS = [
	"bluealsa",
	"pipewire",
	"unavailable",
] as const;

export type BluetoothAudioProvider = (typeof BLUETOOTH_AUDIO_PROVIDERS)[number];

export interface BluetoothAudioProviderDeps {
	readonly fileExists: (path: string) => Promise<boolean>;
}

/**
 * Detect the installed Bluetooth-audio generation before touching its service.
 * BlueALSA wins when both generations are present so an old mixed image retains
 * its previously working unit contract instead of being silently reclassified.
 */
export async function detectBluetoothAudioProvider(
	deps: BluetoothAudioProviderDeps = {
		fileExists: (path) => Bun.file(path).exists(),
	},
): Promise<BluetoothAudioProvider> {
	for (const binary of BLUEALSA_BINARIES) {
		if (await deps.fileExists(binary)) return "bluealsa";
	}
	if (await deps.fileExists(BLUEALSA_PACKAGE_MARKER)) return "bluealsa";
	if (await deps.fileExists(PIPEWIRE_BLUETOOTH_PACKAGE_MARKER))
		return "pipewire";
	return "unavailable";
}
