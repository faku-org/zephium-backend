# Account avatar contract

Status: implemented in the repository on 2026-10-21; staging deployment and live qualification are tracked separately in the desktop handoff.

## Ownership and access

One avatar belongs to the account and is shared by its signed-in devices and browser profiles. All upload, download and deletion requests require the existing account bearer and an active account. The desktop's Rust layer fetches the image; neither the bearer nor a bearer-bearing URL is handed to the webview. Avatars are private account data, not publicly accessible profile pictures.

The desktop refreshes `GET /v1/account` on sign-in and when opening account settings. The returned URL changes on each successful replacement. Other devices see changes on their next account refresh; this feature introduces no push channel or general synchronization engine.

## HTTP contract

| Request | Success | Meaning |
| --- | --- | --- |
| `GET /v1/account` | Existing 200 body plus `avatar_url: string \| null` | Absolute URL on the configured API origin, or null when absent |
| `PUT /v1/account/avatar` | 200 `{ "avatar_url": "https://api.example/v1/account/avatar/<version>.webp" }` | Atomically replace the current avatar after successful processing |
| `GET /v1/account/avatar/<version>.webp` | 200 WebP bytes or authenticated 304 | Return only the caller's current version |
| `DELETE /v1/account/avatar` | 200 `{ "avatar_url": null }` | Idempotently remove the current avatar |

The version is an opaque random identifier. Clients must use the returned URL, not construct one or derive it from an email or account ID. Foreign, deleted and superseded versions all return 404 `avatar_not_found` to an authenticated caller. Successful JSON mutations use the normal no-store policy.

Uploads use `multipart/form-data` with exactly one `file` part. Supported input formats are PNG, JPEG and WebP. The file limit is **2 MiB (2,097,152 bytes)**; total multipart request size is limited to that plus 16 KiB for framing. Clients should reject larger files before sending, but the server independently enforces limits even without Content-Length. Original filenames and multipart metadata are ignored and never logged. File type is verified from decoded bytes, not trusted from a filename or declared MIME type. SVG, GIF, animated/multipage input and remote image URLs are unsupported.

The image response has `Content-Type: image/webp`, exact `Content-Length`, a strong ETag over output bytes, `X-Content-Type-Options: nosniff`, `Vary: Authorization` and `Cache-Control: private, no-cache`. This permits private cached bytes with conditional revalidation, without allowing a shared cache to serve account images. Authentication and current-version ownership are checked before returning 304. The desktop scopes its cache by server origin and account, revalidates when displaying the avatar, and clears it on replacement, deletion and sign-out. Deletion cannot erase copies already downloaded elsewhere.

## Processing and persistence

Apply EXIF orientation before stripping metadata, convert to sRGB, center-crop to a square and resize to exactly 256×256. Preserve alpha where applicable. Encode a single-frame WebP with no EXIF, XMP, ICC profile, comments or other embedded metadata. The desktop picker may crop first to preserve the user's chosen framing; server-side validation and re-encoding always run.

Use a maintained, pinned image decoder with strict malformed-input handling, a maximum of 16,777,216 decoded pixels and 8,192 pixels on either axis. Bound upload duration, decoder execution and concurrent transformations; avoid an unbounded work queue. Output is limited to 256 KiB. A failed or interrupted transformation leaves the previous avatar intact. The implementation must recheck account/session status under the account mutation lock before storing the result, so deletion or sign-out during processing cannot recreate data.

Store only the normalized WebP and minimal version/digest/dimension metadata in one PostgreSQL row per account. This keeps the current service stateless and self-hostable without a new bucket or container filesystem dependency. Replacements atomically discard the old row's bytes. Overlapping avatar writes serialize at commit; the desktop cancels an in-flight upload before requesting removal. Account deletion and session revocation independently prevent pending uploads from saving. No original uploads, filenames, EXIF, image bodies or decoder dumps belong in logs, billing events or analytics. PostgreSQL's existing encrypted backup policy covers the retained avatar. Account avatars are deliberate profile uploads, separate from the browsing/AI content the gateway never persists. Before public launch, the privacy notice must describe stored profile images and backup retention. Private staging qualification uses the owner-approved test accounts.

On code-confirmed account deletion, remove the avatar in the same transaction that disables account access; billing cleanup must not keep it accessible. A cascading account foreign key is an additional final-purge safeguard. Historical encrypted backups expire under the documented backup-retention policy.

## Export

`GET /v1/account/export` includes the normal `account.avatar_url` plus `account.avatar`, which is null or:

```json
{
  "media_type": "image/webp",
  "width": 256,
  "height": 256,
  "encoding": "base64",
  "data": "<processed WebP bytes encoded as base64>"
}
```

Exporting only an authenticated URL is insufficient: the export must contain the actual current image. It never contains the original upload. Profile metadata and export bytes are read consistently from the same avatar version.

## Error contract

Use the existing `{error:{code,retry_after?},request_id}` envelope and genuine Retry-After values on retryable failures.

| HTTP | Code | Desktop meaning |
| --- | --- | --- |
| 400 | `invalid_avatar` | Missing/duplicate file, malformed multipart, empty or undecodable image |
| 408 | `request_timeout` | Upload timed out or was cancelled; retry only if still desired |
| 413 | `body_too_large` | File or multipart body exceeds its byte limit |
| 415 | `unsupported_avatar_format` | Unsupported type or animated/multipage image; choose a still PNG/JPEG/WebP |
| 422 | `avatar_dimensions_exceeded` | Resize the image before uploading |
| 422 | `avatar_processing_failed` | Image cannot be converted within the processing/output limits; choose or resize it |
| 404 | `avatar_not_found` | Refresh account details and fall back to initials |
| 429 | `rate_limited` | Honor Retry-After; upload allowance starts at six per hour per account |
| 503 | `avatar_processing_busy` | Retry after the specified delay; previous avatar is unchanged |

Existing 401 `unauthorized` and 403 account-state errors still apply. Ordinary avatar edits do not require a fresh OTP or a paid plan. Delete remains idempotent; ordinary account API limits apply rather than consuming the upload allowance.

## Verification before activation

Test byte and pixel limits, forged MIME types, malformed/animated images, orientation/crop behavior and absence of metadata in output; cross-account access and 304 authorization; concurrent replacement, sign-out and deletion during decoding; failed transforms preserving the old image; actual image bytes in export; and cascade/early-deletion cleanup. Exercise the built container's native decoder with the pinned Bun runtime. The desktop pass should confirm upload, restart, a second signed-in device, replacement and removal.

The proposed decoder approach uses [Sharp's input limits](https://sharp.pixelplumbing.com/api-constructor/) and [explicit WebP output with metadata removal](https://sharp.pixelplumbing.com/api-output/). Sharp is pinned; re-encoding runs in at most two short-lived subprocesses, with an eight-second parent deadline and a five-second codec processing deadline. Child environments exclude application secrets.
