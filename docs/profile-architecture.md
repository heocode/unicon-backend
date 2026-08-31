# Profile and Profile Photo Architecture

This document records the agreed Profile and Profile Photo product model for
the first mobile integration. Moderation is a separate bounded context whose
source of truth is [`moderation-architecture.md`](moderation-architecture.md).
Open items must not be treated as an implemented or approved public API
contract.

The current backend does not yet implement the models or endpoints described
below. `ProfileModule` currently exposes `GET /profile/me` by selecting public
fields directly from `User`. There is no existing media, object-storage,
image-processing, CDN, upload, or moderation infrastructure.

## Product flow

Onboarding is a post-authentication flow:

```text
register
→ verify email
→ receive access and refresh tokens
→ onboarding
→ profile
```

Onboarding contains three screens:

1. Personal: mandatory `firstName` and `lastName`.
2. Education: optional `program`; the university is already known from the
   verified institutional email.
3. Avatar: optional Profile Photo; the user may continue or skip.

Onboarding is complete only after valid first and last names have been saved
and the client explicitly completes the flow. Program and Profile Photo are
not completion requirements. An upload, processing failure, moderation delay,
manual review, or rejected image must never prevent onboarding completion.

The accepted onboarding state is intentionally simple:

```text
onboardingCompleted: boolean
```

There is no backend `currentStep`, separate Onboarding entity, tutorial state,
or onboarding state machine. Profile fields are real Profile data and may be
saved before completion. Contextual product hints may be added later inside
the main application and must not affect onboarding completion.

## Profile ownership

The stable owner identity remains `User.id`. For the first Profile iteration,
`firstName`, `lastName`, `program`, and `onboardingCompleted` may be stored on
`User`; a separate one-to-one Prisma `Profile` model is not currently
justified. `ProfileModule`, rather than `AuthModule`, owns public profile
queries and mutations.

The expected fields are conceptually:

```text
firstName: String?
lastName: String?
program: String?
onboardingCompleted: Boolean = false
```

Before completion, all three Profile fields may be null. Completion guarantees
non-empty valid first and last names. Program remains optional. Completion is
not inferred only from field presence: the explicit boolean prevents future
Profile requirement changes from unexpectedly replaying Onboarding for
existing users.

The initial Profile API should eventually support:

```text
GET   /profile/me
PATCH /profile/me
POST  /profile/me/onboarding/complete
```

These endpoints are resource-oriented and are not mapped one-to-one to mobile
screens. Partial Profile saves are expected between Onboarding screens, but
the backend does not remember which screen the client last visited.

The completion operation should be idempotent, verify first and last names,
set `onboardingCompleted`, and return the complete current Profile response.
This allows the mobile Profile Reveal transition to prepare the real Profile
without an additional sequential request.

## Profile bootstrap

The authenticated routing contract is:

```text
valid local token pair
→ GET /profile/me
→ onboardingCompleted = false → Onboarding
→ onboardingCompleted = true  → Main App
```

The first Main App destination is initially Profile and may later become Feed.

A pending user does not have a token pair. The Verification flow is restored
from local pending-registration state or from `EMAIL_NOT_VERIFIED` after a
login attempt; it is not discovered through authenticated `/profile/me`.

## Profile Photo product model

A Profile Photo is not an `avatarUrl` field and is not a simultaneous
Tinder-style gallery. The accepted model is:

```text
User
├── one current ProfilePhoto
└── ProfilePhoto history
    ├── previous photos
    ├── photos undergoing processing or review
    └── current photo
```

The current Profile Photo is used for both small social avatars and the
expanded Profile presentation. Previous approved photos remain available for
future history management. Uploading or selecting a new photo must not
destroy the old one.

The current limit is 20 non-deleted or reserved Profile Photos per user.
Pending, processing, and manual-review uploads count toward this limit so
parallel uploads cannot bypass it. Failed or rejected uploads should leave the
visible history and enter cleanup rather than consume a slot permanently.

Profile history management is part of the data-model contract, but its mobile
UI and complete endpoint surface do not have to ship with Onboarding v1.

## Reusable media boundary

Profile Photo lifecycle and generic media lifecycle are separate concerns:

```text
Profile
→ ProfilePhoto
→ Media
→ MediaVariant
→ Object Storage / CDN
```

`ProfilePhoto` owns Profile-specific behavior:

- user ownership and history;
- crop metadata;
- current-photo selection intent;
- creation and deletion state.

`Media` owns reusable behavior:

- upload and processing lifecycle;
- storage representations;
- moderation status;
- provider-independent metadata;
- deletion and cleanup state.

`MediaVariant` owns one physical representation of the logical Media. This
boundary is intended to be reused later by post images, community avatars,
community covers, and event covers without introducing a separate upload
pipeline for each feature. It must not begin with a weak polymorphic
`ownerType`/`ownerId` abstraction before a second real consumer exists.

## Conceptual Prisma relations

The accepted direction is conceptually:

```prisma
model User {
  currentProfilePhotoId String?       @unique
  currentProfilePhoto   ProfilePhoto? @relation(
    "CurrentProfilePhoto",
    fields: [currentProfilePhotoId],
    references: [id],
    onDelete: SetNull
  )

  profilePhotos ProfilePhoto[] @relation("ProfilePhotoOwner")
  ownedMedia    Media[]        @relation("MediaOwner")
}

model ProfilePhoto {
  id        String   @id @default(cuid())
  userId    String
  mediaId   String   @unique

  socialCropX      Float
  socialCropY      Float
  socialCropWidth  Float
  socialCropHeight Float

  expandedCropX      Float
  expandedCropY      Float
  expandedCropWidth  Float
  expandedCropHeight Float

  createdAt DateTime @default(now())
  deletedAt DateTime?

  user       User    @relation(
    "ProfilePhotoOwner",
    fields: [userId],
    references: [id]
  )
  media      Media   @relation(fields: [mediaId], references: [id])
  currentFor User?   @relation("CurrentProfilePhoto")
}
```

Exact Prisma syntax and deletion behavior must be reviewed during
implementation. Service logic must always verify that a selected current
photo belongs to the authenticated user; the current-photo relation alone
does not establish ownership.

Storing the current photo reference on `User` avoids multiple concurrent
current flags. Changing current photo is an atomic user update after verifying
that the target Profile Photo is owned, approved, ready, and not deleted. The
old current photo remains in history.

## Crop and original image

V1 uses two independent normalized framing rectangles:

- one `1:1` social crop shared by `SMALL` and `MEDIUM`;
- one `2:3` expanded crop used by `EXPANDED`.

`EXPANDED` is always generated independently from the sanitized master. It is
never generated from the square social crop or another derivative. This keeps
the face and portrait composition suitable for the real Expanded Profile and
future Discovery viewport.

Crop metadata belongs to `ProfilePhoto`, not generic `Media`, because the same
source media may later be presented differently by different features.
Conceptually it is a normalized rectangle:

```json
{
  "x": 0.14,
  "y": 0.05,
  "width": 0.72,
  "height": 0.72
}
```

The example above represents one crop; ProfilePhoto stores equivalent
normalized metadata for both `socialCrop` and `expandedCrop`. All coordinates
are validated within `0..1`, each rectangle must stay inside the normalized
source bounds, and its aspect ratio must match its variant role.

The original composition must be retained for reprocessing and future crop or
pipeline changes. The permanent `ORIGINAL` representation should be a private,
full-resolution, orientation-normalized, metadata-stripped master rather than
necessarily the byte-for-byte raw upload. Raw temporary uploads should be
removed after successful normalization. Public derivatives must not retain
EXIF, GPS, or other unnecessary embedded metadata.

## Media variants

One logical Media has the following accepted variant roles:

```text
ORIGINAL → private full-resolution master
SMALL    → 192 × 192, 1:1 social crop
MEDIUM   → 640 × 640, 1:1 social crop
EXPANDED → 1280 × 1920, 2:3 expanded framing
```

`SMALL` targets current `56 × 56` avatar surfaces such as Feed, messages, and
comments. `MEDIUM` targets the current `112 × 112` Social Profile avatar and
larger social surfaces such as Friends. `EXPANDED` targets the current sharp
`403 × 605` Expanded Profile viewport and future Discovery.

All variants are generated directly from the sanitized master rather than
from one another. WebP is the accepted initial delivery encoding for v1, but
the codec is not part of the semantic variant role or domain enum. Processing
configuration maps a role to one or more physical representations. This
allows AVIF, JPEG, or another representation to be added later without
changing ProfilePhoto or Media contracts.

Each stored physical representation needs at least:

```text
mediaId
kind
objectKey
mimeType
width
height
byteSize
optional checksum
```

`objectKey` is stored rather than a complete CDN URL. Public URLs are derived
from configuration, allowing CDN or domain changes without rewriting database
rows. Object keys must never contain email, username, or the original
filename.

The normal Profile response returns all public variants in one object. It
does not return the private original:

```json
{
  "currentProfilePhoto": {
    "id": "photo-id",
    "variants": {
      "small": {
        "url": "https://media.example/variants/...",
        "width": 192,
        "height": 192,
        "mimeType": "image/webp"
      },
      "medium": {
        "url": "https://media.example/variants/...",
        "width": 640,
        "height": 640,
        "mimeType": "image/webp"
      },
      "expanded": {
        "url": "https://media.example/variants/...",
        "width": 1280,
        "height": 1920,
        "mimeType": "image/webp"
      }
    }
  }
}
```

The mobile client can render a cached small or medium variant immediately,
prefetch `expanded`, begin the Profile expansion without waiting, and
crossfade to it when ready. The mirrored top/bottom extension, blur, dark
gradient, and transition shown by the Expanded Profile UI are client-side
presentation and are never baked into a media asset. Animation state is never
a backend concern.

`GET /profile/me` obtains the current Profile Photo, its Media, and its ready
variants through one nested database query and one HTTP response. History is
loaded separately and lazily to avoid an initial payload or network waterfall.

## Moderation integration

The complete moderation policy, provider, fallback, retry, audit, reuse, and
human-review contract lives in
[`moderation-architecture.md`](moderation-architecture.md). This document
retains only the Profile-facing integration invariants:

- processing and moderation are independent state machines;
- only processing-ready and moderation-approved Media may become public;
- technical moderation failure remains non-public and never blocks Onboarding;
- pending/review Media is visible only through the authenticated owner contract;
- other viewers keep seeing the previous approved photo or the default avatar;
- approval promotes a photo only when it is still the latest pending intent;
- stale, replaced, rejected, deleted, or deletion-pending Media never becomes
  active because of a late decision;
- Profile and public DTOs never expose provider evidence or private moderation
  details.

The Profile domain consumes the stable moderation outcome and safe owner-facing
status. It does not interpret Sightengine/OpenAI fields, PolicyRevision rules,
provider availability, retry state, or moderation-cache records.

## Upload and processing flow

The target production flow is:

```text
reserve a Profile Photo slot
→ upload raw image to a private quarantine location
→ validate size, signature, type, and decoded dimensions
→ normalize orientation and remove metadata
→ persist private full-resolution master
→ generate private owner-preview renditions
→ hand deterministic inputs to the moderation subsystem
→ if APPROVED, publish immutable production variants
→ mark processing READY and persist the independent moderation status
→ atomically make the latest intended photo current
→ delete the raw temporary upload
```

Technical `PENDING` and `REVIEW_REQUIRED` both keep the image private, but only
`REVIEW_REQUIRED` creates a manual case.
`REJECTED` never becomes current and enters cleanup. `FAILED` processing also
leaves the existing current photo unchanged.

The backend never trusts file extension, filename, client MIME type, client
dimensions, or unvalidated crop metadata. The accepted v1 input contract is:

```text
formats:                JPEG, PNG, WebP, HEIC, HEIF
frames:                 exactly one
maximum upload bytes:   15 MiB (15 × 1024 × 1024 bytes)
maximum decoded pixels: 50,000,000
maximum dimension:      8192 px per side
resize policy:          downscale allowed, upscale forbidden
```

The worker determines format from decoded content and rejects malformed,
unsupported, partially decodable, animated, or multi-frame inputs. In v1 this
includes animated WebP, APNG, and multi-frame HEIC/HEIF. Upload bytes are
checked independently from decoded dimensions and pixel count to defend
against decompression bombs.

After orientation normalization, the selected compositions must contain at
least these effective source pixels:

```text
SOCIAL:   1:1 crop, at least 640 × 640
EXPANDED: 2:3 crop, at least 1280 × 1920
```

Both crop rectangles must fit inside the sanitized master. An otherwise valid
upload is rejected as unsuitable for Profile Photo when either composition
cannot be produced without upscaling. This deliberately trades acceptance of
older or heavily cropped images for predictable quality across both Profile
surfaces.

The accepted ingress is a private direct-to-storage upload using a short-lived
presigned `PUT` target, followed by durable processing. Presigned URLs are
bearer credentials and must be restricted to a predetermined private object
key, expected method and content metadata, and a short expiration. The client
never chooses a bucket or arbitrary storage path. Fire-and-forget processing
inside a NestJS request process is not acceptable because application restart
would lose work.

## Media processing workers

The accepted asynchronous execution model is:

```text
Mobile
→ direct upload to private Cloudflare R2
→ Unicon API confirms upload
→ Cloudflare Queue
→ Media Worker
→ R2 / Moderation Provider / PostgreSQL
```

Cloudflare Queues is the durable job transport. The Media Worker is initially
implemented with Node.js/NestJS and `sharp`/libvips. API and worker live in the
same backend codebase but use separate runtime entrypoints and deploy/scale
independently. The worker implementation is replaceable infrastructure: a
future Go, Rust, or native worker must not require changes to the public API,
Media domain, storage model, or versioned queue job contract.

The queue owns durable delivery, retries, backlog, redelivery after consumer
failure, dead-letter handling, and distribution across consumers. Queue SDK
types, delivery metadata, and Cloudflare-specific behavior stay behind an
infrastructure adapter and do not enter the Media domain.

The initial Profile-facing job contract is conceptually minimal:

```text
PROCESS_MEDIA v1
├── jobId
├── mediaId
├── processingVersion
├── requestedAt
└── traceId?
```

The message contains identifiers rather than mutable Media state, object URLs,
credentials, or provider payloads. The worker reloads authoritative state from
PostgreSQL and resolves storage objects through `ObjectStorage`.

For `PROCESS_MEDIA`, the worker:

1. loads current Media state from PostgreSQL;
2. retrieves the raw upload from private R2;
3. validates actual format, bytes, dimensions, decoded pixels, and integrity;
4. safely decodes, normalizes orientation, and strips EXIF/GPS and unnecessary
   metadata;
5. creates and stores a private sanitized master, both owner-preview crops,
   and deterministic moderation inputs;
6. hands those inputs to the moderation subsystem defined in
   [`moderation-architecture.md`](moderation-architecture.md);
7. publishes immutable production variants to the public bucket only for
   approved Media;
8. commits the resulting Media state and asset metadata to PostgreSQL; and
9. acknowledges the message only after the required durable state has been
   committed.

Rejected, review-required, and terminally invalid inputs are successful
pipeline outcomes once their state and any review case are durably committed.
A technical pending outcome is also acknowledged only after its operational
substate and follow-up retry/park record are durable. Queue redelivery is not
the sole retry schedule and must not cause uncontrolled provider calls.

### Statelessness, idempotency, and concurrency

Workers keep no critical local state. PostgreSQL is the source of truth for
metadata and state, R2 for objects, and Cloudflare Queue for pending work.
Temporary local files may be used during one attempt but are disposable.

Cloudflare Queue delivery is treated as at-least-once. Every job is idempotent
against `(mediaId, processingVersion)`. A redelivered completed version is
acknowledged without repeating work. Conditional state transitions,
deterministic/versioned object keys, and unique database constraints prevent
duplicate variants, Profile selections, and state changes. Moderation-specific
idempotency is defined in
[`moderation-architecture.md`](moderation-architecture.md).
External calls and database transactions cannot be atomic together, so each
pipeline stage must be safely resumable from persisted checkpoints.

API capacity and worker capacity are independent:

```text
initial: API × 1, Media Worker × 1
growth:  API × N, Media Worker × M
```

Worker concurrency is explicitly bounded against CPU, RAM, PostgreSQL, R2,
and moderation-provider limits. Queue backlog never translates directly into
unbounded processing or moderation requests. Retries use capped exponential
backoff with jitter and must respect provider rate limits.

### Future job classes

The versioned job envelope must permit later job types such as
`REMODERATE_MEDIA`, `REGENERATE_VARIANTS`, `DELETE_MEDIA`, and `PURGE_MEDIA`.
It must also permit future priority classes: high for newly uploaded user
content, medium for reach-based review, and low for bulk moderation,
regeneration, and cleanup. V1 does not require priority queues or batching;
batching is reserved for later bulk and maintenance work.

## Latest pending selection

Manual review may finish after the user has completed Onboarding or selected a
newer photo. A late approval must not overwrite a newer choice.

The accepted behavior is latest-intent-wins. Conceptually, `User` retains a
nullable pending Profile Photo reference:

```text
pendingProfilePhotoId
```

Each newly selected upload replaces this pending intent. After automated or
manual approval, the photo becomes current only when it is still the user's
pending selection. Approval of an older photo preserves it in history but does
not make it current. Rejection clears the pending reference only when it still
points to that photo.

Exact Prisma relations for both current and pending references must be
validated during implementation.

## Concurrency invariants

Profile Photo operations must preserve these invariants:

- Reserving an upload locks or serializes on the user, counts all non-deleted
  reserved photos, and rejects the twenty-first slot.
- Pending and review-required uploads count toward the limit.
- Duplicate processing or provider callbacks use conditional status updates
  and are idempotent.
- A photo becomes current only when owned, ready, approved, not deleted, and
  still the latest pending selection.
- Resolving a manual case is a single-winner transaction. A second conflicting
  reviewer receives a stable conflict error.
- Approval after deletion records audit history but never republishes or
  selects the photo.
- Setting an already-current approved historical photo is idempotently
  successful.
- Media provider network operations are never treated as part of a database
  transaction. Storage writes require explicit compensation and cleanup.

## Moderation-facing concurrency

Profile selection applies moderation decisions transactionally. A late result
can update audit state for its Media, but it can publish or select a Profile
Photo only when the Media remains approved, non-deleted, owned by the user, and
the latest pending intent. Full decision authority and freshness rules are
defined in [`moderation-architecture.md`](moderation-architecture.md).

## History management

The future owner-only history surface is expected to support:

```text
GET    /profile/me/photos?cursor=...
PUT    /profile/me/current-photo
DELETE /profile/me/photos/:photoId
```

History is cursor-paginated in deterministic descending creation order and
returns only ready, approved, non-deleted photos with their public variants.
Rejected and failed uploads are not normal history items.

Selecting an old photo as current verifies ownership and publication
eligibility and updates the current reference in one transaction.

The history deletion endpoint deletes only a non-current photo. Attempting to
delete the current photo through it returns a stable conflict. Logical deletion
is immediate in PostgreSQL, while object removal is asynchronous and
idempotent:

```text
ProfilePhoto.deletedAt set
→ Media DELETION_PENDING
→ remove origin objects
→ purge public CDN variants when required
→ Media DELETED
```

This separation is necessary because object storage and CDN deletion cannot be
atomic with PostgreSQL.

## Storage, delivery, and caching

Cloudflare R2 is the accepted primary object storage, not a temporary MVP
provider. Cloudflare CDN through a custom media domain is the accepted public
delivery layer. The topology uses two physically separate buckets:

```text
private R2 bucket
├── quarantine uploads
├── sanitized originals
├── moderation previews
├── deterministic moderation-package inputs
└── pending owner-preview renditions

→ validation/moderation/processing

public R2 bucket
└── approved immutable variants only
    → custom media domain
    → Cloudflare CDN
```

The private bucket has no public development URL or custom public domain.
Direct uploads use short-lived presigned `PUT` URLs against the private R2 S3
API endpoint. The public bucket is exposed only for approved variants through
the custom media domain. Unapproved, review-required, rejected, raw, and
original objects must never be written to the public bucket.

Public variant object keys are versioned or content-addressed. Approved public
responses may use long-lived immutable caching:

```http
Cache-Control: public, max-age=31536000, immutable
```

Changing photo content or crop creates new variant keys, so changing current
photo does not require ordinary cache invalidation. Original and moderation
preview objects remain private.

Moderation takedown, later policy rejection, account deletion, and manual
removal require clearing Profile references, disabling or deleting origin
objects, revoking affected reusable moderation decisions, releasing or
invalidating evaluation claims, and targeted CDN purge. Already cached local
copies on user devices cannot be recalled, but backend and CDN must stop new
delivery promptly.

R2 and Cloudflare are infrastructure choices, not domain concepts. Prisma
models and public DTOs must not contain R2 bucket identifiers, Cloudflare
account data, presigned URLs, or provider-specific response fields. Persistence
stores provider-neutral object keys and storage scope; runtime configuration
owns endpoints, bucket names, credentials, media domain, upload TTL, and purge
configuration.

Application code uses a focused provider-neutral `ObjectStorage` abstraction.
Public URL construction and targeted purge use a separate Media delivery/CDN
abstraction. R2 and Cloudflare SDK calls must not spread into Profile,
moderation policy, controllers, or public contracts. A future move to S3 and
CloudFront or a multi-provider deployment remains an infrastructure migration,
not a Profile-domain redesign.

## Account deletion

Terminal account deletion must clear current and pending Profile Photo
references, logically delete every Profile Photo, and mark their Media for
durable physical cleanup. External storage deletion must happen after the
database transition through an idempotent retry mechanism; it must not run
inside the account-finalization transaction.

Future Media references from posts or communities will require reference-aware
cleanup. In the first Profile-only model, one Profile Photo owns one Media,
making cleanup ownership unambiguous.

## Onboarding v1 delivery boundary

For an operational Avatar step, v1 requires:

- `ProfilePhoto`, `Media`, and `MediaVariant` persistence;
- current and latest-pending Profile Photo references;
- concurrency-safe twenty-photo quota;
- private original/master storage;
- validated normalized `1:1` social and `2:3` expanded crops;
- `SMALL`, `MEDIUM`, and `EXPANDED` variants generated from the master;
- integration with the approved moderation subsystem contract;
- publication only after `READY + APPROVED`;
- one Profile response containing current public variants;
- cleanup for failed, rejected, deleted, and abandoned uploads;
- account-deletion integration;
- tests for ownership, moderation, quota, concurrency, and public-field safety.

The minimum mobile-facing Profile Photo surface may initially be limited to:

```text
create/upload one Profile Photo
inspect its processing/moderation result
receive current Profile Photo through GET /profile/me
complete Onboarding regardless of photo outcome
```

The following can be delivered later without changing the accepted data model:

- Profile Photo history UI and management endpoints;
- reselecting an old photo;
- deleting history photos;
- recropping;
- appeals;
- user reports;
- AI-generated image detection;
- perceptual hash matching;
- multiple moderator assignment and workload management;
- additional Media consumers;
- multiple crop aspect ratios;
- face detection and automatic focal points.

Public Discovery launch will require a separate moderation-readiness review,
including operational monitoring and policy enforcement. The accepted v1
architecture must not assume that automated approval alone permanently settles
an image under every future policy version.

## Accepted decisions

The following architecture is accepted for `profile-photo-v1`.

### Profile Photo and presentation

- Profile Photo is a dedicated entity backed by reusable Media and
  MediaVariant boundaries, not `avatarUrl`.
- A user has one approved current photo, one latest pending selection, and a
  retained history limited to 20 non-deleted/reserved photos.
- Latest intent wins; stale, replaced, deleted, or deletion-pending Media can
  never become active because of a late decision.
- `SMALL` is `192 × 192` and `MEDIUM` is `640 × 640`, sharing one normalized
  `1:1` social crop. `EXPANDED` is `1280 × 1920` with independent normalized
  `2:3` framing.
- Every rendition is generated directly from the sanitized master. WebP is the
  initial encoding, while codec remains representation metadata rather than a
  semantic variant role.
- Expanded mirroring, blur, gradients, and transitions are mobile presentation
  concerns and are never baked into assets.
- Owner Profile responses may include a private pending photo separately from
  the approved current photo. Public responses contain only the approved
  current photo; history loads separately.

### Input and storage

- V1 accepts single-frame JPEG, PNG, WebP, HEIC, and HEIF only.
- Limits are `15 MiB`, `50,000,000` decoded pixels, and `8192 px` per
  dimension; decoded content is authoritative.
- Effective crops after orientation normalization must provide at least
  `640 × 640` social and `1280 × 1920` expanded source pixels. Downscale is
  allowed and upscale is forbidden.
- A private sanitized full-resolution master is retained; raw temporary input
  is removed according to the processing/retention contract.
- Cloudflare R2 is primary storage, with physically separate private and
  approved-public buckets. Cloudflare CDN serves immutable approved variants
  through a custom media domain.
- Mobile uploads directly to a predetermined private key through a short-lived
  presigned `PUT`. Storage and CDN operations remain provider-neutral
  infrastructure outside Profile and Media domain contracts.
- Moderation takedown/deletion revokes delivery, invalidates reusable decisions,
  and performs targeted CDN purge.

### Processing execution

- Cloudflare Queues provides durable at-least-once transport, retries, backlog,
  DLQ handling, and consumer distribution.
- A stateless Node.js/NestJS worker using `sharp`/libvips has an entrypoint,
  deployment, scaling, and bounded concurrency independent from the HTTP API.
- Queue/worker technology and job implementation remain replaceable. Jobs use
  minimal versioned contracts and resumable/idempotent stages.
- `PROCESS_MEDIA` prepares the sanitized master, crops, renditions, and
  deterministic inputs required by the moderation subsystem.
- Future job types, priorities, batching, and an optimized worker language can
  be introduced without changing the Media domain or public API.

### Moderation integration

- Profile consumes only stable moderation status and safe owner-facing state.
- Technical moderation failure, review, and rejection remain non-public and
  never block Onboarding completion.
- Pending/review owner visibility never replaces the approved public current
  photo.
- Only ready, approved, owned, non-deleted Media that remains latest intent may
  become current.
- Provider strategy, PolicyRevision, attempts, decisions, retry, reuse,
  precedence, manual review, and moderation production checks are owned by
  [`moderation-architecture.md`](moderation-architecture.md).

## Related open decisions

All open moderation parameters and external provider checks are tracked only in
[`moderation-architecture.md`](moderation-architecture.md) to avoid duplicate
sources of truth. Profile-specific API validation and DTO details will be
finalized before the corresponding implementation stage.
