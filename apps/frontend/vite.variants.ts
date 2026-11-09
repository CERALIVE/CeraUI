import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VARIANTS_ALIAS = {
	find: /^tailwind-variants$/,
	replacement: path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		'./src/lib/tailwind-variants.ts',
	),
};
