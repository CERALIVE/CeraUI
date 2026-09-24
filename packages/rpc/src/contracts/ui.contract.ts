import { oc } from '@orpc/contract';
import { successResponseSchema } from '../schemas';

export const uiContract = oc.router({ heartbeat: oc.output(successResponseSchema) });
