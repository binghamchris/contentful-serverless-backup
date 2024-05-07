# System Deployment
This directory contains the code needed to deploy the solution on AWS, including:

- `deploy.yaml`: a CloudFormation template defining the AWS resources needed for the solution.
- `build-backup-lambda.js`: a Node.js script which deploys the code for the backup Lambda function and it's dependencies into a Lambda function created by `deploy.yaml`.
- `build-filter-lambda.js`: a Node.js script which deploys the code for the filter Lambda function and it's dependencies into a Lambda function created by `deploy.yaml`.

## Deployment Process
There are four steps to deploying the solution:

1. Configure Build Notifications in AWS Amplify
2. Create Parameters in AWS Systems Manager Parameter Store
3. Deploy the CloudFormation Template
4. Deploy the Lambda Function Code

Each of these steps is described in detail below.

### 1. Configure Build Notifications in AWS Amplify
Unfortunately the AWS Amplify does not provide a means to automate the configuration of build notifications, so this step must be performed manually.

In the AWS Amplify console, under `Hosting > Build notifications` configure notifications for at least one email address for 'All branches'.

This will result in the creation of SNS topics for:
- All branches
- One topic for each branch in the Amplify application

Select one of these topics to serve as the event source to trigger the backup system and make a note of its ARN for use in step 3.

### 2. Create Parameters in AWS Systems Manager Parameter Store
In order to backup content from Contentful, the backup Lambda function requires both a management and a delivery token for the relevant Contentful space. Maintaining the security of these tokens is of paramount importance as together they permit full read and write access to the Contentful space.

For this reason, these tokens should be stored in either AWS Systems Manager (SSM) Parameter Store as `SecureString` parameters or in AWS Secrets Manager. This solution uses SSM Parameter Store.

Create two `SecureString` parameters in Parameter Store, one each for the management and delivery tokens, and store the tokens in them. Make a note of the parameters' ARNs for use in step 3.

### 3. Deploy the CloudFormation Template
Deploy the CloudFormation template providing the following template parameters:

- `ContentfulSpaceId`: The ID of the Contentful space to be backed up, to which the management and delivery tokens provide access.
- `ContentfulDeliveryTokenArn`: The ARN of the parameter in SSM Parameter Store containing the delivery token.
- `ContentfulManagementTokenArn`: The ARN of the parameter in SSM Parameter Store containing the management token.
- `ContentfulSpaceEnvironment`: The name of the environment in the Contentful space to backup. To achieve a full backup of the space's configuration this must be `master`.
- `InitialStorageClass`: The S3 storage class which the backup Lambda function shall set on backup files when they are first uploaded to the S3 bucket.
- `LastUpdateWindow`: The time window, in minutes, since the last data update within which a backup is required.
- `LastUpdateUrl`: The URL of the static API providing the last update timestamp(s) for the data in Contentful. Please see the filter Lambda function's README for more details.
- `LongTermStorageClass`: The S3 storage class to transition backups to via the S3 bucket's lifecycle configuration.
- `SnsTopicArn`: The ARN of the SNS topic, created by AWS Amplify, which shall serve as the event source to trigger the backup system.
- `S3BackupBucketName`: The name for the S3 bucket, which will be created and configured to store the backups.

The CloudFormation template will deploy the two Lambda functions with non-functional placeholder code, which will be replaced in the next step.

### 4. Deploy the Lambda Function Code

**Please Note:** This step assumes that the workstation being used has the AWS CLI configured with credentials which have the `lambda:UpdateFunctionCode` permission on the Lambda functions deployed in the previous step.

To minimise infrastructure requirements and ongoing costs, this solution deploys the Node.js code and npm dependencies for each Lambda function as a ZIP file directly from a local workstation.

The deployment scripts source their configuration from a `.env` file in the `deploy` directory. Create a file named `.env` containing the following environment variables:

- `AWS_PROFILE_NAME`: The name of the profile configured in for the AWS CLI to use with the deployment scripts.
- `BACKUP_LAMBDA_FUNC_NAME`: The name of the backup Lambda function. The default value is `contentful-backup`.
- `FILTER_LAMBDA_FUNC_NAME`: The name of the filter Lambda function. The default value is `amplify-notification-filter`.

Once the `.env` file is in place, run the following commands to build and deploy the Lambda function code and dependencies:

1. In the `backup-lambda` directory run: `npm i` to install its dependencies.
2. In the `filter-lambda` directory run: `npm i` to install its dependencies.
3. In the `deploy` directory run: `node build-backup-lambda.js` to deploy the backup Lambda function's code and dependencies.
4. In the `deploy` directory run: `node build-filter-lambda.js` to deploy the filters Lambda function's code and dependencies.