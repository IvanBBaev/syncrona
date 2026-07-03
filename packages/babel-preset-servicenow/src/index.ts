// SPDX-License-Identifier: GPL-3.0-or-later
import sanitizePlugin from "./sanitizer";
export default function() {
  return {
    plugins: [sanitizePlugin]
  };
}
