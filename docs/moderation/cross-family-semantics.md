# Cross-Family Moderation Semantics

Accepted semantic relationships, prohibited inferences, and initial authority constraints across signal families.

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
