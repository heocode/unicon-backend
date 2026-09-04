# Moderation Architecture

This document is the source of truth for Unicon media moderation architecture
and the accepted `PROFILE_PHOTO` policy surface with its `profile-photo-v1`
policy family. It defines the separation between provider evidence, Unicon
policy, moderation decisions, operational recovery, visibility, and human
review.

The backend does not yet implement the models, workers, providers, policy
engine, or admin surface described here. This is an accepted architecture
contract, not an implemented public API contract.

Profile Photo ownership, history, crops, variants, upload, and storage are
defined in [`profile-architecture.md`](profile-architecture.md). The future
`POST_MEDIA` surface with a `post-media-v1` family and User Reports are outside
this document.

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

## Accepted nudity signal taxonomy

The `nudity-2.1` adapter maps provider paths into the following stable Unicon
signals. `Standalone action` describes rule authority after the applicable
per-signal threshold is met; it is not itself a numeric threshold. `Eligible`
means a rule may receive automatic-reject authority after calibration, not that
the authority is currently enabled.

| Normalized Unicon signal | Policy class                   | Standalone action              | Contextual | Auto-REJECT |
| ------------------------ | ------------------------------ | ------------------------------ | ---------- | ----------- |
| `SEXUAL_ACTIVITY`        | `PROHIBITED`                   | `REVIEW` / calibrated `REJECT` | Yes        | Eligible    |
| `SEXUAL_DISPLAY`         | `PROHIBITED`                   | `REVIEW` / calibrated `REJECT` | Yes        | Eligible    |
| `EROTICA`                | `PROHIBITED`                   | `REVIEW` / calibrated `REJECT` | Yes        | Eligible    |
| `VERY_SUGGESTIVE`        | `EVIDENCE`                     | High unexplained → `REVIEW`    | Yes        | No          |
| `SUGGESTIVE`             | `EVIDENCE`                     | None                           | Yes        | No          |
| `MILDLY_SUGGESTIVE`      | `EVIDENCE`                     | None                           | Yes        | No          |
| `NONE`                   | `NEGATIVE_EVIDENCE`            | None                           | No         | No          |
| `VISIBLY_UNDRESSED`      | `CONTEXTUAL`                   | `REVIEW`                       | Yes        | No          |
| `SEXTOY`                 | `CONTEXTUAL`                   | `REVIEW`                       | Yes        | No          |
| `SUGGESTIVE_FOCUS`       | `CONTEXTUAL`                   | None                           | Yes        | No          |
| `SUGGESTIVE_POSE`        | `CONTEXTUAL`                   | None                           | Yes        | No          |
| `LINGERIE`               | `SAFE_BY_DEFAULT`              | None                           | Yes        | No          |
| `MALE_UNDERWEAR`         | `SAFE_BY_DEFAULT`              | None                           | Yes        | No          |
| `CLEAVAGE_*`             | `SAFE_BY_DEFAULT`              | None                           | Yes        | No          |
| `MALE_CHEST_*`           | `SAFE_BY_DEFAULT`              | None                           | Yes        | No          |
| `BIKINI`                 | `SAFE_BY_DEFAULT`              | None                           | Yes        | No          |
| `SWIMWEAR_ONE_PIECE`     | `SAFE_BY_DEFAULT`              | None                           | Yes        | No          |
| `SWIMWEAR_MALE`          | `SAFE_BY_DEFAULT`              | None                           | Yes        | No          |
| `MINISHORT`              | `SAFE_BY_DEFAULT`              | None                           | No         | No          |
| `MINISKIRT`              | `SAFE_BY_DEFAULT`              | None                           | No         | No          |
| `NUDITY_ART`             | `CONTEXTUAL / SAFE_BY_DEFAULT` | None                           | Yes        | No          |
| `SCHEMATIC`              | `CONTEXTUAL`                   | `REVIEW`                       | Yes        | No          |
| `OTHER`                  | `EVIDENCE`                     | None                           | Yes        | No          |
| `SEA_LAKE_POOL`          | `CONTEXT`                      | None                           | Yes        | No          |
| `OUTDOOR_OTHER`          | `CONTEXT`                      | None                           | Yes        | No          |
| `INDOOR_OTHER`           | `CONTEXT`                      | None                           | Yes        | No          |

`SAFE_BY_DEFAULT` means the signal cannot independently cause moderation
action. It is not a final `ALLOW` and cannot override evidence from this or any
other family. `NONE` is negative nudity evidence only and cannot grant a final
verdict.

Provider intensity scores are not summed. Sightengine emphasizes the most
explicit matching intensity, so `SEXUAL_ACTIVITY`, `SEXUAL_DISPLAY`, and
`EROTICA` are evaluated independently. A high `VERY_SUGGESTIVE` score that is
not explained by usable contextual classes is a review safeguard, never an
automatic rejection.

The adapter owns exact provider-path mapping, including nested paths such as
`nudity.suggestive_classes.cleavage_categories.very_revealing` and
`nudity.context.sea_lake_pool`. Policy consumes only normalized signals and
their source/input-role metadata.

ModerationPackage aggregation is role-aware:

- prohibited evidence in public `SOCIAL` or `EXPANDED` compositions follows
  the normal review/calibrated-reject rules;
- prohibited evidence found only in the private master preview produces
  `REVIEW` in v1 and is not eligible for automatic rejection;
- contextual and safe-by-default signals are evaluated as rule combinations,
  not by taking an unconditional maximum across package inputs.

Changing either crop creates a new ModerationPackage and requires a new or
reusable decision under its new moderation cache key.

## Accepted violence signal taxonomy

The `violence` adapter maps provider output into the following stable Unicon
signals. Automatic-reject eligibility belongs only to a calibrated contextual
Unicon rule; neither prohibited provider signal may independently reject an
image.

| Normalized Unicon signal | Provider path                        | Policy class         | Standalone action                                 | Contextual | Auto-REJECT           |
| ------------------------ | ------------------------------------ | -------------------- | ------------------------------------------------- | ---------- | --------------------- |
| `PHYSICAL_VIOLENCE`      | `violence.classes.physical_violence` | `PROHIBITED`         | `REVIEW`; calibrated contextual rule may `REJECT` | Yes        | Contextual rules only |
| `FIREARM_THREAT`         | `violence.classes.firearm_threat`    | `PROHIBITED`         | `REVIEW`; calibrated contextual rule may `REJECT` | Yes        | Contextual rules only |
| `COMBAT_SPORT`           | `violence.classes.combat_sport`      | `SAFE_BY_DEFAULT`    | None                                              | Yes        | No                    |
| `VIOLENCE_OVERALL`       | `violence.prob`                      | `AGGREGATE_EVIDENCE` | None                                              | No         | No                    |

`PHYSICAL_VIOLENCE` can include staged scenes, news/media imagery, games, or
training. `FIREARM_THREAT` can overlap with cosplay, replicas, museums, and
media imagery. Those false-positive surfaces are why automatic rejection
requires a calibrated combination of normalized evidence and context.

`COMBAT_SPORT` is mitigating context, not an unconditional safety override. It
cannot neutralize stronger conflicting signals by itself. `VIOLENCE_OVERALL`
is supporting aggregate evidence only: it cannot independently trigger
`REVIEW` or `REJECT`, and a low value is not negative evidence when a specific
class is high.

The violence and weapon families have separate semantics. `FIREARM_THREAT`
describes violent or threatening presentation; weapon signals describe the
presence, type, and presentation of a weapon. One ModerationPackage may
contain both without treating them as duplicate evidence.

## Accepted weapon signal taxonomy

Weapons are not prohibited from Unicon Profile Photos merely because they are
present. The `weapon` adapter separates presence, depiction, placement, and
threatening presentation so policy action depends on context.

| Normalized Unicon signal | Provider path                              | Policy class      | Standalone action | Role                               | Auto-REJECT           |
| ------------------------ | ------------------------------------------ | ----------------- | ----------------- | ---------------------------------- | --------------------- |
| `FIREARM`                | `weapon.classes.firearm`                   | `CONTEXTUAL`      | None              | Weapon presence                    | No                    |
| `KNIFE`                  | `weapon.classes.knife`                     | `CONTEXTUAL`      | None              | Weapon/blade presence              | No                    |
| `FIREARM_GESTURE`        | `weapon.classes.firearm_gesture`           | `SAFE_BY_DEFAULT` | None              | Simulated weapon gesture           | No                    |
| `FIREARM_TOY`            | `weapon.classes.firearm_toy`               | `CONTEXT`         | None              | Mitigating weapon-type evidence    | No                    |
| `FIREARM_ANIMATED`       | `weapon.firearm_type.animated`             | `CONTEXT`         | None              | Mitigating depiction evidence      | No                    |
| `AIMING_THREAT`          | `weapon.firearm_action.aiming_threat`      | `CONTEXTUAL`      | `REVIEW`          | Threatening presentation candidate | Contextual rules only |
| `AIMING_CAMERA`          | `weapon.firearm_action.aiming_camera`      | `CONTEXTUAL`      | `REVIEW`          | Threatening presentation candidate | Contextual rules only |
| `AIMING_SAFE`            | `weapon.firearm_action.aiming_safe`        | `CONTEXT`         | None              | Mitigating target context          | No                    |
| `IN_HAND_NOT_AIMING`     | `weapon.firearm_action.in_hand_not_aiming` | `CONTEXT`         | None              | Presentation context               | No                    |
| `WORN_NOT_IN_HAND`       | `weapon.firearm_action.worn_not_in_hand`   | `CONTEXT`         | None              | Presentation context               | No                    |
| `NOT_WORN`               | `weapon.firearm_action.not_worn`           | `CONTEXT`         | None              | Placement context                  | No                    |

`AIMING_THREAT` and `AIMING_CAMERA` independently require review after their
applicable thresholds are met. They become eligible for automatic rejection
only through a calibrated contextual rule, such as sufficiently confident
real-firearm presence plus threatening aim without a credible toy, animated,
or safe-target explanation.

Mitigating weapon evidence may reduce uncertainty but may not independently
override stronger threat or violence evidence. In particular,
`FIREARM_GESTURE` is safe by default only as a simulated gesture; it cannot
neutralize evidence of a real weapon in the same ModerationPackage. Likewise,
placement and non-aiming signals describe presentation rather than proving a
final safe verdict.

The v1 provider taxonomy has no dedicated knife-action signal. Knife presence
alone causes no action, while threatening knife presentation may still be
captured by violence evidence or routed through a future calibrated
cross-family rule. Absence of such evidence must not be inferred from the
absence of a firearm-action signal.

## Accepted gore signal taxonomy

The `gore-2.0` adapter separates graphic severity from depiction type. Whether
content is real, staged, or illustrated affects interpretation, but does not
by itself determine whether the image is suitable for a public Profile Photo.

| Normalized Unicon signal | Provider path                     | Policy class      | Standalone action | Role                            | Auto-REJECT           |
| ------------------------ | --------------------------------- | ----------------- | ----------------- | ------------------------------- | --------------------- |
| `VERY_BLOODY`            | `gore.classes.very_bloody`        | `CONTEXTUAL`      | `REVIEW`          | Severe blood evidence           | Contextual rules only |
| `SLIGHTLY_BLOODY`        | `gore.classes.slightly_bloody`    | `CONTEXTUAL`      | None              | Mild blood evidence             | No                    |
| `BODY_ORGAN`             | `gore.classes.body_organ`         | `CONTEXTUAL`      | `REVIEW`          | Organ/anatomical evidence       | Contextual rules only |
| `SERIOUS_INJURY`         | `gore.classes.serious_injury`     | `CONTEXTUAL`      | `REVIEW`          | Severe injury evidence          | Contextual rules only |
| `SUPERFICIAL_INJURY`     | `gore.classes.superficial_injury` | `SAFE_BY_DEFAULT` | None              | Minor injury evidence           | No                    |
| `CORPSE`                 | `gore.classes.corpse`             | `CONTEXTUAL`      | `REVIEW`          | Death evidence                  | No initially          |
| `SKULL`                  | `gore.classes.skull`              | `CONTEXTUAL`      | None              | Remains/symbolic context        | No                    |
| `UNCONSCIOUS`            | `gore.classes.unconscious`        | `CONTEXTUAL`      | None              | Ambiguous possible-harm context | No                    |
| `BODY_WASTE`             | `gore.classes.body_waste`         | `CONTEXTUAL`      | `REVIEW`          | Disgusting-content evidence     | No                    |
| `OTHER_GORE`             | `gore.classes.other`              | `EVIDENCE`        | None              | Broad/catch-all evidence        | No                    |
| `GORE_REAL`              | `gore.type.real`                  | `CONTEXT`         | None              | Real-depiction context          | No independently      |
| `GORE_FAKE`              | `gore.type.fake`                  | `CONTEXT`         | None              | Staged-depiction context        | No                    |
| `GORE_ANIMATED`          | `gore.type.animated`              | `CONTEXT`         | None              | Illustrated-depiction context   | No                    |

`VERY_BLOODY`, `BODY_ORGAN`, and `SERIOUS_INJURY` are the initial candidates
for automatic rejection through calibrated contextual rules. No candidate has
automatic-reject authority merely because its provider score is high.
`CORPSE` starts without that authority because funerals, historical imagery,
art, and classification errors create significant contextual risk.

`BODY_ORGAN` evaluation accounts for medical, anatomical, museum, and food
contexts. `SKULL` may describe clothing, logos, art, tattoos, or museum
objects. `UNCONSCIOUS` may describe sleep, medical assistance, or staged
content. These signals therefore cannot independently establish prohibited
graphic content.

`GORE_FAKE` and `GORE_ANIMATED` may reduce confidence that real-world harm
occurred, but they cannot neutralize severe graphic evidence. Conversely,
`GORE_REAL` may strengthen real-harm interpretation but does not independently
trigger enforcement. Depiction type and graphic severity remain separate
policy axes.

## Accepted self-harm signal taxonomy

The `self-harm` adapter separates the provider aggregate from real, staged,
and illustrated presentation. Every self-harm rule starts without automatic
rejection authority because scars, recovery or awareness content, staged
media, tattoos, and illustrations create material contextual risk.

| Normalized Unicon signal | Provider path             | Policy class         | Standalone action           | Role                            | Auto-REJECT |
| ------------------------ | ------------------------- | -------------------- | --------------------------- | ------------------------------- | ----------- |
| `SELF_HARM_OVERALL`      | `self-harm.prob`          | `AGGREGATE_EVIDENCE` | High unexplained → `REVIEW` | Provider aggregate / safeguard  | No          |
| `SELF_HARM_REAL`         | `self-harm.type.real`     | `CONTEXTUAL`         | `REVIEW`                    | Possible real or past self-harm | No          |
| `SELF_HARM_FAKE`         | `self-harm.type.fake`     | `CONTEXTUAL`         | `REVIEW`                    | Staged/simulated self-harm      | No          |
| `SELF_HARM_ANIMATED`     | `self-harm.type.animated` | `CONTEXTUAL`         | `REVIEW`                    | Illustrated self-harm           | No          |

The applicable per-signal threshold must be met before a type signal creates a
review case. `SELF_HARM_OVERALL` is normally supporting evidence only, but a
high aggregate unexplained by usable type signals is a fail-closed review
safeguard rather than an automatic approval or rejection.

`SELF_HARM_FAKE` and `SELF_HARM_ANIMATED` describe presentation type; they are
not mitigating evidence and do not neutralize self-harm meaning. Cross-family
weapon, violence, and gore signals may add evidence, but none grants automatic
rejection authority to self-harm in v1.

## Accepted hate and offensive signal taxonomy

The `offensive-2.0` adapter describes detected imagery, symbols, and gestures.
Detection establishes presence only; it does not establish endorsement,
propaganda, ideology, membership, or user intent.

| Normalized Unicon signal | Provider path              | Policy class      | Standalone action | Role                                 | Auto-REJECT                               |
| ------------------------ | -------------------------- | ----------------- | ----------------- | ------------------------------------ | ----------------------------------------- |
| `NAZI_IMAGERY`           | `offensive.nazi`           | `CONTEXTUAL`      | `REVIEW`          | Nazi imagery/symbol evidence         | Contextual rules only; disabled initially |
| `ASIAN_SWASTIKA`         | `offensive.asian_swastika` | `SAFE_BY_DEFAULT` | None              | Cultural/religious swastika context  | No                                        |
| `SUPREMACIST_IMAGERY`    | `offensive.supremacist`    | `CONTEXTUAL`      | `REVIEW`          | Supremacist-symbol evidence          | Contextual rules only; disabled initially |
| `CONFEDERATE_IMAGERY`    | `offensive.confederate`    | `CONTEXTUAL`      | `REVIEW`          | Confederate-symbol evidence          | No initially                              |
| `TERRORIST_SYMBOL`       | `offensive.terrorist`      | `CONTEXTUAL`      | `REVIEW`          | Recognized terrorist-symbol evidence | Contextual rules only; disabled initially |
| `MIDDLE_FINGER`          | `offensive.middle_finger`  | `SAFE_BY_DEFAULT` | None              | Offensive gesture                    | No                                        |

Historical, religious, museum, documentary, journalistic, educational,
artistic, satirical, costume, and condemnatory contexts create material
ambiguity. Therefore, every detected hate/extremist symbol requires review at
the applicable threshold instead of being treated as automatic evidence of
promotion.

`ASIAN_SWASTIKA` is mitigating context only for ambiguity around the swastika.
It cannot override other Nazi or supremacist evidence, and conflicting strong
signals resolve to review rather than automatic approval. Several provider
classes also include historically meaningful symbols later appropriated by
extremist movements, so no contextual automatic-reject rule starts enabled.

`TERRORIST_SYMBOL` deliberately names symbol evidence rather than classifying
a person or organization. Its provider coverage is not assumed to encompass
all extremist organizations. `MIDDLE_FINGER` is allowed by default for the v1
Profile Photo policy and cannot independently trigger moderation action.

### Deferred: propaganda and ideological promotion

Propaganda and ideological promotion are not part of the
`profile-photo-v1` policy family. The current taxonomy detects specified
imagery and symbols only; it does not infer endorsement, glorification,
recruitment, promotion, ideology, or user intent.

A future policy family and its immutable revisions may define:

- what constitutes propaganda;
- what constitutes endorsement or glorification;
- recruitment and promotional content;
- applicable organizations, movements, and ideologies;
- contextual exceptions, including historical, journalistic, educational,
  artistic, documentary, satirical, and condemnatory uses;
- detection and evidence mechanisms beyond symbol presence;
- human-review routing and decision rules;
- eligibility and calibration requirements for automated enforcement.

Introducing that policy requires an explicit product and policy decision. It
must not be enabled implicitly by changing thresholds for the existing
`NAZI_IMAGERY`, `SUPREMACIST_IMAGERY`, `CONFEDERATE_IMAGERY`, or
`TERRORIST_SYMBOL` signals.

## Accepted recreational-drug and medical signal taxonomy

Cannabis imagery, products, plants, paraphernalia, and visible consumption are
permitted by default for `profile-photo-v1`. Non-cannabis recreational drug
use requires human review. The `medical` model supplies contextual evidence
needed to avoid treating ordinary pills or medical equipment as recreational
drug use.

| Normalized Unicon signal         | Provider path                                               | Policy class         | Standalone action           | Role                                                      | Auto-REJECT                               |
| -------------------------------- | ----------------------------------------------------------- | -------------------- | --------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| `RECREATIONAL_DRUG_OVERALL`      | `recreational_drug.prob`                                    | `AGGREGATE_EVIDENCE` | High unexplained → `REVIEW` | Provider aggregate / safeguard                            | No                                        |
| `CANNABIS`                       | `recreational_drug.classes.cannabis`                        | `AGGREGATE_EVIDENCE` | None                        | Any cannabis reference                                    | No                                        |
| `CANNABIS_LOGO_ONLY`             | `recreational_drug.classes.cannabis_logo_only`              | `SAFE_BY_DEFAULT`    | None                        | Cannabis symbol/logo                                      | No                                        |
| `CANNABIS_PLANT`                 | `recreational_drug.classes.cannabis_plant`                  | `SAFE_BY_DEFAULT`    | None                        | Cannabis plant                                            | No                                        |
| `CANNABIS_DRUG`                  | `recreational_drug.classes.cannabis_drug`                   | `SAFE_BY_DEFAULT`    | None                        | Cannabis products, consumption, or paraphernalia evidence | No                                        |
| `RECREATIONAL_DRUG_NOT_CANNABIS` | `recreational_drug.classes.recreational_drugs_not_cannabis` | `CONTEXTUAL`         | `REVIEW`                    | Non-cannabis recreational drug-use evidence               | Contextual rules only; disabled initially |
| `MEDICAL_PILLS`                  | `medical.classes.pills`                                     | `SAFE_BY_DEFAULT`    | None                        | Medical-drug context                                      | No                                        |
| `MEDICAL_PARAPHERNALIA`          | `medical.classes.paraphernalia`                             | `SAFE_BY_DEFAULT`    | None                        | Medical equipment/context                                 | No                                        |

The adapter contract follows the provider's actual plural JSON field
`recreational_drugs_not_cannabis`, even where descriptive provider material
uses a singular concept name. Contract fixtures must detect a provider schema
change rather than silently treating the signal as absent.

`RECREATIONAL_DRUG_OVERALL` is normally supporting evidence. A high aggregate
that is not explained by usable subclass evidence resolves to review; this
covers ambiguous recreational pills and other detected usage outside the
narrow non-cannabis subclass.

Medical evidence may explain ambiguous pills, syringes, or equipment, but it
cannot independently override explicit recreational-use evidence. Conflicting
strong medical and recreational signals resolve to review. Cannabis and
medical safe-by-default signals likewise cannot override stronger evidence
from another policy category.

The primary request includes both `recreational_drug` and `medical`. The
pinned PolicyRevision declares their required normalized coverage, while the
moderation configuration records both provider models and their request and
adapter versions. A missing or unusable required medical response is partial
provider coverage and follows the fail-closed provider-failure flow.

## Accepted cross-family rule taxonomy

Cross-family policy uses separate dimensions rather than overloading one
relationship label:

- `Relationship` is `MEANINGFUL`, `CONTEXTUAL`, `INDEPENDENT`, or `DEFERRED`;
- `Evidence interaction` describes corroboration, conflict, co-occurrence, or
  the absence of an interaction;
- `Outcome floor` records the minimum result after applicable thresholds;
- `Auto-REJECT` records only eligibility for a named calibrated Unicon rule.

Co-occurrence does not establish causality, intent, actor identity, or spatial
association. Provider image-level scores do not prove that signals refer to
the same person, object, or action. Cross-family scores are never mechanically
added, two review signals do not automatically become rejection, and all
cross-family automatic-reject authorities start disabled.

### Violence × Weapon

| Combination                              | Relationship  | Evidence interaction                       | Outcome floor    | Auto-REJECT         |
| ---------------------------------------- | ------------- | ------------------------------------------ | ---------------- | ------------------- |
| `FIREARM_THREAT + AIMING_THREAT`         | `MEANINGFUL`  | Strong corroboration                       | `REVIEW`         | Candidate; disabled |
| `FIREARM_THREAT + FIREARM`               | `MEANINGFUL`  | Corroboration                              | `REVIEW`         | Candidate; disabled |
| `FIREARM_THREAT + AIMING_CAMERA`         | `MEANINGFUL`  | Corroboration                              | `REVIEW`         | Candidate; disabled |
| `PHYSICAL_VIOLENCE + AIMING_THREAT`      | `MEANINGFUL`  | Corroboration with association uncertainty | `REVIEW`         | Candidate; disabled |
| `PHYSICAL_VIOLENCE + AIMING_CAMERA`      | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`         | No initially        |
| `PHYSICAL_VIOLENCE + FIREARM`            | `CONTEXTUAL`  | Co-occurrence                              | Existing verdict | No                  |
| `PHYSICAL_VIOLENCE + KNIFE`              | `CONTEXTUAL`  | Co-occurrence                              | Existing verdict | No                  |
| `COMBAT_SPORT + weapon presence`         | `INDEPENDENT` | None                                       | Existing verdict | No                  |
| `COMBAT_SPORT + threat action`           | `INDEPENDENT` | Threat remains independently actionable    | Threat verdict   | Threat rule only    |
| `FIREARM_THREAT + FIREARM_TOY`           | `CONTEXTUAL`  | Conflicting evidence                       | `REVIEW`         | No                  |
| Violence + `FIREARM_ANIMATED`            | `CONTEXTUAL`  | Depiction context; no safe override        | Existing verdict | No initially        |
| Violence + non-threatening weapon action | `CONTEXTUAL`  | Non-exculpatory context; no safe override  | Existing verdict | No                  |

The first four candidates may receive automatic-reject authority only through
separate named rules after calibration. In particular, apparent corroboration
must not be described as proof that violence and the weapon belong to the same
actor or event. `FIREARM_TOY`, `FIREARM_ANIMATED`, `COMBAT_SPORT`, and
non-threatening action evidence may affect interpretation but cannot silently
cancel an independently actionable threat.

### Violence × Gore

| Combination                              | Relationship  | Evidence interaction                       | Outcome floor                            | Additional effect                                                  | Auto-REJECT                                 |
| ---------------------------------------- | ------------- | ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `PHYSICAL_VIOLENCE + VERY_BLOODY`        | `MEANINGFUL`  | Corroboration with association uncertainty | `REVIEW`                                 | Strong violent and severe-blood evidence                           | Candidate; disabled; same-public-input only |
| `PHYSICAL_VIOLENCE + SERIOUS_INJURY`     | `MEANINGFUL`  | Corroboration with association uncertainty | `REVIEW`                                 | Strong violent and severe-injury evidence                          | Candidate; disabled; same-public-input only |
| `PHYSICAL_VIOLENCE + BODY_ORGAN`         | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Graphic evidence with weak causal association                      | No initially                                |
| `PHYSICAL_VIOLENCE + CORPSE`             | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Violence and death evidence; causality unknown                     | No initially                                |
| `PHYSICAL_VIOLENCE + SLIGHTLY_BLOODY`    | `CONTEXTUAL`  | Corroboration with association uncertainty | `REVIEW`                                 | Mild blood supports violent-scene interpretation                   | No                                          |
| `PHYSICAL_VIOLENCE + SUPERFICIAL_INJURY` | `CONTEXTUAL`  | Corroboration with association uncertainty | `REVIEW`                                 | Minor injury supports context without escalation                   | No                                          |
| `PHYSICAL_VIOLENCE + UNCONSCIOUS`        | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Possible harm consequence; association unknown                     | No                                          |
| `PHYSICAL_VIOLENCE + BODY_WASTE`         | `INDEPENDENT` | Co-occurrence                              | Existing verdict                         | Separate disgusting-content concern                                | No                                          |
| `PHYSICAL_VIOLENCE + SKULL`              | `INDEPENDENT` | Co-occurrence                              | Existing verdict                         | No useful violence relationship                                    | No                                          |
| `PHYSICAL_VIOLENCE + OTHER_GORE`         | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Broad gore evidence is insufficiently specific                     | No                                          |
| `COMBAT_SPORT + SLIGHTLY_BLOODY`         | `CONTEXTUAL`  | Mitigating context                         | Existing verdict; no cross-family action | Compatible with expected sport injury; does not prove harmlessness | No                                          |
| `COMBAT_SPORT + SUPERFICIAL_INJURY`      | `CONTEXTUAL`  | Mitigating context                         | Existing verdict; no cross-family action | Compatible with expected sport injury; does not prove harmlessness | No                                          |
| `COMBAT_SPORT + VERY_BLOODY`             | `CONTEXTUAL`  | Conflicting evidence                       | `REVIEW`                                 | Sport context does not excuse severe graphic imagery               | No                                          |
| `COMBAT_SPORT + SERIOUS_INJURY`          | `CONTEXTUAL`  | Conflicting evidence                       | `REVIEW`                                 | Legitimate sport may still depict severe injury                    | No                                          |
| Violence + `GORE_REAL`                   | `CONTEXTUAL`  | Depiction context                          | Existing verdict                         | Real-appearing depiction; does not prove real-world harm           | No                                          |
| Violence + `GORE_FAKE`                   | `CONTEXTUAL`  | Depiction context                          | Existing verdict                         | Staged/fake context; not a safe override                           | No                                          |
| Violence + `GORE_ANIMATED`               | `CONTEXTUAL`  | Depiction context                          | Existing verdict                         | Illustrated context; not a safe override                           | No                                          |

The first two combinations are the only initial automatic-reject candidates.
Eligibility requires both component signals to meet their thresholds within
the same public `SOCIAL` or `EXPANDED` ModerationPackage input. Evidence split
across inputs, or involving the private master only, may support `REVIEW` but
cannot activate these automatic-reject rules.

Same-input evidence still does not prove that violence caused the blood or
injury, or that both signals refer to the same actor or event. Calibration must
validate that remaining association uncertainty against the relevant dataset.
`GORE_REAL` means real-appearing provider evidence and does not prove
real-world harm. Combat-sport evidence may explain mild or superficial injury
but never grants a final safe verdict or neutralizes severe graphic content.

### Violence × Self-Harm

| Combination                              | Relationship  | Evidence interaction                  | Outcome floor                                       | Additional effect                                                             | Auto-REJECT |
| ---------------------------------------- | ------------- | ------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ----------- |
| `PHYSICAL_VIOLENCE + SELF_HARM_REAL`     | `CONTEXTUAL`  | Co-occurrence with actor ambiguity    | `REVIEW`                                            | Interpersonal and self-directed harm may coexist; no actor binding            | No          |
| `PHYSICAL_VIOLENCE + SELF_HARM_FAKE`     | `CONTEXTUAL`  | Co-occurrence / depiction context     | `REVIEW`                                            | Fake context does not explain away violence; no escalation                    | No          |
| `PHYSICAL_VIOLENCE + SELF_HARM_ANIMATED` | `CONTEXTUAL`  | Co-occurrence / depiction context     | `REVIEW`                                            | Animated context does not explain away violence; no escalation                | No          |
| `FIREARM_THREAT + SELF_HARM_REAL`        | `MEANINGFUL`  | Directionally ambiguous corroboration | `REVIEW`                                            | Self-directed, other-directed, or multi-actor interpretation remains possible | No          |
| `FIREARM_THREAT + SELF_HARM_FAKE`        | `CONTEXTUAL`  | Conflicting or multi-object evidence  | `REVIEW`                                            | Fake evidence cannot negate an independent firearm threat                     | No          |
| `FIREARM_THREAT + SELF_HARM_ANIMATED`    | `CONTEXTUAL`  | Co-occurrence / depiction context     | `REVIEW`                                            | Depiction type only; no escalation                                            | No          |
| `COMBAT_SPORT + SELF_HARM_REAL`          | `INDEPENDENT` | None                                  | `REVIEW`                                            | Sport does not mitigate self-harm evidence                                    | No          |
| `COMBAT_SPORT + SELF_HARM_FAKE`          | `INDEPENDENT` | None                                  | `REVIEW`                                            | Self-harm is evaluated independently                                          | No          |
| `COMBAT_SPORT + SELF_HARM_ANIMATED`      | `INDEPENDENT` | None                                  | `REVIEW`                                            | Self-harm is evaluated independently                                          | No          |
| Violence + `SELF_HARM_OVERALL`           | `CONTEXTUAL`  | Supporting evidence                   | `REVIEW` only when the self-harm safeguard triggers | Cannot establish subtype, direction, intent, or actor relationship            | No          |

Violence evidence may corroborate that a harmful scene exists, but cannot
determine whether harm is self-directed, other-directed, accidental, or
associated with the same actor. In particular, `FIREARM_THREAT` establishes a
firearm aimed at a human or camera but does not bind the direction of harm to
the person identified by self-harm evidence.

Fake or animated self-harm describes depiction type and never cancels an
independently actionable violence signal. Combat-sport context likewise does
not mitigate self-harm evidence. No Violence × Self-Harm rule is eligible for
automatic rejection in v1.

### Weapon × Gore

| Combination                                                    | Relationship  | Evidence interaction                       | Outcome floor                            | Additional effect                                                              | Auto-REJECT                                             |
| -------------------------------------------------------------- | ------------- | ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `FIREARM + VERY_BLOODY`                                        | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Firearm and severe blood coexist; no causal/object binding                     | No initially                                            |
| `FIREARM + SERIOUS_INJURY`                                     | `MEANINGFUL`  | Corroboration with association uncertainty | `REVIEW`                                 | Serious injury may be compatible with firearm harm, but association is unknown | Exploratory candidate; disabled; same-public-input only |
| `KNIFE + VERY_BLOODY`                                          | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Knife and severe blood coexist; no causal binding                              | No initially                                            |
| `KNIFE + SERIOUS_INJURY`                                       | `MEANINGFUL`  | Corroboration with association uncertainty | `REVIEW`                                 | Serious injury includes stab wounds, but the detected knife need not be causal | Exploratory candidate; disabled; same-public-input only |
| `AIMING_THREAT + VERY_BLOODY`                                  | `MEANINGFUL`  | Corroboration with association uncertainty | `REVIEW`                                 | Threatening firearm presentation and severe blood evidence                     | Candidate; disabled; same-public-input only             |
| `AIMING_THREAT + SERIOUS_INJURY`                               | `MEANINGFUL`  | Corroboration with association uncertainty | `REVIEW`                                 | Threatening firearm presentation and major injury evidence                     | Candidate; disabled; same-public-input only             |
| `AIMING_CAMERA + VERY_BLOODY`                                  | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Viewer-directed firearm and severe blood; no victim association                | No initially                                            |
| `AIMING_CAMERA + SERIOUS_INJURY`                               | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Viewer-directed firearm and severe injury; no victim association               | No initially                                            |
| `FIREARM + SLIGHTLY_BLOODY` or `KNIFE + SLIGHTLY_BLOODY`       | `CONTEXTUAL`  | Co-occurrence                              | Existing verdict; no cross-family action | Mild blood adds little semantic certainty                                      | No                                                      |
| `FIREARM + SUPERFICIAL_INJURY` or `KNIFE + SUPERFICIAL_INJURY` | `CONTEXTUAL`  | Co-occurrence                              | Existing verdict; no cross-family action | Minor injury adds little semantic certainty                                    | No                                                      |
| `FIREARM + BODY_ORGAN` or `KNIFE + BODY_ORGAN`                 | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Severe, medical, or anatomical context is possible; no causal binding          | No                                                      |
| `FIREARM + CORPSE` or `KNIFE + CORPSE`                         | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Weapon and death evidence coexist; cause of death is unknown                   | No                                                      |
| `FIREARM + UNCONSCIOUS` or `KNIFE + UNCONSCIOUS`               | `CONTEXTUAL`  | Co-occurrence                              | Existing verdict                         | No evidence the weapon caused unconsciousness                                  | No                                                      |
| `FIREARM + SKULL` or `KNIFE + SKULL`                           | `INDEPENDENT` | None                                       | Existing verdict                         | No useful semantic relationship                                                | No                                                      |
| `FIREARM + BODY_WASTE` or `KNIFE + BODY_WASTE`                 | `INDEPENDENT` | None                                       | Existing verdict                         | Separate semantic concerns                                                     | No                                                      |
| `FIREARM_TOY + severe Gore`                                    | `CONTEXTUAL`  | Conflicting or multi-object evidence       | `REVIEW`                                 | Toy evidence may explain weapon appearance but cannot explain away Gore        | No                                                      |
| `FIREARM_ANIMATED + Gore`                                      | `CONTEXTUAL`  | Depiction context                          | Existing verdict                         | Animated applies to the firearm only, not Gore                                 | No                                                      |
| non-threatening firearm action + severe Gore                   | `CONTEXTUAL`  | Co-occurrence                              | `REVIEW`                                 | Weapon action does not explain severe Gore                                     | No                                                      |

The two `AIMING_THREAT` combinations are the initial strong candidates for
calibrated automatic-reject rules. `FIREARM + SERIOUS_INJURY` and
`KNIFE + SERIOUS_INJURY` are exploratory candidates only: they are eligible
for evaluation but are not expected to receive authority without evidence
that they independently meet the required precision.

Every candidate starts disabled and requires both component signals to meet
their thresholds in the same public `SOCIAL` or `EXPANDED` input. Master-only
or split-input evidence may support review but is not eligible for automatic
rejection. Weapon presence plus a compatible injury class never establishes
that the detected weapon caused the injury or belongs to the same actor or
event.

A depiction-type signal belonging to Weapon changes only interpretation of
the weapon. `FIREARM_ANIMATED` cannot establish that Gore is illustrated, and
`FIREARM_TOY` cannot neutralize independent severe graphic evidence. Gore
depiction type must be established by its own normalized signals.

### Weapon × Self-Harm

| Combination                                                        | Relationship | Evidence interaction                  | Outcome floor                                       | Additional effect                                                                                   | Auto-REJECT |
| ------------------------------------------------------------------ | ------------ | ------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------- |
| `FIREARM + SELF_HARM_REAL`                                         | `MEANINGFUL` | Corroboration with actor ambiguity    | `REVIEW`                                            | Firearm presence supports possible firearm-related self-harm, but there is no actor/object binding  | No          |
| `KNIFE + SELF_HARM_REAL`                                           | `MEANINGFUL` | Corroboration with object ambiguity   | `REVIEW`                                            | Knife presence supports possible cutting/self-harm context, but there is no object-to-actor binding | No          |
| `AIMING_THREAT + SELF_HARM_REAL`                                   | `MEANINGFUL` | Directionally ambiguous corroboration | `REVIEW`                                            | A firearm method is plausible, but self/other direction and actor remain unresolved                 | No          |
| `AIMING_CAMERA + SELF_HARM_REAL`                                   | `CONTEXTUAL` | Co-occurrence                         | `REVIEW`                                            | Viewer-directed firearm evidence does not corroborate self-directed harm                            | No          |
| `AIMING_SAFE + SELF_HARM_REAL`                                     | `CONTEXTUAL` | Conflicting or multi-object evidence  | `REVIEW`                                            | Apparently safe firearm action cannot negate independent self-harm evidence                         | No          |
| `IN_HAND_NOT_AIMING + SELF_HARM_REAL`                              | `CONTEXTUAL` | Conflicting or multi-object evidence  | `REVIEW`                                            | Non-aiming firearm context does not negate self-harm evidence                                       | No          |
| `WORN_NOT_IN_HAND + SELF_HARM_REAL` or `NOT_WORN + SELF_HARM_REAL` | `CONTEXTUAL` | Co-occurrence                         | `REVIEW`                                            | Weak or no useful association with self-harm                                                        | No          |
| `FIREARM_TOY + SELF_HARM_FAKE`                                     | `MEANINGFUL` | Strong semantic corroboration         | `REVIEW`                                            | Separate provider-model outputs support toy/faked firearm self-harm semantics                       | No          |
| `FIREARM_GESTURE + SELF_HARM_FAKE`                                 | `MEANINGFUL` | Strong semantic corroboration         | `REVIEW`                                            | Separate provider-model outputs support mimicked firearm self-harm semantics                        | No          |
| `FIREARM + SELF_HARM_FAKE`                                         | `CONTEXTUAL` | Conflicting or multi-object evidence  | `REVIEW`                                            | Apparent firearm evidence and fake self-harm evidence may refer to different objects                | No          |
| `FIREARM_ANIMATED + SELF_HARM_ANIMATED`                            | `MEANINGFUL` | Corroboration                         | `REVIEW`                                            | Both support illustrated firearm/self-harm context; association remains unresolved                  | No          |
| `KNIFE + SELF_HARM_ANIMATED`                                       | `MEANINGFUL` | Corroboration with object ambiguity   | `REVIEW`                                            | Illustrated self-harm may involve a knife/blade, but association is not established                 | No          |
| Weapon + `SELF_HARM_OVERALL`                                       | `CONTEXTUAL` | Supporting evidence                   | `REVIEW` only when the self-harm safeguard triggers | Aggregate evidence cannot establish method, actor, direction, or object relationship                | No          |

Weapon evidence may support a possible self-harm method, but cannot bind a
weapon, gesture, direction, or actor to the self-harm signal. Separate
Sightengine model outputs are semantically corroborating evidence, not
statistically independent observations.

Corroboration labels apply when the relevant signals meet their thresholds in
the same ModerationPackage input. Signals found only in different inputs are
co-occurrence with input ambiguity rather than corroboration. This distinction
does not lower the result below `REVIEW`, because an actionable self-harm
signal retains its family disposition. Safe, non-aiming, toy, fake, or animated
weapon context never cancels independently actionable self-harm evidence.

No Weapon × Self-Harm rule is eligible for automatic rejection in v1.

### Gore × Self-Harm

| Combination                           | Relationship  | Evidence interaction                 | Outcome floor                                       | Additional effect                                                                                                                           | Auto-REJECT |
| ------------------------------------- | ------------- | ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `VERY_BLOODY + SELF_HARM_REAL`        | `MEANINGFUL`  | Corroboration with actor ambiguity   | `REVIEW`                                            | Severe blood is compatible with real self-harm, but actor and causality remain unresolved                                                   | No          |
| `SERIOUS_INJURY + SELF_HARM_REAL`     | `MEANINGFUL`  | Strong semantic corroboration        | `REVIEW`                                            | Major injury strongly supports a possible physical consequence of real self-harm; association remains unresolved                            | No          |
| `SLIGHTLY_BLOODY + SELF_HARM_REAL`    | `MEANINGFUL`  | Corroboration                        | `REVIEW`                                            | Mild blood is compatible with some cutting/self-harm presentations, but does not distinguish current injury from unrelated or past evidence | No          |
| `SUPERFICIAL_INJURY + SELF_HARM_REAL` | `MEANINGFUL`  | Corroboration                        | `REVIEW`                                            | Minor injury can support self-harm context but does not establish active self-harm                                                          | No          |
| `BODY_ORGAN + SELF_HARM_REAL`         | `CONTEXTUAL`  | Co-occurrence                        | `REVIEW`                                            | Organ evidence may arise from surgery or education; there is no useful self-harm binding                                                    | No          |
| `CORPSE + SELF_HARM_REAL`             | `CONTEXTUAL`  | Co-occurrence with actor ambiguity   | `REVIEW`                                            | Death and self-harm evidence coexist; suicide or death causality cannot be inferred                                                         | No          |
| `UNCONSCIOUS + SELF_HARM_REAL`        | `CONTEXTUAL`  | Co-occurrence with actor ambiguity   | `REVIEW`                                            | A suicide attempt or self-harm consequence cannot be inferred                                                                               | No          |
| `SKULL + SELF_HARM_REAL`              | `INDEPENDENT` | None                                 | `REVIEW`                                            | Skull evidence adds no reliable self-harm semantics                                                                                         | No          |
| `BODY_WASTE + SELF_HARM_REAL`         | `INDEPENDENT` | None                                 | `REVIEW`                                            | No reliable semantic relationship                                                                                                           | No          |
| `OTHER_GORE + SELF_HARM_REAL`         | `CONTEXTUAL`  | Co-occurrence                        | `REVIEW`                                            | The broad class is insufficient for a stronger interaction                                                                                  | No          |
| `GORE_REAL + SELF_HARM_REAL`          | `CONTEXTUAL`  | Depiction context                    | `REVIEW`                                            | Compatible real-appearing representation; does not prove a real-world event                                                                 | No          |
| `GORE_FAKE + SELF_HARM_FAKE`          | `MEANINGFUL`  | Semantic corroboration               | `REVIEW`                                            | Compatible fake gore/self-harm representation                                                                                               | No          |
| `GORE_ANIMATED + SELF_HARM_ANIMATED`  | `MEANINGFUL`  | Semantic corroboration               | `REVIEW`                                            | Compatible illustrated self-harm/gore representation                                                                                        | No          |
| `GORE_FAKE + SELF_HARM_REAL`          | `CONTEXTUAL`  | Conflicting or multi-object evidence | `REVIEW`                                            | Fake Gore cannot negate independently detected real Self-Harm                                                                               | No          |
| `GORE_REAL + SELF_HARM_FAKE`          | `CONTEXTUAL`  | Conflicting or multi-object evidence | `REVIEW`                                            | Real-appearing Gore cannot automatically reclassify fake Self-Harm                                                                          | No          |
| Gore + `SELF_HARM_OVERALL`            | `CONTEXTUAL`  | Supporting evidence                  | `REVIEW` only when the self-harm safeguard triggers | Aggregate evidence cannot establish subtype, actor, or injury association                                                                   | No          |

Gore evidence may support the presence or severity of physical consequences,
but cannot establish that they were self-inflicted, intentional, current,
real-world, or associated with the same person as the self-harm signal. Strong
semantic corroboration does not imply statistical independence, causality,
actor binding, or confirmation of a real-world event.

Corroboration labels require the relevant signals to meet their thresholds in
the same ModerationPackage input. Signals found only in different inputs are
co-occurrence with input ambiguity. This distinction does not lower the result
below `REVIEW`, because independently actionable self-harm evidence retains
its family disposition. Matching or conflicting real/fake/animated types
affect interpretation only and never establish what occurred in reality.

No Gore × Self-Harm rule is eligible for automatic rejection in v1.

### Nudity × Violence

| Combination                                                                     | Relationship  | Evidence interaction                                           | Outcome floor              | Additional effect                                                                                    | Auto-REJECT                                             |
| ------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SEXUAL_ACTIVITY + PHYSICAL_VIOLENCE`                                           | `MEANINGFUL`  | High-risk co-occurrence with association and consent ambiguity | `REVIEW`                   | Sexual and violent activity coexist; their relationship and consent remain unresolved                | Candidate; disabled; same-public-input only             |
| `SEXUAL_ACTIVITY + FIREARM_THREAT`                                              | `MEANINGFUL`  | Co-occurrence with association ambiguity                       | `REVIEW`                   | Sexual activity and firearm threat coexist; there is no actor or sexual-threat binding               | No initially                                            |
| `SEXUAL_ACTIVITY + COMBAT_SPORT`                                                | `INDEPENDENT` | None                                                           | Existing Nudity verdict    | Sport does not strengthen sexual semantics                                                           | No cross-family authority; Nudity family rule may apply |
| `SEXUAL_DISPLAY + PHYSICAL_VIOLENCE`                                            | `MEANINGFUL`  | High-risk co-occurrence with association ambiguity             | `REVIEW`                   | Explicit display and physical violence coexist; sexual violence cannot be inferred                   | Exploratory candidate; disabled; same-public-input only |
| `SEXUAL_DISPLAY + FIREARM_THREAT`                                               | `CONTEXTUAL`  | Co-occurrence                                                  | `REVIEW`                   | Explicit display and firearm threat coexist without actor binding                                    | No                                                      |
| `SEXUAL_DISPLAY + COMBAT_SPORT`                                                 | `INDEPENDENT` | None                                                           | Existing Nudity verdict    | Independent family evaluation                                                                        | No cross-family authority; Nudity family rule may apply |
| `EROTICA + PHYSICAL_VIOLENCE`                                                   | `CONTEXTUAL`  | Co-occurrence with association ambiguity                       | `REVIEW`                   | Nudity and violence coexist, but sexual-harm semantics cannot be inferred                            | No                                                      |
| `EROTICA + FIREARM_THREAT`                                                      | `CONTEXTUAL`  | Co-occurrence                                                  | `REVIEW`                   | Separate independently actionable evidence                                                           | No                                                      |
| `VERY_SUGGESTIVE + PHYSICAL_VIOLENCE`                                           | `CONTEXTUAL`  | Co-occurrence                                                  | `REVIEW`                   | Suggestiveness does not sexualize detected violence                                                  | No                                                      |
| `VERY_SUGGESTIVE + FIREARM_THREAT`                                              | `CONTEXTUAL`  | Co-occurrence                                                  | `REVIEW`                   | No sexual-threat relationship can be inferred                                                        | No                                                      |
| `VISIBLY_UNDRESSED + PHYSICAL_VIOLENCE`                                         | `MEANINGFUL`  | Co-occurrence with association ambiguity                       | `REVIEW`                   | An undressed person and violence create sensitive context; coercion and victimhood remain unresolved | No                                                      |
| `VISIBLY_UNDRESSED + FIREARM_THREAT`                                            | `CONTEXTUAL`  | Co-occurrence                                                  | `REVIEW`                   | Sensitive combination without actor or threat binding                                                | No                                                      |
| `SUGGESTIVE_POSE + PHYSICAL_VIOLENCE` or `SUGGESTIVE_FOCUS + PHYSICAL_VIOLENCE` | `CONTEXTUAL`  | Co-occurrence                                                  | `REVIEW`                   | Sexualized presentation cannot establish sexualized violence                                         | No                                                      |
| Lingerie/underwear + `PHYSICAL_VIOLENCE`                                        | `INDEPENDENT` | None                                                           | Violence verdict           | No sexual escalation and no violence mitigation                                                      | No cross-family authority                               |
| Bikini/swimwear + `PHYSICAL_VIOLENCE`                                           | `INDEPENDENT` | None                                                           | Violence verdict           | No sexual escalation and no violence mitigation                                                      | No cross-family authority                               |
| `SCHEMATIC` + Violence                                                          | `INDEPENDENT` | None                                                           | Existing verdict           | No reliable cross-family relationship                                                                | No                                                      |
| Nudity + `VIOLENCE_OVERALL`                                                     | `CONTEXTUAL`  | Supporting aggregate evidence                                  | Existing family safeguards | Aggregate evidence cannot establish a violence subtype or sexual relationship                        | No                                                      |

Nudity and violence signals cannot establish consent, coercion, assault,
victimhood, perpetrator identity, sexual motivation, or an actor-level
relationship. Even same-input evidence establishes only high-risk
co-occurrence. Safe-by-default clothing, swimwear, pose, or context evidence
neither strengthens sexual semantics nor mitigates independently actionable
violence.

`SEXUAL_ACTIVITY + PHYSICAL_VIOLENCE` is the initial strong evaluation
candidate. `SEXUAL_DISPLAY + PHYSICAL_VIOLENCE` is exploratory because explicit
display and violence may coexist without a sexual-violence relationship. Both
start disabled, require separate calibration, and require both component
signals to meet their thresholds in the same public `SOCIAL` or `EXPANDED`
input. Master-only or split-input findings may support review but cannot
activate either automatic-reject rule.

If other available evidence independently surfaces potential-minor sexual or
exploitative context, the result follows restricted human-review routing. This
matrix does not infer age, and absence of a minor-related signal remains no
evidence that a child is absent.

### Nudity × Gore

| Combination                                                               | Relationship  | Evidence interaction                                   | Outcome floor               | Additional effect                                                                                            | Auto-REJECT                                             |
| ------------------------------------------------------------------------- | ------------- | ------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `SEXUAL_ACTIVITY + VERY_BLOODY`                                           | `MEANINGFUL`  | High-risk co-occurrence with association ambiguity     | `REVIEW`                    | Sexual activity and severe blood coexist; no injury, actor, or causal binding                                | Candidate; disabled; same-public-input only             |
| `SEXUAL_ACTIVITY + SERIOUS_INJURY`                                        | `MEANINGFUL`  | High-risk co-occurrence with association ambiguity     | `REVIEW`                    | Sexual activity and major injury coexist; sexual harm cannot be inferred                                     | Candidate; disabled; same-public-input only             |
| `SEXUAL_ACTIVITY + BODY_ORGAN`                                            | `CONTEXTUAL`  | Co-occurrence with association ambiguity               | `REVIEW`                    | Graphic anatomical evidence; surgery or medical context remains possible                                     | No                                                      |
| `SEXUAL_ACTIVITY + CORPSE`                                                | `MEANINGFUL`  | High-risk co-occurrence with actor ambiguity           | `REVIEW`                    | Extremely sensitive interpretation risk; no relationship or necrophilic activity can be inferred             | No                                                      |
| `SEXUAL_ACTIVITY + UNCONSCIOUS`                                           | `MEANINGFUL`  | High-risk co-occurrence with actor and state ambiguity | `REVIEW`                    | Potential incapacity/consent concern; incapacity during sexual activity and consent state remain unresolved  | No                                                      |
| `SEXUAL_DISPLAY + VERY_BLOODY`                                            | `MEANINGFUL`  | High-risk co-occurrence with association ambiguity     | `REVIEW`                    | Explicit display and severe blood coexist without injury or actor binding                                    | Exploratory candidate; disabled; same-public-input only |
| `SEXUAL_DISPLAY + SERIOUS_INJURY`                                         | `MEANINGFUL`  | High-risk co-occurrence with association ambiguity     | `REVIEW`                    | Explicit display and serious injury coexist without sexual-harm inference                                    | Exploratory candidate; disabled; same-public-input only |
| `EROTICA + VERY_BLOODY` or `EROTICA + SERIOUS_INJURY`                     | `CONTEXTUAL`  | Co-occurrence with association ambiguity               | `REVIEW`                    | Nude/erotic imagery and severe Gore coexist without a causal relationship                                    | No                                                      |
| `VISIBLY_UNDRESSED + VERY_BLOODY` or `VISIBLY_UNDRESSED + SERIOUS_INJURY` | `MEANINGFUL`  | High-risk co-occurrence with association ambiguity     | `REVIEW`                    | Undressed-person context plus severe Gore is especially sensitive, but person association remains unresolved | No                                                      |
| `VERY_SUGGESTIVE + severe Gore`                                           | `CONTEXTUAL`  | Co-occurrence                                          | `REVIEW`                    | Suggestiveness does not sexualize Gore                                                                       | No                                                      |
| Lingerie/underwear/bikini/swimwear + Gore                                 | `INDEPENDENT` | None                                                   | Gore verdict                | No sexual escalation and no Gore mitigation                                                                  | No cross-family authority                               |
| Nudity + `SLIGHTLY_BLOODY`                                                | `CONTEXTUAL`  | Co-occurrence                                          | Existing family disposition | Mild blood does not meaningfully connect to sexual/nudity semantics                                          | No                                                      |
| Nudity + `SUPERFICIAL_INJURY`                                             | `CONTEXTUAL`  | Co-occurrence                                          | Existing family disposition | Minor injury does not establish sexual harm                                                                  | No                                                      |
| Nudity + `BODY_WASTE`                                                     | `INDEPENDENT` | None                                                   | Existing family disposition | No reliable sexual relationship can be inferred                                                              | No                                                      |
| Nudity + `GORE_REAL`                                                      | `CONTEXTUAL`  | Depiction context                                      | Existing family disposition | Real-appearing applies only to Gore and does not prove a real-world event                                    | No                                                      |
| Nudity + `GORE_FAKE`                                                      | `CONTEXTUAL`  | Depiction context                                      | Existing family disposition | Staged/fake applies only to Gore                                                                             | No                                                      |
| Nudity + `GORE_ANIMATED`                                                  | `CONTEXTUAL`  | Depiction context                                      | Existing family disposition | Illustrated applies only to Gore                                                                             | No                                                      |

Nudity and Gore evidence cannot establish sexual harm, consent, incapacity,
victimhood, injury causality, necrophilic activity, or actor identity. Even
same-input evidence establishes only high-risk co-occurrence. Gore depiction
type applies only to Gore and cannot classify Nudity evidence as real, staged,
or animated. `GORE_REAL` remains real-appearing evidence rather than proof of a
real-world event.

The two `SEXUAL_ACTIVITY` combinations are the initial strong evaluation
candidates. The two `SEXUAL_DISPLAY` combinations are exploratory candidates.
All start disabled, require separate calibration, and require both component
signals to meet their thresholds in the same public `SOCIAL` or `EXPANDED`
input. Master-only or split-input findings may support review but cannot
activate these automatic-reject rules. Split-input evidence is co-occurrence
with input ambiguity rather than meaningful corroboration.

Safe-by-default clothing or swimwear never mitigates independently actionable
Gore. If other evidence independently surfaces potential-minor sexual or
exploitative context, the case follows restricted human-review routing. This
matrix does not infer age.

### Nudity × Self-Harm

| Combination                                                                      | Relationship  | Evidence interaction                                                  | Outcome floor                                  | Additional effect                                                                                          | Auto-REJECT               |
| -------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------- |
| `SEXUAL_ACTIVITY + SELF_HARM_REAL`                                               | `MEANINGFUL`  | High-risk co-occurrence with actor and motivation ambiguity           | `REVIEW`                                       | Sexual activity and real/past self-harm evidence coexist; no sexual/self-harm relationship can be inferred | No                        |
| `SEXUAL_ACTIVITY + SELF_HARM_FAKE`                                               | `MEANINGFUL`  | High-risk co-occurrence with representation and association ambiguity | `REVIEW`                                       | Sexual activity and staged/faked self-harm representation coexist without shared-presentation inference    | No                        |
| `SEXUAL_ACTIVITY + SELF_HARM_ANIMATED`                                           | `MEANINGFUL`  | High-risk co-occurrence with representation and association ambiguity | `REVIEW`                                       | Sexual activity and illustrated self-harm representation coexist without shared-presentation inference     | No                        |
| `SEXUAL_DISPLAY + SELF_HARM_REAL`                                                | `MEANINGFUL`  | High-risk co-occurrence with actor ambiguity                          | `REVIEW`                                       | Explicit display and self-harm evidence coexist; exploitative or sexual-harm meaning cannot be inferred    | No                        |
| `SEXUAL_DISPLAY + SELF_HARM_FAKE`                                                | `CONTEXTUAL`  | Co-occurrence                                                         | `REVIEW`                                       | Explicit display does not make fake self-harm sexual                                                       | No                        |
| `SEXUAL_DISPLAY + SELF_HARM_ANIMATED`                                            | `CONTEXTUAL`  | Co-occurrence with depiction ambiguity                                | `REVIEW`                                       | Separate explicit-display and illustrated self-harm evidence                                               | No                        |
| `EROTICA + SELF_HARM_REAL`                                                       | `CONTEXTUAL`  | Co-occurrence with actor ambiguity                                    | `REVIEW`                                       | Nude/erotic imagery and self-harm coexist; association remains unresolved                                  | No                        |
| `VERY_SUGGESTIVE + SELF_HARM_REAL`                                               | `CONTEXTUAL`  | Co-occurrence                                                         | `REVIEW`                                       | Suggestiveness does not sexualize self-harm                                                                | No                        |
| `VISIBLY_UNDRESSED + SELF_HARM_REAL`                                             | `MEANINGFUL`  | High-risk co-occurrence with actor ambiguity                          | `REVIEW`                                       | Undressed-person context and real/past self-harm are sensitive; there is no actor or exploitation binding  | No                        |
| `VISIBLY_UNDRESSED + SELF_HARM_FAKE` or `VISIBLY_UNDRESSED + SELF_HARM_ANIMATED` | `CONTEXTUAL`  | Co-occurrence                                                         | `REVIEW`                                       | Undressed state does not change the Self-Harm subtype                                                      | No                        |
| `SEXTOY + SELF_HARM_*`                                                           | `INDEPENDENT` | None                                                                  | Self-Harm/Nudity family disposition            | Sextoy presence alone provides no self-harm relationship                                                   | No cross-family authority |
| `SUGGESTIVE_POSE + SELF_HARM_*` or `SUGGESTIVE_FOCUS + SELF_HARM_*`              | `CONTEXTUAL`  | Co-occurrence                                                         | Self-Harm verdict where actionable             | No sexualization and no Self-Harm mitigation                                                               | No                        |
| Lingerie/underwear/bikini/swimwear + `SELF_HARM_*`                               | `INDEPENDENT` | None                                                                  | Self-Harm verdict                              | Clothing neither strengthens nor mitigates Self-Harm                                                       | No cross-family authority |
| `NUDITY_ART + SELF_HARM_ANIMATED`                                                | `CONTEXTUAL`  | Depiction context with association ambiguity                          | `REVIEW`                                       | Art context may coexist with illustrated Self-Harm; there is no shared-depiction inference                 | No                        |
| `SCHEMATIC + SELF_HARM_*`                                                        | `CONTEXTUAL`  | Co-occurrence                                                         | `REVIEW`                                       | Schematic nudity does not determine Self-Harm meaning                                                      | No                        |
| Nudity + `SELF_HARM_OVERALL`                                                     | `CONTEXTUAL`  | Supporting aggregate evidence                                         | `REVIEW` when the Self-Harm safeguard triggers | Aggregate evidence cannot establish subtype, motivation, actor, or relationship                            | No                        |

Nudity and Self-Harm evidence cannot establish sexualization of self-harm,
motivation, causality, coercion, exploitation, fetish context, actor identity,
or whether harm is current, past, staged, or associated with the sexual
content. `SELF_HARM_FAKE` and `SELF_HARM_ANIMATED` describe only the Self-Harm
evidence; `NUDITY_ART` describes only Nudity. Their coexistence does not prove
a shared depiction type.

Meaningful high-risk interaction requires both signals to meet their
thresholds in the same ModerationPackage input. Split-input findings are
contextual co-occurrence with input ambiguity rather than meaningful
interaction. This distinction never lowers independently actionable family
outcomes below `REVIEW`.

Clothing, swimwear, sextoy, art, and suggestive-presentation evidence neither
strengthens nor mitigates Self-Harm by itself. If other evidence independently
surfaces potential-minor sexual or exploitative context, the case follows
restricted human-review routing; this matrix does not infer age. No Nudity ×
Self-Harm rule is eligible for automatic rejection in v1.

### Nudity × Weapon

| Combination                                                                                                 | Relationship  | Evidence interaction                                                  | Outcome floor                | Additional effect                                                                                               | Auto-REJECT               |
| ----------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `SEXUAL_ACTIVITY + AIMING_THREAT`                                                                           | `MEANINGFUL`  | High-risk co-occurrence with actor, direction, and coercion ambiguity | `REVIEW`                     | Sexual activity and a firearm aimed at a human coexist; there is no sexual-threat or coercion binding           | No in v1                  |
| `SEXUAL_ACTIVITY + AIMING_CAMERA`                                                                           | `MEANINGFUL`  | High-risk co-occurrence with direction and association ambiguity      | `REVIEW`                     | Sexual activity and a viewer-directed firearm coexist without a relationship inference                          | No                        |
| `SEXUAL_ACTIVITY + FIREARM`                                                                                 | `CONTEXTUAL`  | Co-occurrence with association ambiguity                              | Existing Nudity disposition  | Firearm presence does not establish threat or coercion                                                          | No                        |
| `SEXUAL_ACTIVITY + KNIFE`                                                                                   | `CONTEXTUAL`  | Co-occurrence with association ambiguity                              | Existing Nudity disposition  | Knife presence alone does not establish threatening use                                                         | No                        |
| `SEXUAL_ACTIVITY + AIMING_SAFE`                                                                             | `INDEPENDENT` | None                                                                  | Existing Nudity disposition  | Safe-target action neither relates to nor mitigates sexual evidence                                             | No                        |
| `SEXUAL_ACTIVITY + IN_HAND_NOT_AIMING`                                                                      | `CONTEXTUAL`  | Non-threatening weapon presence                                       | Existing Nudity disposition  | A held firearm does not imply a sexual threat                                                                   | No                        |
| `SEXUAL_ACTIVITY + WORN_NOT_IN_HAND` or `SEXUAL_ACTIVITY + NOT_WORN`                                        | `INDEPENDENT` | None                                                                  | Existing Nudity disposition  | Weapon positioning provides no useful sexual semantics                                                          | No                        |
| `SEXUAL_DISPLAY + AIMING_THREAT`                                                                            | `MEANINGFUL`  | High-risk co-occurrence with actor and coercion ambiguity             | `REVIEW`                     | Explicit display and a human-directed firearm threat coexist without actor binding                              | No                        |
| `SEXUAL_DISPLAY + AIMING_CAMERA`                                                                            | `MEANINGFUL`  | High-risk co-occurrence with association ambiguity                    | `REVIEW`                     | Explicit display and a viewer-directed firearm coexist                                                          | No                        |
| `SEXUAL_DISPLAY + FIREARM` or `SEXUAL_DISPLAY + KNIFE`                                                      | `CONTEXTUAL`  | Co-occurrence                                                         | Existing Nudity disposition  | Presence alone creates no sexual-threat relationship                                                            | No                        |
| `EROTICA + AIMING_THREAT`                                                                                   | `MEANINGFUL`  | High-risk co-occurrence with actor ambiguity                          | `REVIEW`                     | Nude/erotic content and a firearm aimed at a human are sensitive, but their relationship is unresolved          | No                        |
| `EROTICA + AIMING_CAMERA`                                                                                   | `CONTEXTUAL`  | Co-occurrence                                                         | `REVIEW`                     | Viewer-directed threat remains independently actionable                                                         | No                        |
| `EROTICA + FIREARM` or `EROTICA + KNIFE`                                                                    | `INDEPENDENT` | None                                                                  | Existing family dispositions | No reliable cross-family relationship                                                                           | No                        |
| `VISIBLY_UNDRESSED + AIMING_THREAT`                                                                         | `MEANINGFUL`  | High-risk co-occurrence with actor and coercion ambiguity             | `REVIEW`                     | Undressed-person context and a human-directed firearm threat coexist; coercion and victimhood remain unresolved | No                        |
| `VISIBLY_UNDRESSED + AIMING_CAMERA`                                                                         | `CONTEXTUAL`  | Co-occurrence                                                         | `REVIEW`                     | Sensitive coexistence without actor binding                                                                     | No                        |
| `VERY_SUGGESTIVE + AIMING_THREAT`, `SUGGESTIVE_POSE + AIMING_THREAT`, or `SUGGESTIVE_FOCUS + AIMING_THREAT` | `CONTEXTUAL`  | Co-occurrence                                                         | `REVIEW`                     | Suggestiveness does not sexualize a weapon threat                                                               | No                        |
| Lingerie/underwear/bikini/swimwear + `AIMING_THREAT`                                                        | `INDEPENDENT` | None                                                                  | Weapon verdict               | Clothing neither sexualizes nor mitigates the threat                                                            | No cross-family authority |
| `SEXTOY` + Weapon                                                                                           | `INDEPENDENT` | None                                                                  | Existing family dispositions | Sextoy presence does not establish sexual use of a weapon                                                       | No                        |
| Nudity + `FIREARM_GESTURE`                                                                                  | `INDEPENDENT` | None                                                                  | Existing Nudity disposition  | A gesture does not establish a firearm or sexual threat                                                         | No                        |
| Nudity + `FIREARM_TOY`                                                                                      | `INDEPENDENT` | None                                                                  | Existing Nudity disposition  | An apparent toy does not establish a sexual threat or mitigate Nudity                                           | No                        |
| Nudity + `FIREARM_ANIMATED`                                                                                 | `CONTEXTUAL`  | Depiction context                                                     | Existing family disposition  | Animated applies only to the firearm                                                                            | No                        |

Nudity and Weapon evidence cannot establish coercion, consent, sexual threat,
weapon use during sexual activity, fetish context, victimhood, perpetrator
identity, or an actor/object relationship. Weapon presence without a
threat-action signal does not strengthen Nudity. Safe, non-threatening, toy,
gesture, or animated weapon evidence cannot cancel independently actionable
Nudity.

Meaningful high-risk interaction requires both signals to meet their
thresholds in the same ModerationPackage input. Signals found only in
different inputs are contextual co-occurrence with input ambiguity. The
outcome remains at least the independently applicable family verdict, and no
combination receives cross-family automatic-reject authority in v1.

`FIREARM_ANIMATED` describes only the firearm and does not establish the
depiction type of Nudity. Clothing and swimwear neither sexualize nor mitigate
an independently actionable threat. If other evidence independently surfaces
potential-minor sexual or exploitative context, the case follows restricted
human-review routing; this matrix does not infer age.

### Recreational Drug × Medical

| Combination                                                      | Relationship  | Evidence interaction                          | Outcome floor                                                                      | Additional effect                                                                                                 | Auto-REJECT |
| ---------------------------------------------------------------- | ------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------- |
| `RECREATIONAL_DRUG_OVERALL + MEDICAL_PILLS`                      | `MEANINGFUL`  | Potential aggregate disambiguation            | `REVIEW` unless a calibrated medical-explanation rule fully explains the aggregate | Medical pills may explain ambiguous aggregate evidence only                                                       | No          |
| `RECREATIONAL_DRUG_OVERALL + MEDICAL_PARAPHERNALIA`              | `MEANINGFUL`  | Potential aggregate disambiguation            | `REVIEW` unless a calibrated medical-explanation rule fully explains the aggregate | Medical equipment may explain ambiguous aggregate evidence only                                                   | No          |
| `RECREATIONAL_DRUG_NOT_CANNABIS + MEDICAL_PILLS`                 | `CONTEXTUAL`  | Co-occurrence or provider disagreement        | `REVIEW`                                                                           | Medical pills do not explain or negate explicit non-cannabis recreational-use evidence                            | No          |
| `RECREATIONAL_DRUG_NOT_CANNABIS + MEDICAL_PARAPHERNALIA`         | `CONTEXTUAL`  | Conflicting evidence or provider disagreement | `REVIEW`                                                                           | Medical equipment cannot override explicit non-cannabis use; self-injection versus medical use remains unresolved | No          |
| `CANNABIS + MEDICAL_PILLS` or `CANNABIS + MEDICAL_PARAPHERNALIA` | `INDEPENDENT` | None                                          | Existing family dispositions                                                       | Medical context neither strengthens nor mitigates permitted cannabis evidence                                     | No          |
| `CANNABIS_LOGO_ONLY + Medical`                                   | `INDEPENDENT` | None                                          | Existing family dispositions                                                       | A cannabis logo and medical context remain separate                                                               | No          |
| `CANNABIS_PLANT + Medical`                                       | `INDEPENDENT` | None                                          | Existing family dispositions                                                       | A cannabis plant and medical context remain separate                                                              | No          |
| `CANNABIS_DRUG + Medical`                                        | `INDEPENDENT` | None                                          | Existing family dispositions                                                       | Medical context does not negate cannabis products, consumption, or paraphernalia evidence                         | No          |

A calibrated medical-explanation rule may suppress only the
`RECREATIONAL_DRUG_OVERALL` high-unexplained safeguard when credible medical
evidence accounts for the aggregate and no explicit recreational-use subclass
is actionable. Suppression is not an `ALLOW`; it merely prevents that aggregate
safeguard from creating `REVIEW`, after which all other family and cross-family
rules continue normally.

Disambiguation requires the recreational aggregate and medical evidence to
meet their thresholds in the same ModerationPackage input. Split-input medical
evidence cannot explain the aggregate. Medical evidence never overrides
`RECREATIONAL_DRUG_NOT_CANNABIS`, and conflicting explicit signals resolve to
review without mechanical score subtraction.

Missing or unusable medical coverage is a provider-coverage failure. The Media
remains technical `PENDING` under the fail-closed recovery flow rather than
receiving a content `REVIEW` decision. No Recreational Drug × Medical rule is
eligible for automatic rejection in v1.

### Hate/Extremism × Violence

For this matrix, `HATE_REVIEWABLE_IMAGERY` is a policy alias rather than a new
normalized signal:

```text
HATE_REVIEWABLE_IMAGERY =
  NAZI_IMAGERY
  | SUPREMACIST_IMAGERY
  | CONFEDERATE_IMAGERY
  | TERRORIST_SYMBOL
```

The alias expresses shared cross-family disposition only. Each underlying
signal retains its own threshold, evidence provenance, and reason code. Their
scores are never combined or treated as interchangeable.

| Combination                                   | Relationship  | Evidence interaction                                                 | Outcome floor             | Additional effect                                                                                       | Auto-REJECT |
| --------------------------------------------- | ------------- | -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| `HATE_REVIEWABLE_IMAGERY + PHYSICAL_VIOLENCE` | `MEANINGFUL`  | High-risk co-occurrence with motivation and actor ambiguity          | `REVIEW`                  | Prioritize review and record symbol plus violent-scene coexistence without ideological attribution      | No in v1    |
| `HATE_REVIEWABLE_IMAGERY + FIREARM_THREAT`    | `MEANINGFUL`  | High-risk co-occurrence with motivation, target, and actor ambiguity | `REVIEW`                  | Strongly review-relevant coexistence without inferring that the threat is ideological or symbol-related | No in v1    |
| `HATE_REVIEWABLE_IMAGERY + COMBAT_SPORT`      | `INDEPENDENT` | None                                                                 | Existing Hate disposition | Combat sport neither strengthens nor mitigates Hate evidence                                            | No          |
| `HATE_REVIEWABLE_IMAGERY + VIOLENCE_OVERALL`  | `CONTEXTUAL`  | Supporting aggregate evidence                                        | Existing Hate disposition | Aggregate supports context only and cannot establish a Violence subtype or cross-family escalation      | No          |
| `ASIAN_SWASTIKA + PHYSICAL_VIOLENCE`          | `INDEPENDENT` | None                                                                 | Violence disposition      | Cultural/religious swastika evidence does not transform Violence into Hate evidence                     | No          |
| `ASIAN_SWASTIKA + FIREARM_THREAT`             | `INDEPENDENT` | None                                                                 | Violence disposition      | No ideological or threat relationship can be inferred                                                   | No          |
| `ASIAN_SWASTIKA + COMBAT_SPORT`               | `INDEPENDENT` | None                                                                 | Existing dispositions     | No cross-family effect                                                                                  | No          |
| `MIDDLE_FINGER + PHYSICAL_VIOLENCE`           | `INDEPENDENT` | None                                                                 | Violence disposition      | An offensive gesture does not strengthen physical-violence classification                               | No          |
| `MIDDLE_FINGER + FIREARM_THREAT`              | `INDEPENDENT` | None                                                                 | Violence disposition      | The gesture does not establish motive, target, or a relationship to the threat                          | No          |
| `MIDDLE_FINGER + COMBAT_SPORT`                | `INDEPENDENT` | None                                                                 | Existing dispositions     | No cross-family semantics                                                                               | No          |

Meaningful high-risk interaction requires both signals to meet their
thresholds in the same ModerationPackage input. Split-input findings are
contextual co-occurrence with input ambiguity. Even same-input coexistence does
not establish ideological violence, endorsement, motivation, protected-group
targeting, causality, or actor association.

Cross-family coexistence may prioritize a human-review case and attach
separate reason codes, but cannot automatically reject. Combat-sport,
`ASIAN_SWASTIKA`, and `MIDDLE_FINGER` evidence neither creates an ideological
interpretation nor cancels independently actionable Hate or Violence.

`VIOLENCE_OVERALL` remains supporting aggregate evidence only. Missing,
invalid, or contradictory required subtype coverage follows the provider
failure path and leaves Media technical `PENDING`; it does not create a
content-review decision. No Hate/Extremism × Violence rule is eligible for
automatic rejection in `profile-photo-v1`.

### Hate/Extremism × Weapon

`HATE_REVIEWABLE_IMAGERY` retains the policy-alias definition above. Each
underlying Hate signal continues to use its own threshold, provenance, and
reason code.

| Combination                                    | Relationship  | Evidence interaction                                                    | Outcome floor             | Additional effect                                                           | Auto-REJECT |
| ---------------------------------------------- | ------------- | ----------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------- | ----------- |
| `HATE_REVIEWABLE_IMAGERY + AIMING_THREAT`      | `MEANINGFUL`  | High-risk co-occurrence with actor, target, and motivation ambiguity    | `REVIEW`                  | Elevated ordinary-review priority; no ideological-threat inference          | No in v1    |
| `HATE_REVIEWABLE_IMAGERY + AIMING_CAMERA`      | `MEANINGFUL`  | High-risk co-occurrence with actor, direction, and motivation ambiguity | `REVIEW`                  | Elevated ordinary-review priority; no ideological-threat inference          | No in v1    |
| `HATE_REVIEWABLE_IMAGERY + FIREARM`            | `CONTEXTUAL`  | Co-occurrence with ownership and association ambiguity                  | Existing Hate disposition | Firearm presence alone does not establish threat, use, or ownership         | No          |
| `HATE_REVIEWABLE_IMAGERY + KNIFE`              | `CONTEXTUAL`  | Co-occurrence with ownership and association ambiguity                  | Existing Hate disposition | Knife presence alone does not establish threatening use                     | No          |
| `HATE_REVIEWABLE_IMAGERY + AIMING_SAFE`        | `INDEPENDENT` | None                                                                    | Existing Hate disposition | Safe-direction action neither strengthens nor mitigates Hate evidence       | No          |
| `HATE_REVIEWABLE_IMAGERY + IN_HAND_NOT_AIMING` | `CONTEXTUAL`  | Non-threatening weapon presence                                         | Existing Hate disposition | Weapon handling does not establish ideological intent                       | No          |
| `HATE_REVIEWABLE_IMAGERY + WORN_NOT_IN_HAND`   | `INDEPENDENT` | None                                                                    | Existing Hate disposition | No reliable cross-family semantics                                          | No          |
| `HATE_REVIEWABLE_IMAGERY + NOT_WORN`           | `INDEPENDENT` | None                                                                    | Existing Hate disposition | No reliable cross-family semantics                                          | No          |
| `HATE_REVIEWABLE_IMAGERY + FIREARM_GESTURE`    | `INDEPENDENT` | None                                                                    | Existing Hate disposition | A gesture does not establish an armed threat                                | No          |
| `HATE_REVIEWABLE_IMAGERY + FIREARM_TOY`        | `INDEPENDENT` | None                                                                    | Existing Hate disposition | An apparent toy neither strengthens nor mitigates Hate evidence             | No          |
| `HATE_REVIEWABLE_IMAGERY + FIREARM_ANIMATED`   | `CONTEXTUAL`  | Depiction context                                                       | Existing Hate disposition | Animated classification applies only to the firearm                         | No          |
| `ASIAN_SWASTIKA` + Weapon                      | `INDEPENDENT` | None                                                                    | Weapon disposition        | Cultural/religious symbol evidence neither strengthens nor mitigates Weapon | No          |
| `MIDDLE_FINGER` + Weapon                       | `INDEPENDENT` | None                                                                    | Weapon disposition        | An offensive gesture does not establish weapon intent or threat             | No          |

Meaningful high-risk interaction requires both signals to meet their
thresholds in the same ModerationPackage input. Split-input findings are
contextual co-occurrence with input ambiguity. Even same-input evidence cannot
establish ideological threat, protected-group targeting, weapon ownership,
affiliation, membership, recruitment, propaganda, motivation, weapon use, or
actor/object association.

The two meaningful combinations may attach separate reason codes and an
elevated ordinary-review hint. Exact queue ordering, SLA, and prioritization
relative to restricted workflows remain operational configuration rather than
policy verdicts.

`ASIAN_SWASTIKA` neither strengthens Weapon evidence nor cancels separately
detected `HATE_REVIEWABLE_IMAGERY`. Safe-direction, non-threatening,
toy/gesture, or animated weapon evidence likewise cannot mitigate independently
actionable Hate. `FIREARM_ANIMATED` applies only to the firearm and does not
establish the depiction type of Hate imagery. This matrix does not implicitly
activate the deferred Propaganda and Ideological Promotion policy. No
Hate/Extremism × Weapon rule is eligible for automatic rejection in v1.

### Hate/Extremism × Gore

`HATE_REVIEWABLE_IMAGERY` remains a policy alias. Every underlying Hate signal
retains its own threshold, provenance, and reason code.

| Combination                                    | Relationship  | Evidence interaction                                        | Outcome floor                | Additional effect                                                                                  | Auto-REJECT |
| ---------------------------------------------- | ------------- | ----------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- | ----------- |
| `HATE_REVIEWABLE_IMAGERY + VERY_BLOODY`        | `CONTEXTUAL`  | High-risk co-occurrence with motivation and actor ambiguity | `REVIEW`                     | Same-input evidence may attach an elevated ordinary-review hint without ideological attribution    | No in v1    |
| `HATE_REVIEWABLE_IMAGERY + SERIOUS_INJURY`     | `CONTEXTUAL`  | High-risk co-occurrence with motivation and actor ambiguity | `REVIEW`                     | Same-input evidence may attach an elevated ordinary-review hint without inferring ideological harm | No in v1    |
| `HATE_REVIEWABLE_IMAGERY + CORPSE`             | `CONTEXTUAL`  | High-risk co-occurrence with actor ambiguity                | `REVIEW`                     | Sensitive coexistence without inferring ideological killing or cause of death                      | No          |
| `HATE_REVIEWABLE_IMAGERY + UNCONSCIOUS`        | `CONTEXTUAL`  | Co-occurrence with actor and state ambiguity                | `REVIEW`                     | No inference of assault, incapacity, ideological motivation, or victimhood                         | No          |
| `HATE_REVIEWABLE_IMAGERY + BODY_ORGAN`         | `CONTEXTUAL`  | Co-occurrence with association ambiguity                    | `REVIEW`                     | Surgery, medical, educational, or museum context remains possible                                  | No          |
| `HATE_REVIEWABLE_IMAGERY + SLIGHTLY_BLOODY`    | `CONTEXTUAL`  | Co-occurrence                                               | Existing Hate disposition    | Mild blood adds no reliable ideological semantics                                                  | No          |
| `HATE_REVIEWABLE_IMAGERY + SUPERFICIAL_INJURY` | `CONTEXTUAL`  | Co-occurrence                                               | Existing Hate disposition    | Minor injury adds no reliable ideological semantics                                                | No          |
| `HATE_REVIEWABLE_IMAGERY + SKULL`              | `INDEPENDENT` | None                                                        | Existing Hate disposition    | A generic skull supplies no reliable cross-family meaning                                          | No          |
| `HATE_REVIEWABLE_IMAGERY + BODY_WASTE`         | `INDEPENDENT` | None                                                        | Existing family dispositions | No reliable cross-family semantics                                                                 | No          |
| `HATE_REVIEWABLE_IMAGERY + OTHER_GORE`         | `CONTEXTUAL`  | Co-occurrence                                               | Existing Hate disposition    | Broad Gore evidence is insufficient for stronger semantics                                         | No          |
| `HATE_REVIEWABLE_IMAGERY + GORE_REAL`          | `CONTEXTUAL`  | Depiction context                                           | Existing Hate disposition    | Real-appearing applies only to Gore and does not prove a real-world ideological event              | No          |
| `HATE_REVIEWABLE_IMAGERY + GORE_FAKE`          | `CONTEXTUAL`  | Depiction context                                           | Existing Hate disposition    | Staged/fake classification applies only to Gore and does not make Hate imagery benign              | No          |
| `HATE_REVIEWABLE_IMAGERY + GORE_ANIMATED`      | `CONTEXTUAL`  | Depiction context                                           | Existing Hate disposition    | Illustrated classification applies only to Gore                                                    | No          |
| `ASIAN_SWASTIKA` + Gore                        | `INDEPENDENT` | None                                                        | Gore disposition             | Cultural/religious symbol evidence neither strengthens nor mitigates Gore                          | No          |
| `MIDDLE_FINGER` + Gore                         | `INDEPENDENT` | None                                                        | Gore disposition             | An offensive gesture neither explains nor strengthens Gore                                         | No          |

Same-input coexistence of `HATE_REVIEWABLE_IMAGERY` with `VERY_BLOODY`,
`SERIOUS_INJURY`, or `CORPSE` may attach an elevated ordinary-review hint and
separate reason codes. Split-input findings remain ordinary co-occurrence with
input ambiguity and do not receive that cross-family hint. Exact queue ordering
and SLA remain operational configuration.

Hate/Extremism and Gore evidence cannot establish ideological violence, hate
crime, atrocity, genocide, execution, protected-group targeting, victimhood,
perpetrator identity, causality, motivation, or actor association. In
particular, corpse evidence never establishes ideological killing.

`GORE_REAL` means real-appearing Gore, not proof of a real-world or historical
event. `GORE_FAKE` and `GORE_ANIMATED` remain scoped to Gore and neither
classifies the Hate imagery nor makes it benign. `ASIAN_SWASTIKA` does not
cancel separately detected `HATE_REVIEWABLE_IMAGERY`, and generic skull
evidence is insufficient for ideological interpretation. This matrix does not
activate the deferred Propaganda and Ideological Promotion policy. No
Hate/Extremism × Gore rule is eligible for automatic rejection in v1.

### Independent and deferred pairs

For this closure matrix, `DRUG_EVIDENCE` is a policy alias rather than a new
normalized signal:

```text
DRUG_EVIDENCE =
  RECREATIONAL_DRUG_OVERALL
  | CANNABIS
  | CANNABIS_LOGO_ONLY
  | CANNABIS_PLANT
  | CANNABIS_DRUG
  | RECREATIONAL_DRUG_NOT_CANNABIS
```

`MEDICAL_PILLS` and `MEDICAL_PARAPHERNALIA` are excluded because their
interaction with recreational evidence is governed by the dedicated
Recreational Drug × Medical matrix.

| Cross-family pair | Classification | v1 behavior                                                                                                                    | Prohibited inference                                                                                                                                     |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hate × Self-Harm  | `INDEPENDENT`  | Evaluate both families independently; retain audit evidence and separately applicable reason codes                             | No ideological self-harm, ideological motivation, affiliation, recruitment, or shared-actor inference                                                    |
| Hate × Nudity     | `INDEPENDENT`  | Evaluate both families independently; retain audit evidence and separately applicable reason codes                             | No exploitation, sexualized ideology, propaganda, coercion, or actor-relationship inference                                                              |
| Drugs × Violence  | `INDEPENDENT`  | Evaluate both families independently; retain audit evidence and separately applicable reason codes                             | Drug evidence is not a cause or motivation for Violence; no intoxicated-violence or drug-related-assault inference                                       |
| Drugs × Weapon    | `INDEPENDENT`  | Evaluate both families independently; retain audit evidence and separately applicable reason codes                             | No trafficking, armed drug activity, weapon ownership, threat, or intent inference                                                                       |
| Drugs × Gore      | `INDEPENDENT`  | Evaluate both families independently; retain audit evidence and separately applicable reason codes                             | No overdose, poisoning, intoxication injury, cause-of-unconsciousness/death, or causality inference                                                      |
| Drugs × Self-Harm | `DEFERRED`     | Evaluate both families independently; retain audit evidence and separately applicable reason codes; no cross-family escalation | Current evidence cannot establish overdose, intentional poisoning, suicidal drug use, intoxication-related self-harm, causality, intent, or shared actor |
| Drugs × Nudity    | `INDEPENDENT`  | Evaluate both families independently; retain audit evidence and separately applicable reason codes                             | No impaired-consent, exploitation, coercion, intoxication, or actor-relationship inference                                                               |
| Drugs × Hate      | `INDEPENDENT`  | Evaluate both families independently; retain audit evidence and separately applicable reason codes                             | No ideological drug activity, trafficking, affiliation, propaganda, recruitment, or shared-motivation inference                                          |

Independent and deferred pairs preserve the strictest independently produced
family outcome. An independently produced `REVIEW` remains `REVIEW`; two
reviews do not become `REJECT`. Safe-by-default evidence remains in the private
audit trail but does not create a review case or public reason code by itself.
Only independently applicable family reason codes are attached.

These pairs create no cross-family reason code, review-priority change, score
combination, or automatic-reject authority. Co-occurrence never establishes
causality, intent, motivation, intoxication, consent state, or actor binding.

The deferred Drugs × Self-Harm relationship requires new evidence mechanisms
and an explicit future `PolicyRevision` before it can affect disposition. It
must not be activated by silently strengthening current provider scores or
thresholds. With this closure matrix, the `profile-photo-v1` cross-family
semantic taxonomy is complete.

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

## Visibility

Pending or review-required Profile Photos never replace the approved public
current photo:

```text
owner
→ may see latest pending photo through private authenticated delivery

other viewers
→ see previous READY + APPROVED current photo
→ otherwise see default avatar
```

Approval publishes immutable variants and promotes the pending photo only if
it remains latest intent. Rejection removes the pending preview from normal
owner presentation and leaves the prior approved photo unchanged.

The owner DTO may expose `pendingProfilePhoto` and safe processing/moderation
state separately from `currentProfilePhoto`. Public DTOs expose only approved
current Media.

`OWNER_ONLY` is authorization, not DRM. Private delivery uses authenticated
access or short-lived signed URLs, `Cache-Control: private, no-store`, no public
DTO/log exposure, and invalidation after rejection or deletion. A bearer URL
can still be shared during its short validity window.

## Human review

`REVIEW_REQUIRED` creates a durable case:

```text
MediaModerationReviewCase
├── mediaId
├── policyRevisionId
├── status: OPEN | APPROVED | REJECTED
├── reasonCodes
├── reviewerUserId?
├── reviewerNote?
├── createdAt
└── reviewedAt?
```

The first reviewer is the product owner. Records already support reviewer
identity, decision time, reason codes, optional note, and restricted
child-safety routing. The existing `ADMIN` role may form the authorization
basis, but there is not yet an admin guard or operational review surface.

A reviewer sees only a short-lived authenticated/signed private preview.
Unapproved content is never copied to the public bucket for review.

Automation cannot override an explicit manual decision for the same asset and
`PolicyRevision`. A later manual reconsideration, legal takedown, appeal, or
campaign creates a new `ModerationDecision` record and supersedes the active
decision.
A moderator who cannot reach `ALLOW` or `REJECT` leaves the case open,
reassigns it, or escalates it; `MANUAL + REVIEW` is invalid.

Future User Reports remain a separate domain. A future admin workflow may
aggregate Media cases, User reports, and appeals without merging persistence
or semantics.

## Deletion and takedown

Moderation takedown, later rejection, photo/account deletion, and manual
removal require:

- clearing current and pending Profile references when applicable;
- stopping private and public delivery;
- revoking affected reusable decisions;
- invalidating evaluation claims;
- deleting/marking storage objects through durable cleanup;
- targeted CDN purge for public variants;
- retaining only audit evidence allowed by retention policy.

Already cached local device copies cannot be recalled, but backend and CDN
must promptly stop new delivery.

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
