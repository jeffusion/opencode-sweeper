export type SessionLike = {
  id: string;
  parentID?: string;
  title: string;
  directory: string;
  time: {
    created: number;
    updated: number;
    compacting?: number;
  };
};

export interface SweeperClient {
  session: {
    list(): Promise<SessionLike[]>;
    delete(args: { path: { id: string } }): Promise<boolean>;
  };
}

export type SweepResult = {
  scanned: number;
  deleted: number;
  protectedCount: number;
  recentActiveSkipped: number;
  mainNotExpiredSkipped: number;
  subagentNotExpiredSkipped: number;
  cascadeBlockedSkipped: number;
  dryRunSkipped: number;
  errors: Array<{ id: string; error: string }>;
  deletions: Array<{ id: string; title: string; parentID?: string; dryRun: boolean }>;
};

type DeletionRecord = SweepResult["deletions"][number];

function sessionDeletionRecord(session: SessionLike, dryRun: boolean): DeletionRecord {
  const deletion: DeletionRecord = {
    id: session.id,
    title: session.title,
    dryRun,
  };

  if (session.parentID !== undefined) {
    deletion.parentID = session.parentID;
  }

  return deletion;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function runSweep(
  client: SweeperClient,
  opts: {
    expiryMs: number;
    subagentExpiryMs: number;
    recentActivityGraceMs: number;
    dryRun: boolean;
  },
  protectedSessionIDs: ReadonlySet<string>,
): Promise<SweepResult> {
  const now = Date.now();
  const sessions = await client.session.list();

  const result: SweepResult = {
    scanned: 0,
    deleted: 0,
    protectedCount: 0,
    recentActiveSkipped: 0,
    mainNotExpiredSkipped: 0,
    subagentNotExpiredSkipped: 0,
    cascadeBlockedSkipped: 0,
    dryRunSkipped: 0,
    errors: [],
    deletions: [],
  };

  const byID = new Map(sessions.map((session) => [session.id, session]));
  if (byID.size !== sessions.length) {
    const seen = new Set<string>();
    const duplicate = sessions.find((session) => {
      if (seen.has(session.id)) return true;
      seen.add(session.id);
      return false;
    });
    throw new Error(
      `Cannot sweep sessions with duplicate session ID: ${duplicate?.id ?? "unknown"}`,
    );
  }

  const ineligible = new Set<string>();
  const eligible = new Set<string>();

  // Classify the complete snapshot before any deletion: delete() may cascade to
  // descendants, so an ancestor is unsafe whenever any descendant is unsafe.
  for (const session of sessions) {
    result.scanned += 1;

    if (protectedSessionIDs.has(session.id)) {
      result.protectedCount += 1;
      ineligible.add(session.id);
      continue;
    }

    const ageMs = now - session.time.updated;

    if (ageMs < opts.recentActivityGraceMs) {
      result.recentActiveSkipped += 1;
      ineligible.add(session.id);
      continue;
    }

    const hasParent = session.parentID !== undefined && session.parentID.length > 0;
    const thresholdMs = hasParent ? opts.subagentExpiryMs : opts.expiryMs;

    if (ageMs < thresholdMs) {
      if (hasParent) {
        result.subagentNotExpiredSkipped += 1;
      } else {
        result.mainNotExpiredSkipped += 1;
      }
      ineligible.add(session.id);
      continue;
    }

    eligible.add(session.id);
  }

  // An empty parent ID is treated as a root. Walk parent chains with a visited
  // set so malformed cycles cannot make a protected node's ancestry deletable.
  const cascadeBlocked = new Set<string>();
  for (const session of sessions) {
    let current: SessionLike | undefined = session;
    const visited = new Set<string>();
    while (current !== undefined) {
      if (visited.has(current.id)) {
        for (const id of visited) cascadeBlocked.add(id);
        break;
      }
      visited.add(current.id);
      const parentID: string | undefined = current.parentID;
      current = parentID && parentID.length > 0 ? byID.get(parentID) : undefined;
    }
  }

  for (const unsafeID of ineligible) {
    let current = byID.get(unsafeID);
    const visited = new Set<string>([unsafeID]);

    while (current?.parentID && current.parentID.length > 0) {
      const parentID = current.parentID;
      if (visited.has(parentID)) {
        for (const id of visited) cascadeBlocked.add(id);
        break;
      }
      visited.add(parentID);
      cascadeBlocked.add(parentID);
      current = byID.get(parentID);
    }
  }

  const parentDepth = (session: SessionLike): number => {
    let depth = 0;
    let current = session;
    const visited = new Set<string>([session.id]);
    while (current.parentID) {
      const parent = byID.get(current.parentID);
      if (parent === undefined || visited.has(parent.id)) break;
      visited.add(parent.id);
      if (!eligible.has(parent.id)) break;
      depth += 1;
      current = parent;
    }
    return depth;
  };
  const candidates = sessions
    .filter((session) => eligible.has(session.id))
    .sort((a, b) => parentDepth(a) - parentDepth(b));
  const covered = new Set<string>();
  const countedProtected = new Set(
    sessions.filter((s) => protectedSessionIDs.has(s.id)).map((s) => s.id),
  );

  const isDescendantOf = (session: SessionLike, ancestorID: string): boolean => {
    let current = session;
    const visited = new Set<string>();
    while (current.parentID) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      if (current.parentID === ancestorID) return true;
      const parent = byID.get(current.parentID);
      if (parent === undefined) return false;
      current = parent;
    }
    return false;
  };

  for (const session of candidates) {
    if (covered.has(session.id)) continue;

    // Compute current protection closure immediately before each possible
    // delete. The set is intentionally read live: plugin hooks may add IDs
    // while a previous delete is pending.
    const liveProtected = new Set<string>();
    for (const protectedID of protectedSessionIDs) {
      const protectedSession = byID.get(protectedID);
      if (protectedSession === undefined) continue;
      liveProtected.add(protectedID);
      let current = protectedSession;
      const visited = new Set<string>([current.id]);
      while (current.parentID) {
        const parent = byID.get(current.parentID);
        if (parent === undefined || visited.has(parent.id)) break;
        liveProtected.add(parent.id);
        visited.add(parent.id);
        current = parent;
      }
    }

    if (liveProtected.has(session.id)) {
      if (protectedSessionIDs.has(session.id) && !countedProtected.has(session.id)) {
        result.protectedCount += 1;
        countedProtected.add(session.id);
      } else if (!protectedSessionIDs.has(session.id)) {
        result.cascadeBlockedSkipped += 1;
      }
      continue;
    }
    if (cascadeBlocked.has(session.id)) {
      result.cascadeBlockedSkipped += 1;
      continue;
    }

    const removalSet = [
      session,
      ...sessions.filter((child) => eligible.has(child.id) && isDescendantOf(child, session.id)),
    ];
    if (opts.dryRun) {
      for (const removed of removalSet) {
        if (covered.has(removed.id)) continue;
        covered.add(removed.id);
        result.dryRunSkipped += 1;
        result.deletions.push(sessionDeletionRecord(removed, true));
      }
      continue;
    }

    try {
      const deleted = await client.session.delete({ path: { id: session.id } });

      if (!deleted) {
        result.errors.push({ id: session.id, error: "delete returned false" });
        continue;
      }

      for (const removed of removalSet) {
        if (covered.has(removed.id)) continue;
        covered.add(removed.id);
        result.deleted += 1;
        result.deletions.push(sessionDeletionRecord(removed, false));
      }
    } catch (error: unknown) {
      result.errors.push({ id: session.id, error: errorMessage(error) });
    }
  }

  return result;
}
