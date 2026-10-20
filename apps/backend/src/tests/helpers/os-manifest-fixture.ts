export const manifest = {
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.0",
	serial: 3,
	published_at: "2026-09-24T12:00:00Z",
	expires_at: "2026-12-30T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/bundle.raucb",
		size: 10,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/flash.raw.xz",
		size: 10,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/packages.lock.json",
};

export const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));

export const signed = bytes(manifest);

export const signature = new Uint8Array([1, 2, 3]);

export const context = {
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable" as const,
	serial: 2,
	bootedVersion: "2026.9.0",
	installedVersion: "2026.9.3",
	now: Date.parse("2026-09-25T00:00:00Z"),
};

export const deps = {
	verifyCms: async (_data: Uint8Array, _signature: Uint8Array) => ({
		cn: "CeraLive OTA Manifest Signer",
		eku: ["codeSigning"],
		issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
	}),
	compare: async (newer: string, older: string) => {
		const result = Bun.spawnSync([
			"dpkg",
			"--compare-versions",
			newer,
			"gt",
			older,
		]);
		return result.exitCode === 0;
	},
	isQuarantined: async (_version: string) => false,
};
