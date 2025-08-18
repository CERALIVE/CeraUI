export const oneMinute = 60 * 1000;
export const oneHour = 60 * oneMinute;

export function getms() {
	const [sec, ns] = process.hrtime();
	return sec * 1000 + Math.floor(ns / 1000 / 1000);
}
