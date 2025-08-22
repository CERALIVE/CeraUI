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
import type { SvelteComponent } from "svelte";

// import Hamburger from './hamburger.svelte'; // File missing - temporarily commented out
import Logo from "./Logo.svelte";

export type Icon = SvelteComponent;

export const Icons = {
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
