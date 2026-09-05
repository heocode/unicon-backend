# Moderation Core Architecture

Core domain boundaries, invariants, and state model for Unicon media moderation.

## Mental model

```text
Media
→ deterministic ModerationPackage
→ ModerationProviderAttempt
→ normalized Unicon signals and coverage
→ immutable PolicyRevision
→ ModerationDecision
→ visibility and active-media selection
```

The governing principle is:

> Provider evidence is not a Unicon verdict.

Provider labels, flags, scores, and error states never directly determine
public visibility. Only the Unicon policy engine produces `ALLOW`, `REVIEW`,
or `REJECT`.

## Core invariants

- Provider failure never grants public visibility.
- Provider output is normalized before policy evaluation.
- `flagged=true` is evidence, not a final verdict.
- Technical recovery is not human review.
- Incomplete fallback coverage may increase severity through a calibrated
  Unicon rule, but may never grant approval.
- Automation cannot silently override an explicit manual decision for the
  same asset and policy revision.
- Stale, replaced, deleted, or deletion-pending Media never becomes active
  because of a late result.
- Exact-content reuse applies only to active, final, explicitly reusable
  Unicon decisions under the same policy and moderation configuration.
- Every meaningful provider attempt and moderation decision remains auditable.
- Profile Photo moderation, delay, failure, or review never blocks Onboarding
  completion.

## Moderation state

Technical processing and moderation are independent state machines. The Media
moderation state remains intentionally small:

```text
MediaModerationStatus:
  PENDING
  APPROVED
  REVIEW_REQUIRED
  REJECTED
```

Technical work is represented only while moderation is `PENDING`:

```text
MediaModerationOperationalSubstate:
  AUTOMATED_PROCESSING
  RETRY_SCHEDULED
  QUOTA_PARKED
  PROVIDER_CONFIGURATION_BLOCKED
```

The state mapping is:

```text
no final decision / technical recovery → PENDING
ALLOW                                  → APPROVED
REVIEW                                 → REVIEW_REQUIRED
REJECT                                 → REJECTED
```

`REVIEW_REQUIRED` means an explicit human decision is required and a durable
review case exists. A timeout, quota problem, or retryable provider failure
does not create a human case while automated recovery remains viable.

A Profile Photo is publicly eligible only when its processing is ready, its
moderation status is approved, and neither its ProfilePhoto nor Media is
deleted. The Profile integration applies the additional latest-intent and
ownership checks documented in the Profile architecture.
