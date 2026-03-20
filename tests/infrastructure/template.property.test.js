// Feature: project-quality-overhaul, Property 9: CloudFormation template uses no hardcoded Lambda function names outside parameter defaults
// Validates: Requirements 18.2

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Define custom YAML types for CloudFormation intrinsic functions so js-yaml can parse the template
const cfnTags = [
  'Ref', 'Sub', 'GetAtt', 'Join', 'Select', 'Split', 'If',
  'Equals', 'And', 'Or', 'Not', 'FindInMap', 'Base64',
  'Cidr', 'ImportValue', 'GetAZs', 'Condition', 'Transform',
].flatMap((fn) => {
  return ['scalar', 'sequence', 'mapping'].map((kind) =>
    new yaml.Type(`!${fn}`, {
      kind,
      construct: (data) => ({ [`Fn::${fn}`]: data }),
    })
  );
});

const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend(cfnTags);

const templatePath = path.join(__dirname, '../../infrastructure/template.yaml');
const templateContent = fs.readFileSync(templatePath, 'utf8');
const template = yaml.load(templateContent, { schema: CFN_SCHEMA });

// Extract the default hardcoded Lambda function names from Parameters
const backupDefault = template.Parameters.BackupLambdaFunctionName.Default;
const filterDefault = template.Parameters.FilterLambdaFunctionName.Default;
const hardcodedNames = [backupDefault, filterDefault];

/**
 * Recursively collect all plain string values from an object/array.
 * Skips intrinsic function marker objects (Fn::Ref, Fn::Sub, etc.)
 * Returns an array of { path: string, value: string } entries.
 */
function collectStrings(obj, currentPath = '') {
  const results = [];
  if (obj === null || obj === undefined) return results;
  if (typeof obj === 'string') {
    results.push({ path: currentPath, value: obj });
    return results;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      results.push(...collectStrings(item, `${currentPath}[${i}]`));
    });
    return results;
  }
  if (typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      results.push(...collectStrings(val, currentPath ? `${currentPath}.${key}` : key));
    }
  }
  return results;
}

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
