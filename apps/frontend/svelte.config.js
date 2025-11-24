import { persistPreprocessor } from "@macfja/svelte-persistent-runes/plugins";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
	// Consult https://svelte.dev/docs#compile-time-svelte-preprocess
	// for more information about preprocessors
	preprocess: [vitePreprocess(), persistPreprocessor()],
};
