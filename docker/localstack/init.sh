#!/bin/sh
set -e

awslocal sns create-topic --name custody-events >/dev/null

awslocal sqs create-queue --queue-name lending-limit-events-dlq >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/lending-limit-events-dlq --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue --queue-name lending-limit-events \
  --attributes "{\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null

awslocal sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:000000000000:custody-events \
  --protocol sqs \
  --notification-endpoint arn:aws:sqs:us-east-1:000000000000:lending-limit-events \
  --attributes RawMessageDelivery=true >/dev/null

echo "localstack resources ready"
