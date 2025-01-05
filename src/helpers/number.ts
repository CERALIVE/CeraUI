export function validateInteger(num: string, min: number, max: number) {
	const numTmp = parseInt(num, 10);
	if (String(numTmp) !== String(num) || numTmp < min || numTmp > max)
		return undefined;
	return numTmp;
}

export function validatePortNo(num: string) {
	return validateInteger(num, 1, 0xffff);
}
