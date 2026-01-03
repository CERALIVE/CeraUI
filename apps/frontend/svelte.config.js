import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { persistPreprocessor } from "svelte-persistent-runes/plugins";

export default {
	// Consult https://svelte.dev/docs#compile-time-svelte-preprocess
	// for more information about preprocessors
	preprocess: [vitePreprocess(), persistPreprocessor()],
};
