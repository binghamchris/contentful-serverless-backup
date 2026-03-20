const fs = require('fs');
const contentfulExport = require('contentful-export');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
const AdmZip = require('adm-zip');

const s3Client = new S3Client();
const sqsClient = new SQSClient();
const ssmClient = new SSMClient();

// Extract SSM token parsing logic into a testable function
const parseSSMParameters = (parameters, managementArn, deliveryArn) => {
  let contentfulManagementToken,
      contentfulDeliveryToken;

  for (const param of Object.values(parameters)) {
    switch(param['ARN']){
      case managementArn:
        contentfulManagementToken = param['Value'];
        break;
      case deliveryArn:
        contentfulDeliveryToken = param['Value'];
        break;
    }
  }

  return { contentfulManagementToken, contentfulDeliveryToken };
};

// Extract S3 key generation logic into a testable function
const generateS3Key = (date) => {
  const isodate = date.toISOString().replaceAll('-', '/').replaceAll(':', '-').replace('T', '/');
  const s3Path = isodate.slice(0, 10);
  const filenameBase = isodate.slice(11);
  const datePrefix = date.toISOString().slice(0, 10);
  const zipFilename = `${datePrefix}_${filenameBase}.zip`;
  return { s3Path, filenameBase, datePrefix, zipFilename };
};

// Function to return the outcome of the execution
const sendResponse = (status, body) => {
  const response = {
    statusCode: status,
    body: body
  };
  return response;
};

// Function to upload a file to S3
const uploadFile = async (buffer, key) => {
  // Attempt an upload to S3
  const response = await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      StorageClass: process.env.S3_STORAGE_CLASS,
      Key: key,
      Body: buffer,
    })
  );
  // Report the result of the upload attempt, based on the HTTP status code
  if(response['$metadata']['httpStatusCode'] === 200){
    console.log('File uploaded');
    return true;
  } else {
    console.error(`File upload failure: ${response}`);
    return false;
  }
};

// Function to compress a single file into a zip archive
const createZipArchive = (inputFolder, outputFile) => {
  console.log(`Compressing: ${inputFolder}`);
  const zip = new AdmZip();
  zip.addLocalFolder(inputFolder);
  console.log(`Output: ${outputFile}`);
  zip.writeZip(outputFile);
  console.log(`Created ${outputFile} successfully`);
}

async function deleteMessageAsync(receiptHandle) {
  // Attempt to delete the message from the backup queue
  const response = await sqsClient.send(
    new DeleteMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      ReceiptHandle: receiptHandle,
    })
  );
  // Report the result of the delete attempt, based on the HTTP status code
  if(response['$metadata']['httpStatusCode'] == 200){
    console.log(`Message deleted: ${JSON.stringify(response)}`);
    return true;
  } else {
    console.error(`Message delete failure: ${JSON.stringify(response)}`);
    return false;
  }
}

exports.handler = async (event) => {
  // Create file names and paths
  const datetime = new Date();
  const { s3Path, filenameBase, datePrefix, zipFilename } = generateS3Key(datetime);
  const localBackupPath = '/tmp/backup';
  const contentfulExportFilename = `${filenameBase}.json`;
  const contentfulExportFilePath = `${localBackupPath}/${contentfulExportFilename}`;
  const zipFilePath = `${localBackupPath}/${zipFilename}`;

  try {
    if (!fs.existsSync(localBackupPath)){
      fs.mkdirSync(localBackupPath, { recursive: true });
    }

    // Get the SecureString parameters containing the Contentful API tokens from SSM Parameter Store
    const ssmParameters = await ssmClient.send(
      new GetParametersCommand({
        Names: [
          process.env.MANAGEMENT_TOKEN_ARN,
          process.env.DELIVERY_TOKEN_ARN,
        ],
        WithDecryption: true,
      }),
    );

    // Parse the SSM response to extract the parameter values
    const { contentfulManagementToken, contentfulDeliveryToken } = parseSSMParameters(
      ssmParameters['Parameters'],
      process.env.MANAGEMENT_TOKEN_ARN,
      process.env.DELIVERY_TOKEN_ARN
    );

    // Set options for the Contentful export
    const contentfulExportOptions = {
      spaceId: process.env.SPACE_ID,
      environmentId: process.env.SPACE_ENV,
      managementToken: contentfulManagementToken,
      deliveryToken: contentfulDeliveryToken,
      contentFile: contentfulExportFilename,
      exportDir: localBackupPath,
      useVerboseRenderer: false,
      saveFile: true,
      includeDrafts: true,
      downloadAssets: true,
      maxAllowedLimit: 200,
    };

    // Run Contentful export
    const result = await contentfulExport(contentfulExportOptions);
    console.log(`Data downloaded successfully from Contentful for Space ID: ${process.env.SPACE_ID} and Environment: ${process.env.SPACE_ENV}`);

    // Compress the JSON file from the Contentful export
    console.log('Compressing backup');
    await createZipArchive(localBackupPath, zipFilePath)

    // Prepare the zip archive for upload
    console.log('Preparing file for AWS S3');
    let fileBuffer = new Buffer.from(fs.readFileSync(zipFilePath));
    fs.unlinkSync(zipFilePath);

    // Upload the zip archive to S3
    const uploadFileResult = await uploadFile(fileBuffer, `${s3Path}/${zipFilename}`);
    if(uploadFileResult){
      // If the upload was successful delete the message from the backup queue
      const deleteMessageResult = await deleteMessageAsync(event['Records'][0]['receiptHandle']);
      if(deleteMessageResult) {
        // If the message was deleted successfully, report success
        return sendResponse(200, `Backup successful: ${zipFilePath}`);
      } else {
        // Otherwise report failure
        return sendResponse(500, 'Failed to delete message from the backup queue');
      }
    } else {
      // If the file failed to upload to S3, report failure
      return sendResponse(500, 'Failed to upload backup to S3');
    }
  } catch (err) {
    // Report error
    console.error(`The following error occurred: ${err}`);
    return sendResponse(500, err);
  };
};

// Named exports for testability
exports.parseSSMParameters = parseSSMParameters;
exports.generateS3Key = generateS3Key;
exports.sendResponse = sendResponse;
exports.uploadFile = uploadFile;
exports.deleteMessageAsync = deleteMessageAsync;