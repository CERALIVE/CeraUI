import $ from "jquery";

declare global {
	interface Window {
		$: JQueryStatic;
		jQuery: JQueryStatic;
	}
}

window.$ = $;
window.jQuery = $;
