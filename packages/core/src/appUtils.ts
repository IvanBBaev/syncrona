// SPDX-License-Identifier: GPL-3.0-or-later
// #44: this file was an 844-line "god module". It is now a thin re-export barrel
// over four cohesive siblings so both namespace (`import * as AppUtils`) and
// named importers keep working unchanged:
//   - progress:         the standalone progress-tick renderer
//   - downloadPipeline:  manifest sync + missing-file discovery + resumable pull
//   - pushPipeline:      grouping, building and pushing local files
//   - scopeManagement:   scope swap, update-set assignment and scope checks
export * from "./progress";
export * from "./downloadPipeline";
export * from "./pushPipeline";
export * from "./scopeManagement";
