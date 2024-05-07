# Amplify Notification Filter Lambda Function
This Lambda function processes SNS notifications emitted by AWS Amplify and data obtained from a static API about when the site's data in Contentful was last updated to determine whether a backup is needed.

## Environment Variables
The following environment variables are required for this Lambda function:

- `LAST_UPDATE_WINDOW`: The time window, in minutes, since the last data update within which a backup is required.
- `LAST_UPDATE_API_URL`: The URL of the static API providing the last update timestamp(s) for the data in Contentful.
- `SQS_QUEUE_URL`: The URL of the SQS queue to send backup requests to.

## Inputs
The following inputs are processed by this Lambda function:

- An SNS record containing a build status notification from AWS Amplify. The function is designed for a batch size of 1 and will process only the first record if multiple records are included in the input.

## Outputs
The following outputs are produced by this Lambda function:

- A SQS message published to the SQS queue defined in the environment variable `SQS_QUEUE_URL`.