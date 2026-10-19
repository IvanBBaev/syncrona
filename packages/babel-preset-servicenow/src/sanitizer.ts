// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Rewrites constructs that modern JavaScript allows but ServiceNow's ES3-era
 * Rhino engine rejects:
 *   - `__proto__` is renamed to `__proto_sn__` wherever it appears as a name;
 *   - a reserved word used as a dotted property (`a.default`, `a?.class`) moves
 *     to bracket access (`a["default"]`);
 *   - a reserved word used as an object-literal key, method or accessor name is
 *     quoted (`{ "default": 1 }`);
 *   - the "use strict" directive is dropped from the program prologue.
 */
import type { NodePath, PluginObject } from "@babel/core";
import * as t from "@babel/types";
import { isReservedWord } from "./sanitizerHelper";

const PROTO = "__proto__";
const PROTO_REPLACEMENT = "__proto_sn__";

/** The name of a non-computed identifier key that Rhino would reject, if any. */
function reservedKeyName(key: t.Node, computed: boolean): string | undefined {
  if (computed || !t.isIdentifier(key) || !isReservedWord(key.name)) {
    return undefined;
  }
  return key.name;
}

function bracketMemberAccess(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>
): void {
  const { node } = path;
  const name = reservedKeyName(node.property, node.computed);
  if (name === undefined) {
    return;
  }
  const property = t.stringLiteral(name);
  path.replaceWith(
    t.isOptionalMemberExpression(node)
      ? t.optionalMemberExpression(node.object, property, true, node.optional)
      : t.memberExpression(node.object, property, true)
  );
}

function quoteObjectKey(node: t.ObjectProperty | t.ObjectMethod): void {
  const name = reservedKeyName(node.key, node.computed);
  if (name === undefined) {
    return;
  }
  node.key = t.stringLiteral(name);
  if (t.isObjectProperty(node)) {
    // `{ default }` cannot stay shorthand once the key is a string.
    node.shorthand = false;
  }
}

function dropUseStrict(program: t.Program): void {
  program.directives = program.directives.filter(
    directive => directive.value.value !== "use strict"
  );
}

export default function sanitizer(): PluginObject {
  return {
    visitor: {
      Identifier(path) {
        if (path.node.name === PROTO) {
          path.node.name = PROTO_REPLACEMENT;
        }
      },
      MemberExpression: bracketMemberAccess,
      OptionalMemberExpression: bracketMemberAccess,
      ObjectProperty(path) {
        quoteObjectKey(path.node);
      },
      ObjectMethod(path) {
        quoteObjectKey(path.node);
      },
      Program: {
        exit(path) {
          dropUseStrict(path.node);
        }
      }
    }
  };
}
