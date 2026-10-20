/** Build-time brand strings. Equality with runtime branding is enforced by brand-identity.test.ts. */
export const BUILD_BRAND = {
	siteName: "CeraUI for CeraLive",
	appName: "CeraUI",
	deviceName: "CeraLive",
	description:
		"A modern UI for CeraLive streaming encoder management and configuration",
} as const;
