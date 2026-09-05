# Moderation Rollout and Open Decisions

Accepted architecture summary, production-readiness checks, and parameters still requiring explicit decisions.

## Accepted decisions

- Provider and policy are separate boundaries.
- `PROFILE_PHOTO` is the policy surface; `profile-photo-v1` is its policy
  family; immutable `PolicyRevision` records contain executable rules.
- Sightengine is primary with the preliminary eight-model bundle, including
  `recreational_drug` and `medical` as separate required models.
- OpenAI Moderation is asymmetric emergency fallback only.
- Fallback never approves; calibrated fallback rules may reject.
- All fallback automatic-reject authorities start disabled.
- Technical failure stays non-public `PENDING`; human review alone uses
  `REVIEW_REQUIRED`.
- Provider attempts and decisions are separate append-only records.
- Nudity, violence, weapon, gore, self-harm, hate/offensive, and
  recreational-drug/medical taxonomies and role-aware package aggregation are
  accepted as above. Weapon presence without threatening presentation is
  permitted; gore severity remains independent from whether the depiction is
  real, staged, or illustrated; self-harm has no automatic-reject authority in
  v1; symbol presence does not establish ideological endorsement or intent;
  cannabis and medical contexts are permitted by default while non-cannabis
  recreational drug use requires review.
- The Violence × Weapon cross-family matrix is accepted. It separates policy
  relationship, evidence interaction, outcome floor, and automatic-reject
  eligibility, and never infers actor-level or causal association from
  image-level co-occurrence.
- The Violence × Gore cross-family matrix is accepted. Only physical violence
  combined with severe blood or serious injury is initially eligible for a
  calibrated automatic-reject rule, and only when both signals occur in the
  same public moderation input; all such authority starts disabled.
- The Violence × Self-Harm cross-family matrix is accepted with no
  automatic-reject eligibility in v1. Violence may corroborate a harmful scene
  but never establishes self/other direction, intent, causality, or actor
  identity.
- The Weapon × Gore cross-family matrix is accepted. Threat-plus-severe-Gore
  rules are the strong automatic-reject candidates; weapon-presence plus
  serious injury rules are exploratory candidates only. All start disabled,
  require same-public-input evidence, and never imply causal/object binding.
- The Weapon × Self-Harm cross-family matrix is accepted with no
  automatic-reject eligibility in v1. Weapon evidence may support a possible
  method but never binds the weapon, gesture, direction, object, or actor to
  self-harm evidence; cross-input findings are co-occurrence, not
  corroboration.
- The Gore × Self-Harm cross-family matrix is accepted with no automatic-reject
  eligibility in v1. Gore may support the presence or severity of physical
  consequences but never establishes self-infliction, intent, recency,
  real-world occurrence, causality, or actor identity.
- The Nudity × Violence cross-family matrix is accepted. Sexual activity plus
  physical violence is the strong automatic-reject candidate; sexual display
  plus physical violence is exploratory. Both start disabled, require
  same-public-input evidence, and never establish consent, coercion, assault,
  victimhood, sexual motivation, or actor identity.
- The Nudity × Gore cross-family matrix is accepted. Sexual activity plus
  severe blood or serious injury supplies the strong automatic-reject
  candidates; the corresponding sexual-display rules are exploratory. All
  start disabled, require same-public-input evidence, and never establish
  sexual harm, consent, incapacity, victimhood, necrophilic activity,
  causality, or actor identity.
- The Nudity × Self-Harm cross-family matrix is accepted with no
  automatic-reject eligibility in v1. Same-input findings may create
  meaningful high-risk interaction, but never establish sexualization,
  motivation, coercion, exploitation, fetish context, causality, depiction
  type, or actor identity.
- The Nudity × Weapon cross-family matrix is accepted with no automatic-reject
  eligibility in v1. Same-input threat combinations may create meaningful
  high-risk interaction but never establish consent, coercion, sexual threat,
  weapon use, fetish context, victimhood, or actor/object identity.
- The Recreational Drug × Medical cross-family matrix is accepted with no
  automatic-reject eligibility in v1. Same-input medical evidence may suppress
  only an otherwise unexplained aggregate safeguard through a calibrated rule;
  it never overrides explicit non-cannabis recreational-use evidence, and
  suppression is not approval.
- The Hate/Extremism × Violence cross-family matrix is accepted with no
  automatic-reject eligibility in v1. Same-input coexistence may prioritize
  review but never establishes ideological violence, endorsement, motivation,
  protected-group targeting, causality, or actor identity.
- The Hate/Extremism × Weapon cross-family matrix is accepted with no
  automatic-reject eligibility in v1. Same-input threat combinations may add
  ordinary-review priority metadata but never establish ideology, targeting,
  ownership, affiliation, recruitment, propaganda, weapon use, motivation, or
  actor/object identity.
- The Hate/Extremism × Gore cross-family matrix is accepted with no
  automatic-reject eligibility in v1. Same-input severe Gore may attach an
  elevated ordinary-review hint but never establishes ideological violence,
  hate crime, atrocity, genocide, execution, protected-group targeting,
  causality, motivation, victimhood, or actor identity.
- The independent/deferred closure matrix is accepted. These pairs preserve
  the strictest independently produced family outcome and audit evidence but
  create no cross-family reason, priority change, score combination,
  escalation, or automatic-reject authority. Drugs × Self-Harm is explicitly
  deferred pending new evidence mechanisms and a future PolicyRevision.
- The `profile-photo-v1` cross-family semantic taxonomy is complete.
- Propaganda, ideological promotion, glorification, and recruitment are
  explicitly deferred beyond `profile-photo-v1` and require a separate future
  policy decision rather than a threshold-only change.
- Automatic rejection targets at least 97% precision per calibrated rule.
- Child presence alone is allowed; potential minor sexual/exploitative context
  receives restricted human review when surfaced. V1 has no complete proactive
  minor detection, and absence of a minor signal is never evidence of absence.
- Policy rules and required normalized coverage belong to `PolicyRevision`;
  provider execution and evidence acquisition belong to
  `moderationConfigurationVersion`.
- Manual decisions are append-only `ALLOW` or `REJECT` records; an undecided
  human review remains an open case rather than creating `MANUAL + REVIEW`.
- Retry is bounded, durable, separately scheduled, and protected by shared
  provider-health controls.
- Exact-content reuse uses a deterministic ModerationPackage, immutable policy
  revision, configuration version, revocation, and distributed claim/lease.
- Manual authority, asset freshness, deletion, provider disagreement, and
  policy migration follow the precedence rules above.
- Owner-only pending visibility never grants public visibility.
- The Rule Catalog Contract is fixed. It separates matching from effect
  application, uses explicit multi-family scope and required coverage, limits
  same-input relationships to co-located evidence semantics, gives automatic
  reject authority only to calibrated named rules, binds modifiers to explicit
  target evaluations, and leaves presentation outside the catalog.
- Nudity, `SELF_HARM_OVERALL`, and Recreational Drug × Medical currently serve
  only as representative schema-validation cases. The full Nudity Named Rule
  Catalog has not yet been fixed.

## Open production decisions and checks

The moderation architecture is accepted. These production parameters and
external checks remain open:

1. The first active immutable PolicyRevision: thresholds, contextual rules,
   evaluation dataset, sample/confidence requirements, and enabled automatic
   reject authorities.
2. Verified Sightengine operation cost and Free-plan availability for the full
   primary bundle.
3. Written Sightengine confirmation for the intended Trust & Safety and
   restricted child-safety use under its terms.
4. Exact retry attempt budget, maximum retry age, quota wake-up schedule, and
   operator/human escalation deadline.
5. Retention for quarantine uploads, sanitized masters, ModerationPackages,
   pending previews, rejected/failed assets, provider evidence, decisions,
   hashes, and reusable-cache records.
6. Minimum protected admin review UI/tool, including restricted reason-code
   access.

These items do not reopen the accepted architecture, but affected production
paths must not launch until their values and checks are explicit.
