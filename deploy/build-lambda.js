require('dotenv').config();
const fs = require('fs');
const AdmZip = require('adm-zip');
const { fromIni } = require("@aws-sdk/credential-providers");
const {
  LambdaClient,
  UpdateFunctionCodeCommand
} = require('@aws-sdk/client-lambda');

// Configuration mapping for each Lambda target
function getConfig(target) {
  const configs = {
    backup: {
      lambdaPath: '../backup-lambda/',
      envVar: 'BACKUP_LAMBDA_FUNC_NAME',
      zipFileName: 'backup-lambda.zip',
    },
    filter: {
      lambdaPath: '../filter-lambda/',
      envVar: 'FILTER_LAMBDA_FUNC_NAME',
      zipFileName: 'filter-lambda.zip',
    },
  };
  return Object.prototype.hasOwnProperty.call(configs, target) ? configs[target] : null;
}

// Check if deployment response indicates success
function isDeploymentSuccessful(response) {
  return response['$metadata']['httpStatusCode'] === 200;
}

// Function to deploy a zip archive to an existing Lambda function
async function updateLambda(buffer, lambdaFunc, awsProfileName) {
  const lambdaClient = new LambdaClient({
    credentials: fromIni({
      profile: awsProfileName,
    })
  });

  console.log(`Updating Lambda function ${lambdaFunc}`);
  const input = {
    FunctionName: lambdaFunc,
    ZipFile: buffer,
  };
  const command = new UpdateFunctionCodeCommand(input);
  const response = await lambdaClient.send(command);

  if (isDeploymentSuccessful(response)) {
    console.log('Deployment Successful');
  } else {
    console.log('ERROR: Deployment failed');
    console.log(response);
    process.exit(1);
  }
}

// Main logic wrapped in async IIFE
(async () => {
  const target = process.argv[2];
  const config = getConfig(target);

  if (!config) {
    console.log('Usage: node build-lambda.js <backup|filter>');
    process.exit(1);
  }

  const lambdaFuncName = process.env[config.envVar];
  const awsProfileName = process.env.AWS_PROFILE_NAME;
  const zipFilePath = `../${config.zipFileName}`;

  try {
    // Create a zip archive of the Lambda function
    const zip = new AdmZip();
    console.log(`Writing zip to ${zipFilePath}`);
    zip.addLocalFolder(config.lambdaPath);
    zip.writeZip(zipFilePath);

    // Update the Lambda function's code using the zip archive
    const fileBuffer = Buffer.from(fs.readFileSync(zipFilePath));
    fs.unlinkSync(zipFilePath);
    await updateLambda(fileBuffer, lambdaFuncName, awsProfileName);
  } catch (err) {
    console.log(`ERROR: ${err}`);
    process.exit(1);
  }
})();

module.exports = { getConfig, isDeploymentSuccessful };
