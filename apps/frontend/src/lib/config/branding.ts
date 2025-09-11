/**
 * Centralized branding configuration for conditional compilation
 * CERALIVE = main brand (default)
 * BELABOX = secondary frontend-only brand
 */

export type BrandName = "CERALIVE" | "BELABOX";

// Determine brand from environment variable or default to CERALIVE
export const CURRENT_BRAND: BrandName =
	(import.meta.env.VITE_BRAND as BrandName) || "CERALIVE";

export interface BrandConfig {
	/** Device/hardware name */
	deviceName: string;
	/** Full site/app name with copyright */
	siteName: string;
	/** Short app name */
	appName: string;
	/** Description for PWA and meta tags */
	description: string;
	/** Copyright notice */
	copyright: string;
	/** Cloud service name (for remote keys) */
	cloudServiceName: string;
	/** Log file prefix */
	logPrefix: string;
	/** Company/organization name */
	organizationName: string;
}

const brandConfigs: Record<BrandName, BrandConfig> = {
	CERALIVE: {
		deviceName: "CERALIVE",
		siteName: "CeraUI for CERALIVE©",
		appName: "CeraUI",
		description:
			"A modern UI for CERALIVE streaming encoder management and configuration",
		copyright: "CERALIVE",
		cloudServiceName: "CERALIVE Cloud",
		logPrefix: "CERALIVE",
		organizationName: "CERALIVE",
	},
	BELABOX: {
		deviceName: "BELABOX",
		siteName: "CeraUI for BELABOX©",
		appName: "CeraUI",
		description:
			"A modern UI for BELABOX streaming encoder management and configuration",
		copyright: "BELABOX",
		cloudServiceName: "BELABOX Cloud",
		logPrefix: "BELABOX",
		organizationName: "BELABOX",
	},
};

// Export the current brand configuration
export const BRAND_CONFIG = brandConfigs[CURRENT_BRAND];

// Legacy exports for backward compatibility
export const deviceName = BRAND_CONFIG.deviceName;
export const siteName = BRAND_CONFIG.siteName;
