import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { DomainError } from './errors.js';

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse()
      .status(error.status)
      .json({ code: error.code, message: error.message });
  }
}
