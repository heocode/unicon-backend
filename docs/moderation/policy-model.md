# Moderation Policy Model

Policy identity, immutable revisions, content categories, and decision precedence.

## Policy family and immutable revisions

The naming contract has three distinct levels:

```text
PolicySurface:  PROFILE_PHOTO
PolicyFamily:   profile-photo-v1
PolicyRevision: profile-photo-v1@<immutable-revision-id>
```

`PROFILE_PHOTO` identifies the product surface being moderated.
`profile-photo-v1` identifies the compatible policy lineage for that surface.
A `PolicyRevision` is one concrete immutable executable rule set within that
family; it is not a mutable runtime configuration.

```text
PolicyRevisionStatus:
  DRAFT
  ACTIVE
  RETIRED
```

An activated revision is never edited. Changing any threshold, contextual
rule, required normalized signal or coverage requirement, ModerationPackage
aggregation semantics, or automatic-decision authority creates a new
revision. Retiring a revision prevents new evaluations under it but does not
rewrite historical decisions.

An evaluation pins its PolicyRevision when it begins. Retry resumes the same
immutable revision even if another revision becomes active. Applying a newer
revision to pending or previously decided Media requires an explicit
re-evaluation transition or campaign.

Every ModerationDecision records:

- the exact PolicyRevision ID;
- applied rule and reason identifiers;
- the moderation configuration version;
- the exact moderation input hash;
- evidence provenance;
- the outcome and authority source.

### Policy and provider-configuration boundary

`PolicyRevision` owns the meaning of the policy: required normalized signals
and coverage, thresholds, contextual combinations, package aggregation rules,
`ALLOW`/`REVIEW`/`REJECT` rules, and per-rule automatic-reject authority.

`moderationConfigurationVersion` owns how evidence is obtained: providers and
their roles, model bundle, request parameters, adapter mapping from provider
output to normalized signals, declared provider coverage capabilities, and
fallback execution strategy.

Threshold or policy-rule changes require a new `PolicyRevision`.
Provider/model/request/adapter changes require a new
`moderationConfigurationVersion`. If the meaning or semantics of a normalized
signal changes, both identifiers must change.

## Profile Photo policy categories

The accepted categories within the `profile-photo-v1` family are:

- sexual content and nudity;
- child safety;
- violence and gore;
- self-harm;
- weapons;
- hate imagery and symbols;
- violent extremism and propaganda;
- drugs and controlled substances.

Spam, scams, impersonation, harassment, and account-level behavioral abuse do
not belong to Profile Photo image policy.

There is no universal NSFW score. Each family has its own thresholds,
contextual rules, and uncertainty band. Policy must distinguish examples such
as beachwear from explicit sexual content, minor injury from gore, toy/museum
weapons from threatening presentation, historical imagery from propaganda,
and ordinary social alcohol content from controlled-substance promotion.

Automatic rejection prioritizes precision over recall. A rule receives
automatic `REJECT` authority only after evaluation demonstrates at least 97%
precision with adequate sample size, statistical confidence, and relevant
data-slice coverage. Before calibration, uncertainty and high provider scores
resolve to `REVIEW`, not automatic rejection.

## Child safety

The presence of a child is not a violation. V1 does not use age estimation,
and ordinary child, family, and group photos remain eligible for `ALLOW`.

Consequently, v1 does not provide complete proactive minor detection. The
absence of a minor-related signal is not evidence that no child is present and
must never independently justify `ALLOW`. Restricted human review applies
when sexual or exploitative context involving a potential minor is surfaced
by available provider evidence, manual observation, reports, or future
detection mechanisms. This limitation does not add age estimation to v1.

Possible minor presence combined with sexual or exploitative context can never
receive automatic `ALLOW`. It enters restricted human review. Restricted
routing uses internal reason codes, narrower reviewer authorization, and audit
controls without adding a public or domain `ESCALATE` status.

Sightengine plan capability and contractual permission for this Trust & Safety
use remain external production-readiness checks.

## Decision precedence

Authority and freshness rules replace a primitive provider hierarchy:

1. Automation cannot override an explicit manual decision for the same asset
   and PolicyRevision. Late automated attempts are audit evidence only.
2. Every decision binds `mediaId`, `moderationInputHash`, `policyRevisionId`,
   and `moderationConfigurationVersion`.
3. A stale asset may receive an audit decision but can become active only if it
   remains the user's latest pending selection.
4. Deleted/deletion-pending Media is never republished by a late result.
5. Complete Sightengine evidence is evaluated by normal Unicon policy when no
   stronger explicit decision conflicts.
6. OpenAI fallback evidence without a calibrated reject remains `PENDING`; a
   later primary decision may approve or reject it.
7. If calibrated fallback evidence produced `REJECT` and a later primary
   evaluation would produce `ALLOW`, the disagreement becomes human review.
8. A new PolicyRevision does not automatically invalidate old approvals;
   re-evaluation requires an explicit campaign.
9. A later manual, legal, appeal, or campaign verdict appends and supersedes a
   decision; history is never edited.

All decision application uses compare-and-set or equivalent transactional
checks against the active decision record, deletion state, and latest
selection.
