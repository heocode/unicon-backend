# Rule Catalog Contract

Fixed schema, evaluation semantics, validation rules, and representative contract cases for executable policy rules.

## Fixed Rule Catalog Contract

The Rule Catalog Contract is fixed. Nudity, `SELF_HARM_OVERALL`, and
Recreational Drug × Medical remain representative validation cases here; they
are not final Named Rule Catalog entries. The full Nudity catalog and the other
family and cross-family executable rules are separate follow-up work.

The Rule Catalog produces internal decision reasons and policy effects. It does
not select user-facing categories or messages. After aggregation, a separate
`PresentationPolicy` maps the outcome and decision reasons for an audience and
locale.

```ts
type StableRuleId = string;
type ThresholdRef = string;
type CalibrationId = string;
type CoverageRequirementId = string;
type DecisionReasonCode = string;
type ModerationInputId = string;

type ModerationFamily =
  | 'NUDITY'
  | 'VIOLENCE'
  | 'WEAPON'
  | 'GORE'
  | 'SELF_HARM'
  | 'HATE_EXTREMISM'
  | 'RECREATIONAL_DRUG'
  | 'MEDICAL';

type InputRole = 'MASTER' | 'SOCIAL' | 'EXPANDED';

type SignalCondition = {
  signal: string;
  thresholdRef: ThresholdRef;
};

type CoverageRequirement = {
  id: CoverageRequirementId;
};

type PolicyRule = {
  id: StableRuleId;
  type: 'DISPOSITION' | 'SAFEGUARD' | 'MODIFIER' | 'ROUTING';

  scope: {
    kind: 'FAMILY' | 'CROSS_FAMILY' | 'PACKAGE' | 'GLOBAL';
    families: ModerationFamily[];
  };

  description: string;

  when: {
    allOf?: SignalCondition[];
    anyOf?: SignalCondition[];
    noneOf?: SignalCondition[];
  };

  requiredCoverage: CoverageRequirement[];

  inputScope: {
    allowedRoles: InputRole[];
    relationship: 'ANY' | 'SAME_INPUT' | 'SAME_PUBLIC_INPUT';
  };

  effect: {
    outcomeFloor?: 'REVIEW' | 'REJECT';

    modifier?: {
      type:
        'SUPPRESS_RULE' | 'DISQUALIFY_RULE' | 'QUALIFY_RULE' | 'ADD_CONTEXT';
      targetRuleIds: StableRuleId[];
      applicationScope: 'ALL_TARGET_EVALUATIONS' | 'OVERLAPPING_INPUTS';
    };

    decisionReasonCodes?: DecisionReasonCode[];
    reviewRoute?: 'STANDARD' | 'RESTRICTED';
    priorityHint?: 'NORMAL' | 'ELEVATED';
  };

  autoReject: {
    eligibility: 'NOT_ELIGIBLE' | 'EVALUATION_CANDIDATE' | 'ELIGIBLE';
    authority: 'DISABLED' | 'ENABLED';
    calibrationId?: CalibrationId;
  };

  rationale: string;
};
```

`priorityHint` is a supported capability, not an accepted priority assignment.
Until a routing/SLA contract is defined, its absence means that the rule adds no
priority effect.

### Matching and effect application

Matching and effect application are separate facts. A modifier or disabled
authority never erases a successful condition match.

```ts
type PolicyRuleEvaluation = {
  ruleId: StableRuleId;

  matchState:
    'NOT_APPLICABLE' | 'NOT_EVALUABLE' | 'NOT_TRIGGERED' | 'TRIGGERED';

  effectApplication:
    | 'NOT_APPLICABLE'
    | 'APPLIED'
    | 'WITHHELD_AUTHORITY'
    | 'SUPPRESSED_BY_MODIFIER';

  modifiedByRuleIds?: StableRuleId[];
  matchedInputIds: ModerationInputId[];
};
```

One evaluation represents one semantic match binding. If a rule matches
independently on `SOCIAL` and `EXPANDED`, the evaluator may emit separate
records. This preserves input-level modifier behavior and audit evidence.

| Match state      | Effect application       | Meaning                                                                    |
| ---------------- | ------------------------ | -------------------------------------------------------------------------- |
| `NOT_APPLICABLE` | `NOT_APPLICABLE`         | The rule does not apply to the available scope or inputs                   |
| `NOT_EVALUABLE`  | `NOT_APPLICABLE`         | Required coverage is missing; the affected evaluation is technical pending |
| `NOT_TRIGGERED`  | `NOT_APPLICABLE`         | Coverage is sufficient, but conditions did not match                       |
| `TRIGGERED`      | `APPLIED`                | The effect participates in processing or aggregation                       |
| `TRIGGERED`      | `WITHHELD_AUTHORITY`     | A reject candidate matched, but its authority is disabled                  |
| `TRIGGERED`      | `SUPPRESSED_BY_MODIFIER` | The rule matched, but an explicit modifier suppressed its effect           |

`modifiedByRuleIds` is present only for `SUPPRESSED_BY_MODIFIER` and identifies
the explicit modifiers responsible.

### Field semantics and invariants

`DISPOSITION` independently establishes a `REVIEW` or `REJECT` outcome floor.
`SAFEGUARD` establishes `REVIEW` for unresolved ambiguous or aggregate evidence
and never establishes `REJECT` by itself in v1. `MODIFIER` changes only
explicitly named target rules and never independently creates an outcome.
`ROUTING` attaches review-route or operational metadata without changing the
content verdict.

Rule scope is multi-family aware:

- `FAMILY` contains exactly one family;
- `CROSS_FAMILY` contains at least two unique families;
- `PACKAGE` may list affected families or remain family-neutral;
- `GLOBAL` has an empty family list.

Conditions use conjunction, disjunction, and absence semantics:

```text
matches = every(allOf) AND atLeastOne(anyOf) AND none(noneOf)
```

An omitted group is neutral, but every rule has at least one positive condition
in `allOf` or `anyOf`. `noneOf` cannot activate a rule by itself. Coverage is
checked before conditions. Missing required coverage produces `NOT_EVALUABLE`
and technical `PENDING`, never `NOT_TRIGGERED`, content `REVIEW`, or default
`ALLOW`.

Every condition has a semantic, revision-owned `thresholdRef`. Semantically
different signals use different refs even if calibration assigns the same
numeric value. Explanation thresholds are signal-specific. Cross-family reject
candidates use named-rule qualification refs rather than generic constituent
`*_REJECT` refs. Provider scores are evidence; automatic-reject authority
belongs only to a calibrated named rule.

Input role and evidence relationship are separate:

- a single-signal rule uses `relationship: ANY` and constrains only roles;
- `SAME_INPUT` and `SAME_PUBLIC_INPUT` are valid only when semantics depends on
  co-location of multiple evidence conditions;
- `SAME_PUBLIC_INPUT` permits only `SOCIAL` and/or `EXPANDED`, never `MASTER`;
- evidence split across inputs does not satisfy a same-input relationship.

A modifier names at least one target and cannot target itself.
`OVERLAPPING_INPUTS` applies it only to target evaluations whose
`matchedInputIds` intersect the modifier inputs. `ALL_TARGET_EVALUATIONS` is
reserved for genuine package/global semantics. This prevents medical context
on one input from suppressing unrelated drug evidence on another input.

Rule identity, decision reasons, and presentation are separate:

```text
StableRuleId -> precise internal semantic rule
DecisionReasonCode -> stable moderation/audit category
PresentationPolicy -> aggregated reasons/outcome to external category/message
```

The Rule Catalog contains no `userFacingCategory`. A cross-family decision may
preserve multiple reason codes; external category and message selection happens
only after aggregation.

### Valid field combinations

Every rule requires a non-empty ID, description, rationale, allowed-role set,
and at least one positive condition. Evidence-based rules require non-empty
coverage. Every threshold and coverage reference must exist in the same
immutable `PolicyRevision`.

| Rule type     | Required effect                             | Forbidden or restricted fields                                       |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `DISPOSITION` | `outcomeFloor`                              | No modifier                                                          |
| `SAFEGUARD`   | `outcomeFloor: REVIEW`                      | No modifier, no reject floor, always auto-reject ineligible/disabled |
| `MODIFIER`    | Modifier with explicit non-empty target IDs | No outcome floor, always auto-reject ineligible/disabled             |
| `ROUTING`     | `reviewRoute` and/or `priorityHint`         | No outcome floor or modifier, always auto-reject ineligible/disabled |

The allowed automatic-reject states are:

| Eligibility            | Authority  | Calibration                  |
| ---------------------- | ---------- | ---------------------------- |
| `NOT_ELIGIBLE`         | `DISABLED` | Absent                       |
| `EVALUATION_CANDIDATE` | `DISABLED` | Optional evaluation artifact |
| `ELIGIBLE`             | `DISABLED` | Required                     |
| `ELIGIBLE`             | `ENABLED`  | Required                     |

Auto-reject metadata other than `NOT_ELIGIBLE + DISABLED` is valid only for a
`DISPOSITION` with `outcomeFloor: REJECT`. All automated-reject authorities in
the first draft remain disabled. A matched disabled candidate is stored as
`TRIGGERED + WITHHELD_AUTHORITY`; its reject floor does not enter production
aggregation.

Modifier dependencies must be acyclic. V1 also forbids a modifier from
targeting another modifier until a concrete need justifies chained semantics.

Default `ALLOW` is not a signal rule. It is available only after required
package processing and coverage are complete, no technical failure remains, no
enabled reject floor applies, no review floor applies, and no safeguard remains
unresolved. Safe-by-default, context, or negative evidence does not create
`ALLOW`; absence of a family outcome floor is not global approval.

### Stable rule ID lifecycle

A stable rule ID identifies one immutable semantic rule definition. The same ID
is retained across PolicyRevisions for numeric threshold changes, authority
state changes, calibration binding changes, operational priority changes, and
non-semantic wording corrections.

A semantic change requires a new ID. This includes changing evidence meaning,
family/scope semantics, rule type, outcome semantics, modifier targets or
behavior, decision-reason semantics, or an input relationship in a way that
changes interpretation. A retired ID is never reused or removed from historical
audit. IDs do not encode a threshold value or revision number.

Audit stores at least:

```text
ruleId
policyRevisionId
matchState
effectApplication
matchedInputIds
modifiedByRuleIds, when applicable
```

### Representative schema validation cases

These are non-normative contract fixtures, not final catalog entries. They omit
numeric thresholds, presentation assignments, and unaccepted priority choices.

#### Standalone Nudity disposition

```yaml
id: EXAMPLE_NUDITY_SEXUAL_ACTIVITY_REVIEW
type: DISPOSITION
scope: { kind: FAMILY, families: [NUDITY] }
when:
  allOf:
    - signal: SEXUAL_ACTIVITY
      thresholdRef: TH_EXAMPLE_SEXUAL_ACTIVITY_REVIEW
requiredCoverage: [{ id: COV_EXAMPLE_SEXUAL_ACTIVITY }]
inputScope:
  allowedRoles: [MASTER, SOCIAL, EXPANDED]
  relationship: ANY
effect:
  outcomeFloor: REVIEW
  decisionReasonCodes: [EXPLICIT_SEXUAL_ACTIVITY]
  reviewRoute: STANDARD
autoReject: { eligibility: NOT_ELIGIBLE, authority: DISABLED }
rationale: Representative standalone family disposition.
```

This verifies that a single signal constrains roles without inventing an input
relationship.

#### Disabled cross-family reject candidate

```yaml
id: EXAMPLE_XF_NUDITY_VIOLENCE_REJECT
type: DISPOSITION
scope: { kind: CROSS_FAMILY, families: [NUDITY, VIOLENCE] }
when:
  allOf:
    - signal: SEXUAL_ACTIVITY
      thresholdRef: TH_EXAMPLE_XF_SEXUAL_ACTIVITY_QUALIFICATION
    - signal: PHYSICAL_VIOLENCE
      thresholdRef: TH_EXAMPLE_XF_PHYSICAL_VIOLENCE_QUALIFICATION
requiredCoverage:
  - { id: COV_EXAMPLE_SEXUAL_ACTIVITY }
  - { id: COV_EXAMPLE_PHYSICAL_VIOLENCE }
inputScope:
  allowedRoles: [SOCIAL, EXPANDED]
  relationship: SAME_PUBLIC_INPUT
effect:
  outcomeFloor: REJECT
  decisionReasonCodes: [EXPLICIT_SEXUAL_ACTIVITY, PHYSICAL_VIOLENCE]
autoReject: { eligibility: EVALUATION_CANDIDATE, authority: DISABLED }
rationale: Representative same-public-input shadow reject candidate.
```

If it matches, its evaluation is `TRIGGERED + WITHHELD_AUTHORITY`; it creates no
production reject floor.

#### Self-Harm aggregate safeguard

```yaml
id: EXAMPLE_SELF_HARM_OVERALL_UNEXPLAINED_REVIEW
type: SAFEGUARD
scope: { kind: FAMILY, families: [SELF_HARM] }
when:
  allOf:
    - signal: SELF_HARM_OVERALL
      thresholdRef: TH_EXAMPLE_SELF_HARM_OVERALL_SAFEGUARD
  noneOf:
    - signal: SELF_HARM_REAL
      thresholdRef: TH_EXAMPLE_SELF_HARM_REAL_EXPLANATION
    - signal: SELF_HARM_FAKE
      thresholdRef: TH_EXAMPLE_SELF_HARM_FAKE_EXPLANATION
    - signal: SELF_HARM_ANIMATED
      thresholdRef: TH_EXAMPLE_SELF_HARM_ANIMATED_EXPLANATION
requiredCoverage:
  - { id: COV_EXAMPLE_SELF_HARM_OVERALL }
  - { id: COV_EXAMPLE_SELF_HARM_SUBTYPES }
inputScope:
  allowedRoles: [MASTER, SOCIAL, EXPANDED]
  relationship: SAME_INPUT
effect:
  outcomeFloor: REVIEW
  decisionReasonCodes: [UNEXPLAINED_SELF_HARM_EVIDENCE]
  reviewRoute: STANDARD
autoReject: { eligibility: NOT_ELIGIBLE, authority: DISABLED }
rationale: Representative unexplained aggregate-evidence safeguard.
```

This verifies signal-specific explanation refs, absence conditions, same-input
evaluation, and a safeguard that cannot create reject authority.

#### Recreational Drug safeguard and Medical modifier

```yaml
id: EXAMPLE_DRUG_OVERALL_UNEXPLAINED_REVIEW
type: SAFEGUARD
scope: { kind: FAMILY, families: [RECREATIONAL_DRUG] }
when:
  allOf:
    - signal: RECREATIONAL_DRUG_OVERALL
      thresholdRef: TH_EXAMPLE_DRUG_OVERALL_SAFEGUARD
  noneOf:
    - signal: RECREATIONAL_DRUG_NOT_CANNABIS
      thresholdRef: TH_EXAMPLE_NON_CANNABIS_EXPLANATION
    - signal: CANNABIS
      thresholdRef: TH_EXAMPLE_CANNABIS_EXPLANATION
requiredCoverage:
  - { id: COV_EXAMPLE_DRUG_OVERALL }
  - { id: COV_EXAMPLE_DRUG_CLASSES }
inputScope:
  allowedRoles: [MASTER, SOCIAL, EXPANDED]
  relationship: SAME_INPUT
effect:
  outcomeFloor: REVIEW
  decisionReasonCodes: [UNEXPLAINED_RECREATIONAL_DRUG_EVIDENCE]
  reviewRoute: STANDARD
autoReject: { eligibility: NOT_ELIGIBLE, authority: DISABLED }
rationale: Representative unexplained recreational-drug safeguard.
```

```yaml
id: EXAMPLE_DRUG_MEDICAL_AGGREGATE_SUPPRESSION
type: MODIFIER
scope: { kind: CROSS_FAMILY, families: [RECREATIONAL_DRUG, MEDICAL] }
when:
  allOf:
    - signal: RECREATIONAL_DRUG_OVERALL
      thresholdRef: TH_EXAMPLE_DRUG_OVERALL_MODIFIER_QUALIFICATION
  anyOf:
    - signal: MEDICAL_PILLS
      thresholdRef: TH_EXAMPLE_MEDICAL_PILLS_DISAMBIGUATION
    - signal: MEDICAL_PARAPHERNALIA
      thresholdRef: TH_EXAMPLE_MEDICAL_PARAPHERNALIA_DISAMBIGUATION
  noneOf:
    - signal: RECREATIONAL_DRUG_NOT_CANNABIS
      thresholdRef: TH_EXAMPLE_NON_CANNABIS_EXPLICIT_EVIDENCE
requiredCoverage:
  - { id: COV_EXAMPLE_DRUG_OVERALL }
  - { id: COV_EXAMPLE_NON_CANNABIS_DRUG }
  - { id: COV_EXAMPLE_MEDICAL_CONTEXT }
inputScope:
  allowedRoles: [MASTER, SOCIAL, EXPANDED]
  relationship: SAME_INPUT
effect:
  modifier:
    type: SUPPRESS_RULE
    targetRuleIds: [EXAMPLE_DRUG_OVERALL_UNEXPLAINED_REVIEW]
    applicationScope: OVERLAPPING_INPUTS
autoReject: { eligibility: NOT_ELIGIBLE, authority: DISABLED }
rationale: Representative same-input medical disambiguation modifier.
```

When both fixtures match on an overlapping input, the safeguard remains
`TRIGGERED` but becomes `SUPPRESSED_BY_MODIFIER`; the modifier is
`TRIGGERED + APPLIED`. Suppression does not create `ALLOW`, and all remaining
rules continue normally.

These cases verify ordinary disposition, aggregate safeguard, targeted
modifier, technical pending on missing coverage, and a shadow-triggered
disabled reject without mechanism-specific exceptions. The contract is fixed
unless a later catalog exercise exposes a genuine structural contradiction.
