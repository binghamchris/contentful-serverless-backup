'use strict';

// Backup Lambda handler.
//
// Folds tasks 5 (throw on every failure), 6 (message lifecycle + envelope
// validation) and 8 (Node 24 runtime, @aws-sdk v3, archiver, streamed upload)
// onto their TARGET libraries in one pass, per the user's fold-forward
// decision — writing task 5/6 logic against adm-zip and a buffered upload
// would be throwaway work that task 8 immediately replaces.
//
// Design contract (design.md, backup-pipeline section):
//   - Validate the event envelope; zero records -> throw. Unrecognised body is
//     handled by the pipeline (there is one expected body shape here).
//   - Zero-quota checks FIRST: read + validate both SSM tokens before the
//     export, so a misconfiguration is free.
//   - Export (published state, ExO off, maxAllowedLimit 200, downloadAssets).
//   - Archive with `archiver` streamed straight into an S3 multipart upload
//     (@aws-sdk/lib-storage Upload) to a STAGING key the Coverage_Check ignores.
//   - Verify the staged object (present, size matches bytes sent), CopyObject
//     to the final coverage-visible key, verify the final object.
//   - THROW, never return, on any failure. sendResponse survives only on the
//     success return. No manual SQS delete (the ESM deletes on a clean return).
//   - On a caught failure, publish to the Alert_Topic ONLY when
//     ApproximateReceiveCount == 1, then rethrow.
//
// Requirements: 1.1-1.5, 2.1-2.5, 7.1-7.3, 0.2, 22.1-22.7, 23-27, 46.1-46.10.

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const contentfulExport = require('contentful-export');
const archiver = require('archiver');
const { S3Client, CopyObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const AWS_CLIENT_CONFIG = { maxAttempts: 3 };
const s3Client = new S3Client(AWS_CLIENT_CONFIG);
const ssmClient = new SSMClient(AWS_CLIENT_CONFIG);
const snsClient = new SNSClient(AWS_CLIENT_CONFIG);

const STAGING_PREFIX = 'staging';
const DEFAULT_MAX_ALLOWED_LIMIT = 200;

// --- pure helpers ---------------------------------------------------------

// Parse the SSM GetParameters response into the two tokens by ARN.
const parseSSMParameters = (parameters, managementArn, deliveryArn) => {
  let contentfulManagementToken;
  let contentfulDeliveryToken;
  for (const param of Object.values(parameters || {})) {
    switch (param && param.ARN) {
      case managementArn:
        contentfulManagementToken = param.Value;
        break;
      case deliveryArn:
        contentfulDeliveryToken = param.Value;
        break;
      default:
        break;
    }
  }
  return { contentfulManagementToken, contentfulDeliveryToken };
};

// Derive the date-partitioned key parts. The final key ends
// .<ms>Z.zip so it matches the anchored ARCHIVE_KEY the Coverage_Check uses.
const generateS3Key = (date) => {
  const iso = date.toISOString(); // e.g. 2026-09-20T04:52:00.336Z
  const s3Path = iso.slice(0, 10).replaceAll('-', '/'); // 2026/09/20
  const filenameBase = iso.slice(11).replaceAll(':', '-'); // 04-52-00.336Z
  const datePrefix = iso.slice(0, 10);
  const zipFilename = `${datePrefix}_${filenameBase}.zip`;
  return { s3Path, filenameBase, datePrefix, zipFilename };
};

// The success-only response object. Failures THROW; they never return this.
const sendResponse = (status, body) => ({ statusCode: status, body });

// --- side-effecting helpers -----------------------------------------------

// Stream a folder into a zip archive piped directly into an S3 multipart
// upload. Returns the number of bytes uploaded (for staged-size verification).
const streamArchiveToS3 = async (inputFolder, bucket, key, storageClass) => {
  const pass = new PassThrough();
  let bytes = 0;
  pass.on('data', (chunk) => { bytes += chunk.length; });

  const archive = archiver('zip', { zlib: { level: 9 } });
  const upload = new Upload({
    client: s3Client,
    params: { Bucket: bucket, Key: key, Body: pass, StorageClass: storageClass },
  });

  archive.on('warning', (err) => { throw err; });
  archive.on('error', (err) => { throw err; });
  archive.pipe(pass);
  archive.directory(inputFolder, false);

  const finalized = archive.finalize();
  await Promise.all([finalized, upload.done()]);
  return bytes;
};

// Verify a staged object exists and its size matches the bytes we sent.
const verifyStagedObject = async (bucket, key, expectedBytes) => {
  const res = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key }));
  const match = (res.Contents || []).find((o) => o.Key === key);
  if (!match) {
    throw new Error(`Staged object not found after upload: ${key}`);
  }
  if (typeof expectedBytes === 'number' && match.Size !== expectedBytes) {
    throw new Error(`Staged object size mismatch for ${key}: expected ${expectedBytes}, got ${match.Size}`);
  }
  return true;
};

// Assert every asset the export declared was actually written to the tree.
// The library classifies a failed asset download as a filtered-out warning and
// resolves with content data only, so completeness must be reconciled here from
// the returned asset URLs against the files on disk (design.md asset section).
const reconcileAssets = (result, exportDir) => {
  const assets = (result && result.assets) || [];
  const missing = [];
  for (const asset of assets) {
    const file = asset && asset.fields && asset.fields.file;
    const url = file && (file.url || (file['en-US'] && file['en-US'].url));
    if (!url) continue;
    // contentful-export writes assets under exportDir/images.ctfassets.net/...
    const relative = String(url).replace(/^https?:\/\//, '').replace(/^\/\//, '');
    const localPath = path.join(exportDir, relative);
    if (!fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
      missing.push(relative);
    }
  }
  return { total: assets.length, missing };
};

// Publish a failure to the alert topic, but ONLY on first delivery.
const publishFailureIfFirstDelivery = async (record, err) => {
  const receiveCount = Number(
    record && record.attributes && record.attributes.ApproximateReceiveCount
  );
  if (receiveCount !== 1) {
    // Redelivery: the DLQ/Notifier path handles the terminal alert.
    return false;
  }
  if (!process.env.ALERT_TOPIC_ARN) return false;
  try {
    await snsClient.send(new PublishCommand({
      TopicArn: process.env.ALERT_TOPIC_ARN,
      Subject: 'Contentful backup failed',
      Message: `The Contentful backup failed on first delivery.\n\n${err && err.stack ? err.stack : String(err)}`,
    }));
    return true;
  } catch (publishErr) {
    // A publish failure must not mask the original error; log and continue to rethrow.
    console.error(`Alert publish failed: ${publishErr && publishErr.message}`);
    return false;
  }
};

// --- handler ---------------------------------------------------------------

exports.handler = async (event) => {
  // Envelope validation: zero records -> throw (async -> Notifier -> email).
  const records = event && event.Records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Backup Lambda invoked with no SQS records');
  }
  const record = records[0];

  try {
    const datetime = new Date();
    const { s3Path, filenameBase, zipFilename } = generateS3Key(datetime);
    const localBackupPath = path.join(process.env.EPHEMERAL_ROOT || '/tmp', 'backup');
    const contentfulExportFilename = `${filenameBase}.json`;
    const bucket = process.env.S3_BUCKET_NAME;
    const storageClass = process.env.S3_STORAGE_CLASS;
    const finalKey = `${s3Path}/${zipFilename}`;
    const stagingKey = `${STAGING_PREFIX}/${s3Path}/${zipFilename}`;

    if (!fs.existsSync(localBackupPath)) {
      fs.mkdirSync(localBackupPath, { recursive: true });
    }

    // ---- zero-quota checks FIRST -----------------------------------------
    const ssmParameters = await ssmClient.send(new GetParametersCommand({
      Names: [process.env.MANAGEMENT_TOKEN_ARN, process.env.DELIVERY_TOKEN_ARN],
      WithDecryption: true,
    }));
    const { contentfulManagementToken, contentfulDeliveryToken } = parseSSMParameters(
      ssmParameters.Parameters,
      process.env.MANAGEMENT_TOKEN_ARN,
      process.env.DELIVERY_TOKEN_ARN
    );
    if (!contentfulManagementToken || !contentfulDeliveryToken) {
      throw new Error('Contentful token(s) missing from SSM before export — misconfiguration, no quota spent');
    }

    // ---- export (published state, ExO off) -------------------------------
    const maxAllowedLimit = Number(process.env.MAX_ALLOWED_LIMIT) || DEFAULT_MAX_ALLOWED_LIMIT;
    const exportOptions = {
      spaceId: process.env.SPACE_ID,
      environmentId: process.env.SPACE_ENV,
      managementToken: contentfulManagementToken,
      deliveryToken: contentfulDeliveryToken,
      contentFile: contentfulExportFilename,
      exportDir: localBackupPath,
      useVerboseRenderer: false,
      saveFile: true,
      // Published state only — unpublished editorial work is not captured
      // (Requirement 14). Shifts load onto the CDA rate-limit allowance.
      skipContentModel: false,
      includeDrafts: false,
      includeArchived: false,
      includeExperienceOrchestration: false,
      downloadAssets: true,
      maxAllowedLimit,
    };
    const result = await contentfulExport(exportOptions);
    console.log(`Export complete for space ${process.env.SPACE_ID} env ${process.env.SPACE_ENV}`);

    // ---- asset completeness reconciliation -------------------------------
    const { total, missing } = reconcileAssets(result, localBackupPath);
    if (missing.length > 0) {
      // Any shortfall throws — the library already retried each asset with
      // backoff, so a fresh export is a genuine retry (rate-limit-specific
      // handling is layered in task 13).
      throw new Error(`Asset download incomplete: ${missing.length} of ${total} assets missing`);
    }

    // ---- archive -> stream -> staging upload -----------------------------
    const stagedBytes = await streamArchiveToS3(localBackupPath, bucket, stagingKey, storageClass);
    console.log(`Staged archive ${stagingKey} (${stagedBytes} bytes)`);

    // ---- verify staged, promote, verify final ----------------------------
    await verifyStagedObject(bucket, stagingKey, stagedBytes);
    await s3Client.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${stagingKey}`,
      Key: finalKey,
      StorageClass: storageClass,
    }));
    await verifyStagedObject(bucket, finalKey);
    console.log(`Promoted to final key ${finalKey}`);

    // Success: this is the ONLY place sendResponse is returned. A clean
    // return lets the event-source mapping delete the message.
    return sendResponse(200, `Backup successful: ${finalKey}`);
  } catch (err) {
    console.error(`Backup failed: ${err && err.message}`);
    if (err && err.stack) console.error(err.stack);
    await publishFailureIfFirstDelivery(record, err);
    // THROW — a throw returns the message to the queue so the dead-letter
    // path, and therefore notification, is reachable. Never return the raw
    // error object.
    throw err;
  }
};

// Named exports for testability.
exports.parseSSMParameters = parseSSMParameters;
exports.generateS3Key = generateS3Key;
exports.sendResponse = sendResponse;
exports.reconcileAssets = reconcileAssets;
exports.publishFailureIfFirstDelivery = publishFailureIfFirstDelivery;
