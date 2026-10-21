import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';
import { IsMinorUnits } from '@acme/nest-common';

export class OpenAccountDto {
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;
}

export class CreateDepositDto {
  @IsString()
  @IsNotEmpty()
  bankId!: string;

  @IsMinorUnits()
  amount!: number;
}

export class SettlementDto {
  @IsMinorUnits({ min: 0 })
  applyAmount!: number;
}

export class LimitReductionDto {
  @IsMinorUnits({ min: 0 })
  newCupo!: number;
}
