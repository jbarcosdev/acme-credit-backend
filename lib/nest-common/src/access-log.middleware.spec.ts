import { Logger } from '@nestjs/common';
import { AccessLogMiddleware } from './access-log.middleware.js';

describe('AccessLogMiddleware', () => {
  it('logs the request without headers, query string or body', () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation(
      (message: unknown) => void lines.push(message),
    );
    const cls = {
      isActive: () => true,
      getId: () => 'corr-1',
      get: () => ({ id: 'user-1', type: 'user' }),
    };
    const middleware = new AccessLogMiddleware(cls as never);
    let finish: () => void = () => undefined;
    const res = {
      statusCode: 201,
      on: (_event: string, listener: () => void) => void (finish = listener),
    };
    const req = {
      method: 'POST',
      url: '/accounts/1/payments?secret=abc',
      headers: { authorization: 'Bearer secret-token' },
      body: { amount: 1 },
    };

    middleware.use(req, res, () => undefined);
    finish();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      method: 'POST',
      path: '/accounts/1/payments',
      status: 201,
      actorId: 'user-1',
      correlationId: 'corr-1',
    });
    expect(JSON.stringify(lines[0])).not.toContain('secret');
  });
});
