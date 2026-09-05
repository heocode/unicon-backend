# Moderation Signal Taxonomy

Accepted provider-neutral normalized signals for the `profile-photo-v1` policy family.

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
