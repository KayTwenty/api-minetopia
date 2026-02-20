import { FastifyInstance } from 'fastify'

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

// In-memory cache — refresh at most every 10 minutes
let cache: { versions: McVersion[]; at: number } | null = null
const CACHE_TTL = 10 * 60 * 1000

export interface McVersion {
  id:          string
  type:        'release' | 'snapshot'
  releaseTime: string
  java:        number   // 17 or 21
}

/**
 * Derive the minimum required Java major version from the version's release date.
 * We don't fetch individual version manifests here (that would be ~1000 requests)
 * because the release-date boundaries are well-known:
 *  - 1.20.5 released 2024-04-23 → Java 21 required
 *  - 1.17   released 2021-06-08 → Java 17 required
 *  - older                      → Java 17 (we don't support <1.17 on Java 8)
 */
function javaForRelease(v: { releaseTime: string }): number {
  const t = new Date(v.releaseTime).getTime()
  if (t >= new Date('2024-04-23T00:00:00Z').getTime()) return 21
  return 17
}

async function fetchVersions(): Promise<McVersion[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.versions

  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`Mojang manifest returned ${res.status}`)
  const manifest: any = await res.json()

  const versions: McVersion[] = manifest.versions
    .filter((v: any) => v.type === 'release' || v.type === 'snapshot')
    .map((v: any) => ({
      id:          v.id,
      type:        v.type as 'release' | 'snapshot',
      releaseTime: v.releaseTime,
      java:        javaForRelease(v),
    }))

  cache = { versions, at: Date.now() }
  return versions
}

export async function versionRoutes(app: FastifyInstance) {
  // GET /api/mc-versions?snapshots=true
  app.get('/mc-versions', async (req, reply) => {
    const { snapshots } = req.query as { snapshots?: string }

    try {
      const all = await fetchVersions()
      const filtered = snapshots === 'true'
        ? all
        : all.filter(v => v.type === 'release')
      return filtered
    } catch (err: any) {
      return reply.status(502).send({ error: 'Could not fetch version list from Mojang' })
    }
  })
}
