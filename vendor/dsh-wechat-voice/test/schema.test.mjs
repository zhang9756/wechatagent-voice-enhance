// Guard against the failure that made the DSH plugin card show "异常":
// ctx.tools.register() runs assertSupportedJsonSchema on output.schema, and the
// supported subset is strict. This mirrors that subset locally so a bad schema
// fails the test run instead of failing at DSH startup.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'];
const CONSTRAINTS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATIONS = new Set([
  'description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'format', 'comment', '$comment', 'x-order', 'presentationMeta',
]);

function checkNode(node, at, violations) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${at} must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINTS.has(key) || ANNOTATIONS.has(key)) continue;
    violations.push(`${at}.${key} is not a supported keyword`);
  }
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') violations.push(`${at}.description must be a string`);
  if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') violations.push(`${at}.title must be a string`);

  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) { violations.push(`${at} cannot declare both type and oneOf`); return; }
  if (!hasType && !hasOneOf) return;

  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${at}.oneOf must be an array of at least two schemas`);
    else node.oneOf.forEach((branch, index) => checkNode(branch, `${at}.oneOf[${index}]`, violations));
    return;
  }

  if (typeof node.type !== 'string' || !SCHEMA_TYPES.includes(node.type)) {
    violations.push(`${at}.type must be one of ${SCHEMA_TYPES.join('/')}`);
    return;
  }
  const type = node.type;
  const onlyOn = { properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'], enum: ['string', 'number', 'integer', 'boolean', 'null'], const: ['string', 'number', 'integer', 'boolean', 'null'] };
  for (const [key, types] of Object.entries(onlyOn)) {
    if (Object.hasOwn(node, key) && !types.includes(type)) violations.push(`${at}.${key} is not supported on type "${type}"`);
  }
  if (type === 'object') {
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${at}.additionalProperties must be explicitly true or false`);
    }
    if (Object.hasOwn(node, 'required') && (!Array.isArray(node.required) || !node.required.every(entry => typeof entry === 'string'))) {
      violations.push(`${at}.required must be an array of property names`);
    }
    if (Object.hasOwn(node, 'properties')) {
      if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) violations.push(`${at}.properties must be an object of schemas`);
      else for (const [key, child] of Object.entries(node.properties)) checkNode(child, `${at}.properties.${key}`, violations);
    }
  }
  if (type === 'array' && Object.hasOwn(node, 'items')) checkNode(node.items, `${at}.items`, violations);
}

const assertSupported = schema => {
  const violations = [];
  checkNode(schema, 'schema', violations);
  assert.deepEqual(violations, [], violations.join('; '));
};

function definitionsOf() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-schema-'));
  const definitions = [];
  apply({ tools: { register: definition => { definitions.push(definition); return definition; } }, logger: () => ({ info: () => {} }) }, { root });
  fs.rmSync(root, { recursive: true, force: true });
  return definitions;
}

test('the schema checker itself rejects the shapes that broke DSH', () => {
  assert.throws(() => assertSupported({ type: 'json' }), /type must be one of|not a supported keyword/);
  const violations = [];
  checkNode({ type: 'object', properties: { text: { type: 'string', maxLength: 10 } }, additionalProperties: false }, 'schema', violations);
  assert.ok(violations.some(item => item.includes('maxLength')), violations.join('; '));
});

test('every registered tool declares a supported output schema', () => {
  const definitions = definitionsOf();
  assert.ok(definitions.length >= 3);
  for (const definition of definitions) {
    assert.equal(typeof definition.output?.render, 'function', `${definition.name} needs render`);
    assertSupported(definition.output.schema);
  }
});

test('every registered tool declares supported parameters', () => {
  for (const definition of definitionsOf()) {
    assertSupported(definition.parameters);
  }
});

test('schemas stay inside the documented keyword subset', () => {
  const forbidden = /maxLength|minLength|minimum|maximum|pattern|format:|uniqueItems|multipleOf/;
  for (const definition of definitionsOf()) {
    assert.ok(!forbidden.test(JSON.stringify(definition.parameters)), `${definition.name} parameters use a rejected keyword`);
  }
});
