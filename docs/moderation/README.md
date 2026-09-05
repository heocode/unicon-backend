# Moderation Documentation

This document is the source of truth for Unicon media moderation architecture
and the accepted `PROFILE_PHOTO` policy surface with its `profile-photo-v1`
policy family. It defines the separation between provider evidence, Unicon
policy, moderation decisions, operational recovery, visibility, and human
review.

The backend does not yet implement the models, workers, providers, policy
engine, or admin surface described here. This is an accepted architecture
contract, not an implemented public API contract.

Profile Photo ownership, history, crops, variants, upload, and storage are
defined in [`profile-architecture.md`](../profile-architecture.md). The future
`POST_MEDIA` surface with a `post-media-v1` family and User Reports are outside
this document.

## Current status

- Core Profile Photo moderation architecture: **ACCEPTED**.
- Cross-family semantic taxonomy: **COMPLETE**.
- Rule Catalog Contract: **FIXED**.
- Representative schema cases: **VALIDATED**.
- Full Nudity Named Rule Catalog: **NOT STARTED**.
- Numeric thresholds, calibration, and production authorities: **OPEN**.
- Propaganda/ideological-promotion policy: **DEFERRED**.

## Documentation map

1. [Core architecture](architecture.md) — mental model, invariants, and moderation state.
2. [Policy model](policy-model.md) — policy identity, immutable revisions, categories, and precedence.
3. [Media pipeline](media-pipeline.md) — deterministic package, processing, concurrency, and reuse.
4. [Providers and retries](providers-and-retries.md) — Sightengine, OpenAI fallback, failures, and recovery.
5. [Signal taxonomy](signal-taxonomy.md) — accepted normalized single-family signals.
6. [Cross-family semantics](cross-family-semantics.md) — accepted matrices and prohibited inferences.
7. [Rule Catalog Contract](rule-catalog-contract.md) — fixed executable-rule schema and representative cases.
8. [Visibility and review](visibility-and-review.md) — owner/public delivery, human review, and takedown.
9. [Rollout and open decisions](rollout-and-open-decisions.md) — accepted summary and remaining production checks.

## Reading paths

For work on Named Rule Catalogs, read this index, the [Rule Catalog Contract](rule-catalog-contract.md), and the relevant portions of [Signal Taxonomy](signal-taxonomy.md). Add [Cross-Family Semantics](cross-family-semantics.md) only when a rule spans families.

For provider or worker implementation, read [Core Architecture](architecture.md), [Media Pipeline](media-pipeline.md), [Providers and Retries](providers-and-retries.md), and [Policy Model](policy-model.md).

For Profile integration and public/private delivery, read [Visibility and Review](visibility-and-review.md) together with [Profile Architecture](../profile-architecture.md).

## Source-of-truth rule

Each contract belongs to exactly one document in this directory. Other files link to it rather than copying its full definition. The legacy [moderation architecture path](../moderation-architecture.md) is a compatibility pointer only.
