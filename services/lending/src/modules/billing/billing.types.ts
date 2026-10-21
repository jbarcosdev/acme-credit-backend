import type { Prisma } from '../../generated/prisma/client.js';

export type Tx = Prisma.TransactionClient;

export interface StatementView {
  id: string;
  cycleNumber: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  openingBalance: number;
  purchases: number;
  reversals: number;
  payments: number;
  interestCharged: number;
  feesCharged: number;
  closingBalance: number;
  minimumPayment: number;
  termsVersion: number;
}
