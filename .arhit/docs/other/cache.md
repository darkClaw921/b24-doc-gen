# cache

Tiny dependency-free TTL cache (services/cache.ts). Class TTLCache<V>(defaultTtlMs) with get/set/delete/clear/size. Each entry stores value + expiresAt; get returns undefined for missing or expired keys. Used by routes/deal.ts to cache crm.deal.fields per portal for 5 minutes.
