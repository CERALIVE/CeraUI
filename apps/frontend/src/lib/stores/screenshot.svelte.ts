import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";
import { toast } from "svelte-sonner";

// Screenshot data interface
export interface ScreenshotImage {
	filename: string;
	blob: Blob;
	theme: "dark" | "light";
	type: "desktop" | "mobile" | "offline";
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
	console.log(
		`📸 Added ${image.type} ${image.theme} ${image.filename}, total: ${screenshotImagesState.length}`,
	);
}

export function clearScreenshots(): void {
	screenshotImagesState = [];
	console.log("🗑️ Screenshots cleared");
}

export function getScreenshotCount(): number {
	return screenshotImagesState.length;
}

// ZIP download function
export async function downloadScreenshotsZip(): Promise<boolean> {
	const images = screenshotImagesState;
	console.log("🔽 Download requested, images available:", images.length);

	if (images.length === 0) {
		toast.error("No screenshots to download");
		return false;
	}

	try {
		console.log("📦 Creating ZIP...");
		const zipWriter = new ZipWriter(new BlobWriter("application/zip"));

		for (const img of images) {
			let folder = "";
			if (img.type === "desktop") folder = `desktop/${img.theme}/`;
			else if (img.type === "mobile") folder = `mobile/${img.theme}/`;
			else folder = "features/";

			const fullPath = `screenshots/${folder}${img.filename}`;
			await zipWriter.add(fullPath, new BlobReader(img.blob));
			console.log(`✅ Added: ${fullPath}`);
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
		console.log("🚀 ZIP downloaded:", filename, zipBlob.size, "bytes");
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
		return () => {};
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
