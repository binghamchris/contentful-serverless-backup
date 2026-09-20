# System Deployment
This directory contains the code needed to deploy the solution on AWS, including:

- `build-lambda.js`: a Node.js script which deploys the code for a Lambda function and its dependencies into a Lambda function created by the CloudFormation template at `infrastructure/template.yaml`. It accepts a single argument (`backup` or `filter`) to select the target Lambda.

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

This is a **two-pass deployment**. The final `MemorySize` and `EphemeralStorageSize`
can only be measured by running the one-time commissioning export on the deployed
function, so the first pass deploys with the event-source mappings **disabled** and
interim sizing, and a second pass (see step 5) sets the finals.

**First pass** — deploy with the mappings off so no message is consumed before the
code is applied. Run from the repository root (region `eu-central-1`, your `-dev`
profile). Auto-named IAM roles need `CAPABILITY_IAM`:

```bash
aws cloudformation deploy \
  --template-file infrastructure/template.yaml \
  --stack-name contentful-backup \
  --capabilities CAPABILITY_IAM \
  --profile <your-profile-dev> \
  --region eu-central-1 \
  --parameter-overrides \
    SnsTopicArn=<amplify-sns-topic-arn> \
    ContentfulSpaceId=<space-id> \
    ContentfulDeliveryTokenArn=<ssm-arn-of-delivery-token> \
    ContentfulManagementTokenArn=<ssm-arn-of-management-token> \
    ContentfulSpaceEnvironment=master \
    S3BackupBucketName=<globally-unique-bucket-name> \
    InitialStorageClass=STANDARD \
    LongTermStorageClass=GLACIER \
    LastUpdateUrl=<last-update-index-url> \
    AlertEmail=<you@example.com> \
    EventSourceMappingEnabled=false
```

#### Required parameters

- `SnsTopicArn` — ARN of the Amplify build-notification SNS topic that triggers the system.
- `ContentfulSpaceId` — the Contentful space to back up.
- `ContentfulDeliveryTokenArn` — SSM Parameter Store ARN of the delivery token (`SecureString`).
- `ContentfulManagementTokenArn` — SSM Parameter Store ARN of the management token (`SecureString`).
- `ContentfulSpaceEnvironment` — the Contentful environment; use `master` for a full config backup.
- `S3BackupBucketName` — globally-unique name for the backup bucket (created by the stack).
- `InitialStorageClass` — S3 class for freshly-uploaded backups.
- `LongTermStorageClass` — S3 class the lifecycle transitions backups to.
- `LastUpdateUrl` — URL of the static last-update index (see the filter Lambda README).

#### Optional parameters (all defaulted; none is required to deploy)

- `LastUpdateUrlSecondary` (`''`) — a second last-update index; the max timestamp across both is used.
- `TargetBranch` (`''`) — restrict backups to one Amplify branch; empty accepts every branch. The coverage check runs regardless.
- `LastUpdateWindow` (`10`) — minutes since the last data update within which a backup is warranted.
- `BackupLambdaFunctionName` (`contentful-backup`), `FilterLambdaFunctionName` (`amplify-notification-filter`), `NotifierLambdaFunctionName` (`contentful-backup-notifier`).
- `LogRetentionDays` (`90`), `ApplicationLogLevel` (`INFO`; `DEBUG` is the only other value).
- `MaxReceiveCount` (`2`) — source-queue redrive count before the DLQ.
- `MaxAllowedLimit` (`200`) — `contentful-export` page size; the runtime halves it to a floor of 50 on a size error.
- `TransitionDays` (`60`), `NoncurrentVersionRetentionDays` (`210`), `StagingExpiryDays` (`1`).
- `EnableReplication` (`false`), `ReplicationDestinationBucketArn` (`''`), `ReplicationRoleArn` (`''`) — OFF-by-default cross-region replication.
- `EnableObjectLock` (`false`), `ObjectLockRetentionDays` (`30`) — OFF-by-default S3 Object Lock (GOVERNANCE).
- `AlertEmail` (`''`), `SubscribeAlertEmail` (`true`) — failure-alert email. When `SubscribeAlertEmail=true` (the default) you must supply a valid `AlertEmail`; set `SubscribeAlertEmail=false` for a validation-only stack.
- `EventSourceMappingEnabled` (`true`) — set `false` for the first pass, then `true` after code is applied.

**Confirm the email subscription.** After the first deploy, AWS SNS sends a
confirmation email to `AlertEmail`. The alert channel does not work until you click
the confirmation link — do this before relying on failure alerts.

> **One residual manual step (log groups).** The functions write to stack-managed
> log groups (`/aws/lambda/<stack-name>/{backup,filter,notifier}`). AWS Lambda also
> historically created *implicit* groups named `/aws/lambda/<function-name>` on first
> invocation; those are not managed by this stack. Delete them by hand once, after
> cutover, to stop paying their retention:
>
> ```bash
> aws logs delete-log-group --log-group-name /aws/lambda/contentful-backup \
>   --profile <your-profile-dev> --region eu-central-1
> aws logs delete-log-group --log-group-name /aws/lambda/amplify-notification-filter \
>   --profile <your-profile-dev> --region eu-central-1
> ```

### 4. Deploy the Lambda Function Code

The solution deploys each function's code and dependencies as a ZIP via
`UpdateFunctionCode` directly from a workstation (the intentionally low-infrastructure
model). The deploy script is reproducible and gated: it refuses on a dirty git tree,
packages from an allow-list, refuses any credential-shaped file, requires
`node_modules`, tags the deployed commit, and prunes to three published versions. It
reads the three function names from the stack's outputs.

Create `deploy/.env` (see `deploy/.env.example`):

- `AWS_PROFILE_NAME` — the AWS CLI profile (must end `-dev`).
- `STACK_NAME` — the CloudFormation stack name from step 3.

Then, with a **clean git tree**:

```bash
# Install production dependencies for each function (reproducible install)
(cd backup-lambda && npm ci --omit=dev)
(cd filter-lambda && npm ci --omit=dev)
(cd notifier-lambda && npm ci --omit=dev)

# Deploy each function's code
(cd deploy && node build-lambda.js backup)
(cd deploy && node build-lambda.js filter)
(cd deploy && node build-lambda.js notifier)
```

**Enable the mappings.** Once all three functions are on real code, redeploy the
stack from step 3 with `EventSourceMappingEnabled=true` (omit it, since `true` is the
default) to connect the queues.

### 5. Second pass — finalise sizing

Run the one-time commissioning export, read the measured memory/duration envelope
recorded under `docs/`, and redeploy step 3 with the measured `MemorySize`,
`EphemeralStorageSize` and grace period. See the design's sizing section for the
70%-of-ceiling trend obligation.
