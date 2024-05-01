const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const fs = require('fs');
const contentfulExport = require('contentful-export');

exports.handler = async (event) => {
  var datetime = new Date();
  var isodate = datetime.toISOString().replaceAll('-', '/').replaceAll(':', '-').replace('T', '/');
  var s3path = isodate.slice(0, 10);
  var filename = isodate.slice(11) + '.json';

  const local_backup_path = '/tmp';
  const file_name =  filename;
  const options = {
    spaceId: process.env.SPACE_ID,
    environmentId: process.env.SPACE_ENV,
    managementToken: process.env.MANAGEMENT_TOKEN,
    deliveryToken: process.env.DELIVERY_TOKEN,
    contentFile: file_name,
    exportDir: local_backup_path,
    useVerboseRenderer: false,
    saveFile: true,
    includeDrafts: true,
    maxAllowedLimit: 200,
  };

  try {
    const result = await contentfulExport(options);
    console.log('Data downloaded successfully from Contentful for Space ID: ' + process.env.SPACE_ID + ' and Envionment: ' + process.env.SPACE_ENV);

    // Save file to AWS S3
    console.log('Preparing file for AWS S3');
    const outputFile = local_backup_path + "/" + file_name;
    let fileBuffer = new Buffer(fs.readFileSync(outputFile));
    fs.unlinkSync(outputFile);
    
    await uploadFile(fileBuffer, s3path + '/' + filename);
    
    return sendResponse(200, outputFile);
  } catch (err) {
    console.log('ERROR: ', err);
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