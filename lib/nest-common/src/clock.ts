export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = date;
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

export class OffsetClock extends Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advanceDays(days: number): void {
    if (!Number.isFinite(days) || days < 0)
      throw new RangeError('the clock can only move forward');
    this.offsetMs += days * 86_400_000;
  }

  advanceTo(date: Date): void {
    const target = date.getTime();
    if (!Number.isFinite(target) || target < this.now().getTime())
      throw new RangeError('the clock can only move forward');
    this.offsetMs = target - Date.now();
  }
}
