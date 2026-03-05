import type {
  CacheEnvelope,
  CachePolicy,
  GraphNodeResult,
  GraphQuery,
  GraphQueryResult,
  JsonValue,
  ResolverRequest,
  Version,
} from "@plasius/graph-contracts";
import { DEFAULT_HARD_TTL_SECONDS, DEFAULT_SCHEMA_VERSION, DEFAULT_SOFT_TTL_SECONDS } from "@plasius/graph-contracts";

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
  }

  public async query(query: GraphQuery, options: GraphQueryOptions = {}): Promise<GraphQueryResult> {
    const now = this.now();
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
        results[request.key] = this.toNodeResult(request.key, cached, false);
        continue;
      }

      const canServeStale = !options.forceRefresh && options.allowStale !== false && cached && ageMs <= hardTtlMs;
      if (canServeStale) {
        stale = true;
        results[request.key] = this.toNodeResult(request.key, cached, true);
        void this.refresh(request, cacheKey, query.traceId);
        continue;
      }

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
      }
    }

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
      return inflightExisting;
    }

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
        return envelope;
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
