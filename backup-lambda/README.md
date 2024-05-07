# Contentful Backup Lambda Function
This Lambda function backups up a given Contentful space and environment after being triggered by an SQS message.

## Environment Variables
The following environment variables are required for this Lambda function:

- `DELIVERY_TOKEN_ARN`: The ARN of a `SecureString` parameter in AWS Systems Manager Parameter Store containing a Contentful delivery token for the space to backup.
- `MANAGEMENT_TOKEN_ARN`: The ARN of a `SecureString` parameter in AWS Systems Manager Parameter Store containing a Contentful management token for the space to backup.
- `S3_BUCKET_NAME`: The name of the S3 bucket in which to store the backup ZIP archive.
- `S3_STORAGE_CLASS`: The S3 storage class to use for the backup ZIP archive.
- `SPACE_ENV`: The name of the environment to backup within the Contentful space. This must be `master` in order to fully backup the configuration of the Contentful space.
- `SPACE_ID`: The ID fo the Contentful space to backup.
- `SQS_QUEUE_URL`: The URL of the SQS queue which will trigger this Lambda function.
  
## Inputs
The following inputs are processed by this Lambda function:

- The receipt handle for the SQS message which triggers this Lambda function.

## Outputs
The following outputs are produced by this Lambda function:

- A ZIP archive containing the backup, stored in the defined S3 bucket with the specified S3 storage class.
- The deletion of the SQS message which triggered the backup, on successful completion of the backup.