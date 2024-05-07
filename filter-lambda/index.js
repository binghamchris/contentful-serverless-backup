exports.handler = async (event) => {
  console.log(process.env)
  try {
    // Process the first SNS message to determine if the Amplify build succeeded by
    const messageResult = await processMessageAsync(event['Records'][0]);
    if(messageResult){
      // If the Amplify build succeeded, continue
      // Get the timestamp for the last update to the Contentful data
      const lastUpdateTimestamp = getLastUpdateTimestamp(process.env.LAST_UPDATE_API_URL);
      const dateNow = new Date();
      // Calculate the how long ago the last data update was in minutes
      let dateDiffMins = (dateNow - lastUpdateTimestamp) / (1000 * 60);
      if(dateDiffMins < parseInt(process.env.LAST_UPDATE_WINDOW)){
        // If the last update was less than 10 minutes ago, queue a backup via SQS
        console.log(`Last data update was ${dateDiffMins} minutes ago; backup required`);
        // Connect to SQS
        /** 
         * Sending the SQS message is done here in the handler instead of in a function
         * as for some reason the SQS client fails when called in an async function...
         */ 
        const {
          SQSClient,
          SendMessageCommand,
        } = require('@aws-sdk/client-sqs');
        const sqsClient = new SQSClient();
        // Prepare a SQS message to queue a backup
        /**
         * Use a simple deduplication ID and group ID to leverage SQS's deduplication function
         * to prevent repeated backups beng triggered in a short period of time
         */ 
        // Send the SQS message
        console.log('Queuing backup')
        const response = await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: process.env.SQS_QUEUE_URL,
            MessageBody: `Backup needed; data last updated at ${lastUpdateTimestamp}`,
            MessageDeduplicationId: 'backup',
            MessageGroupId: 'backup',
          })
        );
        // Report the result of the message send attempt, based on the HTTP status code
        if(response['$metadata']['httpStatusCode'] == 200){
          console.debug(`Message sent: ${JSON.stringify(response)}`);
          sendResponse(200, 'Backup queued');
        } else {
          console.error(`Message send failure: ${JSON.stringify(response)}`);
          sendResponse(500, 'Failed to queue backup');
        };
      } else {
        // If the last update was more than 10 minutes ago, log this and report successful completion
        console.log(`Last data update was ${dateDiffMins} minutes ago; no backup needed`);
        sendResponse(200, 'No backup required');
      }
    } else {
      // Otherwise, log that no backup is required and report successful completion
      console.log('No backup required')
      sendResponse(200, 'No backup required');
    }
  } catch (err) {
    console.error(`The following error occurred: ${err}`);
    throw err;
  }
};

// Function to return the outcome of the execution
const sendResponse = (status, body) => {
  var response = {
    statusCode: status,
    body: body,
  };
  return response;
};

async function processMessageAsync(record) {
  // Check the message contents
  var message = record.Sns.Message;
  if (message.includes("SUCCEED")) {
    // If the message contains the string "SUCCEED", report success
    console.log('Amplify build succeeded');
    return true;
  } else {
    // Otherwise report failure
    console.log('Amplify build status was not "SUCCEED"');
    return false;
  }
}

function getLastUpdateTimestamp(url) {
  // Fetch the JSON file from the API
  console.log(`Getting URL: ${url}`)
  const fetch = require('sync-fetch');
  const json = fetch(url).json();
  console.debug(`URL content: ${JSON.stringify(json)}`)
  let latestUpdate;
  // Process the JSON to determine the most recent timestamp it contains
  for(table in json) {
    thisTableUpdate = new Date(json[table]['lastUpdatedAt']);
    if (!(latestUpdate)){
      latestUpdate = thisTableUpdate;
    } else if (thisTableUpdate > latestUpdate){
      latestUpdate = thisTableUpdate;
    }
  }
  // Return the latest timestamp
  console.log(`Last API update: ${latestUpdate}`);
  return latestUpdate;
}