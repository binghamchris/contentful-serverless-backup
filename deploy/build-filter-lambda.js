require('dotenv').config();
const fs = require('fs');
const AdmZip = require('adm-zip');
const { fromIni } = require("@aws-sdk/credential-providers");
const {
  LambdaClient,
  UpdateFunctionCodeCommand
} = require('@aws-sdk/client-lambda');

// Create file names and paths
const lambdaFuncName = process.env.FILTER_LAMBDA_FUNC_NAME;
const awsProfileName = process.env.AWS_PROFILE_NAME;
const backupLambdaPath = '../filter-lambda/';
const zipFileName = 'filter-lambda.zip';
const zipFilePath = `../${zipFileName}`;

try {
  // Create a zip archive of the backup Lambda function
  const zip = new AdmZip();
  console.log(`Writing zip to ${zipFilePath}`);
  zip.addLocalFolder(backupLambdaPath);
  zip.writeZip(zipFilePath);

  // Update the Lambda function's code using the zip archive
  let fileBuffer = new Buffer.from(fs.readFileSync(zipFilePath));
  fs.unlinkSync(zipFilePath);
  updateLambda(fileBuffer, lambdaFuncName);
} catch (err) {
  console.log(`ERROR: ${err}`);
};

// Function to deploy a zip archive to an existing lambda function
async function updateLambda(buffer, lambdaFunc){
  // Setup a Lambda client
  const lambdaClient = new LambdaClient({
    credentials: fromIni({
      profile: awsProfileName,
    })
  });
  
  // Deploy the zip archive to the Lambda function
  console.log(`Updating Lambda function ${lambdaFuncName}`)
  const input = {
    FunctionName: lambdaFunc,
    ZipFile: buffer,
  };
  const command = new UpdateFunctionCodeCommand(input);
  const response = await lambdaClient.send(command);

  // Report outcome of the deployment
  if (response['$metadata']['httpStatusCode'] == 200) {
    console.log('Deployment Successful');
  } else {
    console.log('ERROR: Deployment failed');
    console.log(response);
  };
};