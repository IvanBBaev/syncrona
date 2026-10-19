// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Turns an ES-module source file into a plain script. ServiceNow evaluates
 * server and client scripts without a module loader, so every `import` and
 * `export` has to disappear while the code they framed keeps working.
 *
 * An import can carry directives in a comment written above it or after it on
 * the same line:
 *
 *   @keepModule          leave this import statement untouched
 *   @expandModule        drop the import, but rewrite each name it bound to a
 *                        member of the module (`helper` -> `lib.helper`)
 *   @moduleAlias=<name>  together with @expandModule: qualify with <name>
 *                        instead of the module specifier
 */
import type { NodePath, PluginObject, PluginPass } from "@babel/core";
import * as t from "@babel/types";

type DirectiveValue = string | true;

/** Per-file plugin state; Babel creates a fresh pass object for every file. */
type FileState = PluginPass & {
  /** Positions of comments whose directives an import has already claimed. */
  claimedComments: Set<string>;
};

/** A name an import introduced into scope, and what it stands for. */
interface ImportedName {
  local: string;
  /** Member of the module the name refers to; `null` means the module object. */
  member: string | null;
}

const DIRECTIVE_PATTERN = /@(\w+)(?:\s*=\s*(\S+))?/g;

function commentPosition(comment: t.Comment): string {
  const start = comment.loc?.start;
  if (!start) {
    throw new Error(
      "babel-plugin-remove-modules: a comment has no source location; keep Babel's location tracking enabled."
    );
  }
  return `${start.line}:${start.column}`;
}

/**
 * The comments that annotate an import: the ones above it plus any that start
 * on its last line. Babel hands a same-line comment to the next statement as a
 * leading comment too, so each comment is claimed by the first import that
 * reads it and ignored afterwards.
 */
function annotatingComments(node: t.ImportDeclaration): t.Comment[] {
  const lastLine = node.loc?.end.line;
  const sameLine = (node.trailingComments ?? []).filter(
    comment => lastLine !== undefined && comment.loc?.start.line === lastLine
  );
  return [...(node.leadingComments ?? []), ...sameLine];
}

/**
 * Reads `@name` and `@name=value` directives. Comment bodies are joined with a
 * newline: a line comment carries no terminator, and gluing two bodies together
 * would merge a directive with the next comment's first word.
 */
function readDirectives(
  node: t.ImportDeclaration,
  state: FileState
): Map<string, DirectiveValue> {
  const unclaimed = annotatingComments(node).filter(comment => {
    const position = commentPosition(comment);
    if (state.claimedComments.has(position)) {
      return false;
    }
    state.claimedComments.add(position);
    return true;
  });
  const text = unclaimed.map(comment => comment.value).join("\n");
  const directives = new Map<string, DirectiveValue>();
  for (const [, name, value] of text.matchAll(DIRECTIVE_PATTERN)) {
    directives.set(name, value ?? true);
  }
  return directives;
}

function importedNames(node: t.ImportDeclaration): ImportedName[] {
  return node.specifiers.map(specifier => {
    const local = specifier.local.name;
    if (specifier.type === "ImportNamespaceSpecifier") {
      return { local, member: null };
    }
    if (specifier.type === "ImportDefaultSpecifier") {
      return { local, member: local };
    }
    // The member is the exported name, not the local one, so an aliased import
    // (`import { a as b }`) still resolves to `<module>.a`.
    if (specifier.imported.type !== "Identifier") {
      throw new Error(
        `babel-plugin-remove-modules: the string-named import "${specifier.imported.value}" cannot be rewritten; import it under an identifier name.`
      );
    }
    return { local, member: specifier.imported.name };
  });
}

/** The prefix @expandModule qualifies names with: the alias, or the module specifier. */
function expansionPrefix(
  path: NodePath<t.ImportDeclaration>,
  directives: Map<string, DirectiveValue>
): string {
  if (!directives.has("moduleAlias")) {
    return path.node.source.value;
  }
  const alias = directives.get("moduleAlias");
  if (typeof alias !== "string") {
    // A bare `@moduleAlias` would qualify names with `true`.
    throw path.buildCodeFrameError(
      "@moduleAlias needs a name: write @moduleAlias=<name>."
    );
  }
  return alias;
}

function stripImport(path: NodePath<t.ImportDeclaration>, state: FileState): void {
  const directives = readDirectives(path.node, state);
  if (directives.has("keepModule")) {
    return;
  }
  if (directives.has("expandModule")) {
    const prefix = expansionPrefix(path, directives);
    for (const { local, member } of importedNames(path.node)) {
      path.scope.rename(local, member === null ? prefix : `${prefix}.${member}`);
    }
  }
  path.remove();
}

function unwrapDefaultExport(path: NodePath<t.ExportDefaultDeclaration>): void {
  const exported = path.node.declaration;
  if (t.isFunctionDeclaration(exported) || t.isClassDeclaration(exported)) {
    // `export default function () {}` has no name; outside the export it needs one.
    exported.id ??= path.scope.generateUidIdentifier();
    path.replaceWith(exported);
    return;
  }
  // An identifier only re-states a binding declared elsewhere in the file.
  if (t.isIdentifier(exported)) {
    path.remove();
    return;
  }
  // Any other expression: drop it when evaluating it does nothing, and keep it
  // as a statement when it has an effect (`export default init();`).
  const expression = exported as t.Expression;
  if (path.scope.isPure(expression)) {
    path.remove();
  } else {
    path.replaceWith(t.expressionStatement(expression));
  }
}

export default function removeModules(): PluginObject<FileState> {
  return {
    pre() {
      this.claimedComments = new Set();
    },
    visitor: {
      ImportDeclaration(path, state) {
        stripImport(path, state);
      },
      // `export const x = 1` keeps the declaration; `export { x }` goes entirely.
      ExportNamedDeclaration(path) {
        const declared = path.node.declaration;
        if (declared) {
          path.replaceWith(declared);
        } else {
          path.remove();
        }
      },
      // `export * from "./x"` only re-exports another file and declares nothing.
      ExportAllDeclaration(path) {
        path.remove();
      },
      ExportDefaultDeclaration(path) {
        unwrapDefaultExport(path);
      }
    }
  };
}
