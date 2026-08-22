-- Members are identified by platform + that platform's own id, rather than by
-- a Telegram user id. Without this, adding a Discord or web front end means
-- either storing Discord ids in a column called telegramUserId, or a second
-- member table — both of which make every downstream query lie about what it
-- is reading.
--
-- Written by hand rather than generated: the generated version drops
-- telegramUserId and recreates the column, which would discard every existing
-- member and orphan their claims. Each column is backfilled before the old one
-- goes, so no row is lost.

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('telegram', 'discord', 'web');

-- AlterTable: add the new identity columns, nullable so the backfill can run.
ALTER TABLE "Member" ADD COLUMN "platform" "Platform";
ALTER TABLE "Member" ADD COLUMN "externalId" TEXT;

-- Backfill: everyone who exists today arrived through Telegram.
UPDATE "Member"
   SET "platform" = 'telegram',
       "externalId" = "telegramUserId"::text
 WHERE "externalId" IS NULL;

-- Only now that every row has values can these become required.
ALTER TABLE "Member" ALTER COLUMN "platform" SET NOT NULL;
ALTER TABLE "Member" ALTER COLUMN "externalId" SET NOT NULL;

-- The identity constraint moves from the Telegram id to the pair. Created
-- before the old one is dropped so uniqueness is never unenforced.
CREATE UNIQUE INDEX "Member_platform_externalId_key" ON "Member"("platform", "externalId");
DROP INDEX "Member_telegramUserId_key";
ALTER TABLE "Member" DROP COLUMN "telegramUserId";

-- "username" was always the platform's word for it; "handle" is neutral.
ALTER TABLE "Member" RENAME COLUMN "username" TO "handle";

-- AlterTable: the announcement target is an opaque id its front end
-- understands, not necessarily an integer.
ALTER TABLE "Project" RENAME COLUMN "telegramGroupId" TO "announceChannelId";
ALTER TABLE "Project" ALTER COLUMN "announceChannelId" TYPE TEXT USING "announceChannelId"::text;
