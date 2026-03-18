import { createHash } from "node:crypto"

interface S3FileLike {
  exists(): Promise<boolean>
  arrayBuffer(): Promise<ArrayBuffer>
  write(data: Uint8Array): Promise<void>
}

interface S3ClientLike {
  file(key: string, options?: { bucket?: string; type?: string }): S3FileLike
}

interface CacheClient {
  client: S3ClientLike
  bucket: string
  prefix: string
}

const CACHE_ENABLED = process.env.S3_CACHE_ENABLED === "true"

let cacheClientPromise: Promise<CacheClient | null> | null = null

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

async function createClient(): Promise<CacheClient | null> {
  if (!CACHE_ENABLED) {
    return null
  }

  if (!process.versions?.bun) {
    return null
  }

  const bucket = envValue("S3_BUCKET")
  const accessKeyId = envValue("S3_ACCESS_KEY_ID", envValue("AWS_ACCESS_KEY_ID"))
  const secretAccessKey = envValue("S3_SECRET_ACCESS_KEY", envValue("AWS_SECRET_ACCESS_KEY"))
  const endpoint = envValue("S3_ENDPOINT")
  const region = envValue("S3_REGION", envValue("AWS_REGION", "us-east-1"))
  const prefix = envValue("S3_PREFIX", "book2pdf-cache")

  if (!bucket || !accessKeyId || !secretAccessKey) {
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
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint: endpoint || undefined,
  })

  return {
    client,
    bucket,
    prefix,
  }
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
