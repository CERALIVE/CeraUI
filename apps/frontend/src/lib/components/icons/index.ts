import {
	ArrowRight,
	Check,
	ChevronLeft,
	ChevronRight,
	CircleHelp,
	ClipboardCheck,
	Copy,
	CreditCard,
	Ellipsis,
	File,
	FileText,
	Image,
	Laptop,
	LoaderCircle,
	Moon,
	Pizza,
	Plus,
	Settings,
	Sun,
	Trash,
	TriangleAlert,
	User,
	X,
} from "@lucide/svelte";
import type { Component } from "svelte";

// import Hamburger from './hamburger.svelte'; // File missing - temporarily commented out
import Logo from "./Logo.svelte";

export type Icon = Component;

export const Icons: Record<string, Icon> = {
	logo: Logo,
	close: X,
	spinner: LoaderCircle,
	chevronLeft: ChevronLeft,
	chevronRight: ChevronRight,
	trash: Trash,
	post: FileText,
	page: File,
	media: Image,
	settings: Settings,
	billing: CreditCard,
	ellipsis: Ellipsis,
	add: Plus,
	warning: TriangleAlert,
	user: User,
	arrowRight: ArrowRight,
	help: CircleHelp,
	pizza: Pizza,
	check: Check,
	copy: Copy,
	copyDone: ClipboardCheck,
	sun: Sun,
	moon: Moon,
	laptop: Laptop,
	// Hamburger, // File missing - temporarily commented out
};
