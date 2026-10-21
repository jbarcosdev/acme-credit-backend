export interface AwsClientConfig {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function awsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AwsClientConfig {
  const endpoint = env.AWS_ENDPOINT_URL;
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  };
}
