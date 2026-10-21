import { Injectable, NotFoundException } from '@nestjs/common';
import type { CurrentUserInfo } from './current-user.js';

export abstract class AccessPolicy {
  abstract assertCanAccessOwned(user: CurrentUserInfo, ownerId: string): void;
}

@Injectable()
export class LocalAccessPolicy extends AccessPolicy {
  assertCanAccessOwned(user: CurrentUserInfo, ownerId: string): void {
    if (user.isService()) return;
    if (user.userId !== ownerId) throw new NotFoundException();
  }
}
