import type { MetadataRoute } from 'next'

/**
 * `/robots.txt` — a keresőmotor-/renderelő-botok viselkedését szabályozza.
 *
 * MIÉRT: ez egy belső, hitelesített enterprise control-plane, aminek nincs
 * publikus, indexelendő tartalma. `robots.txt` hiányában a Googlebot (és társai)
 * a 404-et „mindent szabad crawlolni"-ként értelmezik: az egészségügyi napló
 * tanúsága szerint a deployolt platform forgalmának ~100%-a a Google renderelő-
 * flottája volt (napi ~2000-4000 kérés, döntően egy 5 másodperces poll-végpontra),
 * miközben valódi végfelhasználói forgalom gyakorlatilag nincs. Ez elfedi a valódi
 * monitoring-jelet és feleslegesen ébreszti a Cloud Run konténert.
 *
 * ALAPÉRTELMEZÉS: mindent tilt (`Disallow: /`).
 * VISSZAÁLLÍTÁS: `ALLOW_SEARCH_INDEXING=true` környezeti változó → nyílt crawl.
 * (Runtime-ban kiértékelt dinamikus route, tehát a változó azonnal hat, build
 * nélkül; a fájl törlése is visszaállítja a korábbi „nincs robots.txt" állapotot.)
 */
export const dynamic = 'force-dynamic'

export default function robots(): MetadataRoute.Robots {
  const allowIndexing = process.env.ALLOW_SEARCH_INDEXING === 'true'

  if (allowIndexing) {
    return {
      rules: [{ userAgent: '*', allow: '/' }],
    }
  }

  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  }
}
