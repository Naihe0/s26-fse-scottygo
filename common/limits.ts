// Business limits enforced by the server and mirrored by the browser UI.

/** Saved routes per account. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/** Characters allowed in an optional bus-report comment. */
export const MAX_REPORT_COMMENT_LENGTH = 200;

/** Rider notifications are kept and listed for this long. */
export const NOTIFICATION_RETENTION_MS = 30 * 60 * 1000;

/** Upper bound for client-supplied route, vehicle, and username identifiers. */
export const MAX_IDENTIFIER_LENGTH = 128;
