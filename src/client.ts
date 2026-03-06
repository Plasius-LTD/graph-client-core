import type {
  CacheEnvelope,
  CachePolicy,
  GraphNodeResult,
  GraphQuery,
  GraphQueryResult,
  JsonValue,
  ResolverRequest,
  TelemetrySink,
  Version,
} from "@plasius/graph-contracts";
import { DEFAULT_HARD_TTL_SECONDS, DEFAULT_SCHEMA_VERSION, DEFAULT_SOFT_TTL_SECONDS, isGraphQuery } from "@plasius/graph-contracts";

export interface GraphTransportResponse {
  data: JsonValue;
  version: Version;
  tags?: string[];
  source?: string;
}

export interface GraphTransport {
  fetch(request: ResolverRequest, context: { traceId?: string }): Promise<GraphTransportResponse>;
}

export interface GraphClientOptions {
  transport: GraphTransport;
  policy?: Partial<CachePolicy>;
  now?: () => number;
  schemaVersion?: string;
  telemetry?: TelemetrySink;
}

export interface GraphQueryOptions {
  allowStale?: boolean;
  forceRefresh?: boolean;
}

interface CacheIndexEntry {
  key: string;
  tags: Set<string>;
}

export class GraphClient {
  private readonly transport: GraphTransport;
  private readonly now: () => number;
  private readonly schemaVersion: string;
  private readonly policy: CachePolicy;
  private readonly telemetry?: TelemetrySink;
  private readonly cache = new Map<string, CacheEnvelope<JsonValue>>();
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly inflight = new Map<string, Promise<CacheEnvelope<JsonValue>>>();

  public constructor(options: GraphClientOptions) {
    this.transport = options.transport;
    this.now = options.now ?? (() => Date.now());
    this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
    this.policy = {
      softTtlSeconds: options.policy?.softTtlSeconds ?? DEFAULT_SOFT_TTL_SECONDS,
      hardTtlSeconds: options.policy?.hardTtlSeconds ?? DEFAULT_HARD_TTL_SECONDS,
    };
    this.telemetry = options.telemetry;
  }

  public async query(query: GraphQuery, options: GraphQueryOptions = {}): Promise<GraphQueryResult> {
    if (!isGraphQuery(query)) {
      throw new Error("Invalid graph query payload");
    }

    const startedAt = this.now();
    const now = startedAt;
    const results: Record<string, GraphNodeResult> = {};
    const errors: GraphQueryResult["errors"] = [];
    let stale = false;
    let partial = false;

    for (const request of query.requests) {
      const cacheKey = this.createCacheKey(request);
      const cached = this.cache.get(cacheKey);
      const ageMs = cached ? now - cached.fetchedAtEpochMs : Number.POSITIVE_INFINITY;
      const softTtlMs = this.policy.softTtlSeconds * 1000;
      const hardTtlMs = this.policy.hardTtlSeconds * 1000;

      if (!options.forceRefresh && cached && ageMs <= softTtlMs) {
        this.telemetry?.metric({
          name: "graph.client.cache.outcome",
          value: 1,
          unit: "count",
          tags: {
            outcome: "fresh_hit",
            resolver: request.resolver,
          },
        });
        results[request.key] = this.toNodeResult(request.key, cached, false);
        continue;
      }

      const canServeStale = !options.forceRefresh && options.allowStale !== false && cached && ageMs <= hardTtlMs;
      if (canServeStale) {
        this.telemetry?.metric({
          name: "graph.client.cache.outcome",
          value: 1,
          unit: "count",
          tags: {
            outcome: "stale_hit",
            resolver: request.resolver,
          },
        });
        this.telemetry?.metric({
          name: "graph.client.stale_served",
          value: 1,
          unit: "count",
        });
        stale = true;
        results[request.key] = this.toNodeResult(request.key, cached, true);
        void this.refresh(request, cacheKey, query.traceId);
        continue;
      }

      this.telemetry?.metric({
        name: "graph.client.cache.outcome",
        value: 1,
        unit: "count",
        tags: {
          outcome: "miss",
          resolver: request.resolver,
        },
      });

      try {
        const envelope = await this.refresh(request, cacheKey, query.traceId);
        results[request.key] = this.toNodeResult(request.key, envelope, false);
      } catch (error) {
        partial = true;
        const message = error instanceof Error ? error.message : "Unknown transport error";
        errors.push({
          code: "CLIENT_FETCH_FAILED",
          message,
          retryable: true,
        });
        results[request.key] = {
          key: request.key,
          data: null,
          stale: false,
          tags: request.tags ?? [],
          error: {
            code: "CLIENT_FETCH_FAILED",
            message,
            retryable: true,
          },
        };
        this.telemetry?.metric({
          name: "graph.client.fetch.error",
          value: 1,
          unit: "count",
          tags: {
            resolver: request.resolver,
          },
        });
        this.telemetry?.error({
          message,
          source: request.resolver,
          code: "CLIENT_FETCH_FAILED",
        });
      }
    }

    this.telemetry?.metric({
      name: "graph.client.query.latency",
      value: this.now() - startedAt,
      unit: "ms",
    });

    return {
      queryId: query.id,
      partial,
      stale,
      generatedAtEpochMs: now,
      results,
      errors,
    };
  }

  public invalidateTags(tags: string[]): number {
    let removed = 0;
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) {
        continue;
      }

      for (const key of keys) {
        if (this.cache.delete(key)) {
          removed += 1;
        }
      }

      this.tagIndex.delete(tag);
    }

    return removed;
  }

  public prime(envelope: CacheEnvelope<JsonValue>): void {
    this.cache.set(envelope.key, envelope);
    this.attachTags({ key: envelope.key, tags: new Set(envelope.tags) });
  }

  private async refresh(request: ResolverRequest, cacheKey: string, traceId?: string): Promise<CacheEnvelope<JsonValue>> {
    const inflightExisting = this.inflight.get(cacheKey);
    if (inflightExisting) {
      this.telemetry?.metric({
        name: "graph.client.inflight.deduped",
        value: 1,
        unit: "count",
      });
      return inflightExisting;
    }

    const refreshStartedAt = this.now();
    const inflightPromise = this.transport
      .fetch(request, { traceId })
      .then((response) => {
        const envelope: CacheEnvelope<JsonValue> = {
          key: cacheKey,
          value: response.data,
          fetchedAtEpochMs: this.now(),
          policy: this.policy,
          version: response.version,
          schemaVersion: this.schemaVersion,
          source: response.source ?? request.resolver,
          tags: response.tags ?? request.tags ?? [],
        };

        this.cache.set(cacheKey, envelope);
        this.attachTags({ key: cacheKey, tags: new Set(envelope.tags) });
        this.telemetry?.metric({
          name: "graph.client.refresh.latency",
          value: this.now() - refreshStartedAt,
          unit: "ms",
          tags: {
            resolver: request.resolver,
          },
        });
        return envelope;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown transport error";
        this.telemetry?.error({
          message,
          source: request.resolver,
          code: "CLIENT_REFRESH_FAILED",
        });
        throw error;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });

    this.inflight.set(cacheKey, inflightPromise);
    return inflightPromise;
  }

  private toNodeResult(key: string, envelope: CacheEnvelope<JsonValue>, stale: boolean): GraphNodeResult {
    return {
      key,
      data: envelope.value,
      stale,
      version: envelope.version,
      fetchedAtEpochMs: envelope.fetchedAtEpochMs,
      tags: envelope.tags,
    };
  }

  private createCacheKey(request: ResolverRequest): string {
    const paramsJson = request.params ? JSON.stringify(request.params) : "";
    return `${request.resolver}:${request.key}:${paramsJson}`;
  }

  private attachTags(entry: CacheIndexEntry): void {
    for (const tag of entry.tags) {
      const keys = this.tagIndex.get(tag) ?? new Set<string>();
      keys.add(entry.key);
      this.tagIndex.set(tag, keys);
    }
  }
}
