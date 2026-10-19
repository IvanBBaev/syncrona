// SPDX-License-Identifier: GPL-3.0-or-later
//
// UserPreference() → sys_user_preference. Unlike most APIs it writes no
// defaults: an option left out is not a field of the record.

import type { ArtefactSpec } from "./shared";

export const userPreference: ArtefactSpec = {
  properties: ["name", "type", "value", "description", "system"],
  build(o, ctx) {
    const value = o.scalar("value");
    if (value === undefined) o.error("UserPreference(): 'value' is required.");
    const description = o.string("description");
    const system = o.boolean("system");
    return ctx.factory.createRecord({
      table: "sys_user_preference",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.requiredString("name"),
        type: o.requiredString("type"),
        value,
        ...(description === undefined ? {} : { description }),
        ...(system === undefined ? {} : { system }),
      },
    });
  },
};
