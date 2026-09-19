# Requirements Document

## Introduction

This specification addresses a comprehensive quality overhaul of the event-driven Contentful backup system for AWS Amplify-hosted apps. A thorough review identified 22 issues spanning bugs, security vulnerabilities, code quality problems, infrastructure misconfigurations, and documentation gaps. This document captures the requirements to resolve every identified issue, organized by category.

The system consists of two Lambda functions (`backup-lambda` and `filter-lambda`), a CloudFormation template, and build/deploy scripts. All components run on Node.js 20.x with AWS SDK v3 on arm64 architecture.

## Glossary

- **Backup_Lambda**: The AWS Lambda function (`backup-lambda/index.js`) that performs Contentful space exports and stores the resulting ZIP archive in S3.
- **Filter_Lambda**: The AWS Lambda function (`filter-lambda/index.js`) that processes SNS notifications from AWS Amplify to determine whether a backup is needed, and queues a message to SQS if so.
- **CloudFormation_Template**: The AWS CloudFormation YAML template (`infrastructure/template.yaml`, currently at `deploy/deploy.yaml`) defining all AWS resources for the system.
- **Build_Script**: The Node.js scripts in the `deploy/` directory that package and deploy Lambda function code (`build-backup-lambda.js` and `build-filter-lambda.js`).
- **Unified_Build_Script**: A single parameterized Node.js script that replaces both individual Build_Scripts.
- **SSM_Parameter**: An AWS Systems Manager Parameter Store SecureString parameter containing a Contentful API token.
- **Backup_Bucket**: The S3 bucket created by the CloudFormation_Template to store Contentful backup archives.
- **SQS_Queue**: The FIFO SQS queue used to decouple the Filter_Lambda from the Backup_Lambda.
- **Handler**: The exported `handler` async function that serves as the entry point for a Lambda function invocation.
- **SendResponse_Function**: The `sendResponse()` helper function present in both Lambda functions that constructs a response object.
- **Deploy_README**: The README file in the `deploy/` directory documenting the deployment process.

## Requirements

### Requirement 0: Preserve Existing System Behavior

**User Story:** As a developer, I want all quality improvements to be strictly non-functional, so that the backup system continues to operate exactly as intended without any change to its observable behavior.

#### Acceptance Criteria

1. THE end-to-end event flow (SNS notification → Filter_Lambda → SQS_Queue → Backup_Lambda → Backup_Bucket) SHALL remain unchanged.
2. THE Contentful export configuration (space ID, environment, tokens, draft inclusion, asset downloads, max allowed limit) SHALL remain unchanged.
3. THE S3 object key path format and ZIP filename convention used by the Backup_Lambda SHALL remain unchanged.
4. THE SQS FIFO deduplication behavior (MessageDeduplicationId and MessageGroupId values) SHALL remain unchanged.
5. THE CloudFormation_Template SHALL remain backward-compatible: all existing parameters SHALL retain their current names, types, and default values, and no existing parameter SHALL be removed.
6. THE Filter_Lambda SHALL continue to evaluate Amplify build status by checking for the string "SUCCEED" in the SNS message body.
7. THE Backup_Lambda SHALL continue to delete the triggering SQS message only after a successful S3 upload.

### Requirement 1: Fix Switch Statement Fall-Through in Backup Lambda SSM Parsing

**User Story:** As a developer, I want the SSM parameter parsing logic to correctly assign each token to its respective variable, so that the Contentful export uses the correct management and delivery tokens.

#### Acceptance Criteria

1. WHEN the Backup_Lambda parses SSM_Parameter responses, THE Backup_Lambda SHALL include a `break` statement after each `case` clause in the `switch` statement to prevent fall-through.
2. WHEN the SSM_Parameter response contains both the management token ARN and the delivery token ARN, THE Backup_Lambda SHALL assign each token value exclusively to its corresponding variable (`contentfulManagementToken` and `contentfulDeliveryToken`).
3. IF the SSM_Parameter response contains an ARN that does not match any expected environment variable, THEN THE Backup_Lambda SHALL skip that parameter without modifying any token variable.

### Requirement 2: Fix Assignment-Instead-of-Comparison in Backup Lambda Upload Check

**User Story:** As a developer, I want the S3 upload result check to use a comparison operator, so that upload failures are correctly detected and reported.

#### Acceptance Criteria

1. WHEN the `uploadFile` function in the Backup_Lambda evaluates the S3 response HTTP status code, THE Backup_Lambda SHALL use a strict equality comparison (`===`) instead of an assignment operator (`=`).
2. WHEN the S3 `PutObject` response returns an HTTP status code other than 200, THE Backup_Lambda SHALL return `false` from the `uploadFile` function and log the failure.

### Requirement 3: Return SendResponse Result from Lambda Handlers

**User Story:** As a developer, I want both Lambda handlers to return the result of `sendResponse()`, so that the Lambda execution context receives a meaningful response object.

#### Acceptance Criteria

1. WHEN the Backup_Lambda Handler calls the SendResponse_Function, THE Backup_Lambda SHALL return the result of that call as the Handler's return value.
2. WHEN the Filter_Lambda Handler calls the SendResponse_Function, THE Filter_Lambda SHALL return the result of that call as the Handler's return value.

### Requirement 4: Declare Loop Variable with Proper Scoping in Filter Lambda

**User Story:** As a developer, I want all variables in the Filter_Lambda to be properly declared, so that no implicit global variables are created.

#### Acceptance Criteria

1. THE Filter_Lambda SHALL declare the `thisTableUpdate` variable in the `getLastUpdateTimestamp` function using `let` or `const` before use.
2. THE Filter_Lambda SHALL declare all `for...in` loop iterator variables using `let` or `const`.

### Requirement 5: Fix Deployment Success Check in Backup Build Script

**User Story:** As a developer, I want the backup Build_Script to correctly detect deployment failures, so that non-200 HTTP status codes are reported as errors.

#### Acceptance Criteria

1. WHEN the `updateLambda` function in the backup Build_Script evaluates the Lambda API response, THE Build_Script SHALL check that the HTTP status code equals 200 using a strict equality comparison (`=== 200`).
2. WHEN the Lambda API response returns an HTTP status code other than 200, THE Build_Script SHALL log an error message including the response details.

### Requirement 6: Remove Environment Variable Logging from Filter Lambda

**User Story:** As a security-conscious developer, I want the Filter_Lambda to not log sensitive environment variables, so that secrets are not exposed in CloudWatch logs.

#### Acceptance Criteria

1. THE Filter_Lambda SHALL NOT contain `console.log(process.env)` or any statement that logs the complete set of environment variables.
2. WHEN the Filter_Lambda Handler is invoked, THE Filter_Lambda SHALL only log non-sensitive operational information.

### Requirement 7: Remove Excess S3 Permission from Filter Lambda Role

**User Story:** As a security-conscious developer, I want the Filter_Lambda IAM role to follow least-privilege, so that it only has permissions it actually needs.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL NOT grant `s3:PutObject` permission to the `FilterLambdaRole`.
2. THE CloudFormation_Template SHALL grant the `FilterLambdaRole` only `sqs:SendMessage`, CloudWatch Logs, and any other permissions the Filter_Lambda actually requires.

### Requirement 8: Enable Server-Side Encryption on Backup Bucket

**User Story:** As a security-conscious developer, I want the Backup_Bucket to have server-side encryption enabled, so that backup data is encrypted at rest.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL configure `BucketEncryption` on the Backup_Bucket resource with SSE-S3 (`AES256`) or SSE-KMS encryption.

### Requirement 9: Configure Dead-Letter Queue for SQS Queue

**User Story:** As a developer, I want failed backup messages to be retained in a dead-letter queue, so that failures are not silently lost.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL define a dead-letter queue (DLQ) resource for the SQS_Queue.
2. THE CloudFormation_Template SHALL configure a `RedrivePolicy` on the SQS_Queue that routes messages to the DLQ after a defined number of receive attempts.
3. THE CloudFormation_Template SHALL grant the Backup_Lambda IAM role permissions to receive and delete messages from the DLQ.

### Requirement 10: Move AWS SDK Client Initialization to Module Scope

**User Story:** As a developer, I want AWS SDK clients and `require()` calls to be at module scope, so that Lambda cold-start performance is improved through execution context reuse.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL declare all `require()` calls and AWS SDK client instantiations (`S3Client`, `SQSClient`, `SSMClient`) at module scope, outside the Handler and helper functions.
2. THE Filter_Lambda SHALL declare all `require()` calls and AWS SDK client instantiations (`SQSClient`) at module scope, outside the Handler and helper functions.

### Requirement 11: Add hasOwnProperty Guards to for...in Loops

**User Story:** As a developer, I want `for...in` loops to include `hasOwnProperty` checks, so that only own properties of objects are iterated.

#### Acceptance Criteria

1. WHEN the Backup_Lambda iterates over object properties using `for...in`, THE Backup_Lambda SHALL include a `hasOwnProperty` check or use `Object.entries()`/`Object.keys()` instead.
2. WHEN the Filter_Lambda iterates over object properties using `for...in`, THE Filter_Lambda SHALL include a `hasOwnProperty` check or use `Object.entries()`/`Object.keys()` instead.

### Requirement 12: Use const for SendResponse Variable Declaration

**User Story:** As a developer, I want the `sendResponse` function in both Lambdas to use `const` for its response variable, so that the code follows modern JavaScript best practices.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL declare the `response` variable in the SendResponse_Function using `const` instead of `var`.
2. THE Filter_Lambda SHALL declare the `response` variable in the SendResponse_Function using `const` instead of `var`.

### Requirement 13: Replace sync-fetch with Built-in Fetch in Filter Lambda

**User Story:** As a developer, I want the Filter_Lambda to use the built-in `fetch` API available in Node.js 20.x, so that the event loop is not blocked by synchronous HTTP requests.

#### Acceptance Criteria

1. THE Filter_Lambda SHALL use the built-in asynchronous `fetch` function (available in Node.js 20.x) instead of the `sync-fetch` library.
2. WHEN the Filter_Lambda calls `fetch`, THE Filter_Lambda SHALL use `await` to handle the asynchronous response.
3. THE Filter_Lambda `package.json` SHALL NOT list `sync-fetch` as a dependency after the migration.

### Requirement 14: Consolidate Build Scripts into a Single Parameterized Script

**User Story:** As a developer, I want a single build script that accepts parameters for which Lambda to deploy, so that code duplication is eliminated.

#### Acceptance Criteria

1. THE Unified_Build_Script SHALL accept a command-line argument or configuration parameter to determine which Lambda function to build and deploy.
2. THE Unified_Build_Script SHALL replace both `build-backup-lambda.js` and `build-filter-lambda.js`.
3. WHEN the Unified_Build_Script is invoked with a valid Lambda identifier, THE Unified_Build_Script SHALL package and deploy the corresponding Lambda function code.
4. IF the Unified_Build_Script is invoked without a valid Lambda identifier, THEN THE Unified_Build_Script SHALL display a usage message listing valid options.

### Requirement 15: Fix Buffer.from() Constructor Usage in Build Scripts

**User Story:** As a developer, I want the build scripts to use the correct `Buffer.from()` static method, so that no deprecation warnings are produced.

#### Acceptance Criteria

1. THE Unified_Build_Script SHALL use `Buffer.from()` instead of `new Buffer.from()` when creating buffers from file data.

### Requirement 16: Await Top-Level Async Function Calls in Build Scripts

**User Story:** As a developer, I want async function calls in build scripts to be properly awaited, so that errors are caught and the process exit code reflects success or failure.

#### Acceptance Criteria

1. WHEN the Unified_Build_Script calls the `updateLambda` async function, THE Unified_Build_Script SHALL `await` the call or use `.then()/.catch()` to handle the result.
2. IF the `updateLambda` function rejects with an error, THEN THE Unified_Build_Script SHALL log the error and exit with a non-zero exit code.

### Requirement 17: Move CloudFormation Template to infrastructure/ Directory

**User Story:** As a developer, I want the CloudFormation template to reside in the `infrastructure/` directory, so that the project follows the established convention for IaC file organization.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL be located at `infrastructure/template.yaml`.
2. THE Deploy_README SHALL reference the new location of the CloudFormation_Template.

### Requirement 18: Parameterize Lambda Function Names in CloudFormation Template

**User Story:** As a developer, I want Lambda function names to be configurable via CloudFormation parameters, so that multiple environments can be deployed without naming conflicts.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL define parameters for the Backup_Lambda function name and the Filter_Lambda function name, with default values matching the current hardcoded names (`contentful-backup` and `amplify-notification-filter`).
2. THE CloudFormation_Template SHALL use these parameters in all resource properties and IAM policy ARNs that reference the Lambda function names.

### Requirement 19: Enable S3 Bucket Versioning on Backup Bucket

**User Story:** As a developer, I want the Backup_Bucket to have versioning enabled, so that backup objects are protected against accidental overwrites or deletions.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL enable `VersioningConfiguration` with a status of `Enabled` on the Backup_Bucket resource.

### Requirement 20: Correct SQS VisibilityTimeout to Meet AWS Recommendation

**User Story:** As a developer, I want the SQS_Queue visibility timeout to be at least 6 times the consuming Lambda's timeout, so that the configuration follows AWS best practices and avoids duplicate processing.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL set the SQS_Queue `VisibilityTimeout` to at least 6 times the Backup_Lambda function timeout (at least 1800 seconds for a 300-second Lambda timeout).

### Requirement 21: Create .env.example File for Deploy Scripts

**User Story:** As a developer, I want a `.env.example` template file in the `deploy/` directory, so that required environment variables are documented in a machine-readable format alongside the code.

#### Acceptance Criteria

1. THE `.env.example` file SHALL exist in the `deploy/` directory.
2. THE `.env.example` file SHALL list all required environment variables (`AWS_PROFILE_NAME`, `BACKUP_LAMBDA_FUNC_NAME`, `FILTER_LAMBDA_FUNC_NAME`) with placeholder values or comments describing expected values.

### Requirement 22: Fix Typographical Errors in Deploy README

**User Story:** As a developer, I want the Deploy_README to use correct grammar, so that the documentation is professional and clear.

#### Acceptance Criteria

1. THE Deploy_README SHALL use "its dependencies" (possessive) instead of "it's dependencies" (contraction) in all occurrences.
