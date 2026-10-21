-- CreateEnum
CREATE TYPE "CardAccountStatus" AS ENUM ('ACTIVE', 'DELINQUENT', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('PURCHASE', 'REVERSAL', 'PAYMENT', 'INTEREST', 'LATE_FEE', 'COLLATERAL_APPLICATION');

-- CreateEnum
CREATE TYPE "Bucket" AS ENUM ('PRINCIPAL', 'DEFERRED', 'INTEREST', 'FEES');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('DEBIT', 'CREDIT');

-- CreateTable
CREATE TABLE "card_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" TEXT NOT NULL,
    "custody_account_id" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "CardAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "principal" BIGINT NOT NULL DEFAULT 0,
    "deferred" BIGINT NOT NULL DEFAULT 0,
    "interest" BIGINT NOT NULL DEFAULT 0,
    "fees" BIGINT NOT NULL DEFAULT 0,
    "limit_cap" BIGINT,
    "cycle_day" INTEGER NOT NULL,
    "terms_version" INTEGER NOT NULL,
    "closure_key" TEXT,
    "closure_reason" TEXT,
    "closure_debt" BIGINT,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "card_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "type" "MovementType" NOT NULL,
    "bucket" "Bucket" NOT NULL,
    "direction" "Direction" NOT NULL,
    "amount" BIGINT NOT NULL,
    "bucket_balance_after" BIGINT NOT NULL,
    "reference_movement_id" UUID,
    "statement_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movements_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE UNIQUE INDEX "card_accounts_custody_account_id_key" ON "card_accounts"("custody_account_id");

-- CreateIndex
CREATE INDEX "card_accounts_owner_id_idx" ON "card_accounts"("owner_id");

-- CreateIndex
CREATE INDEX "card_accounts_status_idx" ON "card_accounts"("status");

-- CreateIndex
CREATE INDEX "movements_account_id_created_at_idx" ON "movements"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "movements_reference_movement_id_idx" ON "movements"("reference_movement_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "card_accounts" ADD CONSTRAINT "card_accounts_balances_nonnegative"
  CHECK ("principal" >= 0 AND "deferred" >= 0 AND "interest" >= 0 AND "fees" >= 0);
ALTER TABLE "card_accounts" ADD CONSTRAINT "card_accounts_cycle_day_valid" CHECK ("cycle_day" IN (1, 15));
ALTER TABLE "card_accounts" ADD CONSTRAINT "card_accounts_limit_cap_nonnegative" CHECK ("limit_cap" IS NULL OR "limit_cap" >= 0);
ALTER TABLE "movements" ADD CONSTRAINT "movements_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "movements" ADD CONSTRAINT "movements_balance_nonnegative" CHECK ("bucket_balance_after" >= 0);

CREATE UNIQUE INDEX "movements_single_reversal" ON "movements" ("reference_movement_id") WHERE "type" = 'REVERSAL';

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "movements_immutable" BEFORE UPDATE OR DELETE ON "movements"
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER "audit_log_immutable" BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
