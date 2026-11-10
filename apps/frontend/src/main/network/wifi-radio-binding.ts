export interface WifiRadioBinding {
	readonly device: string;
	readonly incarnation: string | undefined;
	readonly link: number;
	readonly session: number;
}

export function sameWifiRadio(
	a: WifiRadioBinding,
	b: WifiRadioBinding,
): boolean {
	return (
		a.device === b.device &&
		a.incarnation === b.incarnation &&
		a.link === b.link &&
		a.session === b.session
	);
}

// Future backend refusals are optional during the additive protocol rollout.
export function wifiRadioChanged(result: { readonly error?: string }): boolean {
	return (
		result.error === "radio-changed" || result.error === "binding-required"
	);
}
