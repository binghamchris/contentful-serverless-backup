# Implementation Plan: Project Quality Overhaul

## Overview

Incremental quality overhaul of the event-driven Contentful backup system. Each task group addresses a logical area (backup-lambda, filter-lambda, infrastructure, build scripts, documentation, testing). All changes are non-functional and preserve existing system behavior (Requirement 0). Functions are extracted for testability as needed. Property-based tests use fast-check with Node.js built-in test runner.

## Tasks

- [x] 1. Set up test infrastructure and extract testable functions from backup-lambda
  - [x] 1.1 Create `tests/` directory structure and install fast-check as a dev dependency in a root-level `package.json`
    - Create directories: `tests/backup-lambda/`, `tests/filter-lambda/`, `tests/deploy/`, `tests/infrastructure/`
    - Add root `package.json` with `fast-check` dev dependency and a `test` script using `node --test`
    - _Requirements: 0_

  - [x] 1.2 Extract testable helper functions from `backup-lambda/index.js` into exportable modules
    - Extract SSM token parsing logic into an exported `parseSSMParameters(parameters, managementArn, deliveryArn)` function
    - Extract S3 key generation logic into an exported `generateS3Key(date)` function
    - Extract `sendResponse`, `uploadFile`, `deleteMessageAsync` as named exports
    - Move `require()` calls and SDK client instantiations (`S3Client`, `SQSClient`, `SSMClient`) to module scope
    - Ensure the handler uses the extracted functions — no behavior change
    - _Requirements: 10.1, 0.1, 0.2, 0.3_

  - [x] 1.3 Apply bug fixes to backup-lambda
    - Add `break` after each `case` in the SSM parsing switch (now in extracted function)
    - Change `=` to `===` in `uploadFile` status check
    - Add `return` before each `sendResponse()` call in the handler
    - Replace `for(param in ...)` with `Object.entries()` or `for...of` with own-property safety in SSM parsing
    - Change `var response` to `const response` in `sendResponse`
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 3.1, 11.1, 12.1_

  - [x] 1.4 Write property test: SSM token parsing (Property 1)
    - **Property 1: SSM token parsing assigns each token to its correct variable**
    - File: `tests/backup-lambda/ssm-parsing.property.test.js`
    - Generate random token pairs in random order; verify correct assignment
    - **Validates: Requirements 1.1, 1.2**

  - [x] 1.5 Write property test: Upload status check (Property 2)
    - **Property 2: Upload status check returns true only for HTTP 200**
    - File: `tests/backup-lambda/upload-file.property.test.js`
    - Generate random HTTP status codes; verify `uploadFile` returns true iff status === 200
    - **Validates: Requirements 2.1, 2.2**

  - [x] 1.6 Write property test: S3 object key format (Property 3)
    - **Property 3: S3 object key format is deterministic and correct**
    - File: `tests/backup-lambda/s3-key-format.property.test.js`
    - Generate random Date objects; verify key matches `YYYY/MM/DD/YYYY-MM-DD_HH-mm-ss.sssZ.zip`
    - **Validates: Requirements 0.3**

  - [x] 1.7 Write property test: sendResponse shape (Property 10)
    - **Property 10: sendResponse produces a well-formed response object**
    - File: `tests/backup-lambda/send-response.property.test.js`
    - Generate random status codes and body strings; verify output shape
    - **Validates: Requirements 3.1, 3.2, 12.1, 12.2**

  - [x] 1.8 Write property test: Own-property iteration — backup side (Property 5)
    - **Property 5: Object iteration processes only own properties (backup-lambda)**
    - File: `tests/backup-lambda/own-property.property.test.js`
    - Generate objects with inherited prototype properties; verify only own properties processed
    - **Validates: Requirements 11.1**


- [x] 2. Checkpoint — Verify backup-lambda changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Refactor filter-lambda and apply fixes
  - [x] 3.1 Extract testable helper functions from `filter-lambda/index.js` into exportable modules
    - Extract `sendResponse`, `processMessageAsync`, `getLastUpdateTimestamp` as named exports
    - Move `require('@aws-sdk/client-sqs')` and `SQSClient` instantiation to module scope
    - Ensure the handler uses the extracted functions — no behavior change
    - _Requirements: 10.2, 0.1, 0.4, 0.6_

  - [x] 3.2 Apply bug fixes and improvements to filter-lambda
    - Remove `console.log(process.env)` from the handler
    - Add `return` before each `sendResponse()` call in the handler
    - Declare `thisTableUpdate` with `let` and loop variable with `const` in `getLastUpdateTimestamp`
    - Replace `for(table in json)` with `Object.entries()` or guarded own-property iteration
    - Change `var response` to `const response` in `sendResponse`
    - Replace `sync-fetch` with built-in async `fetch` + `await` in `getLastUpdateTimestamp`; make function `async` and add `await` at call site
    - _Requirements: 6.1, 6.2, 3.2, 4.1, 4.2, 11.2, 12.2, 13.1, 13.2_

  - [x] 3.3 Remove `sync-fetch` dependency from `filter-lambda/package.json`
    - Remove `sync-fetch` from the dependencies object
    - _Requirements: 13.3_

  - [x] 3.4 Write property test: SUCCEED check (Property 4)
    - **Property 4: Filter Lambda SUCCEED check**
    - File: `tests/filter-lambda/succeed-check.property.test.js`
    - Generate random strings; verify `processMessageAsync` returns true iff string contains "SUCCEED"
    - **Validates: Requirements 0.6**

  - [x] 3.5 Write property test: Latest timestamp (Property 6)
    - **Property 6: getLastUpdateTimestamp returns the most recent timestamp**
    - File: `tests/filter-lambda/latest-timestamp.property.test.js`
    - Generate JSON objects with random ISO timestamps; verify function returns the maximum
    - **Validates: Requirements 13.1**

  - [x] 3.6 Write property test: Own-property iteration — filter side (Property 5)
    - **Property 5: Object iteration processes only own properties (filter-lambda)**
    - File: `tests/filter-lambda/own-property.property.test.js`
    - Generate objects with inherited prototype properties; verify only own properties processed
    - **Validates: Requirements 11.2**

- [x] 4. Checkpoint — Verify filter-lambda changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Update CloudFormation template and move to infrastructure/
  - [x] 5.1 Create `infrastructure/template.yaml` from `deploy/deploy.yaml` with all infrastructure changes
    - Move/copy `deploy/deploy.yaml` to `infrastructure/template.yaml`
    - Remove `s3:PutObject` permission from `FilterLambdaRole`
    - Add `BucketEncryption` with SSE-S3 (AES256) to `BackupBucket`
    - Add `VersioningConfiguration: Status: Enabled` to `BackupBucket`
    - Add `DeadLetterQueue` FIFO resource with 14-day retention
    - Add `RedrivePolicy` on `SQSQueue` pointing to DLQ with `maxReceiveCount: 3`
    - Grant `BackupLambdaRole` permissions on the DLQ (sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes)
    - Change `SQSQueue` `VisibilityTimeout` from 450 to 1800
    - Add `BackupLambdaFunctionName` and `FilterLambdaFunctionName` parameters with defaults `contentful-backup` and `amplify-notification-filter`
    - Replace all hardcoded Lambda function name references with `!Ref` / `!Sub` using the new parameters
    - _Requirements: 7.1, 7.2, 8.1, 9.1, 9.2, 9.3, 17.1, 18.1, 18.2, 19.1, 20.1, 0.5_

  - [x] 5.2 Delete the old `deploy/deploy.yaml` file
    - _Requirements: 17.1_

  - [x] 5.3 Write property test: No hardcoded Lambda names in template (Property 9)
    - **Property 9: CloudFormation template uses no hardcoded Lambda function names outside parameter defaults**
    - File: `tests/infrastructure/template.property.test.js`
    - Parse YAML template; scan all resource properties and IAM ARNs for hardcoded function name strings
    - **Validates: Requirements 18.2**

  - [x] 5.4 Write unit tests for CloudFormation template structure
    - File: `tests/infrastructure/template.unit.test.js`
    - Verify FilterLambdaRole has no s3:PutObject (Req 7.1)
    - Verify BackupBucket has BucketEncryption (Req 8.1)
    - Verify DLQ resource, RedrivePolicy, and IAM permissions exist (Req 9.1–9.3)
    - Verify BackupLambdaFunctionName and FilterLambdaFunctionName parameters with correct defaults (Req 18.1)
    - Verify BackupBucket has VersioningConfiguration enabled (Req 19.1)
    - Verify SQS VisibilityTimeout ≥ 1800 (Req 20.1)
    - Verify all existing parameters retained (Req 0.5)
    - _Requirements: 7.1, 8.1, 9.1, 9.2, 9.3, 18.1, 19.1, 20.1, 0.5_

- [x] 6. Checkpoint — Verify infrastructure changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Consolidate build scripts into unified deploy/build-lambda.js
  - [x] 7.1 Create `deploy/build-lambda.js` as the unified build script
    - Accept CLI argument (`backup` or `filter`) to select Lambda target
    - Map argument to correct source path, env var name, and zip filename
    - Use `Buffer.from()` instead of `new Buffer.from()`
    - Wrap main logic in async IIFE; `await` the `updateLambda()` call
    - Use strict equality `=== 200` for deployment status check
    - Show usage message and exit for missing/invalid arguments
    - Exit with non-zero code on deployment failure
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 15.1, 16.1, 16.2, 5.1, 5.2_

  - [x] 7.2 Delete old build scripts `deploy/build-backup-lambda.js` and `deploy/build-filter-lambda.js`
    - _Requirements: 14.2_

  - [x] 7.3 Write property test: Build config selection (Property 7)
    - **Property 7: Build script config selection maps arguments to correct Lambda configuration**
    - File: `tests/deploy/config-selection.property.test.js`
    - Generate from valid identifiers; verify correct path, env var, and zip filename mapping
    - **Validates: Requirements 14.1, 14.3**

  - [x] 7.4 Write property test: Build deployment status check (Property 8)
    - **Property 8: Build script deployment status check returns success only for HTTP 200**
    - File: `tests/deploy/deploy-status.property.test.js`
    - Generate random HTTP status codes; verify success reported iff status === 200
    - **Validates: Requirements 5.1, 5.2**

  - [x] 7.5 Write unit tests for build script
    - File: `tests/deploy/build-script.unit.test.js`
    - Verify usage message displayed with no/invalid args (Req 14.4)
    - Verify non-zero exit on Lambda API failure (Req 16.2)
    - _Requirements: 14.4, 16.2_

- [-] 8. Checkpoint — Verify build script changes
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Update documentation
  - [~] 9.1 Create `deploy/.env.example` with placeholder values
    - Include `AWS_PROFILE_NAME`, `BACKUP_LAMBDA_FUNC_NAME`, `FILTER_LAMBDA_FUNC_NAME` with placeholder values
    - _Requirements: 21.1, 21.2_

  - [~] 9.2 Update `deploy/README.md`
    - Fix "it's dependencies" → "its dependencies" in all occurrences
    - Update CloudFormation template path reference from `deploy/deploy.yaml` to `infrastructure/template.yaml`
    - Update build script instructions to reference unified `build-lambda.js` instead of individual scripts
    - _Requirements: 22.1, 17.2, 14.2_

  - [~] 9.3 Write unit tests for documentation
    - File: `tests/backup-lambda/handler.unit.test.js` and `tests/filter-lambda/handler.unit.test.js` (add doc-related assertions)
    - Verify `.env.example` exists with all required variables (Req 21.1, 21.2)
    - Verify README contains "its dependencies" not "it's dependencies" (Req 22.1)
    - Verify template file exists at `infrastructure/template.yaml` (Req 17.1)
    - _Requirements: 21.1, 21.2, 22.1, 17.1_

- [ ] 10. Write remaining handler unit tests for both Lambdas
  - [~] 10.1 Write unit tests for backup-lambda handler
    - File: `tests/backup-lambda/handler.unit.test.js`
    - Verify Contentful export options object has exact expected keys/values (Req 0.2)
    - Verify handler returns sendResponse result (Req 3.1)
    - Verify SQS delete is called only after successful S3 upload — mock-based (Req 0.7)
    - Verify unknown ARN in SSM response is skipped (Req 1.3)
    - _Requirements: 0.2, 0.7, 1.3, 3.1_

  - [~] 10.2 Write unit tests for filter-lambda handler
    - File: `tests/filter-lambda/handler.unit.test.js`
    - Verify handler returns sendResponse result (Req 3.2)
    - Verify SQS message uses correct deduplication and group IDs (Req 0.4)
    - Verify sync-fetch is not in filter-lambda package.json (Req 13.3)
    - _Requirements: 0.4, 3.2, 13.3_

- [~] 11. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties (Properties 1–10 from design)
- Unit tests validate specific examples, edge cases, and structural requirements
- All SDK client instantiations are moved to module scope for Lambda warm-start performance
- Functions are extracted for testability without changing any behavior
