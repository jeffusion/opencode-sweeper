import type { SessionLike, SweeperClient } from "../src/sweep";

export const FIXED_NOW = 1_700_000_000_000;

export type SessionSeed = {
  readonly id: string;
  readonly ageMs: number;
  readonly title: string;
  readonly directory: string;
  readonly parentID?: string;
  readonly compacting?: number;
};

export type DeleteBehavior =
  | { readonly kind: "ok" }
  | { readonly kind: "false" }
  | { readonly kind: "throw"; readonly error: unknown };

export function makeSession(seed: SessionSeed): SessionLike {
  const session: SessionLike = {
    id: seed.id,
    title: seed.title,
    directory: seed.directory,
    time: {
      created: FIXED_NOW - seed.ageMs,
      updated: FIXED_NOW - seed.ageMs,
    },
  };

  if (seed.parentID !== undefined) {
    session.parentID = seed.parentID;
  }

  if (seed.compacting !== undefined) {
    session.time.compacting = seed.compacting;
  }

  return session;
}

export async function withMockedNow<T>(now: number, run: () => Promise<T>): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(Date, "now");

  if (originalDescriptor === undefined) {
    throw new Error("Date.now descriptor missing");
  }

  Object.defineProperty(Date, "now", {
    configurable: true,
    value: () => now,
  });

  try {
    return await run();
  } finally {
    Object.defineProperty(Date, "now", originalDescriptor);
  }
}

export class MockSweeperClient implements SweeperClient {
  readonly deleteCalls: string[] = [];

  constructor(
    private readonly sessions: SessionLike[],
    private readonly deleteBehaviors: Map<string, DeleteBehavior> = new Map(),
  ) {}

  readonly session = {
    list: async (): Promise<SessionLike[]> => this.sessions,
    delete: async (args: { path: { id: string } }): Promise<boolean> => {
      this.deleteCalls.push(args.path.id);

      const behavior = this.deleteBehaviors.get(args.path.id);

      if (behavior === undefined || behavior.kind === "ok") {
        return true;
      }

      if (behavior.kind === "false") {
        return false;
      }

      throw behavior.error;
    },
  };
}

export function defaultSweeperOpts(args: {
  expiryMs: number;
  recentActivityGraceMs: number;
  dryRun: boolean;
  subagentExpiryMs?: number;
}): {
  expiryMs: number;
  subagentExpiryMs: number;
  recentActivityGraceMs: number;
  dryRun: boolean;
} {
  return {
    expiryMs: args.expiryMs,
    subagentExpiryMs: args.subagentExpiryMs ?? args.expiryMs,
    recentActivityGraceMs: args.recentActivityGraceMs,
    dryRun: args.dryRun,
  };
}
