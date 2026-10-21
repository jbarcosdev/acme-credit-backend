import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { RequirePrincipal, RequireScopes } from '@acme/auth';
import { SCOPES } from '@acme/contracts';
import { Clock, OffsetClock } from '@acme/nest-common';

@Controller('internal/dev/clock')
@RequirePrincipal('service')
@RequireScopes(SCOPES.jobsRun)
export class DevClockController {
  constructor(private readonly clock: Clock) {}

  @Get()
  current() {
    return { now: this.offsetClock().now().toISOString() };
  }

  @Post()
  advance(@Body() body: { days?: number; to?: string }) {
    const clock = this.offsetClock();
    try {
      if (body.to !== undefined) clock.advanceTo(new Date(body.to));
      else if (body.days !== undefined) clock.advanceDays(body.days);
      else throw new RangeError('send days or to');
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return { now: clock.now().toISOString() };
  }

  private offsetClock(): OffsetClock {
    if (!(this.clock instanceof OffsetClock)) throw new NotFoundException();
    return this.clock;
  }
}
