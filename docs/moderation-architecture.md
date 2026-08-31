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
