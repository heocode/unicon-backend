# Authentication operation completion events

Stage 4 / Iteration 7 step 2.3.4 adds one observation per invocation of
`AuthenticationOperationService.execute`, after its authoritative result or
error is known. `AuthenticationOperationTelemetryService` writes a JSON string
through Nest Logger at log level `log`. Log configuration may suppress it.
No new environment setting, database table or external backend is required.

## Event contract

| Field             | Meaning                                                         |
| ----------------- | --------------------------------------------------------------- |
| `event`           | `AUTHENTICATION_OPERATION_COMPLETED`                            |
| `schemaVersion`   | `1`                                                             |
| `operation`       | `SIGN_IN_REQUEST`, `RESEND`, or defensive `UNKNOWN`             |
| `outcome`         | `CREATED`, `REUSED`, `EXISTING`, `DENIED`, `FAILURE`            |
| `replayed`        | Receipt/reconciliation replay indicator from the result         |
| `durationMs`      | Finite nonnegative elapsed time through authoritative execution |
| `denial`          | Fixed admission-denial category, otherwise null                 |
| `deniedPolicyIds` | Sorted unique known Delivery/cooldown policy IDs for DENIED     |
| `failureReason`   | Fixed operation failure category, otherwise null                |

The receiver constructs a fresh allowlisted payload. Unknown categories are
masked, unknown policy IDs are excluded, and all extra fields are discarded.
There are no emails, IPs, operation/challenge/Delivery IDs, bucket keys, proof,
tokens, hashes, encryption envelopes, URLs or raw error messages. The policy
allowlist contains the global, IP and identity Delivery policies and both
Delivery cooldown policies. An absent policy is not evidence of an allowed check.

These are completion observations, not durable accounting. A replayed CREATED
does not create or charge another Delivery; reconciliation can return a replayed
result even on the caller's first execution. Missing/dropped logs cannot be
recovered from these events. A COMMIT_OUTCOME_UNKNOWN failure does not establish
rollback. Use authoritative receipts/state for exact accounting.

## Failure isolation and limits

Publication runs outside transactions and retries. Synchronous receiver
exceptions and Promise rejections cannot replace the original response/error.
Receiver promises are never awaited; an unsettled receiver cannot hold the auth
response open or become a new business retry. Failure is not recursively logged
through the failed receiver.

This protects against receiver throw/rejection/pending promises, not synchronous
CPU stalls, blocked stdout, process crashes or durable-export outages. Receivers
must return promptly. Any future network exporter needs its own bounded resource
and timeout design before adoption. No external exporter is introduced here.

Instrumentation covers `execute`, including its internal reconciliation, only.
It does not cover standalone `createOperationId`/`reconcile` calls, HTTP guards,
proof verification, worker attempts, all allowed policy checks or retry counters.
Duration excludes publication and is neither pure SQL nor end-to-end HTTP latency.
The wider architecture's operational metric requirements remain future work.

## Bounded aggregate analysis

For locally captured, single-line Nest text logs, this example counts outcomes
without extracting any subject identifier. It accepts a Nest prefix before the
JSON object and ignores unrelated lines. Run against a chosen log file, not `.env`.

```python
import collections
import json
import sys

outcomes = collections.Counter()
denials = collections.Counter()
decoder = json.JSONDecoder()
for line in sys.stdin:
    start = line.find('{')
    if start < 0:
        continue
    try:
        event, _ = decoder.raw_decode(line[start:])
    except ValueError:
        continue
    if not isinstance(event, dict):
        continue
    if (event.get('event'), event.get('schemaVersion')) != (
        'AUTHENTICATION_OPERATION_COMPLETED', 1
    ):
        continue
    outcomes[(event['operation'], event['outcome'], event['replayed'])] += 1
    for policy in event['deniedPolicyIds']:
        denials[(event['operation'], policy)] += 1
print('Completion observations:', outcomes)
print('Policy denial observations:', denials)
```

Policy counts overlap when several policies deny one operation. These totals
cannot establish unique people, false-positive rates, capacity or new charges.
Use them with successful outcomes, workload evidence and authoritative state;
do not derive production quotas from this fixture.

## Verification scenario

Run `npm run test:load:telemetry-failure`. Each of three receiver modes starts
two independent OS processes sharing the same disposable PostgreSQL copy.
The receiver alone is substituted, after production event sanitization.
Each mode verifies three fresh CREATED results, cross-process CREATED replay,
REUSED, EXISTING, a real exhausted-IP DENIED and a confirmed receipt-trigger
abort reporting STATE_UNAVAILABLE. Database snapshots and independent receipt
oracles verify unchanged state after replay/denial/abort and exact quota and
cooldown accounting. Real workers send nine total Deliveries to the loopback
HTTP provider. Reports contain bounded counts/checks, not subject identifiers.
