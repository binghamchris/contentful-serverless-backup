// Shared CloudFormation template-loading helper.
// Extracts the YAML intrinsic-function schema and template parse that
// tests/infrastructure/*.test.js previously duplicated verbatim.
// Validates: Requirement 45.6 (duplicated schema extracted to one module).
//
// PORTED TO js-yaml 5. v5 removed the `Type` constructor and
// `DEFAULT_SCHEMA.extend()` that v4 used; custom tags are now built with
// defineScalarTag / defineSequenceTag / defineMappingTag and composed into a
// `Schema`. The parsed shape is deliberately IDENTICAL to the v4 output
// (`!Sub "x"` -> { 'Fn::Sub': 'x' }, `!If [a,b]` -> { 'Fn::If': [a,b] }), and
// tests/infrastructure/yaml-schema-equivalence.unit.test.js proves it against a
// snapshot of the pre-migration parse.

const fs = require('node:fs');
const path = require('node:path');
const {
  load, Schema, CORE_SCHEMA,
  defineScalarTag, defineSequenceTag, defineMappingTag,
} = require('js-yaml');

// CloudFormation short-form intrinsics. Each may appear as a scalar, a sequence
// or a mapping, so every name is registered in all three node kinds.
const CFN_FNS = [
  'Ref', 'Sub', 'GetAtt', 'Join', 'Select', 'Split', 'If',
  'Equals', 'And', 'Or', 'Not', 'FindInMap', 'Base64',
  'Cidr', 'ImportValue', 'GetAZs', 'Condition', 'Transform',
];

// Load-only tags: `identify: () => false` keeps them out of dumping entirely.
const cfnTags = CFN_FNS.flatMap((fn) => {
  const tagName = `!${fn}`;
  const key = `Fn::${fn}`;
  const wrap = (data) => ({ [key]: data });

  return [
    defineScalarTag(tagName, {
      resolve: (source) => wrap(source),
      identify: () => false,
    }),
    defineSequenceTag(tagName, {
      create: () => [],
      addItem: (carrier, item) => { carrier.push(item); },
      finalize: (carrier) => wrap(carrier),
      identify: () => false,
    }),
    defineMappingTag(tagName, {
      create: () => new Map(),
      addPair: (carrier, k, v) => { carrier.set(k, v); return ''; },
      has: (carrier, k) => carrier.has(k),
      keys: (result) => Object.keys(result[key] || {}),
      get: (result, k) => (result[key] || {})[k],
      finalize: (carrier) => wrap(Object.fromEntries(carrier)),
      identify: () => false,
    }),
  ];
});

const CFN_SCHEMA = new Schema([...CORE_SCHEMA.tags, ...cfnTags]);

const TEMPLATE_PATH = path.join(__dirname, '../../infrastructure/template.yaml');

/** Load and parse the project's CloudFormation template. */
function loadTemplate(templatePath = TEMPLATE_PATH) {
  const content = fs.readFileSync(templatePath, 'utf8');
  return load(content, { schema: CFN_SCHEMA });
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
