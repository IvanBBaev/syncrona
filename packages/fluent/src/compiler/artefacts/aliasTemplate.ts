// SPDX-License-Identifier: GPL-3.0-or-later
//
// AliasTemplate() → sys_alias_templates.

import type { FluentValue } from "../evaluate";
import { CData, type CompiledRecord } from "../record";
import { lookup, type ArtefactSpec, type BuildContext, type Options } from "./shared";

/** The SDK's default on-edit and post-process script (the same text). */
const DEFAULT_SCRIPT = `(function execute(aliasId, connectionSysId, jsonDefaultData, jsonDynamicData) {
   // aliasId: sys_id of the alias record
   // connectionSysId: sys_id of the connection record created by using the default and dynamic data
   // jsonDefaultData (String): The default JSON template data from template table
   // e.g. var jsonDefaultParsed = JSON.parse(jsonDefaultData);
   //      gs.info("default connection url = " + jsonDefaultParsed["connection"]["connection_url"]);
   // jsonDynamicData (String): User input based on the key/values defined in "Dynamic Data"
   // e.g. var jsonDynamicParsed = JSON.parse(jsonDynamicData);
   //      gs.info("dynamic connection url = " + jsonDynamicParsed["connection.connection_url"]);
})(aliasId, connectionSysId, jsonDefaultData, jsonDynamicData);
`;
const DEFAULT_PRE_EDIT_SCRIPT = `(function execute(aliasId, connectionSysId, jsonDefaultData, jsonDynamicData) {
   // aliasId: sys_id of the alias record.
   // connectionSysId: sys_id of the connection record created by using the default and dynamic data.
   // jsonDefaultData (String): The default JSON template data from template table.
   // e.g. var jsonDefaultParsed = JSON.parse(jsonDefaultData);
   //      gs.info("default connection url = " + jsonDefaultParsed["connection"]["connection_url"]);
   // jsonDynamicData (String): Current values of Connection and Credential fields (except Password fields) based on the key-value pairs defined in "Dynamic Data".
   // e.g. var jsonDynamicParsed = JSON.parse(jsonDynamicData);
   //      gs.info("dynamic connection url = " + jsonDynamicParsed["connection.connection_url"]);

   //returns array of objects. Each object has name-value pairs for populating additional fields values in connections dashboard in the edit view.
   //In this example script, additionalField1, additionalField2 are additional fields.
   //Here we define calcAdditionalField1(), calcAdditionalField2() functions in the script
   //to calculate current values for additionalField1, additionalField2.

   //return [{
   //         name: "additionalField1"
   //         value: calcAdditionalField1(),
   //    },
   //    {
   //         name: "additionalField2"
   //         value: calcAdditionalField2(),
   //    }
   //];

   return [];
})(aliasId, connectionSysId, jsonDefaultData, jsonDynamicData);
`;

/** The only keys the SDK renames to snake_case, at any depth; every other key is kept. */
const SNAKE_KEYS: Record<string, string> = {
  connectionFields: "connection_fields",
  credentialFields: "credential_fields",
  additionalFields: "additional_fields",
  useMid: "use_mid",
  connectionUrl: "connection_url",
  defaultGroup: "default_group",
};

/** A literal as the JSON the SDK writes: known keys renamed, null and undefined object members dropped. */
function toJson(o: Options, value: FluentValue, key: string): unknown {
  switch (value.kind) {
    case "string":
    case "number":
    case "boolean":
      return value.value;
    case "null":
      return null;
    case "array":
      return value.items.map((item) => toJson(o, item, key));
    case "object":
      return Object.fromEntries(
        [...value.props]
          .filter(([, v]) => v.kind !== "undefined" && v.kind !== "null")
          .map(([k, v]) => [lookup(SNAKE_KEYS, k) ?? k, toJson(o, v, key)]),
      );
    default:
      return o.error(`AliasTemplate(): '${key}' must be JSON data.`, value);
  }
}

function jsonField(o: Options, key: string): string {
  const value = o.get(key);
  return value === undefined || value.kind === "null" ? "" : JSON.stringify(toJson(o, value, key), null, 2);
}

function scriptField(o: Options, key: string, fallback: string): string | CData {
  const script = o.string(key);
  return script === undefined ? fallback : new CData(script);
}

/** A sys_id string, or the record of an API call (the SDK takes any record's id). */
function testAction(o: Options, ctx: BuildContext): string | CompiledRecord {
  const value = o.get("testAction");
  if (value?.kind === "call") return ctx.recordOf(value);
  return o.string("testAction") ?? "";
}

export const aliasTemplate: ArtefactSpec = {
  properties: ["name", "dynamicDataSchema", "defaultDataTemplate", "preEditScript", "onEditScript", "postProcessScript", "testAction"],
  build(o, ctx) {
    return ctx.factory.createRecord({
      table: "sys_alias_templates",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name"),
        dynamic_data_schema: jsonField(o, "dynamicDataSchema"),
        default_data_template: jsonField(o, "defaultDataTemplate"),
        pre_edit_script: scriptField(o, "preEditScript", DEFAULT_PRE_EDIT_SCRIPT),
        on_edit_script: scriptField(o, "onEditScript", DEFAULT_SCRIPT),
        post_process_script: scriptField(o, "postProcessScript", DEFAULT_SCRIPT),
        test_action: testAction(o, ctx),
      },
    });
  },
};
