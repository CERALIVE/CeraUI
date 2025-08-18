import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { get, writable } from 'svelte/store';
import { toast } from 'svelte-sonner';

// Screenshot data interface
export interface ScreenshotImage {
  filename: string;
  blob: Blob;
  theme: 'dark' | 'light';
  type: 'desktop' | 'mobile' | 'offline';
}

// Global screenshot store - persistent across navigation
export const screenshotImages = writable<ScreenshotImage[]>([]);
export const isCapturing = writable<boolean>(false);
export const captureProgress = writable<string>('');

// Helper functions
export function addScreenshot(image: ScreenshotImage) {
  screenshotImages.update(images => {
    const updated = [...images, image];
    console.log(`📸 Added ${image.type} ${image.theme} ${image.filename}, total: ${updated.length}`);
    return updated;
  });
}

export function clearScreenshots() {
  screenshotImages.set([]);
  console.log('🗑️ Screenshots cleared');
}

export function getScreenshotCount(): number {
  return get(screenshotImages).length;
}

// ZIP download function
export async function downloadScreenshotsZip(): Promise<boolean> {
  const images = get(screenshotImages);
  console.log('🔽 Download requested, images available:', images.length);

  if (images.length === 0) {
    toast.error('No screenshots to download');
    return false;
  }

  try {
    console.log('📦 Creating ZIP...');
    const zipWriter = new ZipWriter(new BlobWriter('application/zip'));

    for (const img of images) {
      let folder = '';
      if (img.type === 'desktop') folder = `desktop/${img.theme}/`;
      else if (img.type === 'mobile') folder = `mobile/${img.theme}/`;
      else folder = 'features/';

      const fullPath = `screenshots/${folder}${img.filename}`;
      await zipWriter.add(fullPath, new BlobReader(img.blob));
      console.log(`✅ Added: ${fullPath}`);
    }

    const zipBlob = await zipWriter.close();
    const filename = `ceraui-screenshots-${new Date().toISOString().split('T')[0]}.zip`;

    // Download
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast.success(`Downloaded ${filename}!`);
    console.log('🚀 ZIP downloaded:', filename, zipBlob.size, 'bytes');
    return true;
  } catch (error) {
    console.error('❌ Download failed:', error);
    toast.error(`Download failed: ${error.message}`);
    return false;
  }
}
