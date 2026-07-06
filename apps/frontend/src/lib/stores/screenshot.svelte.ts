import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";
import { toast } from "svelte-sonner";

import type { NavElements } from "$lib/config";

// Screenshot data interface
export interface ScreenshotImage {
	filename: string;
	blob: Blob;
	theme: "dark" | "light";
	type: "desktop" | "mobile" | "offline";
}

export const REQUIRED_CAPTURE_DESTINATIONS = [
	"live",
	"network",
	"settings",
] as const;

export type CaptureDestination = (typeof REQUIRED_CAPTURE_DESTINATIONS)[number];

// Derives the capture list from `navElements` (the source `MainView` navigation
// uses) so it can never drift from the real 3-destination layout. Dev-only
// entries (`devtools`/`identity`, `isDev: true`) are excluded; throws if any
// required destination is absent rather than silently capturing fewer.
export function deriveCaptureKeys(elements: NavElements): string[] {
	const keys = Object.keys(elements).filter((key) => !elements[key]?.isDev);

	for (const required of REQUIRED_CAPTURE_DESTINATIONS) {
		if (!keys.includes(required)) {
			throw new Error(
				`Screenshot capture list drifted from navElements: missing "${required}" destination. Derived keys: [${keys.join(", ")}]`,
			);
		}
	}

	return keys;
}

export function zipFolderForImage(image: ScreenshotImage): string {
	if (image.type === "desktop") return `desktop/${image.theme}/`;
	if (image.type === "mobile") return `mobile/${image.theme}/`;
	return "features/";
}

// Global screenshot state using Svelte 5 runes
let screenshotImagesState = $state<ScreenshotImage[]>([]);
let isCapturingState = $state(false);
let captureProgressState = $state("");

// Getters
export function getScreenshotImages(): ScreenshotImage[] {
	return screenshotImagesState;
}

export function getIsCapturing(): boolean {
	return isCapturingState;
}

export function getCaptureProgress(): string {
	return captureProgressState;
}

// Setters
export function setIsCapturing(value: boolean): void {
	isCapturingState = value;
}

export function setCaptureProgress(value: string): void {
	captureProgressState = value;
}

// Helper functions
export function addScreenshot(image: ScreenshotImage): void {
	screenshotImagesState = [...screenshotImagesState, image];
}

export function clearScreenshots(): void {
	screenshotImagesState = [];
}

export function getScreenshotCount(): number {
	return screenshotImagesState.length;
}

// ZIP download function
export async function downloadScreenshotsZip(): Promise<boolean> {
	const images = screenshotImagesState;

	if (images.length === 0) {
		toast.error("No screenshots to download");
		return false;
	}

	try {
		const zipWriter = new ZipWriter(new BlobWriter("application/zip"));

		for (const img of images) {
			const fullPath = `screenshots/${zipFolderForImage(img)}${img.filename}`;
			await zipWriter.add(fullPath, new BlobReader(img.blob));
		}

		const zipBlob = await zipWriter.close();
		const filename = `ceraui-screenshots-${new Date().toISOString().split("T")[0]}.zip`;

		// Download
		const url = URL.createObjectURL(zipBlob);
		const link = document.createElement("a");
		link.href = url;
		link.download = filename;
		link.style.display = "none";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);

		toast.success(`Downloaded ${filename}!`);
		return true;
	} catch (error) {
		console.error("❌ Download failed:", error);
		toast.error(`Download failed: ${(error as Error).message}`);
		return false;
	}
}

// Legacy-compatible store-like objects for template reactivity
// These allow using getters that are reactive in Svelte 5
export const screenshotImages = {
	get value() {
		return screenshotImagesState;
	},
	subscribe(callback: (value: ScreenshotImage[]) => void): () => void {
		$effect(() => {
			callback(screenshotImagesState);
		});
		return () => {
			/* no-op unsubscribe */
		};
	},
};

export const isCapturing = {
	get value() {
		return isCapturingState;
	},
	set: setIsCapturing,
};

export const captureProgress = {
	get value() {
		return captureProgressState;
	},
	set: setCaptureProgress,
};
