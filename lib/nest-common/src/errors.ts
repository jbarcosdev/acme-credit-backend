export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 404);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

export class UnprocessableError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 422);
  }
}

export class ServiceUnavailableError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 503);
  }
}
