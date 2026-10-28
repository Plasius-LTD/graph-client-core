import { spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { GraphClient, type GraphTransportResponse } from "../src/client.js";

const query = { requests: [{ resolver: "fixture.read", key: "fixture", tags: ["fixture-tag"] }] };
const response = (version: number): GraphTransportResponse => ({ data: { version }, version, tags: ["fixture-tag"] });

function deferred() {
  let resolve!: (value: GraphTransportResponse) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<GraphTransportResponse>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("GraphClient background failure ownership", () => {
  it.each([false, true])("preserves stale success, deduplication and recovery (telemetry=%s)", async (withTelemetry) => {
    let now = 0;
    const failed = deferred();
    const recovery = deferred();
    const telemetry = { metric: vi.fn(), error: vi.fn(), trace: vi.fn() };
    const fetch = vi.fn().mockResolvedValueOnce(response(1))
      .mockReturnValueOnce(failed.promise).mockReturnValueOnce(recovery.promise);
    const client = new GraphClient({ transport: { fetch }, now: () => now,
      policy: { softTtlSeconds: 1, hardTtlSeconds: 30 }, telemetry: withTelemetry ? telemetry : undefined });

    await client.query(query);
    now = 2_000;
    const readers = await Promise.all(Array.from({ length: 20 }, () => client.query(query)));
    for (const result of readers) {
      expect(result).toMatchObject({ partial: false, stale: true, errors: [],
        results: { fixture: { data: { version: 1 }, stale: true, fetchedAtEpochMs: 0 } } });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    failed.reject(new Error("synthetic outage"));
    // Cross an event-loop turn without installing a process-global rejection listener.
    await setImmediate();
    expect(fetch).toHaveBeenCalledTimes(2); // No automatic retry.
    expect(telemetry.error.mock.calls).toEqual(withTelemetry ? [[{
      message: "synthetic outage", source: "fixture.read", code: "CLIENT_REFRESH_FAILED",
    }]] : []);

    now = 3_000;
    // A failed refresh does not evict the still-eligible cached snapshot.
    expect((await client.query(query)).results.fixture?.data).toEqual({ version: 1 });
    const observer = client.query(query, { forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    recovery.resolve(response(2));
    expect((await observer).results.fixture?.version).toBe(2);
    expect(await client.query(query)).toMatchObject({ partial: false, stale: false,
      results: { fixture: { data: { version: 2 } } } });
    expect(fetch).toHaveBeenCalledTimes(3);
    if (withTelemetry) expect(telemetry.error).toHaveBeenCalledTimes(1);
  });

  it("keeps a foreground caller's error when it joins a detached failing refresh", async () => {
    let now = 0;
    const pending = deferred();
    const telemetry = { metric: vi.fn(), error: vi.fn(), trace: vi.fn() };
    const fetch = vi.fn().mockResolvedValueOnce(response(1)).mockReturnValueOnce(pending.promise);
    const client = new GraphClient({ transport: { fetch }, telemetry, now: () => now,
      policy: { softTtlSeconds: 1, hardTtlSeconds: 30 } });
    await client.query(query);
    now = 2_000;
    expect((await client.query(query)).stale).toBe(true);
    const foreground = client.query(query, { allowStale: false });
    pending.reject(new Error("synthetic outage"));
    expect(await foreground).toMatchObject({ partial: true, stale: false,
      results: { fixture: { data: null, error: { code: "CLIENT_FETCH_FAILED", retryable: true } } } });
    await setImmediate();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(telemetry.error.mock.calls.map(([error]) => error.code))
      .toEqual(["CLIENT_REFRESH_FAILED", "CLIENT_FETCH_FAILED"]);
  });

  it.each(["cold", "allowStale=false", "forceRefresh", "hard expiry"] as const)("returns a controlled foreground error for %s", async (mode) => {
    let now = 0;
    const telemetry = { metric: vi.fn(), error: vi.fn(), trace: vi.fn() };
    const fetch = vi.fn().mockRejectedValue(new Error("synthetic outage"));
    if (mode !== "cold") fetch.mockResolvedValueOnce(response(1));
    const client = new GraphClient({ transport: { fetch }, telemetry, now: () => now,
      policy: { softTtlSeconds: 1, hardTtlSeconds: 30 } });
    if (mode !== "cold") await client.query(query);
    now = mode === "hard expiry" ? 30_001 : 2_000;
    const options = mode === "allowStale=false" ? { allowStale: false }
      : mode === "forceRefresh" ? { forceRefresh: true } : {};
    expect(await client.query(query, options)).toMatchObject({ partial: true, stale: false,
      errors: [{ code: "CLIENT_FETCH_FAILED", message: "synthetic outage", retryable: true }],
      results: { fixture: { data: null, stale: false, error: { code: "CLIENT_FETCH_FAILED" } } } });
    expect(fetch).toHaveBeenCalledTimes(mode === "cold" ? 1 : 2);
    expect(telemetry.error.mock.calls.map(([error]) => error.code))
      .toEqual(["CLIENT_REFRESH_FAILED", "CLIENT_FETCH_FAILED"]);
  });

  it.each([false, true])("survives a detached failure in a strict Node process (telemetry=%s)", (withTelemetry) => {
    const source = `
      import assert from 'node:assert/strict';
      import { setImmediate } from 'node:timers/promises';
      import { GraphClient } from ${JSON.stringify(new URL("../src/client.ts", import.meta.url).href)};
      let now = 0, calls = 0, errors = 0, reject;
      const pending = new Promise((_, no) => { reject = no; });
      const client = new GraphClient({ now: () => now,
        policy: { softTtlSeconds: 1, hardTtlSeconds: 30 },
        telemetry: ${withTelemetry} ? { metric() {}, error() { errors++; } } : undefined,
        transport: { async fetch() {
          calls++;
          if (calls === 2) return pending;
          return { data: { calls }, version: calls };
        } }
      });
      const query = { requests: [{ resolver: 'fixture.read', key: 'fixture' }] };
      await client.query(query);
      now = 2000;
      const results = await Promise.all(Array.from({ length: 20 }, () => client.query(query)));
      assert.ok(results.every(result => result.stale && !result.partial && result.results.fixture.version === 1));
      assert.equal(calls, 2);
      reject(new Error('synthetic outage'));
      await setImmediate();
      assert.equal(calls, 2);
      assert.equal(errors, ${withTelemetry ? 1 : 0});
      const recovered = await client.query(query, { forceRefresh: true });
      assert.equal(recovered.results.fixture.version, 3);
      assert.equal(recovered.partial, false);
      console.log('strict process survived and recovered');
    `;
    const child = spawnSync(process.execPath,
      ["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "--eval", source],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toContain("strict process survived and recovered");
  });
});
