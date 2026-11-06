import { awsClientConfig, s3ClientConfig, s3PresignClientConfig } from './aws.config';

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

  it('signs browser-facing URLs for S3_PUBLIC_ENDPOINT_URL, keeping server calls internal', () => {
    const env = {
      AWS_REGION: 'af-south-1',
      AWS_ENDPOINT_URL: 'http://localstack:4566',
      S3_PUBLIC_ENDPOINT_URL: 'http://localhost:4566',
    };
    expect(s3ClientConfig(env)).toMatchObject({ endpoint: 'http://localstack:4566' });
    expect(s3PresignClientConfig(env)).toEqual({
      region: 'af-south-1',
      endpoint: 'http://localhost:4566',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  it('presigns exactly like the server-side client when no public endpoint is set', () => {
    const env = { AWS_REGION: 'af-south-1', AWS_ENDPOINT_URL: undefined };
    expect(s3PresignClientConfig(env)).toEqual(s3ClientConfig(env));
    expect(
      s3PresignClientConfig({ ...env, S3_PUBLIC_ENDPOINT_URL: 'https://s3.example.com' }),
    ).toEqual({ region: 'af-south-1', endpoint: 'https://s3.example.com', forcePathStyle: true });
  });
});
