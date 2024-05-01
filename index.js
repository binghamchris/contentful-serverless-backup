const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const fs = require('fs');
const contentfulExport = require('contentful-export');
const AdmZip = require("adm-zip");

exports.handler = async (event) => {
  const datetime = new Date();
  const isodate = datetime.toISOString().replaceAll('-', '/').replaceAll(':', '-').replace('T', '/');
  const s3Path = isodate.slice(0, 10);
  const filenameBase = isodate.slice(11);
  const localBackupPath = '/tmp';
  const contentfulExportFilename = `${filenameBase}.json`;
  const contentfulExportFilePath = `${localBackupPath}/${contentfulExportFilename}`;
  const zipFilename = `${filenameBase}.zip`;
  const zipFilePath = `${localBackupPath}/${zipFilename}`;
  const options = {
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
    const result = await contentfulExport(options);
    console.log(`Data downloaded successfully from Contentful for Space ID: ${process.env.SPACE_ID} and Environment: ${process.env.SPACE_ENV}`);

    console.log('Compressing backup');
    createZipArchive(contentfulExportFilePath, zipFilePath)

    console.log('Preparing file for AWS S3');
    let fileBuffer = new Buffer.from(fs.readFileSync(zipFilePath));
    fs.unlinkSync(zipFilePath);
    
    await uploadFile(fileBuffer, `${s3Path}/${zipFilename}`);
    
    return sendResponse(200, zipFilePath);
  } catch (err) {
    console.log(`ERROR: ${err}`);
    return sendResponse(500, err);
  };
};

const sendResponse = (status, body) => {
  var response = {
    statusCode: status,
    body: body
  };

  return response;
};

const uploadFile = async (buffer, key) => {
  let params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: buffer
  };

  return await s3.putObject(params).promise();
};

const createZipArchive = (inputFile, outputFile) => {
  try {
    console.log(`Compressing: ${inputFile}`)
    const zip = new AdmZip();
    zip.addLocalFile(inputFile);
    console.log(`Output: ${outputFile}`)
    zip.writeZip(outputFile);
    console.log(`Created ${outputFile} successfully`);
  } catch (e) {
    console.log(`Something went wrong. ${e}`);
  }
}