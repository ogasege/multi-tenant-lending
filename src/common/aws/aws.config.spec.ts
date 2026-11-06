import { awsClientConfig, s3ClientConfig } from './aws.config';

describe('AWS client config', () => {
  it('relies on the default credential chain (task role) when no endpoint is set', () => {
    const config = s3ClientConfig({ AWS_REGION: 'af-south-1', AWS_ENDPOINT_URL: undefined });
    expect(config).toEqual({ region: 'af-south-1' });
  });

  it('targets LocalStack with path-style S3 and dummy credentials when an endpoint is set', () => {
    const env = { AWS_REGION: 'af-south-1', AWS_ENDPOINT_URL: 'http://localhost:4566' };
    expect(awsClientConfig(env)).toEqual({
      region: 'af-south-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    expect(s3ClientConfig(env)).toMatchObject({ forcePathStyle: true });
  });
});
