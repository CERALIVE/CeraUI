import { get } from "svelte/store";
import { locale } from "@ceraui/i18n/svelte";
import { existingLocales, rtlLanguages } from "@ceraui/i18n";
import { localeStore } from "../stores/locale";

export interface PWAManifest {
	name: string;
	short_name: string;
	description: string;
	start_url: string;
	scope: string;
	display: string;
	orientation: string;
	theme_color: string;
	background_color: string;
	categories: string[];
	lang: string;
	dir: "ltr" | "rtl";
	icons: Array<{
		src: string;
		sizes: string;
		type: string;
		purpose: string;
	}>;
}

export function generateDynamicManifest(): PWAManifest {
	const currentLocale = get(locale) || get(localeStore).code || "en";
	const isRTL = rtlLanguages.includes(currentLocale);

	// Get locale info (for future use)
	const _localeInfo =
		existingLocales.find((l) => l.code === currentLocale) || existingLocales[0];

	// Get the current origin for absolute URLs
	const origin = window.location.origin;

	return {
		name: "CeraUI for BELABOX©",
		short_name: "CeraUI",
		description:
			"A modern PWA for BELABOX streaming encoder management and configuration",
		start_url: `${origin}/`,
		scope: `${origin}/`,
		display: "standalone",
		orientation: "portrait-primary",
		theme_color: "#ffffff",
		background_color: "#ffffff",
		categories: ["multimedia", "utilities"],
		lang: currentLocale,
		dir: isRTL ? "rtl" : "ltr",
		icons: [
			{
				src: `${origin}/web-app-manifest-192x192.png`,
				sizes: "192x192",
				type: "image/png",
				purpose: "any maskable",
			},
			{
				src: `${origin}/web-app-manifest-512x512.png`,
				sizes: "512x512",
				type: "image/png",
				purpose: "any maskable",
			},
		],
	};
}

export function updateManifestLink() {
	// Generate dynamic manifest content and create a blob URL
	const manifestData = generateDynamicManifest();

	// Create a blob with the manifest content
	const manifestBlob = new Blob([JSON.stringify(manifestData, null, 2)], {
		type: "application/json",
	});

	// Create object URL for the blob
	const manifestUrl = URL.createObjectURL(manifestBlob);

	// Update or create the manifest link
	let manifestLink = document.querySelector(
		'link[rel="manifest"]',
	) as HTMLLinkElement;
	if (manifestLink) {
		// Revoke the old blob URL to prevent memory leaks
		if (manifestLink.href.startsWith("blob:")) {
			URL.revokeObjectURL(manifestLink.href);
		}
		manifestLink.href = manifestUrl;
	} else {
		// Create new manifest link if it doesn't exist
		manifestLink = document.createElement("link");
		manifestLink.rel = "manifest";
		manifestLink.href = manifestUrl;
		document.head.appendChild(manifestLink);
	}
}
