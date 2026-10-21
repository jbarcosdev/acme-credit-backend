import { awsConfigFromEnv } from './aws-config.js';

describe('awsConfigFromEnv', () => {
  it('ignores the developer shell region and credentials when an emulator endpoint is configured', () => {
    const config = awsConfigFromEnv({
      AWS_ENDPOINT_URL: 'http://localhost:4566',
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'AKIAREALKEY',
      AWS_SECRET_ACCESS_KEY: 'real-secret',
    });
    expect(config).toEqual({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  it('lets the emulator region be chosen explicitly', () => {
    expect(
      awsConfigFromEnv({
        AWS_ENDPOINT_URL: 'http://localhost:4566',
        LOCAL_AWS_REGION: 'eu-west-1',
      }).region,
    ).toBe('eu-west-1');
  });

  it('uses the regular AWS region and the default credential chain without an endpoint', () => {
    expect(awsConfigFromEnv({ AWS_REGION: 'us-west-2' })).toEqual({
      region: 'us-west-2',
    });
    expect(awsConfigFromEnv({})).toEqual({ region: 'us-east-1' });
  });
});
