const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Documentation unit tests', () => {
  describe('Req 21.1, 21.2: .env.example contains all required variables', () => {
    const envExamplePath = path.join(__dirname, '../../deploy/.env.example');
    let content;

    it('.env.example file exists', () => {
      assert.ok(fs.existsSync(envExamplePath), 'deploy/.env.example should exist');
      content = fs.readFileSync(envExamplePath, 'utf-8');
    });

    it('contains AWS_PROFILE_NAME', () => {
      content = fs.readFileSync(envExamplePath, 'utf-8');
      assert.ok(content.includes('AWS_PROFILE_NAME'), 'should contain AWS_PROFILE_NAME');
    });

    it('contains STACK_NAME (function names now come from stack outputs)', () => {
      content = fs.readFileSync(envExamplePath, 'utf-8');
      assert.ok(content.includes('STACK_NAME'), 'should contain STACK_NAME');
    });

    it('no longer hardcodes per-function names (read from stack outputs)', () => {
      content = fs.readFileSync(envExamplePath, 'utf-8');
      assert.ok(!content.includes('BACKUP_LAMBDA_FUNC_NAME'), 'must not hardcode the backup function name');
      assert.ok(!content.includes('FILTER_LAMBDA_FUNC_NAME'), 'must not hardcode the filter function name');
    });
  });

  describe('Req 22.1: README grammar fix', () => {
    it('deploy/README.md contains "its dependencies" not "it\'s dependencies"', () => {
      const readmePath = path.join(__dirname, '../../deploy/README.md');
      const content = fs.readFileSync(readmePath, 'utf-8');
      assert.ok(!content.includes("it's dependencies"), 'should not contain "it\'s dependencies"');
    });
  });

  describe('Req 17.1: CloudFormation template location', () => {
    it('template exists at infrastructure/template.yaml', () => {
      const templatePath = path.join(__dirname, '../../infrastructure/template.yaml');
      assert.ok(fs.existsSync(templatePath), 'infrastructure/template.yaml should exist');
    });

    it('old deploy/deploy.yaml does not exist', () => {
      const oldPath = path.join(__dirname, '../../deploy/deploy.yaml');
      assert.ok(!fs.existsSync(oldPath), 'deploy/deploy.yaml should not exist');
    });
  });

  describe('Req 33: deployment docs are executable and complete', () => {
    const { loadTemplate } = require('../helpers/cfn-template');
    const readme = fs.readFileSync(path.join(__dirname, '../../deploy/README.md'), 'utf-8');

    it('documents every template parameter by name', () => {
      const params = Object.keys(loadTemplate().Parameters);
      const undocumented = params.filter((p) => !readme.includes(p));
      assert.deepEqual(undocumented, [], `undocumented parameters: ${undocumented.join(', ')}`);
    });

    it('contains a literal, executable deploy command with capabilities, region and template path', () => {
      assert.match(readme, /aws cloudformation deploy/);
      assert.match(readme, /--capabilities CAPABILITY_IAM/);
      assert.match(readme, /--region eu-central-1/);
      assert.match(readme, /--template-file infrastructure\/template\.yaml/);
    });

    it('describes the two-pass ordering and the subscription-confirmation gate', () => {
      assert.match(readme, /two-pass/i);
      assert.match(readme, /EventSourceMappingEnabled=false/);
      assert.match(readme, /[Cc]onfirm the email subscription/);
    });

    it('references no former template location', () => {
      assert.ok(!readme.includes('deploy/deploy.yaml'), 'must not reference the old template path');
    });
  });
});
