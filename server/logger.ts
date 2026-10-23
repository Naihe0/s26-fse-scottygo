// Console logging with a consistent "[Tag ISO-timestamp]" prefix.

export interface ILogger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export function createLogger(tag: string): ILogger {
  const prefix = () => `[${tag} ${new Date().toISOString()}]`;
  return {
    info: (message, ...details) =>
      console.log(`${prefix()} ${message}`, ...details),
    warn: (message, ...details) =>
      console.warn(`${prefix()} ${message}`, ...details),
    error: (message, ...details) =>
      console.error(`${prefix()} ${message}`, ...details)
  };
}

/** Error messages are useful in logs; arbitrary thrown values are stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
