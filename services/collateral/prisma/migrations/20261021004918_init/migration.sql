-- CreateEnum
CREATE TYPE "CustodyAccountStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "CustodyMovementType" AS ENUM ('DEPOSIT', 'RELEASE', 'APPLIED');

-- CreateTable
CREATE TABLE "custody_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "held_amount" BIGINT NOT NULL DEFAULT 0,
    "limit_version" INTEGER NOT NULL DEFAULT 0,
    "status" "CustodyAccountStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "custody_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "custody_account_id" UUID NOT NULL,
    "bank_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custody_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "custody_account_id" UUID NOT NULL,
    "type" "CustodyMovementType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "held_after" BIGINT NOT NULL,
    "deposit_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custody_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "scope" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("scope","owner_id","key")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "correlation_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custody_accounts_owner_id_idx" ON "custody_accounts"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_reference_key" ON "deposits"("reference");

-- CreateIndex
CREATE INDEX "deposits_custody_account_id_idx" ON "deposits"("custody_account_id");

-- CreateIndex
CREATE INDEX "custody_movements_custody_account_id_created_at_idx" ON "custody_movements"("custody_account_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_next_attempt_at_idx" ON "outbox_events"("published_at", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_custody_account_id_fkey" FOREIGN KEY ("custody_account_id") REFERENCES "custody_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custody_movements" ADD CONSTRAINT "custody_movements_custody_account_id_fkey" FOREIGN KEY ("custody_account_id") REFERENCES "custody_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custody_accounts" ADD CONSTRAINT "custody_accounts_held_nonnegative" CHECK ("held_amount" >= 0);
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "custody_movements" ADD CONSTRAINT "custody_movements_amount_positive" CHECK ("amount" > 0);

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "custody_movements_immutable" BEFORE UPDATE OR DELETE ON "custody_movements"
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER "audit_log_immutable" BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
