import {
  getCurrentScopeWithFallback,
  getServiceNowConfig,
  snRequest,
  toTableResultRows,
} from "./servicenowCore";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function tableGet(
  table: string,
  opts: {
    query?: string;
    fields?: string[];
    limit?: number;
  },
  timeoutMs: number
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  params.set("sysparm_query", opts.query || "");
  params.set("sysparm_limit", String(opts.limit || 10));
  if (opts.fields && opts.fields.length > 0) {
    params.set("sysparm_fields", opts.fields.join(","));
  }
  const response = await snRequest(
    "GET",
    `/api/now/table/${table}?${params.toString()}`,
    undefined,
    timeoutMs
  );
  return toTableResultRows(response.data);
}

async function getCurrentUserSysId(timeoutMs: number): Promise<string> {
  const snCfg = getServiceNowConfig();
  const users = await tableGet(
    "sys_user",
    {
      query: `user_name=${snCfg.user}`,
      fields: ["sys_id", "user_name"],
      limit: 1,
    },
    timeoutMs
  );
  if (users.length === 0) {
    throw new Error(`Could not find sys_user for SN_USER=${snCfg.user}`);
  }
  return toStringField(users[0].sys_id);
}

async function getUserPreference(
  userSysId: string,
  prefName: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const prefs = await tableGet(
    "sys_user_preference",
    {
      query: `user=${userSysId}^name=${prefName}`,
      fields: ["sys_id", "name", "value", "user"],
      limit: 1,
    },
    timeoutMs
  );
  return prefs.length > 0 ? prefs[0] : null;
}

async function upsertUserPreference(
  userSysId: string,
  prefName: string,
  value: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const existing = await getUserPreference(userSysId, prefName, timeoutMs);
  if (existing) {
    const prefSysId = toStringField(existing.sys_id);
    const updateResp = await snRequest(
      "PUT",
      `/api/now/table/sys_user_preference/${prefSysId}`,
      { value },
      timeoutMs
    );
    return asRecord(asRecord(updateResp.data).result);
  }

  const createResp = await snRequest(
    "POST",
    "/api/now/table/sys_user_preference",
    {
      value,
      name: prefName,
      type: "string",
      user: userSysId,
    },
    timeoutMs
  );
  return asRecord(asRecord(createResp.data).result);
}

async function getScopeByCode(
  scopeCode: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const scopes = await tableGet(
    "sys_scope",
    {
      query: `scope=${scopeCode}`,
      fields: ["sys_id", "scope", "name"],
      limit: 1,
    },
    timeoutMs
  );
  return scopes.length > 0 ? scopes[0] : null;
}

async function getScopeBySysId(
  scopeSysId: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const scopes = await tableGet(
    "sys_scope",
    {
      query: `sys_id=${scopeSysId}`,
      fields: ["sys_id", "scope", "name"],
      limit: 1,
    },
    timeoutMs
  );
  return scopes.length > 0 ? scopes[0] : null;
}

async function getUpdateSetByName(
  updateSetName: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const sets = await tableGet(
    "sys_update_set",
    {
      query: `name=${updateSetName}`,
      fields: ["sys_id", "name", "state", "application"],
      limit: 1,
    },
    timeoutMs
  );
  return sets.length > 0 ? sets[0] : null;
}

async function getUpdateSetBySysId(
  updateSetSysId: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const sets = await tableGet(
    "sys_update_set",
    {
      query: `sys_id=${updateSetSysId}`,
      fields: ["sys_id", "name", "state", "application"],
      limit: 1,
    },
    timeoutMs
  );
  return sets.length > 0 ? sets[0] : null;
}

export async function listScopes(
  timeoutMs: number,
  queryText?: string,
  limit: number = 100
): Promise<Record<string, unknown>[]> {
  const encoded = toStringField(queryText).trim();
  const query = encoded.length > 0 ? encoded : "";
  const rows = await tableGet(
    "sys_scope",
    {
      query,
      fields: ["sys_id", "scope", "name"],
      limit: Math.min(Math.max(limit, 1), 500),
    },
    timeoutMs
  );
  return rows;
}

export async function listUpdateSets(
  timeoutMs: number,
  queryText?: string,
  limit: number = 100
): Promise<Record<string, unknown>[]> {
  const query = toStringField(queryText).trim();
  const rows = await tableGet(
    "sys_update_set",
    {
      query,
      fields: ["sys_id", "name", "state", "application", "sys_created_on"],
      limit: Math.min(Math.max(limit, 1), 500),
    },
    timeoutMs
  );
  return rows;
}

export async function getSessionContext(timeoutMs: number): Promise<Record<string, unknown>> {
  const userSysId = await getCurrentUserSysId(timeoutMs);

  let scopeInfo: Record<string, unknown> = {};
  try {
    const scopeRes = await getCurrentScopeWithFallback(timeoutMs);
    if (scopeRes.status < 200 || scopeRes.status >= 300) {
      throw new Error(`getCurrentScope failed with status ${scopeRes.status}`);
    }
    const scopeObj = asRecord(asRecord(scopeRes.data).result);
    const scopeCode = toStringField(scopeObj.scope);
    const scopeRec = scopeCode ? await getScopeByCode(scopeCode, timeoutMs) : null;
    scopeInfo = {
      scope: scopeCode,
      scopeSysId: toStringField(scopeObj.sys_id) || toStringField(scopeRec?.sys_id),
      name: toStringField(scopeRec?.name),
    };
  } catch (_) {
    const pref = await getUserPreference(userSysId, "apps.current_app", timeoutMs);
    const prefValue = toStringField(pref?.value);
    const scopeRec = prefValue ? await getScopeBySysId(prefValue, timeoutMs) : null;
    scopeInfo = {
      scope: toStringField(scopeRec?.scope),
      scopeSysId: prefValue,
      name: toStringField(scopeRec?.name),
    };
  }

  const updateSetPref = await getUserPreference(userSysId, "sys_update_set", timeoutMs);
  const updateSetSysId = toStringField(updateSetPref?.value);
  const updateSet = updateSetSysId
    ? await getUpdateSetBySysId(updateSetSysId, timeoutMs)
    : null;

  return {
    userSysId,
    scope: scopeInfo,
    updateSet: {
      sysId: updateSetSysId,
      name: toStringField(updateSet?.name),
      state: toStringField(updateSet?.state),
    },
  };
}

export async function setCurrentScope(
  scopeCode: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const scopeRec = await getScopeByCode(scopeCode, timeoutMs);
  if (!scopeRec) {
    throw new Error(`Scope not found: ${scopeCode}`);
  }

  const userSysId = await getCurrentUserSysId(timeoutMs);
  await upsertUserPreference(
    userSysId,
    "apps.current_app",
    toStringField(scopeRec.sys_id),
    timeoutMs
  );

  return {
    requestedScope: scopeCode,
    scopeSysId: toStringField(scopeRec.sys_id),
    scopeName: toStringField(scopeRec.name),
    sessionContext: await getSessionContext(timeoutMs),
  };
}

export async function setCurrentUpdateSet(
  params: {
    updateSetName?: string;
    updateSetSysId?: string;
    createIfMissing?: boolean;
  },
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const updateSetSysIdInput = toStringField(params.updateSetSysId);
  const updateSetNameInput = toStringField(params.updateSetName);
  const createIfMissing = params.createIfMissing !== false;

  let targetUpdateSet: Record<string, unknown> | null = null;

  if (updateSetSysIdInput) {
    targetUpdateSet = await getUpdateSetBySysId(updateSetSysIdInput, timeoutMs);
  } else if (updateSetNameInput) {
    targetUpdateSet = await getUpdateSetByName(updateSetNameInput, timeoutMs);
    if (!targetUpdateSet && createIfMissing) {
      const created = await snRequest(
        "POST",
        "/api/now/table/sys_update_set",
        { name: updateSetNameInput },
        timeoutMs
      );
      targetUpdateSet = asRecord(asRecord(created.data).result);
    }
  }

  if (!targetUpdateSet) {
    throw new Error("Update set not found. Provide updateSetName or updateSetSysId.");
  }

  const targetSysId = toStringField(targetUpdateSet.sys_id);
  if (!targetSysId) {
    throw new Error("Target update set is missing sys_id.");
  }

  const userSysId = await getCurrentUserSysId(timeoutMs);
  await upsertUserPreference(userSysId, "sys_update_set", targetSysId, timeoutMs);

  return {
    targetUpdateSet: {
      sysId: targetSysId,
      name: toStringField(targetUpdateSet.name),
      state: toStringField(targetUpdateSet.state),
    },
    sessionContext: await getSessionContext(timeoutMs),
  };
}
