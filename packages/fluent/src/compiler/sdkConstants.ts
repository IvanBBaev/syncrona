// SPDX-License-Identifier: GPL-3.0-or-later
//
// Constant maps the SDK exports from `@servicenow/sdk/core` (`ui/Form.ts`):
// each member is the sys_id of a platform record.

export const ANNOTATION_TYPE: Readonly<Record<string, string>> = {
  Info_Box_Blue: "753f88a80f930000b12e6903cfe01206",
  Info_Box_Red: "823f88a80f930000b12e6903cfe01209",
  Line_Separator: "a93fc8e00f530000b12e6903cfe012e6",
  Plain_Text: "8e7fdb04531300109686ddeeff7b127d",
  Section_Details: "19756e5ec3313000bac1addbdfba8f18",
  Section_Plain_Text: "a21c608353611010a813ddeeff7b12fc",
  Section_Separator: "443e806c0fd30000b12e6903cfe01281",
  Text: "863e446c0fd30000b12e6903cfe012ce",
};

export const FORMATTER: Readonly<Record<string, string>> = {
  Activities_Filtered: "444ea5c6bf310100e628555b3f0739d6",
  Attached_Knowledge: "cfa76e850a0a0b1f01446f67c8538d00",
};

/** The constant maps by their exported name. */
export const SDK_CONSTANTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  AnnotationType: ANNOTATION_TYPE,
  Formatter: FORMATTER,
};
