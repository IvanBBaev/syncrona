// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-211: sanitizeForAudit walks attacker-influenced data (`args` is whatever a
// model sent, `outcome` is whatever the instance returned) while the audit lock is
// held. The walk is bounded on depth and breadth, and it must not lose a field to
// the "__proto__" setter. Every case below either threw, hung, or silently dropped
// data before the fix.
const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeForAudit } = require('../dist/audit.js');

const MAX_DEPTH = 8;
const MAX_ENTRIES = 200;

function nest(levels, leaf) {
  let node = leaf;
  for (let i = 0; i < levels; i += 1) {
    node = { child: node };
  }
  return node;
}

test('REV-211 depth cap replaces the subtree past the limit with a value-free marker', () => {
  const secret = 'postgres://dbuser:s3cr3t@db.internal:5432/app';
  const out = sanitizeForAudit(nest(20, { dsn: secret }));

  let node = out;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    assert.equal(typeof node, 'object', `level ${i} should still be an object`);
    node = node.child;
  }
  assert.equal(typeof node, 'string');
  assert.match(node, /^<depth-capped: object\(1 keys\)>$/);

  // The point of the marker: nothing below the cap is inspected, so nothing below
  // it may be reproduced either.
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('s3cr3t'), 'a secret below the depth cap must not be serialized');
  assert.ok(!serialized.includes('dbuser'));
});

test('REV-211 depth cap names an array container without listing its items', () => {
  // Eight object wrappers put the array itself at exactly the capped depth.
  const out = sanitizeForAudit(nest(MAX_DEPTH, ['a', 'b', 'c']));
  let node = out;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    node = node.child;
  }
  assert.equal(node, '<depth-capped: array(3)>');
});

test('REV-211 a cyclic object terminates and stays JSON-serializable', () => {
  const root = { name: 'x_my_scope' };
  root.self = root;
  root.list = [root];

  const out = sanitizeForAudit(root);
  assert.equal(out.name, 'x_my_scope');
  // Before the cap this recursed until the stack blew; the RangeError propagated
  // out of the audit write, losing the record for a mutating tool call. And even
  // had it returned, the JSON.stringify inside writeAuditEvent would have thrown
  // "Converting circular structure to JSON".
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('REV-211 array breadth cap keeps the head and counts what it dropped', () => {
  const input = Array.from({ length: 250 }, (_, i) => `row-${i}`);
  const out = sanitizeForAudit(input);

  assert.equal(out.length, MAX_ENTRIES + 1);
  assert.equal(out[0], 'row-0');
  assert.equal(out[MAX_ENTRIES - 1], `row-${MAX_ENTRIES - 1}`);
  assert.equal(out[MAX_ENTRIES], '<50 more item(s) omitted>');
});

test('REV-211 array at the cap is not annotated', () => {
  const out = sanitizeForAudit(Array.from({ length: MAX_ENTRIES }, (_, i) => i));
  assert.equal(out.length, MAX_ENTRIES);
  assert.equal(out[MAX_ENTRIES - 1], MAX_ENTRIES - 1);
});

test('REV-211 object breadth cap keeps the head and counts what it dropped', () => {
  const input = {};
  for (let i = 0; i < 250; i += 1) {
    input[`field_${String(i).padStart(3, '0')}`] = `value-${i}`;
  }
  const out = sanitizeForAudit(input);
  const keys = Object.keys(out);

  assert.equal(keys.length, MAX_ENTRIES + 1);
  assert.equal(out.field_000, 'value-0');
  assert.equal(out['<audit-truncated>'], '50 more key(s) omitted');
  assert.equal(out.field_249, undefined);
});

test('REV-211 breadth truncation still redacts inside what it keeps', () => {
  const input = { password: 'p@ss' };
  for (let i = 0; i < 250; i += 1) {
    input[`f${i}`] = 'ok';
  }
  const out = sanitizeForAudit(input);
  assert.equal(out.password, '<redacted>');
});

test('REV-211 array position does not shrink an element\'s recursion budget', () => {
  // The trap this pins down: `value.map(sanitizeAuditValue)` passes (item, INDEX,
  // array), so the index arrives as `depth` — element 0 recursed with a full
  // budget while element 8 was capped outright, making redaction depend on where
  // in the array a record happened to sit.
  const input = Array.from({ length: 12 }, (_, i) => ({
    tag: `item-${i}`,
    nested: { deeper: { password: 'p@ss' } },
  }));
  const out = sanitizeForAudit(input);

  assert.equal(out.length, 12);
  out.forEach((entry, i) => {
    assert.equal(typeof entry, 'object', `element ${i} must not be depth-capped`);
    assert.equal(entry.tag, `item-${i}`);
    assert.equal(entry.nested.deeper.password, '<redacted>', `element ${i} must be redacted`);
  });
});

test('REV-211 a "__proto__" field survives into the audit record', () => {
  // JSON.parse is the real path — `args` arrives over JSON-RPC — and it makes
  // "__proto__" an OWN property. Plain `out[k] = v` then hits the inherited setter
  // instead of creating a property, so the field vanished from the record.
  const input = JSON.parse('{"__proto__": {"password": "p@ss"}, "scope": "x_my_scope"}');
  const out = sanitizeForAudit(input);

  assert.ok(Object.keys(out).includes('__proto__'), '__proto__ must be an own enumerable key');
  assert.equal(out.__proto__.password, '<redacted>');
  assert.equal(out.scope, 'x_my_scope');
  assert.ok(JSON.stringify(out).includes('__proto__'));
  // Storing the field must not re-point the container's prototype.
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test('REV-211 a secret-shaped "__proto__" string value is redacted, not dropped', () => {
  const input = JSON.parse(
    '{"__proto__": "postgres://dbuser:s3cr3t@db.internal:5432/app"}'
  );
  const out = sanitizeForAudit(input);
  assert.equal(out.__proto__, '<redacted>');
});
