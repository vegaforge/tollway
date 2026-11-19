import type { RedisLikeClient } from "@vegaforge/tollway-server";
import type { Redis } from "ioredis";

/**
 * Narrows an ioredis client to the three calls the settlement cache makes.
 * Spelling them out keeps the mapping checked by the compiler instead of
 * casting the whole client, and keeps each SET form paired with its options.
 */
export function toSettlementCacheClient(redis: Redis): RedisLikeClient {
  return {
    get: (key) => redis.get(key),
    async set(
      key: string,
      value: string,
      mode: "EX" | "PX",
      ttl: number,
      condition?: "NX",
    ): Promise<unknown> {
      if (mode === "PX") {
        if (condition !== "NX") {
          throw new Error("the settlement cache only sets PX keys with NX");
        }
        return redis.set(key, value, "PX", ttl, "NX");
      }
      return redis.set(key, value, "EX", ttl);
    },
    eval: (script, numKeys, ...keysAndArgs) => redis.eval(script, numKeys, ...keysAndArgs),
  };
}
