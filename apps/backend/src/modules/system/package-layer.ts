export type PackageLayer = "app" | "platform";

export const PACKAGE_LAYERS: Record<string, "app" | "platform"> = {
	"libsrt1.5-ceralive": "app",
	cerastream: "app",
	"ceralive-device": "app",
	"srtla-send-rs": "app",
	"gstreamer1.0-libuvch264src": "app",
	modemmanager: "app",
	"libmm-glib0": "app",
	"libmbim-glib4": "app",
	"libmbim-proxy": "app",
	"libmbim-utils": "app",
	"libqmi-glib5": "app",
	"libqmi-proxy": "app",
	"libqmi-utils": "app",
	"libqrtr-glib0": "app",
	"ceralive-modem-support": "app",
};

export const ceralivePackageList = Object.keys(PACKAGE_LAYERS).filter(
	(name) => PACKAGE_LAYERS[name] === "app",
);

export function classifyPackageLayer(name: string): PackageLayer {
	return PACKAGE_LAYERS[name] ?? "platform";
}
