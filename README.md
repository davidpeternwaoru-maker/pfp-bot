# pfp-bot

A Telegram bot that gives every member of a community their own profile
picture. No two people in a collection can ever hold the same one.

## Stack

TypeScript · Node 20+ · grammY · sharp · PostgreSQL · Prisma · Vitest

## Setup

```bash
npm install
cp .env.example .env        # then fill it in
npx prisma migrate deploy
npx prisma generate
npm run dev
```

`.env` needs `DATABASE_URL` and `TELEGRAM_BOT_TOKEN`. Everything else is
optional — including wallet features, which need `SOLANA_RPC_URL` and
`PUBLIC_BASE_URL` set together or not at all.

## Running a drop

```bash
npm run admin -- create-project --slug my-drop --name "My Drop" --width 512 --height 512
npm run admin -- import-traits  --project my-drop --dir my-drop --required background
npm run admin -- capacity       --project my-drop --members 500
npm run admin -- open-claims    --project my-drop
```

Members open `https://t.me/<bot>?start=my-drop`.

`npm run admin -- --help` lists the rest: awards, one-of-one artwork,
commission settings, payables, holder export, stats.

## Tests

```bash
npm test              # everything
npm run test:core     # the product, no front end involved
npm run check:layers  # proves core still works with src/adapters deleted
```

Tests marked integration need `DATABASE_URL`; they skip without it.

## Backups

```bash
npm run backup              # write a dump
npm run backup -- --check   # prove it parses and covers every table
npm run backup -- --restore # put rows back, skipping any already there
```

Restore is additive and never deletes, so running it cannot lose anything
written since the dump.

## Deploying

```bash
npm run deploy
```

Use that rather than `flyctl deploy` directly — it passes `--ha=false`.
Telegram allows one long-polling connection per token, so a second machine
does not add redundancy; the two terminate each other and the bot answers
nobody.

## Known ceiling

Claims on one project serialise on that project's row lock, so throughput is
bounded by database round trips rather than CPU.

Measured against a managed Postgres over the public internet: **~2 claims per
second**, holding to about **40 simultaneous claimants**. Beyond that,
transactions begin timing out while waiting for the lock — cleanly, with no
duplicates and no partial claims, but members see a failure.

A drop expecting more than that at once wants a database closer to the app.

## How it is put together

`src/core/` is the product: rendering, rarity, claims, wallets, commissions.
It has no idea Telegram exists.

`src/adapters/` holds front ends — Telegram, HTTP, the admin CLI — which reach
core only through `src/core/ports.ts`.

Delete `src/adapters/` and core still compiles and passes its tests.
`npm run check:layers` proves it.

See [SECURITY.md](SECURITY.md) for where untrusted input enters and what
stands in front of it.
