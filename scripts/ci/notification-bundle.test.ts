import { describe, expect, it } from 'bun:test';

import { notificationKeys, renderCatalogMessage } from './notification-bundle';

describe('backend notification key extraction', () => {
	it('includes keys held in tables and constants when emitters select them dynamically', () => {
		// Given source containing several ways to spell literal notification keys
		const source = `
			const notices = { installed: { key: "notifications.updateInstalled" } };
			const recovered = 'notifications.updateSlotSyncRecovered';
			const available = \`notifications.updatesAvailableMessage\`;
			const busy = "network.os.deviceBusy";
			// "notifications.commentOnly"
			import { notificationSend } from "./notifications";
			notificationSend(notices[kind].key);
		`;
		// When deriving the production guard's requirements
		const keys = notificationKeys(source);
		// Then dynamic selection does not hide any complete literal key
		expect(keys).toEqual([
			'network.os.deviceBusy',
			'notifications.updateInstalled',
			'notifications.updateSlotSyncRecovered',
			'notifications.updatesAvailableMessage',
		]);
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: parser fixture must contain an unevaluated template expression.
	it.each(['const key = `notifications.${kind}`;', 'const key = "notifications." + kind;'])(
		'refuses an unenumerable key family when source uses %s',
		(source) => {
			// Given a family that would silently bypass literal extraction
			// When extracting its requirements, then require explicit key literals
			expect(() => notificationKeys(source)).toThrow('complete literals');
		},
	);
});

describe('notification catalog interpolation', () => {
	it('distinguishes parameter values when a translated pattern repeats a placeholder', () => {
		// Given a catalog pattern, independently of the compiled output
		const pattern = '{name}: {version}, {name}';
		// When deriving deterministic inputs and the expected rendered text
		const rendered = renderCatalogMessage(pattern);
		// Then interpolation checks both static text and parameter selection
		expect(rendered).toEqual({
			inputs: { name: '__name__', version: '__version__' },
			expected: '__name__: __version__, __name__',
		});
	});
});
