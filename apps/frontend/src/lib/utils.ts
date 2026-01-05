import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Re-export transitions for backwards compatibility
export { flyAndScale, safeCrossfade, safeScale } from "./transitions";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function capitalizeFirstLetter(str: string) {
	return String(str).charAt(0).toUpperCase() + String(str).slice(1);
}

export type WithoutChild<T> = T extends { child?: unknown }
	? Omit<T, "child">
	: T;
export type WithoutChildren<T> = T extends { children?: unknown }
	? Omit<T, "children">
	: T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
	ref?: U | null;
};
