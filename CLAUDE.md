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
