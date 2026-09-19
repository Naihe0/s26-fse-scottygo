// Extracts all the secrets and environment variables from the .env file

import dotenv from 'dotenv';

dotenv.config();

export const STAGE: string = process.env.STAGE ?? 'DEV'; // defaults to DEV

export const DB_CONN_STR: string =
  STAGE === 'DEV'
    ? (process.env.DB_URL ?? 'unknown') + (process.env.DEV_DB ?? 'unknown')
    : STAGE === 'PROD'
      ? (process.env.DB_URL ?? 'unknown') + (process.env.PROD_DB ?? 'unknown')
      : 'unknown';

// PORT is effective only for localhost
// ignored by codespaces and Render, which have their default ports
export const PORT: number = process.env.PORT ? Number(process.env.PORT) : 1000; // defaults to 1000

// Optional interface binding, e.g. 127.0.0.1 for local-only development.
// Hosted deployments retain Node's default when this is unset.
export const BIND_ADDRESS: string | undefined = process.env.BIND_ADDRESS;

export const JWT_KEY: string = process.env.JWT_KEY ?? 'someDefaultKey';

// Used only when creating the initial admin; existing accounts are unchanged.
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

export const JWT_EXP: string =
  STAGE === 'PROD' ? (process.env.JWT_EXP ?? '365d') : 'never'; // defaults to never

export const ENV = process.env.ENV ?? 'LOCAL'; // defaults to LOCAL

// Email configuration for Brevo (formerly Sendinblue) API
export const BREVO_API_KEY: string = process.env.BREVO_API_KEY ?? '';
export const EMAIL_USER: string = process.env.EMAIL_USER ?? '';
export const EMAIL_FROM_NAME: string =
  process.env.EMAIL_FROM_NAME ?? 'ScottyGO';

// TrueTime API (Pittsburgh Regional Transit)
export const TRUETIME_KEY: string = process.env.TRUETIME_KEY ?? '';
export const TRUETIME_BASE_URL: string =
  process.env.TRUETIME_BASE_URL ??
  'https://truetime.portauthority.org/bustime/api/v3';

// Note: Tripshot API for CMU Shuttle is public and doesn't require API keys
// The base URL is hardcoded in the tripshot.service.ts file

// Gemini API (LLM content moderation for TUC3)
export const GEMINI_API_KEY: string = process.env.GEMINI_API_KEY ?? '';
export const GEMINI_MODEL: string =
  process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite-preview';

// Set the HOST URL depending on the build environment and where the app is served from
export const HOST: string =
  ENV === 'RENDER'
    ? (process.env.RENDER_HOST ?? 'unknown')
    : ENV === 'CODESPACE'
      ? (process.env.CODESPACE_HOST ?? 'unknown')
      : ENV === 'LOCAL'
        ? (process.env.LOCAL_HOST ?? 'unknown')
        : 'unknown';

export const GOOGLE_MAPS_KEY: string = process.env.GOOGLE_MAPS_KEY ?? '';
