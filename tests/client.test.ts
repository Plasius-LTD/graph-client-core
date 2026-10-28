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

function deferredResponse() {
  let resolve!: (value: { data: { value: string }; version: string; tags: string[] }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ data: { value: string }; version: string; tags: string[] }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const lifecycleResponse = (value: string, tags = ["fixture-tag"]) => ({ data: { value }, version: value, tags });
const lifecycleQuery = { requests: [{ resolver: "fixture.read", key: "fixture", tags: ["fixture-tag"] }] };

describe("GraphClient refresh ownership", () => {
  it("does not restore an invalidated entry when a stale background refresh completes", async () => {
    const clock = new FakeClock();
    const old = deferredResponse();
    const fetch = vi.fn().mockResolvedValueOnce(lifecycleResponse("old"))
      .mockReturnValueOnce(old.promise).mockResolvedValue(lifecycleResponse("current"));
    const client = new GraphClient({ transport: { fetch }, now: () => clock.now(), policy: { softTtlSeconds: 1, hardTtlSeconds: 30 } });
    await client.query(lifecycleQuery);
    clock.tick(2_000);
    expect((await client.query(lifecycleQuery)).stale).toBe(true);
    // Observe the same pending work so its completion and finally are awaited deterministically.
    const observer = client.query(lifecycleQuery, { forceRefresh: true });
    expect(client.invalidateTags(["fixture-tag"])).toBe(1);
    old.resolve(lifecycleResponse("old"));
    await observer;
    const result = await client.query(lifecycleQuery);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.results.fixture?.version).toBe("current");
    expect(result.stale).toBe(false);
  });

  it("preserves a prime boundary without comparing opaque version strings", async () => {
    const old = deferredResponse();
    const fetch = vi.fn().mockReturnValue(old.promise);
    const client = new GraphClient({ transport: { fetch }, now: () => 1_000 });
    const initial = client.query(lifecycleQuery);
    client.prime({ key: "fixture.read:fixture:", value: { value: "primed" }, version: "a-current",
      fetchedAtEpochMs: 1_000, policy: { softTtlSeconds: 30, hardTtlSeconds: 300 },
      schemaVersion: "1.0.0", source: "fixture.read", tags: ["fixture-tag"] });
    old.resolve(lifecycleResponse("z-obsolete"));
    // Existing callers may finish their original snapshot; it must not become shared cache state.
    expect((await initial).results.fixture?.version).toBe("z-obsolete");
    expect((await client.query(lifecycleQuery)).results.fixture?.version).toBe("a-current");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)("keeps newer inflight deduplication when old work finishes with %s", async (outcome) => {
    const old = deferredResponse();
    const current = deferredResponse();
    const fetch = vi.fn().mockResolvedValueOnce(lifecycleResponse("seed"))
      .mockReturnValueOnce(old.promise).mockReturnValue(current.promise);
    const client = new GraphClient({ transport: { fetch } });
    await client.query(lifecycleQuery);
    const initial = client.query(lifecycleQuery, { forceRefresh: true });
    expect(client.invalidateTags(["fixture-tag"])).toBe(1);
    const newer = client.query(lifecycleQuery);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(3);
    if (outcome === "resolve") old.resolve(lifecycleResponse("obsolete"));
    else old.reject(new Error("obsolete request failed"));
    expect((await initial).partial).toBe(outcome === "reject");
    const joined = client.query(lifecycleQuery, { forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    current.resolve(lifecycleResponse("current"));
    for (const result of await Promise.all([newer, joined])) expect(result.results.fixture?.version).toBe("current");
    expect((await client.query(lifecycleQuery)).results.fixture?.version).toBe("current");
  });

  it("does not overwrite a newer fetch when the obsolete response arrives last", async () => {
    const old = deferredResponse();
    const current = deferredResponse();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const client = new GraphClient({ transport: { fetch } });
    const initial = client.query(lifecycleQuery);
    // Initial requests are fenceable by their advertised tags even before an envelope exists.
    expect(client.invalidateTags(["fixture-tag"])).toBe(0);
    const newer = client.query(lifecycleQuery);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    current.resolve(lifecycleResponse("current"));
    await newer;
    old.resolve(lifecycleResponse("obsolete"));
    await initial;
    expect((await client.query(lifecycleQuery)).results.fixture?.version).toBe("current");
  });

  it("starts a new refresh after prime and protects it from obsolete cleanup", async () => {
    const old = deferredResponse();
    const current = deferredResponse();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(current.promise);
    const client = new GraphClient({ transport: { fetch }, now: () => 1_000 });
    const initial = client.query(lifecycleQuery);
    client.prime({ key: "fixture.read:fixture:", value: { value: "prime" }, version: "prime",
      fetchedAtEpochMs: 1_000, policy: { softTtlSeconds: 30, hardTtlSeconds: 300 },
      schemaVersion: "1.0.0", source: "fixture.read", tags: ["fixture-tag"] });
    const newer = client.query(lifecycleQuery, { forceRefresh: true });
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    old.resolve(lifecycleResponse("obsolete")); await initial;
    const joined = client.query(lifecycleQuery, { forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    current.resolve(lifecycleResponse("current"));
    for (const result of await Promise.all([newer, joined])) expect(result.results.fixture?.version).toBe("current");
  });

  it("fences overlapping and repeatedly invalidated pending tags while preserving unrelated work", async () => {
    const a = deferredResponse(), b = deferredResponse(), unrelated = deferredResponse();
    const fetch = vi.fn((request: ResolverRequest) => request.key === "a" ? a.promise : request.key === "b" ? b.promise : unrelated.promise);
    const client = new GraphClient({ transport: { fetch } });
    const query = (key: string, tags: string[]) => ({ requests: [{ resolver: "fixture.read", key, tags }] });
    const pendingA = client.query(query("a", ["shared", "a"]));
    const pendingB = client.query(query("b", ["shared", "b"]));
    const pendingOther = client.query(query("other", ["other"]));
    expect(client.invalidateTags(["shared", "shared", "missing"])).toBe(0);
    expect(client.invalidateTags(["shared"])).toBe(0);
    a.resolve(lifecycleResponse("obsolete-a", ["shared", "a"])); b.resolve(lifecycleResponse("obsolete-b", ["shared", "b"]));
    unrelated.resolve(lifecycleResponse("current-other", ["other"]));
    await Promise.all([pendingA, pendingB, pendingOther]);
    const newA = client.query(query("a", ["shared", "a"]));
    const newB = client.query(query("b", ["shared", "b"]));
    const other = await client.query(query("other", ["other"]));
    expect(other.results.other?.version).toBe("current-other");
    await Promise.all([newA, newB]);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(client.invalidateTags(["shared", "a"])).toBe(2);
  });

  it("recovers after a current refresh fails without retaining detached ownership metadata", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(lifecycleResponse("recovered"));
    const client = new GraphClient({ transport: { fetch } });
    expect((await client.query(lifecycleQuery)).partial).toBe(true);
    expect((await client.query(lifecycleQuery)).results.fixture?.version).toBe("recovered");
    expect(fetch).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 100; i++) {
      const pending = deferredResponse();
      const ephemeral = new GraphClient({ transport: { fetch: () => pending.promise } });
      const request = ephemeral.query(lifecycleQuery);
      ephemeral.invalidateTags(["fixture-tag"]);
      pending.resolve(lifecycleResponse("obsolete")); await request;
      // Inspect retained collection sizes for the bounded-lifecycle NFR, not transport timing or GC heuristics.
      for (const value of Object.values(ephemeral)) if (value instanceof Map) expect(value.size).toBe(0);
    }
  });
});

it("establishes ownership before a transport synchronously invalidates its request tags", async () => {
  let client!: GraphClient;
  let calls = 0;
  const fetch = async () => {
    calls++;
    if (calls === 1) client.invalidateTags(["fixture-tag"]);
    return lifecycleResponse(calls === 1 ? "obsolete" : "current");
  };
  client = new GraphClient({ transport: { fetch } });
  await client.query(lifecycleQuery);
  expect((await client.query(lifecycleQuery)).results.fixture?.version).toBe("current");
  expect(calls).toBe(2);
});
