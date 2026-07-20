import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const serviceUnit = readFileSync(
	resolve(import.meta.dir, '../deployment/ceralive.service'),
	'utf8',
);
const backendPackage = JSON.parse(
	readFileSync(resolve(import.meta.dir, '../apps/backend/package.json'), 'utf8'),
);
const deviceSetup = JSON.parse(
	readFileSync(resolve(import.meta.dir, '../apps/backend/setup.json'), 'utf8'),
);
const backendMain = readFileSync(resolve(import.meta.dir, '../apps/backend/src/main.ts'), 'utf8');
const debianBuild = readFileSync(
	resolve(import.meta.dir, '../scripts/build/build-debian-package.sh'),
	'utf8',
);

test('device service runs the root-owned backend in production mode', () => {
	expect(serviceUnit).toContain('User=root');
	expect(serviceUnit).toContain('Group=root');
	expect(serviceUnit).toContain('Environment=NODE_ENV=production');
});

test('device backend compile command pins production mode', () => {
	expect(backendPackage.scripts.build).toContain('NODE_ENV=production bun build');
	expect(backendPackage.scripts['build:backend-only']).toContain('NODE_ENV=production bun build');
});

test('device package uses the installed sender and does not require BCRPT at boot', () => {
	expect(deviceSetup.ssh_user).toBe('ceralive');
	expect(deviceSetup.srtla_path).toBe('/usr/bin');
	expect(deviceSetup.sound_device_dir).toBe('/sys/class/sound');
	expect(deviceSetup.usb_device_dir).toBe('/dev');
	expect(deviceSetup.bcrpt_path).toBeUndefined();
	expect(backendMain).toContain('if (setup.bcrpt_path) {');
});

test('device package leaves port 80 to the CeraUI service', () => {
	expect(debianBuild).not.toContain('cp dist/ceralive.socket');
	expect(debianBuild).toContain('systemctl disable --now ceralive.socket');
});

test('optional SRT ingest cannot prevent device service boot', () => {
	expect(backendMain).toMatch(/await guardNonCritical\("srt-ingest", initSRTIngest\);/);
});

test('device package exposes static assets in the backend working directory', () => {
	expect(debianBuild).toContain('ln -s /var/www/ceralive "$TEMP_DIR/opt/ceralive/public"');
});
