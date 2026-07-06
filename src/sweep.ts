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
    dryRunSkipped: 0,
    errors: [],
    deletions: [],
  };

  for (const session of sessions) {
    result.scanned += 1;

    if (protectedSessionIDs.has(session.id)) {
      result.protectedCount += 1;
      continue;
    }

    const ageMs = now - session.time.updated;

    if (ageMs < opts.recentActivityGraceMs) {
      result.recentActiveSkipped += 1;
      continue;
    }

    const thresholdMs = session.parentID === undefined ? opts.expiryMs : opts.subagentExpiryMs;

    if (ageMs < thresholdMs) {
      if (session.parentID === undefined) {
        result.mainNotExpiredSkipped += 1;
      } else {
        result.subagentNotExpiredSkipped += 1;
      }
      continue;
    }

    if (opts.dryRun) {
      result.dryRunSkipped += 1;
      result.deletions.push(sessionDeletionRecord(session, true));
      continue;
    }

    try {
      const deleted = await client.session.delete({ path: { id: session.id } });

      if (!deleted) {
        result.errors.push({ id: session.id, error: "delete returned false" });
        continue;
      }

      result.deleted += 1;
      result.deletions.push(sessionDeletionRecord(session, false));
    } catch (error: unknown) {
      result.errors.push({ id: session.id, error: errorMessage(error) });
    }
  }

  return result;
}
