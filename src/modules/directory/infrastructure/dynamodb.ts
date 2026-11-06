import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { type AwsEnv, awsClientConfig } from '../../../common/aws/aws.config';

/**
 * DynamoDB document client for the tenant directory. Uses the shared AWS client settings:
 * the ECS task role in AWS, LocalStack (`AWS_ENDPOINT_URL`) locally and in tests. The global
 * table has a replica in every cell region, so reads always stay in-region.
 */
export function createDirectoryDocumentClient(env: AwsEnv): DynamoDBDocumentClient {
  const client = new DynamoDBClient({ ...awsClientConfig(env), maxAttempts: 3 });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
