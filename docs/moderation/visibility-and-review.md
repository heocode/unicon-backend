# Moderation Visibility and Human Review

Owner/public visibility, manual authority, review handling, deletion, and takedown.

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
