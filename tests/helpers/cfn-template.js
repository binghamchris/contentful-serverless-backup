// Shared CloudFormation template-loading helper.
// Extracts the js-yaml intrinsic-function schema and template parse that
// tests/infrastructure/*.test.js previously duplicated verbatim.
// Validates: Requirement 45.6 (duplicated schema extracted to one module).

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Custom YAML types so js-yaml can parse CloudFormation intrinsic tags.
const cfnTags = [
  'Ref', 'Sub', 'GetAtt', 'Join', 'Select', 'Split', 'If',
  'Equals', 'And', 'Or', 'Not', 'FindInMap', 'Base64',
  'Cidr', 'ImportValue', 'GetAZs', 'Condition', 'Transform',
].flatMap((fn) =>
  ['scalar', 'sequence', 'mapping'].map((kind) =>
    new yaml.Type(`!${fn}`, {
      kind,
      construct: (data) => ({ [`Fn::${fn}`]: data }),
    })
  )
);

const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend(cfnTags);

const TEMPLATE_PATH = path.join(__dirname, '../../infrastructure/template.yaml');

/** Load and parse the project's CloudFormation template. */
function loadTemplate(templatePath = TEMPLATE_PATH) {
  const content = fs.readFileSync(templatePath, 'utf8');
  return yaml.load(content, { schema: CFN_SCHEMA });
}

/**
 * Recursively collect every plain string value from an object tree, with its path.
 * Intrinsic-function marker objects (Fn::Ref, Fn::Sub, ...) are traversed as
 * ordinary objects, so their string arguments are included.
 * Returns [{ path, value }].
 */
function collectStrings(obj, currentPath = '') {
  const results = [];
  if (obj === null || obj === undefined) return results;
  if (typeof obj === 'string') {
    results.push({ path: currentPath, value: obj });
    return results;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => results.push(...collectStrings(item, `${currentPath}[${i}]`)));
    return results;
  }
  if (typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      results.push(...collectStrings(val, currentPath ? `${currentPath}.${key}` : key));
    }
  }
  return results;
}

/** Every logical resource name of a given CloudFormation Type in the template. */
function resourcesOfType(template, type) {
  return Object.entries(template.Resources || {})
    .filter(([, r]) => r.Type === type)
    .map(([name]) => name);
}

module.exports = { CFN_SCHEMA, TEMPLATE_PATH, loadTemplate, collectStrings, resourcesOfType };
