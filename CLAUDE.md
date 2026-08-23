# Project context

A Telegram bot that generates unique profile pictures for online communities.
Each community ("project") has its own artwork pack. Members open a deep link,
roll through trait combinations, and claim exactly one — permanently locked to
them, with an edition number. No two members within a project may ever hold the
same combination.

## Stack

TypeScript, Node 20+, grammY, sharp, PostgreSQL, Prisma, Vitest.

## Non-negotiable rules

1. **Uniqueness is enforced by database constraints, never by application logic.**
   Two constraints carry the entire product: one claim per member per project,
   and one trait combination per project. Application-level checks race and will
   eventually ship duplicates. Duplicates destroy the premise of the product.

2. **Never trust input from Telegram.** Deep link payloads, usernames, callback
   data and file uploads are all attacker-controlled. Validate shape and length
   before use. Never interpolate them into paths or queries.

3. **No secrets in the repository.** Everything through environment variables.
   Maintain `.env.example` with keys only, never values.

4. **Fail closed.** On any error in an eligibility or ownership check, deny.
   Never default to granting access.

5. **No custody.** Never hold, store, or manage anyone's private keys or assets.

## Code standards

- Strict TypeScript. `strict: true`. No `any` — if a type is hard, model it properly.
- Small pure functions where possible. Side effects isolated at the edges.
- Errors are typed and handled explicitly. No silent catches.
- Every non-obvious decision gets a one-line comment explaining _why_, not what.
- No dead code, no commented-out blocks, no placeholder stubs left behind.

## What not to do

- Do not add features beyond the current phase's scope.
- Do not install a dependency without stating why a standard library approach won't work.
- Do not write abstractions for a second use case that does not exist yet.
- Do not generate large README files. Documentation stays short.

## Standard of work

The product should feel like it cost far more to build than it did. That comes
from a small number of unglamorous things done properly:

- **Nothing ever spins.** Callback queries answered immediately, always.
- **Nothing is ever a dead end.** Every error state names a next action.
- **Nothing leaks.** No stack traces, no internal IDs, no file paths in any message.
- **Nothing is lost.** Any interrupted flow resumes exactly where it stopped.
- **Nothing surprises.** The same input produces the same output, every time, forever.

Seamlessness is reliability plus latency. It is not features.

## Layering

`core/` is the product: rendering, hashing, rarity, exclusions, capacity, claim
rules, database access. It has zero knowledge of any front end — no grammY, no
message or chat objects, no chat IDs in any signature.

`adapters/` holds front ends (Telegram, the admin CLI). They import core only
through `core/ports.js`, which is the whole contract a new adapter implements.

The test: delete `src/adapters/` and core still compiles and passes its tests.
Enforced by lint, and checkable with `npm run check:layers`.

## Claim taxonomy

Three kinds of claim exist. They are not variations of one thing — they have
different economics, different ownership, and different rules.

|                        | Open pool                | Bespoke                | Custom                        |
| ---------------------- | ------------------------ | ---------------------- | ----------------------------- |
| Artwork                | Composited from traits   | Hand-drawn, one of one | Commissioned for one member   |
| Selected by            | Member, from open traits | Project awards it      | Member orders it              |
| Paid by                | Project (in setup fee)   | Project (as add-on)    | The member, in USDC           |
| Transferable           | Yes                      | Yes                    | No                            |
| Counts in rarity stats | Yes                      | Yes                    | No                            |
| Requires token holding | No                       | No                     | Yes, if project configures it |

Rules that follow from this:

- Custom claims never appear in rarity statistics or trait supply counts. They
  would otherwise dilute the scarcity the project promised its holders.
- Custom traits belong to one member and never enter another member's pool.
- A member may hold one open-pool claim AND one custom claim per project.
- Bespoke and custom claims have no trait combination. Their uniqueness hash
  derives from image content instead.

## Wallet rules

- NEVER request, accept, transmit, log or store a private key or seed phrase.
  Not as a fallback. Not temporarily. Not in a comment or an example.
- Wallet ownership is proven by signature only. A typed address proves nothing.
- One wallet address links to at most one member, enforced by database constraint.
- All signature verification happens server-side. Never trust a client result.
- Wallet linking is optional and gates only token features. It must never be
  required to make an ordinary claim.

## Craft standard

- Answer every callback query immediately, before doing any work.
- Every failure path names a next action. Never leave a member stuck.
- Any interrupted flow resumes exactly where it stopped.
- Identical inputs produce identical outputs, permanently.
