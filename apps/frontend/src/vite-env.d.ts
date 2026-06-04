/// <reference types="svelte" />
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Fontsource variable packages are CSS side-effect imports without bundled type
// declarations; declare them so `import "@fontsource-variable/..."` type-checks.
declare module "@fontsource-variable/*";
