/**
 * Centralized branding configuration
 * CeraLive-only branding
 */

export type BrandName = "CERALIVE";

export const CURRENT_BRAND: BrandName = "CERALIVE";

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

export const BRAND_CONFIG: BrandConfig = {
	deviceName: "CeraLive",
	siteName: "CeraUI for CeraLive©",
	appName: "CeraUI",
	description:
		"A modern UI for CeraLive streaming encoder management and configuration",
	copyright: "CeraLive",
	cloudServiceName: "CeraLive Cloud",
	logPrefix: "CeraLive",
	organizationName: "CeraLive",
};

// Legacy exports for backward compatibility
export const deviceName = BRAND_CONFIG.deviceName;
export const siteName = BRAND_CONFIG.siteName;
