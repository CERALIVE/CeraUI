/// <reference types="bun" />
import { expect, test } from 'bun:test';
import {
	type UpdateCapabilities,
	updateCapabilitiesSchema,
	updateCapabilityFileSchema,
} from './update-capabilities.schema';

const declaration = {
	schema: 1 as const,
	features: ['apt-all-packages', 'kernel-apt-stage'] satisfies UpdateCapabilities['features'],
	ota_uid: 999,
	apt_uid: 42,
};

test('parses the kernel staging feature in image and RPC capabilities', () => {
	// Given an image declaring the new capability, when parsed at both boundaries.
	expect(updateCapabilityFileSchema.parse(declaration)).toEqual(declaration);
	const reply = { mode: 'capable', features: declaration.features } as const;
	// Then the feature is preserved, not stripped or renamed.
	expect(updateCapabilitiesSchema.parse(reply)).toEqual(reply);
});

test.each([
	{ ...declaration, features: ['apt-all-packages', 'future-kernel-feature'] },
	{ ...declaration, features: 'kernel-apt-stage' },
	{ ...declaration, features: [true] },
	{ ...declaration, ota_uid: '999' },
	{ ...declaration, unexpected: true },
])('rejects an invalid capability declaration %#', (input) => {
	// Given one invalid dimension, when parsed, then no authority is granted.
	expect(updateCapabilityFileSchema.safeParse(input).success).toBe(false);
});

test.each<{ features: UpdateCapabilities['features'] }>([
	{ features: [] },
	{ features: ['apt-all-packages', 'kernel-apt-stage', 'kernel-apt-stage'] },
])('preserves existing empty and duplicate feature array semantics %#', ({ features }) => {
	// Given arrays accepted by schema 1, when parsed, then no new restriction is imposed.
	const input = { ...declaration, features };
	expect(updateCapabilityFileSchema.parse(input)).toEqual(input);
});
