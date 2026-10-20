export function progressFromWire(progress: {
	readonly total: number;
	readonly downloading: number;
	readonly unpacking: number;
	readonly setting_up: number;
}): { readonly percent: number; readonly etaSeconds: number } {
	const { total, downloading, unpacking, setting_up: settingUp } = progress;
	const percent =
		total > 0
			? Math.min(
					100,
					Math.round(
						((downloading + unpacking + settingUp) / (3 * total)) * 100,
					),
				)
			: 0;
	return { percent, etaSeconds: 0 };
}
