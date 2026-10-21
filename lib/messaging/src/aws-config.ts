export interface AwsClientConfig {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function awsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AwsClientConfig {
  const endpoint = env.AWS_ENDPOINT_URL;
  if (endpoint) {
    return {
      region: env.LOCAL_AWS_REGION ?? 'us-east-1',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    };
  }
  return { region: env.AWS_REGION ?? 'us-east-1' };
}
