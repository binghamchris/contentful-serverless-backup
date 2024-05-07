# Event-Driven Contentful Backups for AWS Amplify-hosted Apps
A solution for efficently backing up entries and assets from [Contentful](https://www.contentful.com) where the frontend is hosted on [AWS Amplify](https://aws.amazon.com/amplify/).

This solution follows an event-driven architecture pattern which leverages SNS notifications emitted by AWS Amplify during the build process to trigger the backup process. These notifications are processed by a small AWS Lambda function which determines whether a backup is required, and if so queues the backup via an AWS SQS queue.

This AWS SQS queue uses message deduplication to avoid multiple backups being triggered in a short period of time. A larger Lambda function processes messages from the AWS SQS queue and performs the backup, storing the resulting ZIP file in AWS S3.

## Repository Structure
This repository contains the following directories, each of which has its own readme.

- `backup-lambda`: Code for the Lambda function which performs the backups of Contentful.
- `deploy`: A CloudFormation template to deploy the required AWS resources, and scripts to deploy the code and dependencies into the Lambda functions.
- `filter-lambda`: Code for the Lambda function which processes SNS notifications from AWS Amplify to determine when backups are required.

## License
This work is licensed under a [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License][cc-by-nc-sa].
[![CC BY-NC-SA 4.0][cc-by-nc-sa-image]][cc-by-nc-sa]

[cc-by-nc-sa]: http://creativecommons.org/licenses/by-nc-sa/4.0/
[cc-by-nc-sa-image]: https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png
[cc-by-nc-sa-shield]: https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg

Full license details can be found here: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode