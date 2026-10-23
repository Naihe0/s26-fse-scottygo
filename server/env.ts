// Configuration from environment variables (loaded from .env when present).
// See .env.template for descriptions.

import dotenv from 'dotenv';

dotenv.config();

export const STAGE: string = process.env.STAGE ?? 'DEV';

export const ENV: string = process.env.ENV ?? 'LOCAL';

const STAGE_DATABASE =
  STAGE === 'DEV'
    ? process.env.DEV_DB
    : STAGE === 'PROD'
      ? process.env.PROD_DB
      : undefined;

/** DB_URL plus the stage's database suffix, concatenated exactly. */
export const DB_CONN_STR: string =
  STAGE === 'DEV' || STAGE === 'PROD'
    ? (process.env.DB_URL ?? 'unknown') + (STAGE_DATABASE ?? 'unknown')
    : 'unknown';

/** Hosting platforms such as Render supply PORT themselves. */
export const PORT: number = process.env.PORT ? Number(process.env.PORT) : 8080;

/** Optional interface binding, e.g. 127.0.0.1 for local-only development. */
export const BIND_ADDRESS: string | undefined = process.env.BIND_ADDRESS;

/** Public origin of this deployment, used in log output. */
export const HOST: string =
  (ENV === 'RENDER'
    ? process.env.RENDER_HOST
    : ENV === 'CODESPACE'
      ? process.env.CODESPACE_HOST
      : ENV === 'LOCAL'
        ? process.env.LOCAL_HOST
        : undefined) ?? 'unknown';

export const JWT_KEY: string = process.env.JWT_KEY ?? 'someDefaultKey';

/** Production tokens expire; development tokens never do. */
export const JWT_EXP: string =
  STAGE === 'PROD' ? (process.env.JWT_EXP ?? '365d') : 'never';

/** Used only when creating the initial admin; existing accounts are unchanged. */
export const INITIAL_ADMIN_PASSWORD: string =
  process.env.INITIAL_ADMIN_PASSWORD || 'admin';

// Fail closed on production startup instead of issuing forgeable sessions or
// creating an administrator with development credentials.
if (STAGE === 'PROD') {
  const isPlaceholder = (value: string) =>
    /please[\s_-]*(populate|replace)|changeme|your[\s_-]*(jwt|secret|password)|someDefaultKey/i.test(
      value
    );
  if (!process.env.JWT_KEY || isPlaceholder(JWT_KEY) || JWT_KEY.length < 32) {
    throw new Error('Production requires a JWT_KEY of at least 32 characters');
  }
  if (
    !process.env.INITIAL_ADMIN_PASSWORD ||
    isPlaceholder(INITIAL_ADMIN_PASSWORD) ||
    INITIAL_ADMIN_PASSWORD.length < 12
  ) {
    throw new Error(
      'Production requires an INITIAL_ADMIN_PASSWORD of at least 12 characters'
    );
  }
}

/** Browser Google Maps key; restrict it to approved origins and APIs. */
export const GOOGLE_MAPS_KEY: string = process.env.GOOGLE_MAPS_KEY ?? '';

// Optional integrations. Each is disabled when its key is empty.
export const BREVO_API_KEY: string = process.env.BREVO_API_KEY ?? '';
export const EMAIL_USER: string = process.env.EMAIL_USER ?? '';
export const EMAIL_FROM_NAME: string =
  process.env.EMAIL_FROM_NAME ?? 'ScottyGO';

export const TRUETIME_KEY: string = process.env.TRUETIME_KEY ?? '';
export const TRUETIME_BASE_URL: string =
  process.env.TRUETIME_BASE_URL ??
  'https://truetime.portauthority.org/bustime/api/v3';

export const GEMINI_API_KEY: string = process.env.GEMINI_API_KEY ?? '';
export const GEMINI_MODEL: string =
  process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite-preview';
