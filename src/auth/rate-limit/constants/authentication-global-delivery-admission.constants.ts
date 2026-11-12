/** One application-wide creation budget. No user characteristic or HMAC alias;
 * this fixed namespace is separate from immutable v1 characteristic-derived keys. */
export const AUTHENTICATION_GLOBAL_DELIVERY_ADMISSION = Object.freeze({
  policyId: 'AUTH_DELIVERY_GLOBAL',
  key: 'gcra:auth:delivery-admission:v1',
});
