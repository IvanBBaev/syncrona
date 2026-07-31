// SPDX-License-Identifier: GPL-3.0-or-later
// Property-based coverage for the MCP tool-argument validator.
//
// validateToolArguments is the first thing index.ts runs on a tools/call request,
// with `request.params.name` and the raw arguments object passed straight through
// from the client. It is therefore the one function in the server whose entire
// input is attacker-controlled, and it has exactly two obligations:
//
//   1. Totality — it must return a verdict for ANY (toolName, args) pair. There is
//      no try/catch around the call in index.ts, so a throw is an unhandled crash
//      on the request path instead of a clean INVALID_ARGUMENTS error.
//   2. Soundness of "valid" — when it says valid, the normalizedArgs it hands to
//      the handler must actually satisfy the constraints it just checked. A
//      handler that re-checks (or that interpolates the value into a URL or an
//      audit line) must never see a value the gate silently let past.
//
// Both obligations were violated; see the two `regression:` tests below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  validateToolArguments,
  TABLE_NAME_REGEX,
  SYS_ID_REGEX,
} = require('../dist/inputValidation.js');
const { MCP_TOOLS } = require('../dist/toolSchemas.js');

const TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name).filter(
  (name) => typeof name === 'string' && name.length > 0
);

// The identifier fields validateTopLevelIdentifiers re-checks regardless of tool.
const IDENTIFIER_REGEXES = {
  table: TABLE_NAME_REGEX,
  tableName: TABLE_NAME_REGEX,
  sysId: SYS_ID_REGEX,
  updateSetSysId: SYS_ID_REGEX,
  expectedUpdateSetSysId: SYS_ID_REGEX,
};
const IDENTIFIER_KEYS = Object.keys(IDENTIFIER_REGEXES);

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// Names that reach the schema lookup: real tools, plausible typos, and the
// Object.prototype members a bare record index resolves.
const toolName = fc.oneof(
  { arbitrary: fc.constantFrom(...TOOL_NAMES), weight: 6 },
  {
    arbitrary: fc.constantFrom(
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
      '__defineGetter__',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString'
    ),
    weight: 3,
  },
  { arbitrary: fc.string({ maxLength: 12 }), weight: 1 }
);

// Identifier values that hover around the regex boundary: valid, whitespace-
// padded, newline-bearing, wrong case, wrong length, and non-strings.
const identifierValue = fc.oneof(
  fc.constantFrom(
    'incident',
    'sys_script_include',
    'a'.repeat(32),
    'A'.repeat(32),
    '  incident  ',
    'incident\n',
    '\nincident',
    'incident\t',
    ` ${'a'.repeat(32)} `,
    `${'a'.repeat(32)}\n`,
    '',
    ' ',
    '\n',
    'Incident',
    'z'.repeat(32),
    'a'.repeat(31),
    'a'.repeat(33),
    '../secret',
    'incident;drop'
  ),
  fc.string({ maxLength: 40 }),
  fc.constantFrom(null, undefined, 42, true, {}, [], () => 1)
);

const argsArbitrary = fc.dictionary(
  fc.oneof(
    { arbitrary: fc.constantFrom(...IDENTIFIER_KEYS), weight: 6 },
    {
      arbitrary: fc.constantFrom(
        'query',
        'fields',
        'limit',
        'timeoutMs',
        'dryRun',
        'confirmDestructive',
        'record',
        'updates',
        'script',
        'constructor',
        '__proto__'
      ),
      weight: 3,
    },
    { arbitrary: fc.string({ maxLength: 8 }), weight: 1 }
  ),
  fc.oneof(
    { arbitrary: identifierValue, weight: 5 },
    { arbitrary: fc.anything({ maxDepth: 2 }), weight: 2 }
  ),
  { maxKeys: 5 }
);

// ---------------------------------------------------------------------------
// Property 1 — totality
// ---------------------------------------------------------------------------

test('validateToolArguments returns a verdict for every tool name and argument object', () => {
  fc.assert(
    fc.property(toolName, argsArbitrary, (name, args) => {
      const result = validateToolArguments(name, args);
      assert.equal(typeof result, 'object');
      assert.equal(typeof result.valid, 'boolean');
      if (result.valid) {
        assert.equal(typeof result.normalizedArgs, 'object');
        assert.notEqual(result.normalizedArgs, null);
      } else {
        assert.equal(typeof result.error, 'string');
        assert.ok(result.error.length > 0);
      }
      return true;
    }),
    { numRuns: 4000 }
  );
});

test('regression: an Object.prototype member as the tool name is rejected, not thrown on', () => {
  // Pre-fix, `toolArgSchemas[toolName]` resolved the inherited member, so the
  // truthy-but-schemaless `Object` function reached `schema.safeParse(args)`:
  //   TypeError: schema.safeParse is not a function
  // Found by the totality property, which shrank to
  //   ["constructor", {}]  { seed: 1774036992, path: "0:0:0" }
  // index.ts:106 passes `request.params.name` verbatim before any
  // is-this-a-real-tool check, so the name is fully client-controlled and the
  // throw surfaced as a generic internal error instead of INVALID_ARGUMENTS.
  // Same bug class, and the same fix, as normalizeAuthMethod in @syncrona/sn-transport.
  for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    const result = validateToolArguments(name, { table: 'incident' });
    assert.equal(result.valid, true, `${name} must not throw`);
  }
});

// ---------------------------------------------------------------------------
// Property 2 — an accepted identifier survives its own regex
// ---------------------------------------------------------------------------

test('an accepted identifier in normalizedArgs always satisfies the regex it was validated against', () => {
  fc.assert(
    fc.property(toolName, argsArbitrary, (name, args) => {
      const result = validateToolArguments(name, args);
      fc.pre(result.valid === true);
      for (const [key, regex] of Object.entries(IDENTIFIER_REGEXES)) {
        if (!Object.prototype.hasOwnProperty.call(result.normalizedArgs, key)) {
          continue;
        }
        const value = result.normalizedArgs[key];
        if (typeof value !== 'string' || value.length === 0) {
          // An absent-or-empty identifier is resolved by name downstream; the
          // empty case is documented in src as "not supplied".
          continue;
        }
        assert.ok(
          regex.test(value),
          `${name}: accepted ${key}=${JSON.stringify(value)} which fails ${regex}`
        );
      }
      return true;
    }),
    { numRuns: 4000 }
  );
});

test('regression: an identifier the tool schema does not cover is still normalized before it is accepted', () => {
  // Pre-fix, validateTopLevelIdentifiers parsed the value with a `.trim()`ing
  // schema and then DISCARDED the parsed output, keeping only `parsed.success`.
  // So whenever the value was not also normalized by the tool's own zod schema —
  // either an extra key on a looseObject, or any tool with no entry in
  // toolArgSchemas — the verdict was "valid" while normalizedArgs still held the
  // untrimmed string. Found by the property above, which shrank to
  //   ["sn_query_records", { sysId: " aaaaaaaa…a " }]
  //   { seed: -297384011, path: "12:2:0:1" }
  // The escaping characters are exactly those String.prototype.trim strips, so
  // "incident\n" reached the Table API URL builder and the audit line as a value
  // the gate had declared regex-clean.
  const paddedSysId = ` ${'a'.repeat(32)} `;

  // (a) extra key on a looseObject schema
  const extra = validateToolArguments('sn_query_records', {
    table: 'incident',
    sysId: paddedSysId,
  });
  assert.equal(extra.valid, true);
  assert.equal(extra.normalizedArgs.sysId, 'a'.repeat(32));

  // (b) a tool with no schema of its own
  const noSchema = validateToolArguments('sn_search_scripts', { table: '  incident\n' });
  assert.equal(noSchema.valid, true);
  assert.equal(noSchema.normalizedArgs.table, 'incident');
});

test('normalizing an accepted identifier never mutates the caller-supplied arguments object', () => {
  // The fix must copy rather than write through: index.ts keeps `rawArgs` for the
  // audit trail and the correlation id, so normalization must not retroactively
  // rewrite what the client actually sent.
  fc.assert(
    fc.property(toolName, argsArbitrary, (name, args) => {
      const before = JSON.stringify(args, (_key, value) =>
        typeof value === 'function' ? '[fn]' : value
      );
      validateToolArguments(name, args);
      const after = JSON.stringify(args, (_key, value) =>
        typeof value === 'function' ? '[fn]' : value
      );
      return before === after;
    }),
    { numRuns: 3000 }
  );
});

// ---------------------------------------------------------------------------
// Property 3 — verdicts are stable and independent of key order
// ---------------------------------------------------------------------------

test('the verdict does not depend on the insertion order of the argument keys', () => {
  fc.assert(
    fc.property(toolName, argsArbitrary, (name, args) => {
      const keys = Object.keys(args);
      fc.pre(keys.length > 1);
      const reversed = {};
      for (const key of [...keys].reverse()) {
        // defineProperty, not assignment: `reversed.__proto__ = v` would hit the
        // Object.prototype setter and change the prototype instead of adding the
        // own key the arbitrary generated.
        Object.defineProperty(reversed, key, {
          value: args[key],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const a = validateToolArguments(name, args);
      const b = validateToolArguments(name, reversed);
      // The first-issue wording may legitimately differ when two keys are both
      // invalid, so compare the accept/reject decision only.
      return a.valid === b.valid;
    }),
    { numRuns: 3000 }
  );
});
