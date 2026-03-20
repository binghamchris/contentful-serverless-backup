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

    it('contains BACKUP_LAMBDA_FUNC_NAME', () => {
      content = fs.readFileSync(envExamplePath, 'utf-8');
      assert.ok(content.includes('BACKUP_LAMBDA_FUNC_NAME'), 'should contain BACKUP_LAMBDA_FUNC_NAME');
    });

    it('contains FILTER_LAMBDA_FUNC_NAME', () => {
      content = fs.readFileSync(envExamplePath, 'utf-8');
      assert.ok(content.includes('FILTER_LAMBDA_FUNC_NAME'), 'should contain FILTER_LAMBDA_FUNC_NAME');
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
});
