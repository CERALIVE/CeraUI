import { oc } from '@orpc/contract';
import { successResponseSchema } from '../schemas/ui.schema';

export const uiContract = oc.router({ heartbeat: oc.output(successResponseSchema) });
