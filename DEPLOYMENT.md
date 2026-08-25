# Deploying to Fly.io

Everything needed to get this running, and nothing about how it works — see
[README.md](README.md) for that.

## What is already here

| File            | What it does                                                 |
| --------------- | ------------------------------------------------------------ |
| `Dockerfile`    | Two-stage build. Runs as `node`, never root                  |
| `fly.toml`      | One machine, health-checked, 30s grace on SIGTERM            |
| `.dockerignore` | Keeps `.env`, `backups/` and `node_modules` out of the image |

---

## 1. A database

You need Postgres reachable from Fly. Either works.

### Fly Postgres — same platform, private networking

```bash
fly postgres create --name pfp-bot-db --region iad --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
fly postgres attach pfp-bot-db --app pfp-bot
```

`attach` sets `DATABASE_URL` as a secret for you. It uses Fly's private
network, so the database is never exposed publicly.

### A managed provider — Neon, Supabase, anything else

Create a database, copy its connection string, and set it yourself:

```bash
fly secrets set DATABASE_URL="postgresql://..." --app pfp-bot
```

> **Put `sslmode=verify-full` in the URL, not `sslmode=require`.**
> `node-postgres` currently treats `require` as `verify-full`, but will adopt
> weaker libpq semantics in pg v9 — which encrypts without verifying the
> certificate. Being explicit now means that change cannot silently downgrade
> you to an unverified connection.

Serverless providers that auto-suspend (Neon's free tier) will pause after
inactivity. The first request after a pause is slow, and `/ready` will report
503 until it wakes. That is correct behaviour, not a fault.

## 2. Migrations

Migrations are **not** run automatically at boot. Two machines starting
together would race the same migration, and a deploy that fails half-way
through one leaves a schema nobody can reason about.

Run them explicitly, before the deploy that needs them:

```bash
# Against Fly Postgres, through a tunnel:
fly proxy 15432:5432 -a pfp-bot-db          # leave running in one terminal
DATABASE_URL="postgresql://postgres:PASSWORD@localhost:15432/pfp_bot" npx prisma migrate deploy

# Against a managed provider, straight from your machine:
npx prisma migrate deploy
```

`migrate deploy` only applies migrations that already exist. It never
generates one and never prompts, which is what makes it safe to run against
production.

## 3. Secrets

```bash
fly secrets set \
  TELEGRAM_BOT_TOKEN="..." \
  ADMIN_IDS="telegram:5710427266" \
  --app pfp-bot
```

Secrets are encrypted at rest and injected as environment variables. `fly
secrets list` shows names and digests, never values.

## 4. Deploy

```bash
npm run deploy
```

Use that, **not** `fly deploy`. It passes `--ha=false`. Telegram permits one
long-polling connection per token, so a second machine is not redundancy — the
two terminate each other's `getUpdates` with a 409 and neither answers anybody.

## 5. Check it

```bash
fly status --app pfp-bot                       # one machine, started
curl https://pfp-bot.fly.dev/health            # {"ok":true}
curl https://pfp-bot.fly.dev/ready             # {"ready":true}
fly logs --app pfp-bot | grep bot.started
```

---

## Environment variables

### Required

| Variable             | Example                              | Notes                                                                                                      |
| -------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | `postgresql://…?sslmode=verify-full` | Must start `postgres://` or `postgresql://`. Set by `fly postgres attach`, or by you                       |
| `TELEGRAM_BOT_TOKEN` | `8853090779:AA…`                     | From @BotFather. Shape is checked at startup, so a truncated paste fails to boot rather than 401-ing later |

### Set in `fly.toml`, not as secrets

| Variable     | Value                | Notes                                                        |
| ------------ | -------------------- | ------------------------------------------------------------ |
| `NODE_ENV`   | `production`         | Stops `.env` being read at all                               |
| `HTTP_PORT`  | `3000`               | Must match `internal_port`                                   |
| `TRAIT_ROOT` | `/app/trait-packs`   | Artwork ships in the image                                   |
| `CLAIM_ROOT` | `/app/output/claims` | Rendered claims. Reproducible, so losing them costs only CPU |

### Optional

| Variable          | Default   | Notes                                                                                                    |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `ADMIN_IDS`       | _(empty)_ | `telegram:123,discord:456`. **Empty authorises nobody.** Needed for `/queue`, awards, one-of-one artwork |
| `LOG_LEVEL`       | `info`    | `debug` · `info` · `warn` · `error`                                                                      |
| `SOLANA_RPC_URL`  | _(unset)_ | Full RPC endpoint, key included. **https only** — the key rides inside the URL                           |
| `PUBLIC_BASE_URL` | _(unset)_ | Where members reach the signing page. **https**, except `http://localhost` outside production            |

`SOLANA_RPC_URL` and `PUBLIC_BASE_URL` must be set **together or not at all** —
the process refuses to start with only one. Wallet linking needs both, and
neither is any use alone. With both unset, everything except wallet features
runs normally.

---

## Shutting down without dropping a claim

A deploy sends SIGTERM. The process then, in order:

1. Stops the bot, **waiting for any in-flight update to finish**
2. Closes the signing page listener
3. Disconnects the database

Each step runs even if the previous one failed, so a wedged bot cannot leave a
connection open. Signals after the first are ignored, so a second SIGTERM
cannot start a parallel teardown that disconnects the database under the first.

`kill_timeout = "30s"` in `fly.toml` is load-bearing and deliberately not the
default. Fly's default is **5 seconds**, and a claim holds the project row lock
for its whole transaction — `insertClaim` allows 20 seconds before giving up.
At the default, a deploy timed against a busy moment would SIGKILL a member's
claim _after they had confirmed it_: the row either committed or did not, and
nobody was told which. Thirty seconds is past that ceiling, so an in-flight
claim always reaches its own conclusion first.

Do not lower it below 25 seconds without also lowering
`TRANSACTION_TIMEOUT_MS`.

## Health checks

| Endpoint  | Question                          | Touches the database    |
| --------- | --------------------------------- | ----------------------- |
| `/health` | Should this process be restarted? | **No**                  |
| `/ready`  | Should traffic come here?         | Yes, with a 3s deadline |

Fly probes `/ready`. `/health` deliberately does not check the database: a
sleeping database is not something restarting fixes, and checking it there
would turn a slow database into a restart loop that took the bot down with it.

## Rolling back

```bash
fly releases --app pfp-bot
fly deploy --image registry.fly.io/pfp-bot:deployment-XXXX
```

Rolling back the **image** does not roll back the **schema**. If the release
you are leaving included a migration, check that the older image still works
against the current schema before you do it.

## Costs

One `shared-cpu-1x` machine at 512MB, always on — roughly **$3–4/month**. It
cannot auto-stop: the bot polls Telegram continuously, so a stopped machine is
a bot that answers nobody. Fly Postgres adds its own machine and volume.

Fly's free allowance ended in 2024. A trial account without a payment method
stops machines after **5 minutes**, which looks exactly like a bot that
ignores you.
