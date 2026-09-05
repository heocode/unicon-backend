# Moderation Providers and Retries

Provider roles, normalized evidence acquisition, failure handling, and durable recovery.

## Primary provider

Sightengine is the primary proactive provider for Profile Photos. The
preliminary v1 model bundle is:

```text
nudity-2.1
violence
weapon
gore-2.0
self-harm
offensive-2.0
recreational_drug
medical
```

The provider adapter normalizes Sightengine-specific output into stable Unicon
signals and explicit coverage metadata. HTTP success is insufficient unless
every signal required by the pinned PolicyRevision is present and valid.

Two external production checks remain:

- verify the real operation count and Free-plan availability of the complete
  multi-model request;
- obtain written Sightengine confirmation that the intended Trust & Safety and
  restricted child-safety review use is permitted under its terms.

## Asymmetric OpenAI fallback

OpenAI Moderation does not run in the normal Profile Photo path. It is an
emergency fallback when Sightengine cannot complete the required assessment.
OpenAI `flagged`, categories, and scores are normalized evidence only.

Because coverage is incomplete:

```text
OpenAI fallback signals
→ calibrated Unicon fallback rule may produce REJECT
→ otherwise Media remains non-public PENDING
→ schedule Sightengine recovery
→ fallback never produces ALLOW or public visibility
```

Explicit sexual content and extreme graphic gore are candidate fallback rules.
Their automatic-reject authority starts disabled and is enabled independently
only after the same evaluation and precision requirements are met. Ordinary
violence and self-harm have no default automatic-reject authority because of
material contextual false-positive risk.

## Provider attempts and decisions

Provider execution and content decisions are separate append-only records:

```text
ModerationProviderAttempt
├── mediaId
├── moderationInputHash
├── policyRevisionId
├── provider
├── providerRole: PRIMARY | FALLBACK
├── providerConfigurationVersion
├── status: SUCCEEDED | FAILED | SKIPPED
├── failureKind?
├── rawEvidenceReference?
├── normalizedSignals?
├── coverage?
├── attemptNumber
├── startedAt
├── completedAt
└── nextRetryAt?

ModerationDecision
├── mediaId
├── moderationInputHash
├── policyRevisionId
├── moderationConfigurationVersion
├── source: AUTOMATED | MANUAL | LEGAL | APPEAL | REUSE
├── outcome: ALLOW | REVIEW | REJECT
├── ruleIds
├── reasonCodes
├── evidenceAttemptIds
├── reusedFromDecisionId?
├── isReusable
├── revokedAt?
├── supersededAt?
├── expiresAt?
├── createdAt
└── actorId?
```

Failed calls do not masquerade as assessments. Raw evidence remains private
infrastructure/audit data. Normalized signals are the only provider data
consumed by policy. Public DTOs expose neither.

Media may keep an active decision reference and denormalized moderation state,
but append-only attempts and decisions are the audit source of truth.

`ModerationDecision` is an append-only decision record, not a “decision
revision.” A later valid decision creates a new record and supersedes the
previous active record without mutating history. A decision with
`source=MANUAL` may have only `ALLOW` or `REJECT` as its outcome. If a reviewer
cannot decide, the review case remains open, is reassigned, or is escalated;
the system must not create a `MANUAL + REVIEW` decision.

## Failure taxonomy

Primary failures are classified before retry or fallback:

```text
TIMEOUT | NETWORK | 5XX
→ OpenAI fallback
→ PENDING / RETRY_SCHEDULED
→ bounded exponential backoff with jitter

RATE_LIMITED
→ honor Retry-After
→ OpenAI fallback
→ PENDING / RETRY_SCHEDULED

QUOTA_EXHAUSTED
→ OpenAI fallback
→ PENDING / QUOTA_PARKED
→ wake after quota reset or plan upgrade
→ operator alert

AUTH | CONFIGURATION_ERROR
→ shared circuit breaker
→ OpenAI fallback
→ PENDING / PROVIDER_CONFIGURATION_BLOCKED
→ operator alert

PARTIAL | UNUSABLE | MALFORMED_RESPONSE
→ OpenAI fallback
→ PENDING
→ retry or alert according to recoverability

INVALID_PROVIDER_REQUEST
→ engineering failure
→ no blind retry
→ fallback only if the ModerationPackage is independently valid
→ never publish
```

The initial transient schedule may begin around `30s → 2m → 10m → 1h`, but
runtime configuration defines a bounded attempt count, maximum automated retry
age, quota wake-up behavior, and the point at which unresolved work requires
operator or human intervention.

Provider health and circuit-breaker state are shared across workers. Local-only
breakers would allow a scaled fleet to continue hammering a failed provider.
Quota and configuration failures park work instead of creating retry storms.

## Retry execution

Media preparation and provider retry are separate jobs:

```text
PROCESS_MEDIA
→ validate/decode/normalize
→ sanitized master
→ private owner renditions
→ deterministic ModerationPackage
→ initial primary/fallback evaluation

RETRY_MODERATION
→ reload existing ModerationPackage
→ recheck deletion/freshness/cache/lease
→ retry provider evaluation
→ never repeat decoding or regenerate artifacts
```

A technical pending outcome is acknowledged only after its operational state
and follow-up retry or park record are durable. Queue redelivery is not the
sole retry schedule and cannot cause uncontrolled provider calls.
