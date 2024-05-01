const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const fs = require('fs');
const contentfulExport = require('contentful-export');
const AdmZip = require("adm-zip");

exports.handler = async (event) => {
  // Create file names and paths
  const datetime = new Date();
  const isodate = datetime.toISOString().replaceAll('-', '/').replaceAll(':', '-').replace('T', '/');
  const s3Path = isodate.slice(0, 10);
  const filenameBase = isodate.slice(11);
  const localBackupPath = '/tmp';
  const contentfulExportFilename = `${filenameBase}.json`;
  const contentfulExportFilePath = `${localBackupPath}/${contentfulExportFilename}`;
  const zipFilename = `${filenameBase}.zip`;
  const zipFilePath = `${localBackupPath}/${zipFilename}`;

  // Set options for the Contentful export
  const contentfulExportOptions = {
    spaceId: process.env.SPACE_ID,
    environmentId: process.env.SPACE_ENV,
    managementToken: process.env.MANAGEMENT_TOKEN,
    deliveryToken: process.env.DELIVERY_TOKEN,
    contentFile: contentfulExportFilename,
    exportDir: localBackupPath,
    useVerboseRenderer: false,
    saveFile: true,
    includeDrafts: true,
    maxAllowedLimit: 200,
  };

  try {
    // Run Contentful export
    const result = await contentfulExport(contentfulExportOptions);
    console.log(`Data downloaded successfully from Contentful for Space ID: ${process.env.SPACE_ID} and Environment: ${process.env.SPACE_ENV}`);

    // Compress the JSON file from the Contentful export
    console.log('Compressing backup');
    await createZipArchive(contentfulExportFilePath, zipFilePath)

    // Prepare the zip archive for upload
    console.log('Preparing file for AWS S3');
    let fileBuffer = new Buffer.from(fs.readFileSync(zipFilePath));
    fs.unlinkSync(zipFilePath);
    
    // Upload the zip archive to S3
    await uploadFile(fileBuffer, `${s3Path}/${zipFilename}`);
    
    // Report success
    return sendResponse(200, zipFilePath);

  } catch (err) {
    // Report error
    console.log(`ERROR: ${err}`);
    return sendResponse(500, err);
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
  let params = {
    Bucket: process.env.S3_BUCKET_NAME,
    StorageClass: process.env.S3_STORAGE_CLASS,
    Key: key,
    Body: buffer,
  };
  return await s3.putObject(params).promise();
};

// Function to compress a single file into a zip archive
const createZipArchive = (inputFile, outputFile) => {
  console.log(`Compressing: ${inputFile}`)
  const zip = new AdmZip();
  zip.addLocalFile(inputFile);
  console.log(`Output: ${outputFile}`)
  zip.writeZip(outputFile);
  console.log(`Created ${outputFile} successfully`);
}