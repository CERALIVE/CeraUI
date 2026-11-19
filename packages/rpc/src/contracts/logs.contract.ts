/**
 * Device logs ORPC contract. Follow ownership is scoped to the calling socket.
 */
import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
	logAroundInputSchema,
	logAroundOutputSchema,
	logBootInfoSchema,
	logBundleManifestSchema,
	logDeleteOlderFilesOutputSchema,
	logExportInputSchema,
	logExportOutputSchema,
	logFollowStartInputSchema,
	logFollowStartOutputSchema,
	logFollowStopOutputSchema,
	logQueryInputSchema,
	logQueryOutputSchema,
	logRetentionSchema,
	logStorageOutputSchema,
	logStorageSchema,
} from '../schemas';

export const logsContract = oc.router({
	query: oc.input(logQueryInputSchema).output(logQueryOutputSchema),
	around: oc.input(logAroundInputSchema).output(logAroundOutputSchema),
	boots: oc.output(z.array(logBootInfoSchema)),
	followStart: oc.input(logFollowStartInputSchema).output(logFollowStartOutputSchema),
	followStop: oc.output(logFollowStopOutputSchema),
	getStorage: oc.output(logStorageSchema),
	setRetention: oc.input(logRetentionSchema).output(logStorageOutputSchema),
	deleteOlderFiles: oc.output(logDeleteOlderFilesOutputSchema),
	deleteLegacyDebug: oc.output(logStorageOutputSchema),
	clearAll: oc.output(logDeleteOlderFilesOutputSchema),
	createExport: oc.input(logExportInputSchema).output(logExportOutputSchema),
	previewBundle: oc.output(logBundleManifestSchema),
	createBundle: oc.output(logExportOutputSchema),
});
