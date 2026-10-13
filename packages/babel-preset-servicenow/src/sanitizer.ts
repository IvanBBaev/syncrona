// SPDX-License-Identifier: GPL-3.0-or-later
import { PluginObject } from "@babel/core";
import * as t from "@babel/types";
import { isReservedWord } from "./sanitizerHelper";
export default function() {
  return {
    visitor: {
      Identifier(path) {
        //replaces references to __proto__, illegal in SN
        if (path.node.name === "__proto__") {
          path.node.name = "__proto_sn__";
        }
      },
      //if a reserved word is used as a property, move it to a bracket syntax
      MemberExpression(path) {
        if (
          path.node.property.type === "Identifier" &&
          isReservedWord(path.node.property.name) &&
          !path.node.computed
        ) {
          const replacement = t.memberExpression(
            path.node.object,
            t.stringLiteral(path.node.property.name),
            true
          );
          path.replaceWith(replacement);
        }
      },
      // `a?.default` is the same dot access spelled through optional chaining.
      OptionalMemberExpression(path) {
        if (
          path.node.property.type === "Identifier" &&
          isReservedWord(path.node.property.name) &&
          !path.node.computed
        ) {
          path.replaceWith(
            t.optionalMemberExpression(
              path.node.object,
              t.stringLiteral(path.node.property.name),
              true,
              path.node.optional
            )
          );
        }
      },
      //ES3 rejects a reserved word as an object literal key too, so quote it;
      //methods and accessors (`get default() {}`) carry the same key
      "ObjectProperty|ObjectMethod"(path) {
        const node = path.node as t.ObjectProperty | t.ObjectMethod;
        const key = node.key;
        if (key.type === "Identifier" && isReservedWord(key.name) && !node.computed) {
          node.key = t.stringLiteral(key.name);
          if (node.type === "ObjectProperty") {
            node.shorthand = false;
          }
        }
      },
      //remove use strict
      Program: {
        exit: function exit(path) {
            const list = path.node.directives;
            for(let i=list.length-1, it; i>=0 ; i--){
                it = list[i];
                if (it.value.value==='use strict'){
                    list.splice(i,1);
                }
            }
        }
      }
    }
  } as PluginObject;
}
