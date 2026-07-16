// SPDX-License-Identifier: GPL-3.0-or-later
import { PluginObject, NodePath } from "@babel/core";
import * as t from "@babel/types";
export default function() {
  const commentUsageTracker = new Set<string>();
  function genLocString(comment: t.Comment) {
    if(comment.loc){
      return `c${comment.loc.start.column}l${comment.loc.start.line}`;
    }
    else throw new Error("Issues with comment.loc on babel plugin. Talk to a dev to resolve this.");
  }
  function getCommentTags(path: NodePath<t.ImportDeclaration>) {
    const node = path.node;
    let comments = "";
    if (node.leadingComments && node.leadingComments.length > 0) {
      comments = node.leadingComments
        .filter(comment => {
          return !commentUsageTracker.has(genLocString(comment));
        })
        .reduce((acc, comment) => {
          commentUsageTracker.add(genLocString(comment));
          acc += comment.value;
          return acc;
        }, "");
    }
    const tags = new Map<string, string | boolean>();
    const tagRegex = /@\w+\s*=?\s*\w+/g;
    const matches = comments.match(tagRegex);
    if (matches) {
      for (const match of matches) {
        if (match.includes("=")) {
          const chunks = match.split("=");
          const tag = chunks[0].trim().substring(1);
          const value = chunks[1].trim();
          tags.set(tag, value);
        } else {
          tags.set(match.substring(1), true);
        }
      }
    }
    return tags;
  }
  function renameAllImports(
    moduleName: string,
    _imports: { local: string; imported: string | null }[],
    path: NodePath<t.ImportDeclaration>
  ) {
    for (const { local, imported } of _imports) {
      // Rename the LOCAL binding (the name actually in scope) to the qualified
      // form. A null `imported` marks a namespace import, which expands to the
      // module object itself rather than a `<module>.<member>` reference.
      const qualified =
        imported === null ? moduleName : [moduleName, imported].join(".");
      path.scope.rename(local, qualified);
    }
  }
  return {
    // Babel caches and reuses a single plugin instance across every file in a
    // build, so the factory-closure `commentUsageTracker` would otherwise carry
    // state between files. The tracker exists to dedupe a comment WITHIN one file
    // (a leading comment can attach to several nodes); reset it before each file
    // so one file's comment at a given line/column cannot suppress a
    // same-positioned @keepModule/@expandModule tag in the next file.
    pre() {
      commentUsageTracker.clear();
    },
    visitor: {
      //remove imports
      ImportDeclaration(path) {
        //get comment tags
        const tags = getCommentTags(path);
        //should we remove?
        if (tags.has("keepModule")) {
          //no we shouldn't
          return;
        }
        //load all imported modules
        const _imports = path.node.specifiers.reduce(
          (acc, cur) => {
            if (cur.type === "ImportSpecifier") {
              // Rename FROM the local binding, but build the qualified name from
              // the ORIGINAL imported name so an aliased import
              // (`import { foo as bar }`) still resolves to `<module>.foo`.
              if(cur.imported.type == "Identifier")
              acc.push({ local: cur.local.name, imported: cur.imported.name });
              else throw new Error("Wrong identifier type in babel plugin. Check with a dev.")
            }
            if (cur.type === "ImportDefaultSpecifier") {
              acc.push({ local: cur.local.name, imported: cur.local.name });
            }
            if (cur.type === "ImportNamespaceSpecifier") {
              // `import * as ns` binds the whole module object; expand `ns` to
              // the module itself so `ns.foo()` becomes `<module>.foo()`.
              acc.push({ local: cur.local.name, imported: null });
            }
            return acc;
          },
          [] as { local: string; imported: string | null }[]
        );
        //yes we should remove
        //should we expand?
        if (tags.has("expandModule")) {
          //do we have an alias?
          if (tags.has("moduleAlias")) {
            //expand with alias
            const aliasName = tags.get("moduleAlias") as string;
            renameAllImports(aliasName, _imports, path);
          } else {
            //expand using module name
            const moduleName = path.node.source.value;
            renameAllImports(moduleName, _imports, path);
          }
        }
        //remove import path
        path.remove();
      },
      ExportNamedDeclaration(path) {
        if (path.node.declaration) {
          path.replaceWith(path.node.declaration);
        } else {
          path.remove();
        }
      },
      ExportDefaultDeclaration(path) {
        const type = path.node.declaration.type;
        if (type === "FunctionDeclaration") {
          //anonymous function
          if (!(path.node.declaration as t.FunctionDeclaration).id) {
            (path.node
              .declaration as t.FunctionDeclaration).id = path.scope.generateUidIdentifier();
          }
          path.replaceWith(path.node.declaration);
          return;
        }
        if (type === "Identifier") {
          path.remove();
          return;
        }
        if (type === "ClassDeclaration") {
          if (!(path.node.declaration as t.ClassDeclaration).id) {
            (path.node
              .declaration as t.ClassDeclaration).id = path.scope.generateUidIdentifier();
          }
          path.replaceWith(path.node.declaration);
          return;
        }
        //fallback remove it
        path.remove();
      }
    }
  } as PluginObject;
}
