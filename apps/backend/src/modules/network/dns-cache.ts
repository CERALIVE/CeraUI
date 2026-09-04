export function haveSameElements(
	first: readonly string[],
	second: readonly string[],
): boolean {
	const firstValues = new Set(first);
	const secondValues = new Set(second);
	return (
		first.every((value) => secondValues.has(value)) &&
		second.every((value) => firstValues.has(value))
	);
}
