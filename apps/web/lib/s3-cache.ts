import { createHash } from "node:crypto"

import { LRUCache } from "lru-cache"
import { S3mini } from "s3mini"

interface S3FileLike {
  exists(): Promise<boolean>
  arrayBuffer(): Promise<ArrayBuffer>
  write(data: Uint8Array): Promise<void>
}

interface S3ClientLike {
  file(key: string, options?: { bucket?: string; type?: string }): S3FileLike
}

interface S3MiniLike {
  objectExists(key: string): Promise<boolean | null>
  getObjectArrayBuffer(key: string): Promise<ArrayBuffer | null>
  putObject(key: string, data: Uint8Array | string, contentType?: string): Promise<unknown>
}

interface CacheClient {
  client: S3ClientLike
  bucket: string
  prefix: string
}

interface S3Config {
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
  region: string
  prefix: string
}

const CACHE_ENABLED = process.env.S3_CACHE_ENABLED === "true"
const MEMORY_CACHE_MAX_ITEMS = Number.parseInt(process.env.MEMORY_CACHE_MAX_ITEMS ?? "32", 10)
const MEMORY_CACHE_TTL_MS = Number.parseInt(process.env.MEMORY_CACHE_TTL_MS ?? `${60 * 60 * 1000}`, 10)
const MEMORY_CACHE_ENABLED = Number.isFinite(MEMORY_CACHE_MAX_ITEMS) && MEMORY_CACHE_MAX_ITEMS > 0

let cacheClientPromise: Promise<CacheClient | null> | null = null
const memoryZipCache = MEMORY_CACHE_ENABLED
  ? new LRUCache<string, Uint8Array>({
      max: MEMORY_CACHE_MAX_ITEMS,
      ttl: Number.isFinite(MEMORY_CACHE_TTL_MS) && MEMORY_CACHE_TTL_MS > 0 ? MEMORY_CACHE_TTL_MS : 60 * 60 * 1000,
      updateAgeOnGet: true,
      ttlAutopurge: true,
    })
  : null

function envValue(name: string, fallback = ""): string {
  const value = process.env[name]
  return value ? value.trim() : fallback
}

function buildObjectKey(prefix: string, key: string): string {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "")
  const normalizedKey = key.replace(/^\/+/, "")
  if (!normalizedPrefix) {
    return normalizedKey
  }
  return `${normalizedPrefix}/${normalizedKey}`
}

async function createBunClient(config: S3Config): Promise<CacheClient | null> {
  if (!process.versions?.bun) {
    return null
  }

  const moduleName = "bun"
  const bunModule = await import(moduleName)
  if (!bunModule || typeof bunModule !== "object") {
    return null
  }

  const maybeCtor = Reflect.get(bunModule, "S3Client")
  if (typeof maybeCtor !== "function") {
    return null
  }

  const S3ClientCtor = maybeCtor as new (options: {
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    endpoint?: string
  }) => S3ClientLike

  const client = new S3ClientCtor({
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    endpoint: config.endpoint,
  })

  return {
    client,
    bucket: config.bucket,
    prefix: config.prefix,
  }
}

class S3MiniFile implements S3FileLike {
  private readonly client: S3MiniLike
  private readonly key: string
  private readonly type?: string

  constructor(client: S3MiniLike, key: string, type?: string) {
    this.client = client
    this.key = key
    this.type = type
  }

  async exists(): Promise<boolean> {
    const value = await this.client.objectExists(this.key)
    return value === true
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const data = await this.client.getObjectArrayBuffer(this.key)
    if (!data) {
      throw new Error("Missing object data")
    }
    return data
  }

  async write(data: Uint8Array): Promise<void> {
    await this.client.putObject(this.key, data, this.type || "application/octet-stream")
  }
}

class S3MiniClientAdapter implements S3ClientLike {
  private readonly client: S3MiniLike

  constructor(client: S3MiniLike) {
    this.client = client
  }

  file(key: string, options?: { bucket?: string; type?: string }): S3FileLike {
    void options?.bucket
    return new S3MiniFile(this.client, key, options?.type)
  }
}

function withBucketInEndpoint(endpoint: string | undefined, bucket: string): string | null {
  if (!endpoint) {
    return null
  }

  const trimmed = endpoint.replace(/\/+$/, "")
  if (!trimmed) {
    return null
  }

  return `${trimmed}/${bucket}`
}

function createS3MiniClient(config: S3Config): CacheClient | null {
  const endpoint = withBucketInEndpoint(config.endpoint, config.bucket)
  if (!endpoint) {
    return null
  }

  const client = new S3mini({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    endpoint,
    region: config.region || "auto",
  }) as unknown as S3MiniLike

  return {
    client: new S3MiniClientAdapter(client),
    bucket: config.bucket,
    prefix: config.prefix,
  }
}

async function createClient(): Promise<CacheClient | null> {
  if (!CACHE_ENABLED) {
    return null
  }

  const bucket = envValue("S3_BUCKET", envValue("AWS_S3_BUCKET", envValue("AWS_BUCKET")))
  const accessKeyId = envValue("AWS_ACCESS_KEY_ID", envValue("S3_ACCESS_KEY_ID"))
  const secretAccessKey = envValue("AWS_SECRET_ACCESS_KEY", envValue("S3_SECRET_ACCESS_KEY"))
  const endpoint = envValue("AWS_ENDPOINT_URL_S3", envValue("S3_ENDPOINT", envValue("AWS_S3_ENDPOINT")))
  const region = envValue("AWS_REGION", envValue("S3_REGION", "us-east-1"))
  const prefix = envValue("S3_PREFIX", "book2pdf-cache")

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return null
  }

  const config = {
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: endpoint || undefined,
    region,
    prefix,
  }

  const bunClient = await createBunClient(config)
  if (bunClient) {
    return bunClient
  }

  return createS3MiniClient(config)
}

async function getClient(): Promise<CacheClient | null> {
  if (!cacheClientPromise) {
    cacheClientPromise = createClient()
  }
  return cacheClientPromise
}

export async function isS3CacheAvailable(): Promise<boolean> {
  const client = await getClient()
  return client !== null
}

export function readMemoryCachedZip(cacheKey: string): Uint8Array | null {
  if (!memoryZipCache) {
    return null
  }

  const value = memoryZipCache.get(cacheKey)
  if (!value) {
    return null
  }

  return Uint8Array.from(value)
}

export function writeMemoryCachedZip(cacheKey: string, bytes: Uint8Array): void {
  if (!memoryZipCache) {
    return
  }

  memoryZipCache.set(cacheKey, Uint8Array.from(bytes))
}

export function buildZipCacheKey(urls: string[]): string {
  const normalized = urls
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .join("\n")

  const digest = createHash("sha256")
    .update(`zip-v1\n${normalized}`)
    .digest("hex")

  return `zip-v1/${digest}.zip`
}

export async function readCachedZip(cacheKey: string): Promise<Uint8Array | null> {
  const cache = await getClient()
  if (!cache) {
    return null
  }

  const key = buildObjectKey(cache.prefix, cacheKey)
  const file = cache.client.file(key, {
    bucket: cache.bucket,
    type: "application/zip",
  })

  const exists = await file.exists()
  if (!exists) {
    return null
  }

  const data = await file.arrayBuffer()
  return new Uint8Array(data)
}

export async function writeCachedZip(cacheKey: string, bytes: Uint8Array): Promise<boolean> {
  const cache = await getClient()
  if (!cache) {
    return false
  }

  const key = buildObjectKey(cache.prefix, cacheKey)
  const file = cache.client.file(key, {
    bucket: cache.bucket,
    type: "application/zip",
  })
  await file.write(bytes)
  return true
}
