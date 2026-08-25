# Handover

Written for whoever picks this up next — a new Claude Code session, a
different account, or a person. Read this and `CLAUDE.md` first; between them
you should not need to ask what any decision was for.

`CLAUDE.md` holds the rules that must not be broken. This file holds where the
work has got to, what was decided along the way, and what will bite you.

---

## What this is

A Telegram bot that gives every member of a community their own profile
picture. Members open a deep link, roll through trait combinations, and claim
exactly one — permanently theirs, with an edition number. **No two members in
a collection can ever hold the same combination.**

That last sentence is the product. Everything else is arrangement.

## Where it stands

Built against a phased plan (the "Build Plan v2", phases 8–15). Phases 1–7
predate it.

| Phase | What                                      | State                 |
| ----- | ----------------------------------------- | --------------------- |
| 8     | Core/adapter split                        | done                  |
| 9     | Claim taxonomy, "none" traits             | done                  |
| 10    | Browse a slot by name, collision handling | done                  |
| 11    | Solana wallet verification                | done                  |
| 12    | Member commissions                        | done                  |
| 13    | **Gated channel access**                  | **not started**       |
| 14    | Hardening, backups, deployment            | done                  |
| 15    | On-chain                                  | deliberately deferred |

Plus, added outside the plan: `/verify`, non-token eligibility enforcement,
and the Telegram command menu.

**551 tests pass.** `npm test` runs everything; `npm run check:layers` proves
core still compiles and passes its own tests with `src/adapters/` deleted.

## What is live right now

A real collection, imported and open:

- **Hammy** (`hammy`), 512×512, status `live`, 100 combinations, 0 claims
- Deep link: `https://t.me/totemhq_bot?start=hammy`
- Bot: **running on the owner's laptop only.** Not deployed. Closing that
  terminal stops it.

Fly.io app `pfp-bot` exists but its machine is **stopped** — the account is on
a trial with no payment method, which caps machines at five minutes. See
`DEPLOYMENT.md`.

---

## Things that will bite you

Every one of these cost real time to find. None is obvious from the code.

**`npm run check:layers` moves `src/adapters/` out of the tree while it runs.**
It takes about four minutes. Editing adapter files during that window writes
into a directory about to be replaced by the restore. Check `src/adapters`
exists before editing if a layer check might be running.

**Deploy with `npm run deploy`, never `flyctl deploy`.** The script passes
`--ha=false`. Telegram allows one long-polling connection per token, so a
second machine is not redundancy — the two terminate each other's `getUpdates`
with a 409 and neither answers anybody. This actually happened and took the
bot down.

**`ADMIN_IDS` must be the operator's Telegram user id, not the bot's.** It was
set to the bot's own id for a long time, which silently meant nobody was an
admin. The owner's id is `5710427266` (`@blockfidave`). The bot's is
`8853090779`. They are easy to confuse because both appear in the token.

**The database sleeps.** Neon's free tier auto-suspends. A test run can fail
with integration tests skipped and no individual failure — that is the
database, not the code. `assertDatabaseResponsive` exists to say so in one
line. Retry; it wakes in about thirty seconds.

**Bash heredocs in this environment eat backslashes.** `\n` inside a
`<<'EOF'` heredoc arrives as a real newline, producing unterminated string
literals in generated TypeScript. Use the Write/Edit tools for any file
containing escape sequences, or write a `.py` patch file and run it.

**`--dir` and `--required` take different kinds of name.** `--dir` is relative
to `trait-packs/`; `--required` takes the _slot_ name after the numeric prefix
is stripped (`base`, not `02-base`).

---

## Decisions worth knowing

Things a fresh reader would otherwise be tempted to "fix".

**Uniqueness is enforced by database constraints, never by application logic.**
Two constraints carry the product: one claim per member per project, and one
combination per project. Any check in TypeScript is a courtesy that produces a
better message. Do not replace a constraint with a check — it races.

**A hand-awarded legendary is `claimType: 'open'`, not `bespoke`.** `claimType`
records how the artwork was _produced_, not who selected it. The invariant is
exact: `open` if and only if `traitIds` is non-empty. What makes an award an
award is its tier plus a null `memberSlotKey`.

**Payment comes before approval in commissions.** That is what makes a decline
owe a refund. Approving first would spare the refund but commit an operator to
work before knowing they will be paid.

**Price and treasury share are copied onto each order**, not read live. A
payable report that recomputed from current settings would silently restate
what was owed on orders already paid for.

**Nothing that is not a definite yes is ever a yes.** Eligibility, token
gating, signature verification, balance reads — every ambiguous path refuses.
A gate that opens on error opens exactly when something is wrong. Several
tests exist solely to enumerate those paths.

**No trait ids, member ids or commission ids in callback data.** Buttons carry
positions into lists the server itself drew, resolved against session state. A
forged payload can only re-pick from a list the member already had open.

**Tenure is "first confirmed present", not "joined".** Telegram never reports
join dates. `GroupMembership.knownSince` records when the bot first saw
somebody. For anybody already in a group it is later than the truth — always
in the member's disfavour, which is the right direction to be wrong.

**`/health` deliberately does not touch the database.** It answers "should
this be restarted", and restarting never fixes a sleeping database. `/ready`
is the one that checks, and Fly probes that.

**`kill_timeout = "30s"` in `fly.toml` is load-bearing.** Fly's default is 5s,
and a claim can hold the project row lock for 20s. At the default, a deploy
during a busy moment SIGKILLs a member's claim after they confirmed it. Do not
lower it below 25s without also lowering `TRANSACTION_TIMEOUT_MS`.

---

## Known limits

**Claim throughput: about 2 per second, holding to ~40 simultaneous
claimants.** Measured, not estimated — see the README. Beyond that,
transactions time out cleanly waiting on the row lock. Bounded by database
round trips, so the fix is a database closer to the app, not a faster machine.

**Trait artwork ships inside the Docker image.** There is no volume, to keep
costs down. Changing artwork means redeploying. Before a real drop this wants
the volume back; `fly.toml` says where.

**Commission payment confirmation is manual.** Nothing watches the chain. An
operator taps "Payment received" having checked their wallet. This is the
plan's choice at this stage.

**Reference images are checked for being images, not for content.** A human
sees every one before it influences artwork.

---

## What to do next

In the order I would do it.

**1. Deploy.** Needs a payment method on Fly. Roughly $3–4/month. Everything
else is blocked on this in the sense that the bot currently only runs on one
laptop. `DEPLOYMENT.md` has every command.

**2. Nothing — `ADMIN_IDS` on Fly is already corrected and staged.** It did
hold the bot's own id; it now holds `telegram:5710427266` and will take effect
on the next deploy. Mentioned only so nobody re-fixes it.

**3. Decide eligibility for Hammy.** Currently open to anyone with the link.
`npm run admin -- eligibility --project hammy --in-group <id>` restricts it.

**4. Bind Hammy to its community group** so `/verify` works and claims are
announced: `npm run admin -- group --project hammy --chat <id> --announce`.

**5. Phase 13** — gated channel access. The only unbuilt phase. Its own spec
is in the plan; note that `/verify` was deliberately built independent of it,
so channels are additive.

**6. Consider trait weights.** With `none` at equal weight, about a quarter of
members roll bare eyes. `none.open.1.png` plus higher weights on the others
changes that. Nothing is claimed yet, so a re-import loses nothing.

---

## Orientation

```
src/core/        the product. Knows nothing about Telegram.
src/adapters/    front ends: telegram/, http/, cli/. Reach core only
                 through src/core/ports.ts.
prisma/          schema and migrations
tests/core/      must pass with src/adapters deleted
tests/adapters/  driven with synthetic Telegram updates
```

`src/core/ports.ts` is the whole contract between the two. If an adapter needs
something core does not export, widening that file is a deliberate decision
made once and visibly — not a deep import.

Start by reading `CLAUDE.md`, then `src/core/ports.ts`, then
`src/core/claim/insert.ts` — the last is the smallest file that explains what
the product actually guarantees.

## Docs

| File            | What                                              |
| --------------- | ------------------------------------------------- |
| `CLAUDE.md`     | Rules that must not be broken. Read first         |
| `README.md`     | What it is, setup, running a drop                 |
| `DEPLOYMENT.md` | Fly.io, database provisioning, every env var      |
| `SECURITY.md`   | Every point untrusted input enters, and its guard |
| `HANDOVER.md`   | This file                                         |
