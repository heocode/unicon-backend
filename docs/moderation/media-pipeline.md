# Moderation Media Pipeline

Deterministic moderation inputs, processing boundaries, concurrency, and exact-content reuse.

## Deterministic ModerationPackage

Policy evaluates a private ModerationPackage, not raw upload bytes:

```text
ModerationPackage
├── sanitized master preview
├── social crop preview
├── expanded crop preview
├── normalizationVersion
├── crop/presentation configuration
└── manifestVersion
```

`moderationInputHash` is SHA-256 over the canonical manifest and referenced
deterministic content. It binds a decision to the master view, both public
compositions, and normalization pipeline. Perceptual hashing is deferred.

## Exact-content decision reuse

The reuse key is:

```text
moderationInputHash
+ policyRevisionId
+ moderationConfigurationVersion
```

`moderationConfigurationVersion` fingerprints how required evidence is
obtained: provider roles, model/request configuration, adapter mapping,
declared provider coverage capabilities, and fallback execution strategy.
The `PolicyRevision`, not this configuration version, declares which
normalized signals and coverage the policy requires.
Provider identity need not be a separate component because the cache stores a
final Unicon decision, but every evidence-affecting strategy/provider change
must change the configuration version.

Only active final reusable `ALLOW` or `REJECT` decisions may be reused.
`PENDING`, `REVIEW`, failed attempts, revoked, superseded, and expired
decisions are never reusable. Manual correction, legal takedown, appeal,
report outcome, or re-moderation campaign can revoke/supersede a reusable
decision.

Concurrent cache misses use a distributed claim/lease on the cache key. One
worker evaluates; others wait or reschedule. No database transaction stays
open across provider calls. Expired leases are reclaimable after worker
failure. Workers recheck for an active final decision immediately before a
provider call and before committing a decision.

Cross-user reuse never exposes another user's ownership, source evidence,
existence, or detailed rejection reason. Client responses remain generic.
