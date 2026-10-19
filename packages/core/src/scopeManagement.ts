// SPDX-License-Identifier: GPL-3.0-or-later
// Session scope and update-set handling. Both are per-user preferences on the
// instance (`apps.current_app`, `sys_update_set`), so switching either one is
// "point the user's preference record at a new target, creating it if absent".
import type { AxiosPromise } from "axios";
import { SN, Sync } from "@syncrona/types";
import * as ConfigManager from "./config.js";
import * as snClient from "./snClient.js";
import { logger } from "./Logger.js";

type Client = ReturnType<typeof snClient.defaultClient>;
// Any Table API lookup that answers with rows carrying a sys_id.
type SysIdQuery = AxiosPromise<Sync.SNAPIResponse<Array<{ sys_id: string }>>>;

/** The three Table API operations behind one user preference. */
interface PreferenceRecordOps {
  find(userSysId: string): SysIdQuery;
  update(targetSysId: string, preferenceSysId: string): Promise<unknown>;
  create(targetSysId: string, userSysId: string): Promise<unknown>;
}

const sysIdOf = (query: SysIdQuery): Promise<string> =>
  snClient.unwrapTableAPIFirstItem(query, "sys_id");

const currentUserSysId = (client: Client): Promise<string> => sysIdOf(client.getUserSysId());

// An empty lookup means the user has never had this preference: create the
// record instead of updating it.
async function pointPreferenceAt(
  ops: PreferenceRecordOps,
  targetSysId: string,
  userSysId: string
): Promise<void> {
  const preferenceSysId = await snClient.unwrapTableAPIFirstItemOrEmpty(
    ops.find(userSysId),
    "sys_id"
  );
  if (preferenceSysId === "") {
    await ops.create(targetSysId, userSysId);
    return;
  }
  await ops.update(targetSysId, preferenceSysId);
}

const appPreference = (client: Client): PreferenceRecordOps => ({
  find: (user) => client.getCurrentAppUserPrefSysId(user),
  update: (target, pref) => client.updateCurrentAppUserPref(target, pref),
  create: (target, user) => client.createCurrentAppUserPref(target, user),
});

const updateSetPreference = (client: Client): PreferenceRecordOps => ({
  find: (user) => client.getCurrentUpdateSetUserPref(user),
  update: (target, pref) => client.updateCurrentUpdateSetUserPref(target, pref),
  create: (target, user) => client.createCurrentUpdateSetUserPref(target, user),
});

/**
 * Moves the session to `scopeName` and returns the scope the instance now
 * reports, read back from the same preference so a refused write shows up.
 */
export const swapScope = async (scopeName: string): Promise<SN.ScopeObj> => {
  const client = snClient.defaultClient();
  const appSysId = await sysIdOf(client.getScopeId(scopeName));
  try {
    await pointPreferenceAt(appPreference(client), appSysId, await currentUserSysId(client));
  } catch (e) {
    logger.error(e instanceof Error ? e.message : String(e));
    throw e;
  }
  return client.getSessionScope();
};

/**
 * Creates an update set named `name` and makes it the current user's active
 * one; returns its name and sys_id.
 */
export const createAndAssignUpdateSet = async (name = "") => {
  logger.info(`Update Set Name: ${name}`);
  const client = snClient.defaultClient();
  const created = await snClient.unwrapSNResponse(client.createUpdateSet(name));
  const updateSetSysId = created.sys_id;
  await pointPreferenceAt(
    updateSetPreference(client),
    updateSetSysId,
    await currentUserSysId(client)
  );
  return { name, id: updateSetSysId };
};

const scopeResult = (sessionScope: string, manifestScope: string): Sync.ScopeCheckResult => ({
  match: sessionScope === manifestScope,
  sessionScope,
  manifestScope,
});

/**
 * Compares the session scope with the project's manifest scope, switching the
 * session first when `swap` is set and they differ. Before the first download
 * there is no manifest, and the check passes with empty scopes.
 */
export const checkScope = async (swap: boolean): Promise<Sync.ScopeCheckResult> => {
  const manifest = ConfigManager.getManifest();
  if (!manifest) {
    return scopeResult("", "");
  }
  const projectScope = manifest.scope;
  const { scope: sessionScope } = await snClient.defaultClient().getSessionScope();
  if (sessionScope === projectScope || !swap) {
    return scopeResult(sessionScope, projectScope);
  }
  const switched = await swapScope(projectScope);
  return scopeResult(switched.scope, projectScope);
};
