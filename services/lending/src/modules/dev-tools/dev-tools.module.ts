import { Module } from '@nestjs/common';
import { DevClockController } from './dev-clock.controller.js';

@Module({ controllers: [DevClockController] })
export class DevToolsModule {}
