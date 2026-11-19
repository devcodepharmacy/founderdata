/**
 * Why an inbound message is refused when no mail handler is installed. The sender's server reports it back.
 * It lives outside index.ts because every export of the Worker entry becomes a Worker export, and `wrangler dev`
 * refuses a string there.
 */
export const NO_MAIL_HANDLER = 'This address does not accept mail: the FounderData deployment it points to has no mail handler.';
