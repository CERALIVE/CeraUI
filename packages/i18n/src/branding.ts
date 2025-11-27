/**
 * Branding support for i18n system
 * CeraLive-only branding
 */

export type BrandName = "CERALIVE";

export const getCurrentBrand = (): BrandName => "CERALIVE";

export interface BrandStrings {
	deviceName: string;
	deviceNameLower: string;
	siteName: string;
	cloudService: string;
	logName: string;
	organizationName: string;
}

const brandStrings: BrandStrings = {
	deviceName: "CeraLive",
	deviceNameLower: "ceralive",
	siteName: "CeraUI for CeraLive©",
	cloudService: "CeraLive Cloud",
	logName: "CeraLive Log",
	organizationName: "CeraLive",
};

/**
 * Get brand-specific strings
 */
export const getBrandStrings = (): BrandStrings => brandStrings;

/**
 * Replace brand placeholders in translation strings
 * Usage: brandTranslation("{{deviceName}} device is powered on") -> "CeraLive device is powered on"
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
