# Public Auth, Account, and Profile API Contract

This document freezes the intended MVP public contract for Stage 11. It is the
target for the incremental implementation work; adding this document does not
mean every current endpoint already conforms to it.

TOTP, passkeys, email-OTP login, OAuth, multiple affiliations, and other
post-MVP identity work are intentionally excluded. Future authenticators must
resolve the stable `User.id` and converge on the credential-neutral session
layer without changing the meaning of the current MVP contract prematurely.

## Compatibility rules

- Clients branch on stable `code` values, never on `message` text.
- `message` is a safe English fallback and may change without versioning.
- Error-specific machine-readable context is nested under `details`.
- Adding an optional response field is backward-compatible.
- Adding an error code requires an explicit contract review. Generated clients
  may model codes as closed enums, so clients must retain an unknown-code
  fallback and the server must not assume a new code is automatically safe.
- Removing or renaming fields or codes, changing field nullability, moving
  existing fields, or changing a success status is potentially breaking.
- The current singular `email` and `university` profile fields describe the
  MVP representation. They are not permanent identity or ownership keys;
  `User.id` is the stable application identity.

## Public error envelope

Every non-2xx JSON response uses:

```json
{
  "code": "INVALID_CREDENTIALS",
  "message": "Invalid email or password."
}
```

`code` and `message` are required. `details` is optional and is present only
when the endpoint documents useful structured context:

```json
{
  "code": "SESSION_TOO_FRESH",
  "message": "This session is too new to manage sessions.",
  "details": {
    "managementAvailableAt": "2026-08-18T12:00:00.000Z",
    "retryAfterSeconds": 3600
  }
}
```

The MVP envelope does not include `timestamp`, `path`, or `requestId`. A future
correlation ID may be added as an optional field together with consistent
request-context logging and an `X-Request-Id` response header.

Unhandled errors return `INTERNAL_ERROR` without stack traces, Prisma errors,
provider responses, configuration values, or other internal details. Optional
infrastructure failures such as GeoIP and best-effort notifications must not
replace an otherwise successful response.

## Validation errors

Body, path, and query validation failures return HTTP 400:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "The request is invalid.",
  "details": {
    "violations": [
      {
        "field": "email",
        "code": "INVALID_EMAIL",
        "message": "Email must be a valid email address."
      }
    ]
  }
}
```

One and multiple violations use the same array form. Violations are returned
in deterministic field-and-code order. Nested fields use dotted paths and
array indexes, for example `items[0].id`. Malformed JSON uses
`MALFORMED_JSON` at the envelope level because no validated field set can be
reliably produced.

Stable validation violation codes are:

```text
REQUIRED
INVALID_TYPE
INVALID_EMAIL
INVALID_UUID
INVALID_LENGTH
VALUE_TOO_LONG
WEAK_PASSWORD
UNKNOWN_FIELD
```

The public codes are deliberately independent of class-validator constraint
names. Violation messages are safe fallbacks and are not localization or
branching keys.

## Error-code catalog

### Authentication and credentials

| Code                           | HTTP | Meaning                                                                      |
| ------------------------------ | ---: | ---------------------------------------------------------------------------- |
| `INVALID_CREDENTIALS`          |  401 | Email/password credentials are invalid without revealing which value failed. |
| `CURRENT_PASSWORD_INVALID`     |  401 | Re-authentication with the current MVP password failed.                      |
| `PASSWORDS_DO_NOT_MATCH`       |  400 | Password confirmation differs.                                               |
| `NEW_PASSWORD_SAME_AS_CURRENT` |  400 | The requested new password is unchanged.                                     |

### Registration and email verification

| Code                               | HTTP | Meaning                                                        |
| ---------------------------------- | ---: | -------------------------------------------------------------- |
| `EMAIL_ALREADY_REGISTERED`         |  409 | The normalized login email is already registered.              |
| `EMAIL_DOMAIN_NOT_ALLOWED`         |  400 | The institutional domain is not currently eligible.            |
| `EMAIL_NOT_VERIFIED`               |  403 | Login requires institutional-email verification.               |
| `EMAIL_VERIFICATION_TOKEN_INVALID` |  400 | The token is invalid, used, superseded, or otherwise unusable. |
| `EMAIL_VERIFICATION_TOKEN_EXPIRED` |  400 | The token expired and the client may offer resend.             |
| `EMAIL_ALREADY_VERIFIED`           |  409 | Verification was already completed.                            |
| `VERIFICATION_EMAIL_COOLDOWN`      |  429 | A resend is temporarily rate-limited.                          |
| `VERIFICATION_EMAIL_UNAVAILABLE`   |  503 | Required verification-email delivery failed.                   |

`EMAIL_NOT_VERIFIED` details contain `email` and
`resendAvailableInSeconds`. `VERIFICATION_EMAIL_COOLDOWN` details contain
`retryAfterSeconds`, and the response also includes `Retry-After`.

### Account and profile state

| Code                    | HTTP | Meaning                                                       |
| ----------------------- | ---: | ------------------------------------------------------------- |
| `ACCOUNT_UNAVAILABLE`   |  403 | The account cannot perform the requested authenticated flow.  |
| `ACCOUNT_STATE_CHANGED` |  409 | A concurrent state transition invalidated the operation.      |
| `PROFILE_UNAVAILABLE`   |  409 | The authorized profile became unavailable during the request. |
| `RESOURCE_NOT_FOUND`    |  404 | No public route or resource matches the request.              |

### Access and refresh tokens

| Code                     | HTTP | Meaning                                                                                        |
| ------------------------ | ---: | ---------------------------------------------------------------------------------------------- |
| `ACCESS_TOKEN_REQUIRED`  |  401 | An access bearer token was not supplied.                                                       |
| `ACCESS_TOKEN_INVALID`   |  401 | The supplied access token is malformed, has an invalid signature, or has the wrong token type. |
| `ACCESS_TOKEN_EXPIRED`   |  401 | The access JWT expired; a client with a refresh token may refresh once.                        |
| `REFRESH_TOKEN_REQUIRED` |  401 | A refresh bearer token was not supplied.                                                       |
| `REFRESH_TOKEN_INVALID`  |  401 | The supplied refresh token is invalid or its session cannot refresh.                           |
| `REFRESH_TOKEN_EXPIRED`  |  401 | The refresh JWT or its session expired.                                                        |
| `REFRESH_TOKEN_REUSED`   |  401 | A previously rotated refresh token was presented again.                                        |

Token errors do not reveal whether a referenced user or session record exists.
Except for `ACCESS_TOKEN_EXPIRED`, clients clear the affected local auth state
and require a new authentication flow. Refresh requests for one local session
must be serialized, and a successful rotation atomically replaces both local
tokens.

### Sessions

| Code                    | HTTP | Meaning                                                              |
| ----------------------- | ---: | -------------------------------------------------------------------- |
| `SESSION_UNAVAILABLE`   |  401 | The authenticated session is missing, revoked, expired, or inactive. |
| `SESSION_NOT_FOUND`     |  404 | An owned active target session was not found.                        |
| `SESSION_TOO_FRESH`     |  403 | The current session cannot yet manage other sessions.                |
| `SESSION_LIMIT_REACHED` |  409 | Creating another active session would exceed the limit.              |

`SESSION_TOO_FRESH` details contain `managementAvailableAt` and
`retryAfterSeconds`. `SESSION_LIMIT_REACHED` details contain
`activeSessionLimit`.

### Password recovery and change

| Code                            | HTTP | Meaning                                                                     |
| ------------------------------- | ---: | --------------------------------------------------------------------------- |
| `PASSWORD_RESET_TOKEN_INVALID`  |  400 | A reset token is invalid, expired, used, superseded, or account-ineligible. |
| `PASSWORD_CHANGED_CONCURRENTLY` |  409 | Another request changed the credential first.                               |

Password mismatch and current-password failures reuse the authentication and
credential codes above. Reset-token variants intentionally remain
indistinguishable.

### Rate limits

| Code                  | HTTP | Meaning                                                 |
| --------------------- | ---: | ------------------------------------------------------- |
| `RATE_LIMIT_EXCEEDED` |  429 | A database-backed request or attempt limit was reached. |

All 429 responses contain `details.retryAfterSeconds` and an integer
`Retry-After` header. Clients use the header as authoritative and never parse
the message.

### Account deletion

| Code                                    |                        HTTP | Meaning                                                     |
| --------------------------------------- | --------------------------: | ----------------------------------------------------------- |
| `ACCOUNT_DELETION_SCHEDULED`            |                         403 | Login is unavailable during the cancellable grace period.   |
| `ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED` | 403 login, 409 cancellation | The account passed its cancellation deadline.               |
| `ACCOUNT_DELETION_ALREADY_CANCELLED`    |                         409 | A concurrent or prior request already restored the account. |

Scheduled and expired login details contain `deletionScheduledAt` and
`canCancel`. After requesting deletion, clients immediately discard all local
tokens. Cancellation returns one new token pair and never restores old tokens
or sessions.

### Internal and required infrastructure

| Code                       | HTTP | Meaning                                                                |
| -------------------------- | ---: | ---------------------------------------------------------------------- |
| `REGISTRATION_UNAVAILABLE` |  503 | Registration could not complete safely after bounded internal retries. |
| `SERVICE_UNAVAILABLE`      |  503 | A required infrastructure dependency is temporarily unavailable.       |
| `INTERNAL_ERROR`           |  500 | An unexpected internal failure occurred.                               |

## Endpoint inventory and target statuses

| Endpoint                           | Request DTO                            | Success DTO                           | Status | Authentication and headers                  | Documented error codes                                                                                                                                              |
| ---------------------------------- | -------------------------------------- | ------------------------------------- | -----: | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`              | `RegisterDto`                          | `RegistrationResponseDto`             |    201 | Public                                      | `VALIDATION_FAILED`, `PASSWORDS_DO_NOT_MATCH`, `EMAIL_DOMAIN_NOT_ALLOWED`, `EMAIL_ALREADY_REGISTERED`, `REGISTRATION_UNAVAILABLE`, `VERIFICATION_EMAIL_UNAVAILABLE` |
| `POST /auth/login`                 | `LoginDto`                             | `AuthTokensResponseDto`               |    201 | Session metadata headers                    | `VALIDATION_FAILED`, `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_UNAVAILABLE`, deletion-state codes, `SESSION_LIMIT_REACHED`                              |
| `POST /auth/verify-email`          | `VerifyEmailDto`                       | `EmailVerificationResponseDto`        |    201 | Session metadata headers                    | validation and verification-token codes, `EMAIL_ALREADY_VERIFIED`, `SESSION_LIMIT_REACHED`                                                                          |
| `POST /auth/resend-verification`   | `ResendVerificationDto`                | `ResendVerificationResponseDto`       |    201 | Public                                      | `VALIDATION_FAILED`, `VERIFICATION_EMAIL_COOLDOWN`, `VERIFICATION_EMAIL_UNAVAILABLE`                                                                                |
| `POST /auth/forgot-password`       | `ForgotPasswordDto`                    | `ForgotPasswordResponseDto`           |    202 | Request IP; informational metadata accepted | `VALIDATION_FAILED`, `RATE_LIMIT_EXCEEDED`                                                                                                                          |
| `POST /auth/reset-password`        | `ResetPasswordDto`                     | `ResetPasswordResponseDto`            |    200 | Request IP; informational metadata accepted | `VALIDATION_FAILED`, `PASSWORDS_DO_NOT_MATCH`, `PASSWORD_RESET_TOKEN_INVALID`, `PASSWORD_CHANGED_CONCURRENTLY`                                                      |
| `POST /auth/refresh`               | none                                   | `AuthTokensResponseDto`               |    201 | Refresh bearer token                        | refresh-token codes                                                                                                                                                 |
| `POST /auth/logout`                | none                                   | none                                  |    204 | Access bearer token                         | access-token and `SESSION_UNAVAILABLE` codes                                                                                                                        |
| `GET /auth/sessions`               | none                                   | `SessionsResponseDto`                 |    200 | Access bearer token                         | access-token and `SESSION_UNAVAILABLE` codes                                                                                                                        |
| `PATCH /auth/sessions/:sessionId`  | `SessionParamsDto`, `UpdateSessionDto` | `UpdateSessionResponseDto`            |    200 | Access bearer token                         | validation, access/session codes, `SESSION_TOO_FRESH`, `SESSION_NOT_FOUND`                                                                                          |
| `DELETE /auth/sessions/others`     | none                                   | `RevokeOtherSessionsResponseDto`      |    200 | Access bearer token                         | access/session codes, `SESSION_TOO_FRESH`                                                                                                                           |
| `DELETE /auth/sessions/:sessionId` | `SessionParamsDto`                     | none                                  |    204 | Access bearer token                         | validation, access/session codes, `SESSION_TOO_FRESH`, `SESSION_NOT_FOUND`                                                                                          |
| `PATCH /account/password`          | `ChangePasswordDto`                    | `PasswordChangeResponseDto`           |    200 | Access bearer token                         | validation, access/session/account codes, credential codes, `PASSWORD_CHANGED_CONCURRENTLY`                                                                         |
| `POST /account/deletion`           | `RequestAccountDeletionDto`            | `AccountDeletionResponseDto`          |    202 | Access bearer token                         | validation, access/session/account codes, `CURRENT_PASSWORD_INVALID`                                                                                                |
| `POST /account/deletion/cancel`    | `CancelAccountDeletionDto`             | `AccountDeletionCancelledResponseDto` |    200 | Session metadata headers                    | validation, credentials, rate-limit and deletion-state codes, `SESSION_LIMIT_REACHED`                                                                               |
| `GET /profile/me`                  | none                                   | `ProfileResponseDto`                  |    200 | Access bearer token                         | access/session/account codes, `PROFILE_UNAVAILABLE`                                                                                                                 |

There is no public security-event endpoint in the MVP.

## Swagger and mobile-client requirements

- Every public endpoint declares an explicit success response DTO or an empty
  204 response.
- Protected endpoints use named access- or refresh-bearer OpenAPI schemes.
- Informational device headers are documented where they are accepted and are
  never described as security signals.
- Each documented error response references the shared envelope and a typed
  details schema where applicable.
- Examples demonstrate branching codes but do not make message text stable.
- The generated OpenAPI document must not contain anonymous successful auth,
  account, or profile responses.
- Runtime contract tests must verify representative responses against the
  documented DTOs and ensure Prisma, token-hash, deletion-internal, and
  security-service fields are absent.

Changing logout from its current implicit `201` response to `204 No Content`
is an intentional pre-frontend-freeze correction and must be delivered and
tested with the later endpoint implementation work.
