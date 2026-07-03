// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncro-now-ai/types";
import * as ConfigManager from "./config.js";
import {
  defaultClient,
  unwrapSNResponse,
  unwrapTableAPIFirstItem,
  unwrapTableAPIFirstItemOrEmpty,
} from "./snClient.js";
import { isScopedEndpointUnavailableError } from "./manifestBuilder.js";
import { logger } from "./Logger.js";

export const swapScope = async (currentScope: string): Promise<SN.ScopeObj> => {
  const client = defaultClient();
  const scopeId = await unwrapTableAPIFirstItem(
    client.getScopeId(currentScope),
    "sys_id"
  );
  await swapServerScope(scopeId);
  const scopeObj = await unwrapSNResponse(client.getCurrentScope());
  return scopeObj;
};

const swapServerScope = async (scopeId: string): Promise<void> => {
  try {
    const client = defaultClient();
    const userSysId = await unwrapTableAPIFirstItem(
      client.getUserSysId(),
      "sys_id"
    );
    // Empty result means no user pref record exists yet — create it.
    const curAppUserPrefId = await unwrapTableAPIFirstItemOrEmpty(
      client.getCurrentAppUserPrefSysId(userSysId),
      "sys_id"
    );
    if (curAppUserPrefId !== "")
      await client.updateCurrentAppUserPref(scopeId, curAppUserPrefId);
    else await client.createCurrentAppUserPref(scopeId, userSysId);
  } catch (e) {
    let message
    if (e instanceof Error) message = e.message
    else message = String(e)
    logger.error(message);
    throw e;
  }
};

/**
 * Creates a new update set and assigns it to the current user.
 * @param updateSetName - does not create update set if value is blank
 */
export const createAndAssignUpdateSet = async (updateSetName = "") => {
  logger.info(`Update Set Name: ${updateSetName}`);
  const client = defaultClient();
  const { sys_id: updateSetSysId } = await unwrapSNResponse(
    client.createUpdateSet(updateSetName)
  );
  const userSysId = await unwrapTableAPIFirstItem(
    client.getUserSysId(),
    "sys_id"
  );
  // Empty result means no update-set pref record exists yet — create it.
  const curUpdateSetUserPrefId = await unwrapTableAPIFirstItemOrEmpty(
    client.getCurrentUpdateSetUserPref(userSysId),
    "sys_id"
  );

  if (curUpdateSetUserPrefId !== "") {
    await client.updateCurrentUpdateSetUserPref(
      updateSetSysId,
      curUpdateSetUserPrefId
    );
  } else {
    await client.createCurrentUpdateSetUserPref(updateSetSysId, userSysId);
  }
  return {
    name: updateSetName,
    id: updateSetSysId,
  };
};

export const checkScope = async (
  swap: boolean
): Promise<Sync.ScopeCheckResult> => {
  const man = ConfigManager.getManifest();
  if (man) {
    const client = defaultClient();
    let scopeObj: SN.ScopeObj;
    try {
      scopeObj = await unwrapSNResponse(client.getCurrentScope());
    } catch (e) {
      if (isScopedEndpointUnavailableError(e)) {
        return {
          match: true,
          sessionScope: man.scope,
          manifestScope: man.scope,
        };
      }
      throw e;
    }
    if (scopeObj.scope === man.scope) {
      return {
        match: true,
        sessionScope: scopeObj.scope,
        manifestScope: man.scope,
      };
    } else if (swap) {
      const swappedScopeObj = await swapScope(man.scope);
      return {
        match: swappedScopeObj.scope === man.scope,
        sessionScope: swappedScopeObj.scope,
        manifestScope: man.scope,
      };
    } else {
      return {
        match: false,
        sessionScope: scopeObj.scope,
        manifestScope: man.scope,
      };
    }
  }
  //first time case
  return {
    match: true,
    sessionScope: "",
    manifestScope: "",
  };
};
