// Feature: project-quality-overhaul, Property 9: CloudFormation template uses no hardcoded Lambda function names outside parameter defaults
// Validates: Requirements 18.2

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadTemplate, collectStrings } = require('../helpers/cfn-template');

const template = loadTemplate();

// Extract the default hardcoded Lambda function names from Parameters
const backupDefault = template.Parameters.BackupLambdaFunctionName.Default;
const filterDefault = template.Parameters.FilterLambdaFunctionName.Default;
const hardcodedNames = [backupDefault, filterDefault];

describe('Property 9: No hardcoded Lambda function names outside parameter defaults', () => {
  it('should not contain hardcoded Lambda function names in any resource properties', () => {
    const resources = template.Resources;
    assert.ok(resources, 'Template must have a Resources section');

    const allStrings = collectStrings(resources, 'Resources');

    for (const name of hardcodedNames) {
      const matches = allStrings.filter((entry) => entry.value.includes(name));
      assert.equal(
        matches.length,
        0,
        `Found hardcoded Lambda function name "${name}" in resource properties at: ${matches.map((m) => `${m.path} = "${m.value}"`).join(', ')}`
      );
    }
  });

  it('should only have hardcoded Lambda function names in Parameter Default values', () => {
    // Collect strings from the entire template
    const allStrings = collectStrings(template);

    for (const name of hardcodedNames) {
      const matches = allStrings.filter((entry) => entry.value.includes(name));

      // Every match should be within a Parameter Default path
      for (const match of matches) {
        const isParameterDefault =
          match.path.match(/^Parameters\.\w+\.Default$/) !== null;
        assert.ok(
          isParameterDefault,
          `Hardcoded Lambda function name "${name}" found outside Parameter Defaults at: ${match.path} = "${match.value}"`
        );
      }
    }
  });
});
