// SPDX-License-Identifier: GPL-3.0-or-later
import type { PresetObject } from "@babel/core";
import sanitizer from "./sanitizer";

/** Babel preset that makes modern output acceptable to ServiceNow's Rhino engine. */
export default function servicenowPreset(): PresetObject {
  return { plugins: [sanitizer] };
}
