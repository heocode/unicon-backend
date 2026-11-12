/** One permission budget shared by this application's Resend team across replicas.
 * No recipients, message contents, idempotency keys or user characteristics. */
export const MAIL_SUBMISSION_GATE = Object.freeze({
  policyId: 'MAIL_RESEND_SUBMISSION',
  key: 'gcra:mail:resend-submission:v1',
});
