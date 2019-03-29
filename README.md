# aws-monitoring-functions

1. npm install in each sub package
2. Zip the directory
3. Upload the zip to AWS Lambda

## Lambda configurations

### IAM Roles

- `AWSLambdaBasicExecutionRole` for CloudWatch Logs
- Read access for the target services like `AmazonEC2ReadOnlyAccess`
- Write access for the S3 bucket if `writeToS3` is true

### Event Params

- `regions`: region code array to check instances. default: all regions
- `writeToS3`: set true to write CSV to S3
- `postToSlack`: set true to port alerts to Slack channel

### Environment Variables

- `S3_BUCKET`: S3 bucket name to write CSV. requred if `writeToS3` is true
- `SLACK_WEBHOOK_URL`: Slack webhook URL to post alerts (See Slack Incoming WebHooks integration). required if `postToSlack` is true 
