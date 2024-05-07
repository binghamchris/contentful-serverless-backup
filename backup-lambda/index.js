const fs = require('fs');
const contentfulExport = require('contentful-export');

exports.handler = async (event) => {
  // Create file names and paths
  const datetime = new Date();
  const isodate = datetime.toISOString().replaceAll('-', '/').replaceAll(':', '-').replace('T', '/');
  const s3Path = isodate.slice(0, 10);
  const filenameBase = isodate.slice(11);
  const localBackupPath = '/tmp/backup';
  const contentfulExportFilename = `${filenameBase}.json`;
  const contentfulExportFilePath = `${localBackupPath}/${contentfulExportFilename}`;
  const zipFilename = `${filenameBase}.zip`;
  const zipFilePath = `${localBackupPath}/${zipFilename}`;

  try {
    if (!fs.existsSync(localBackupPath)){
      fs.mkdirSync(localBackupPath, { recursive: true });
    }
  
    const {
      SSMClient,
      GetParametersCommand,
    } = require('@aws-sdk/client-ssm');
    const ssmClient = new SSMClient();
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
    let contentfulManagementToken,
        contentfulDeliveryToken;
    
    for(param in ssmParameters['Parameters']) {
      switch(ssmParameters['Parameters'][param]['ARN']){
        case process.env.MANAGEMENT_TOKEN_ARN:
          contentfulManagementToken = ssmParameters['Parameters'][param]['Value'];
        case process.env.DELIVERY_TOKEN_ARN:
          contentfulDeliveryToken = ssmParameters['Parameters'][param]['Value'];
      }
    }

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
        sendResponse(200, `Backup successful: ${zipFilePath}`);
      } else {
        // Otherwise report failure
        sendResponse(500, 'Failed to delete message from the backup queue');
      }
    } else {
      // If the file failed to upload to S3, report failure
      sendResponse(500, 'Failed to upload backup to S3');
    }
  } catch (err) {
    // Report error
    console.error(`The following error occurred: ${err}`);
    sendResponse(500, err);
  };
};

// Function to return the outcome of the execution
const sendResponse = (status, body) => {
  var response = {
    statusCode: status,
    body: body
  };
  return response;
};

// Function to upload a file to S3
const uploadFile = async (buffer, key) => {
  const {
    S3Client,
    PutObjectCommand,
  } = require('@aws-sdk/client-s3');
  const s3Client = new S3Client();
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
  if(response['$metadata']['httpStatusCode'] = 200){
    console.log('File uploaded');
    return true;
  } else {
    console.error(`File upload failure: ${response}`);
    return false;
  }
};

// Function to compress a single file into a zip archive
const createZipArchive = (inputFolder, outputFile) => {
  const AdmZip = require('adm-zip');
  console.log(`Compressing: ${inputFolder}`);
  const zip = new AdmZip();
  zip.addLocalFolder(inputFolder);
  console.log(`Output: ${outputFile}`);
  zip.writeZip(outputFile);
  console.log(`Created ${outputFile} successfully`);
}

async function deleteMessageAsync(receiptHandle) {
  // Connect to SQS
  const {
    SQSClient,
    DeleteMessageCommand,
  } = require('@aws-sdk/client-sqs');
  const sqsClient = new SQSClient();
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