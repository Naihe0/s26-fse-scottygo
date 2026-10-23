// Application errors are plain IAppError objects (not Error instances) so they
// can be sent to clients unchanged. Build them here instead of inline literals.

import type {
  ClientErrorName,
  IAppError,
  ServerErrorName
} from '../common/server.responses';

export function clientError(name: ClientErrorName, message: string): IAppError {
  return { type: 'ClientError', name, message };
}

export function serverError(name: ServerErrorName, message: string): IAppError {
  return { type: 'ServerError', name, message };
}

/** Narrow a caught value to an IAppError, or return null for anything else. */
export function toAppError(error: unknown): IAppError | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'name' in error
  ) {
    return error as IAppError;
  }
  return null;
}
