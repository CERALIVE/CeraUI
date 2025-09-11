/**
 * Dynamic branding support for i18n system
 * This module provides brand-aware translation functions
 */

export type BrandName = "CERALIVE" | "BELABOX";

// Get brand from environment or default to CERALIVE (main brand)
export const getCurrentBrand = (): BrandName => {
	// Browser environment (client-side)
	if (typeof window !== "undefined") {
		return (
			((window as any).__BRAND_CONFIG__?.deviceName as BrandName) || "CERALIVE"
		);
	}

	// Node environment (build-time)
	if (typeof process !== "undefined") {
		return (process.env.VITE_BRAND as BrandName) || "CERALIVE";
	}

	// Fallback
	return "CERALIVE";
};

export interface BrandStrings {
	deviceName: string;
	deviceNameLower: string;
	siteName: string;
	cloudService: string;
	logName: string;
	organizationName: string;
}

const brandStrings: Record<BrandName, BrandStrings> = {
	CERALIVE: {
		deviceName: "CERALIVE",
		deviceNameLower: "ceralive",
		siteName: "CeraUI for CERALIVE©",
		cloudService: "CERALIVE Cloud",
		logName: "CERALIVE Log",
		organizationName: "CERALIVE",
	},
	BELABOX: {
		deviceName: "BELABOX",
		deviceNameLower: "belabox",
		siteName: "CeraUI for BELABOX©",
		cloudService: "BELABOX Cloud",
		logName: "BELABOX Log",
		organizationName: "BELABOX",
	},
};

/**
 * Get brand-specific strings for the current brand
 */
export const getBrandStrings = (): BrandStrings => {
	const brand = getCurrentBrand();
	return brandStrings[brand];
};

/**
 * Replace brand placeholders in translation strings
 * Usage: brandTranslation("{{deviceName}} device is powered on") -> "CERALIVE device is powered on"
 */
export const brandTranslation = (template: string): string => {
	const brand = getBrandStrings();

	return template
		.replace(/\{\{deviceName\}\}/g, brand.deviceName)
		.replace(/\{\{deviceNameLower\}\}/g, brand.deviceNameLower)
		.replace(/\{\{siteName\}\}/g, brand.siteName)
		.replace(/\{\{cloudService\}\}/g, brand.cloudService)
		.replace(/\{\{logName\}\}/g, brand.logName)
		.replace(/\{\{organizationName\}\}/g, brand.organizationName);
};

/**
 * Create a brand-aware translation helper
 */
export const createBrandTranslation = (
	translations: Record<string, string>,
) => {
	const brandedTranslations: Record<string, string> = {};

	for (const [key, value] of Object.entries(translations)) {
		brandedTranslations[key] = brandTranslation(value);
	}

	return brandedTranslations;
};
