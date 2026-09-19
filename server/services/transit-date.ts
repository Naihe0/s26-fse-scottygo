import type { IAppError } from '../../common/server.responses';

function invalidInput(message: string): never {
  const error: IAppError = {
    type: 'ClientError',
    name: 'OutOfBounds',
    message
  };
  throw error;
}

/** Treat a requested schedule date as a calendar day, not midnight UTC. */
export function parseTransitDate(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return invalidInput(
      'Date must be a valid calendar date in YYYY-MM-DD format'
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return invalidInput(
      'Date must be a valid calendar date in YYYY-MM-DD format'
    );
  }
  return date;
}

export function validateTransitTime(value: unknown): void {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    invalidInput('Time must be in HH:MM format between 00:00 and 23:59');
  }
}
