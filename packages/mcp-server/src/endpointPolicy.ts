// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Shared allow-rule for model-supplied remote script endpoints.
 *
 * Both `sn_execute_background_script` (serviceNowCrudHandlers) and
 * `sync_unified_change_workflow` (workflowHandlers) let the caller override the
 * background-script API path. Because that value is model-controlled and is used
 * to build the request URL, it must be constrained so it cannot point the
 * background-script POST at an arbitrary path (path traversal, protocol-relative
 * `//host`, or a non-path string). Keeping the check in one place stops the two
 * call sites from drifting.
 *
 * An endpoint is accepted only when it is a rooted path made of the safe URL
 * path characters and contains no `..` traversal segment.
 */
export function isSafeRemoteEndpoint(endpointPath: string): boolean {
  if (!/^\/[a-z0-9_./-]*$/i.test(endpointPath)) {
    return false;
  }
  // The character class above permits "." and "/", so it still admits "/../"
  // path-traversal sequences. Reject any ".." segment explicitly. Also reject a
  // leading "//" which the regex allows but is a protocol-relative authority.
  if (endpointPath.startsWith("//")) {
    return false;
  }
  return !endpointPath.split("/").some((segment) => segment === "..");
}
