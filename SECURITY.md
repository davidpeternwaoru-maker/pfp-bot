# Untrusted input

Every point where something from outside reaches the filesystem, the database,
an RPC endpoint or an outbound API, and what stands in front of it.

"Outside" means anything this process did not itself generate. Telegram
payloads, uploaded files, operator flags and RPC replies are all on that list.

## Telegram

| Input                      | Reaches                                     | Guard                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/start` deep-link payload | database lookup by slug                     | `parseSlug` — charset and length; `findUnique` sends it as a bound parameter, so it matches one row or none. No `contains`, no string building                                                                                 |
| Callback data              | handler dispatch                            | `parseCallbackData` — fixed shapes, 8-byte ceiling, anything unrecognised returns null and is ignored. Carries **no** trait ids, member ids, commission ids or colour values; only positions into lists the server itself drew |
| Username                   | announcement text                           | `normaliseUsername` restricts the charset before it is interpolated. No `parse_mode` is ever set, so nothing can inject entities                                                                                               |
| Questionnaire text         | database, and later an illustrator's screen | `validateBrief` — length caps, and a charset that excludes control characters, zero-width joiners and bidi overrides. A brief must not read one way in the approval queue and another to the artist                            |
| Uploaded photo             | filesystem                                  | Header bytes decide the format, not the extension. The size cap applies to what arrives, not what was declared. Stored under a generated name, so nothing sent reaches a path                                                  |
| Wallet signature           | ed25519 verification                        | Verified server-side against a message rebuilt from stored state. A browser's claim that a signature checked out is worth nothing                                                                                              |

## HTTP (the signing page)

| Input                      | Reaches                         | Guard                                                                                                                                                                                                         |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/link/:token`             | database lookup                 | Pattern-checked before use. Unknown, spent and expired all return the same 404, so a guessed token learns nothing                                                                                             |
| `POST /verify/:token` body | signature check, database write | Field types and lengths checked; address and signature parsed as base58 with exact byte lengths. The challenge is consumed by a conditional UPDATE before verification, so a failed attempt cannot be retried |
| Any other path             | —                               | 404 with no body worth reading. No directory listing, no hints                                                                                                                                                |

## Operator input (admin CLI)

| Input                              | Reaches             | Guard                                                                                           |
| ---------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `--dir`, `--file`                  | filesystem read     | `resolveWithinRoot` — refuses anything resolving outside the configured root, symlinks included |
| `--project`, `--slug`              | database            | `parseSlug`, then `findUnique`                                                                  |
| `--issuer`                         | authorisation       | Must appear in `ADMIN_IDS`, platform-qualified. Empty allowlist authorises nobody               |
| `--price`, `--share`, `--capacity` | database            | Parsed to exact integers; a share above 100% is refused rather than stored                      |
| `--slots`                          | commission settings | Checked against slots the project actually has traits for                                       |
| Trait pack images                  | render pipeline     | `loadTraitImage` — PNG magic bytes, exact canvas dimensions, size ceiling                       |

## Outbound

| Call                                   | Risk                                  | Guard                                                                                                                      |
| -------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Solana RPC (`getTokenAccountsByOwner`) | Hostile or broken reply               | Every field type-checked; anything unexpected returns `unavailable`, which denies. Bounded by an `AbortController` timeout |
| Telegram file download                 | Oversized or non-image                | Fixed host — the reply supplies a path, never a URL. Cap applied to bytes received                                         |
| Telegram sendMessage                   | Failure disrupting a committed action | Announcements and notifications never throw; a failure is logged and the claim or transition stands                        |

## Private keys

There is no code path anywhere in `src/` that requests, accepts, transmits,
logs or stores a private key or seed phrase. Verified by search: every match in
`src/` is a comment saying so, or copy telling a member we will never ask.

Tests generate ephemeral ed25519 keypairs in memory to sign test messages —
unavoidable, since verifying a signature requires one to exist. They are never
written anywhere and never come from a person.

## What is deliberately not defended

**Payment confirmation is manual.** Nothing watches the chain, so an operator
marking an order paid is trusted to have looked. This is the plan's choice at
this stage; automating it is a later phase.

**Reference images are not scanned for content.** They are checked for being
images and nothing more. A human sees every one before it influences artwork.

**The trait root is trusted once inside.** An operator who can write to it can
change what renders. That is the same authority as running the CLI at all.
