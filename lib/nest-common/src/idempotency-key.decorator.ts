import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';

export const IdempotencyKeyHeader = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const key = context.switchToHttp().getRequest().headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 128) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return key;
  },
);
