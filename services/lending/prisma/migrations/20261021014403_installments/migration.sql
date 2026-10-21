-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MovementType" ADD VALUE 'INSTALLMENT_PRINCIPAL';
ALTER TYPE "MovementType" ADD VALUE 'INSTALLMENT_INTEREST';

-- AlterTable
ALTER TABLE "movements" ADD COLUMN     "installments" INTEGER,
ADD COLUMN     "rate_bps" INTEGER;

-- AlterTable
ALTER TABLE "statements" ADD COLUMN     "deferred_balance" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deferred_purchases" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "installment_details" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "installment_interest" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "installment_principal" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "installment_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "purchase_movement_id" UUID NOT NULL,
    "principal" BIGINT NOT NULL,
    "installments" INTEGER NOT NULL,
    "apr_bps" INTEGER NOT NULL,
    "installment_amount" BIGINT NOT NULL,
    "remaining_principal" BIGINT NOT NULL,
    "billed_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "installment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installment_plans_purchase_movement_id_key" ON "installment_plans"("purchase_movement_id");

-- CreateIndex
CREATE INDEX "installment_plans_account_id_status_idx" ON "installment_plans"("account_id", "status");

-- AddForeignKey
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_purchase_movement_id_fkey" FOREIGN KEY ("purchase_movement_id") REFERENCES "movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "statements" DROP CONSTRAINT "statements_balance_identity";
ALTER TABLE "statements" ADD CONSTRAINT "statements_balance_identity" CHECK (
  "closing_balance" = "opening_balance" + "purchases" + "interest_charged" + "fees_charged"
    + "installment_principal" + "installment_interest" - "reversals" - "payments"
);

ALTER TABLE "movements" ADD CONSTRAINT "movements_installments_valid" CHECK (
  ("installments" IS NULL AND "rate_bps" IS NULL) OR ("installments" >= 2 AND "rate_bps" >= 0 AND "bucket" = 'DEFERRED' AND "type" = 'PURCHASE')
);

ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_consistent" CHECK (
  "installments" >= 2 AND "apr_bps" >= 0 AND "principal" > 0 AND "installment_amount" > 0
  AND "remaining_principal" >= 0 AND "remaining_principal" <= "principal"
  AND "billed_count" >= 0 AND "billed_count" <= "installments"
  AND "status" IN ('ACTIVE', 'COMPLETED', 'ACCELERATED')
);
