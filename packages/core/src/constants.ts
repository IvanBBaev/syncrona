// SPDX-License-Identifier: GPL-3.0-or-later
import { delimiter } from "path";

/**
 * Joins encoded file-path lists (the `build --diff` manifest, git change sets).
 * A single platform delimiter can occur inside a path on some systems, so the
 * separator is the delimiter written twice.
 */
export const PATH_DELIMITER = delimiter.repeat(2);

/** Pause between two attempts of a retryable push request, in milliseconds. */
export const PUSH_RETRY_WAIT = 3_000;
/** Attempts a retryable push request gets before its error is surfaced. */
export const PUSH_RETRY_LIMIT = 3;
