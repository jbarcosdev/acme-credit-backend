import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { IsMinorUnits } from '@acme/nest-common';

export class RequestCardDto {
  @IsUUID()
  custodyAccountId!: string;

  @IsInt()
  @IsIn([1, 15])
  cycleDay!: number;
}

export class AuthorizeDto {
  @IsMinorUnits()
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  merchant?: string;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(60)
  installments?: number;
}

export class PaymentDto {
  @IsMinorUnits()
  amount!: number;
}

export class LimitReductionDto {
  @IsMinorUnits({ min: 0 })
  newCupo!: number;
}
