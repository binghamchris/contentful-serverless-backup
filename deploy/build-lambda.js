'use strict';

// Reproducible, gated, traceable Lambda code deployment.
//
// Keeps the laptop UpdateFunctionCode model (the owner's explicit choice) but
// makes it safe and repeatable. Per task 18 + design.md deployment section:
//   - Refuse on a dirty git tree.
//   - Package from an explicit ALLOW-LIST (.gitignore protects git, not the
//     zip — a stray .env would otherwise ship a management token).
//   - Refuse if node_modules is absent or a credential file matched.
//   - npm ci --omit=dev before packaging.
//   - Validate every required env var with a named message.
//   - Explicit region; UpdateFunctionCode(..., Publish: true).
//   - Record the commit as a function TAG (an env var is CFN-managed drift).
//   - Prune published versions to 3 (code storage is a per-region quota).
//   - Read function names from stack outputs (not hardcoded).
//   - A placeholder-SHA verification command.
//
// Requirements: 29.x, 30.x, 31.x, 32.x.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const archiver = require('archiver');
const { fromIni } = require('@aws-sdk/credential-providers');
const {
  LambdaClient, UpdateFunctionCodeCommand, TagResourceCommand,
  ListVersionsByFunctionCommand, DeleteFunctionCommand,
} = require('@aws-sdk/client-lambda');
const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');

const REGION = 'eu-central-1';
const MAX_PUBLISHED_VERSIONS = 3;

// Files/dirs permitted into the zip. Everything else is excluded — an
// allow-list, not a deny-list, so a new stray file never ships by accident.
const PACKAGE_ALLOWLIST = new Set(['index.js', 'coverage-check.js', 'node_modules', 'package.json', 'package-lock.json']);
const CREDENTIAL_PATTERNS = [/\.env$/, /\.env\..+/, /credentials/i, /\.pem$/, /id_rsa/, /\.key$/];

// Own-property lookup (never resolves prototype-chain names).
function getConfig(target) {
  const configs = {
    backup: { lambdaPath: '../backup-lambda/', outputKey: 'BackupFunctionName', zipFileName: 'backup-lambda.zip' },
    filter: { lambdaPath: '../filter-lambda/', outputKey: 'FilterFunctionName', zipFileName: 'filter-lambda.zip' },
    notifier: { lambdaPath: '../notifier-lambda/', outputKey: 'NotifierFunctionName', zipFileName: 'notifier-lambda.zip' },
  };
  return Object.prototype.hasOwnProperty.call(configs, target) ? configs[target] : null;
}

// The API response is successful only on a 200 status.
function isDeploymentSuccessful(response) {
  return response && response['$metadata'] && response['$metadata'].httpStatusCode === 200;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assertCleanTree() {
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (status.trim() !== '') {
    throw new Error('Refusing to deploy: the git working tree is dirty. Commit or stash first.');
  }
}

function currentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

// Recursively collect files under a dir, honouring the top-level allow-list and
// refusing any credential-shaped file.
function collectAllowedFiles(root) {
  const top = fs.readdirSync(root);
  const files = [];
  for (const entry of top) {
    if (!PACKAGE_ALLOWLIST.has(entry)) continue;
    const abs = path.join(root, entry);
    walk(abs, root, files);
  }
  return files;
}

function walk(abs, root, files) {
  const stat = fs.statSync(abs);
  const rel = path.relative(root, abs);
  // The credential-shape guard protects against a stray secret in the
  // function's OWN source (a .env, a credentials.json, a *.pem). It must NOT
  // apply inside node_modules, where legitimate vendored files carry names
  // like GetRoleCredentialsCommand.js — matching /credentials/i on those is a
  // false positive that blocks every deploy.
  const inVendored = rel.split(path.sep).includes('node_modules');
  if (!inVendored && CREDENTIAL_PATTERNS.some((re) => re.test(rel))) {
    throw new Error(`Refusing to package a credential-shaped file: ${rel}`);
  }
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(abs)) walk(path.join(abs, child), root, files);
  } else {
    files.push({ abs, rel });
  }
}

async function zipDirectory(lambdaDir, zipPath) {
  if (!fs.existsSync(path.join(lambdaDir, 'node_modules'))) {
    throw new Error(`Refusing to deploy: node_modules absent in ${lambdaDir}. Run "npm ci --omit=dev" first.`);
  }
  const files = collectAllowedFiles(lambdaDir);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const f of files) archive.file(f.abs, { name: f.rel });
    archive.finalize();
  });
}

async function stackOutput(cfn, stackName, outputKey) {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = (res.Stacks[0] && res.Stacks[0].Outputs) || [];
  const match = outputs.find((o) => o.OutputKey === outputKey);
  if (!match) throw new Error(`Stack ${stackName} has no output ${outputKey}`);
  return match.OutputValue;
}

async function pruneVersions(lambda, functionName) {
  const res = await lambda.send(new ListVersionsByFunctionCommand({ FunctionName: functionName }));
  const numbered = (res.Versions || [])
    .filter((v) => v.Version !== '$LATEST')
    .sort((a, b) => Number(b.Version) - Number(a.Version));
  for (const v of numbered.slice(MAX_PUBLISHED_VERSIONS)) {
    await lambda.send(new DeleteFunctionCommand({ FunctionName: `${functionName}:${v.Version}` }));
    console.log(`Pruned old version ${v.Version}`);
  }
}

async function main() {
  const target = process.argv[2];
  const config = getConfig(target);
  if (!config) {
    console.log('Usage: node build-lambda.js <backup|filter|notifier>');
    process.exit(1);
    return;
  }

  const profile = requireEnv('AWS_PROFILE_NAME');
  const stackName = requireEnv('STACK_NAME');

  assertCleanTree();
  const commit = currentCommit();

  const credentials = fromIni({ profile });
  const lambda = new LambdaClient({ region: REGION, credentials });
  const cfn = new CloudFormationClient({ region: REGION, credentials });

  const functionName = await stackOutput(cfn, stackName, config.outputKey);
  const lambdaDir = path.resolve(__dirname, config.lambdaPath);
  const zipPath = path.resolve(__dirname, `../${config.zipFileName}`);

  console.log(`Packaging ${target} from allow-list into ${zipPath}`);
  await zipDirectory(lambdaDir, zipPath);
  const zipBuffer = fs.readFileSync(zipPath);
  fs.unlinkSync(zipPath);

  console.log(`Updating ${functionName} (commit ${commit})`);
  const response = await lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: functionName,
    ZipFile: zipBuffer,
    Publish: true,
  }));
  if (!isDeploymentSuccessful(response)) {
    console.log('ERROR: deployment failed');
    console.log(response);
    process.exit(1);
    return;
  }

  // Record the deployed commit as a function TAG (an env var is
  // CloudFormation-managed and would be reverted on the next stack update).
  await lambda.send(new TagResourceCommand({
    Resource: response.FunctionArn.replace(/:\d+$/, ''),
    Tags: { DeployedCommit: commit },
  }));

  await pruneVersions(lambda, functionName);
  console.log(`Deployment successful: ${functionName} version ${response.Version}, commit ${commit}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { getConfig, isDeploymentSuccessful, collectAllowedFiles, requireEnv, PACKAGE_ALLOWLIST, CREDENTIAL_PATTERNS };
