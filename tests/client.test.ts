import { describe, expect, it, vi } from "vitest";

import type { ResolverRequest } from "@plasius/graph-contracts";
import { GraphClient } from "../src/client.js";

class FakeClock {
  private value = 1_000;

  now(): number {
    return this.value;
  }

  tick(ms: number): void {
    this.value += ms;
  }
}

describe("GraphClient", () => {
  it("deduplicates in-flight fetches for same request", async () => {
    const clock = new FakeClock();
    let calls = 0;

    const transport = {
      async fetch(request: ResolverRequest) {
        calls += 1;
        return {
          data: { key: request.key, value: "ok" },
          version: 1,
          tags: ["entity"],
        };
      },
    };

    const client = new GraphClient({
      transport,
      now: () => clock.now(),
      policy: { softTtlSeconds: 1, hardTtlSeconds: 5 },
    });

    const query = {
      id: "q1",
      requests: [{ resolver: "entity.get", key: "entity:1" }],
    };

    const [a, b] = await Promise.all([client.query(query), client.query(query)]);

    expect(calls).toBe(1);
    expect(a.results["entity:1"]?.data).toEqual({ key: "entity:1", value: "ok" });
    expect(b.results["entity:1"]?.data).toEqual({ key: "entity:1", value: "ok" });
  });

  it("serves stale data between soft and hard ttl when allowed", async () => {
    const clock = new FakeClock();
    let version = 1;

    const transport = {
      async fetch() {
        return {
          data: { version },
          version,
          tags: ["entity"],
        };
      },
    };

    const client = new GraphClient({
      transport,
      now: () => clock.now(),
      policy: { softTtlSeconds: 1, hardTtlSeconds: 10 },
    });

    const query = {
      id: "q1",
      requests: [{ resolver: "entity.get", key: "entity:1" }],
    };

    const first = await client.query(query);
    expect(first.stale).toBe(false);

    version = 2;
    clock.tick(2_500);

    const second = await client.query(query, { allowStale: true });

    expect(second.stale).toBe(true);
    expect(second.results["entity:1"]?.data).toEqual({ version: 1 });
  });

  it("invalidates cached entries by tag", async () => {
    const transport = {
      async fetch() {
        return {
          data: { ok: true },
          version: 1,
          tags: ["profile"],
        };
      },
    };

    const client = new GraphClient({ transport });
    const query = {
      requests: [{ resolver: "profile.get", key: "user:1" }],
    };

    await client.query(query);
    const removed = client.invalidateTags(["profile"]);

    expect(removed).toBe(1);
  });

  it("emits telemetry for cache outcomes, errors, and query latency", async () => {
    const telemetry = {
      metric: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
    const transport = {
      async fetch(request: ResolverRequest) {
        if (request.key === "bad:1") {
          throw new Error("upstream down");
        }
        return {
          data: { ok: true },
          version: 1,
          tags: ["profile"],
        };
      },
    };

    const client = new GraphClient({
      transport,
      telemetry,
      policy: { softTtlSeconds: 60, hardTtlSeconds: 120 },
    });

    await client.query({
      requests: [{ resolver: "profile.get", key: "good:1" }],
    });
    await client.query({
      requests: [{ resolver: "profile.get", key: "good:1" }],
    });
    await client.query({
      requests: [{ resolver: "profile.get", key: "bad:1" }],
    });

    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "graph.client.cache.outcome",
        tags: expect.objectContaining({ outcome: "miss" }),
      }),
    );
    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "graph.client.cache.outcome",
        tags: expect.objectContaining({ outcome: "fresh_hit" }),
      }),
    );
    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "graph.client.query.latency",
      }),
    );
    expect(telemetry.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "CLIENT_FETCH_FAILED",
      }),
    );
  });

  it("fails fast when query payload is invalid", async () => {
    const client = new GraphClient({
      transport: {
        async fetch() {
          throw new Error("should not run");
        },
      },
    });

    await expect(
      client.query({
        requests: "bad",
      } as unknown as any),
    ).rejects.toThrow("Invalid graph query payload");
  });
});
