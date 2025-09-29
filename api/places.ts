import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';

// Simple in-memory cache (resets if function cold-starts)
const CACHE = new Map<string, { data: any; until: number }>();
const put = (k: string, v: any, ttlSec = 3600) => {
  CACHE.set(k, { data: v, until: Date.now() + ttlSec * 1000 });
  if (CACHE.size > 5000) {
    const firstKey = CACHE.keys().next().value;
    CACHE.delete(firstKey);
  }
};
const get = (k: string) => {
  const e = CACHE.get(k);
  if (!e) return null;
  if (Date.now() > e.until) {
    CACHE.delete(k);
    return null;
  }
  return e.data;
};

// Only allow read-only actions
const ALLOWED = new Set([
  'searchText',
  'nearbySearch',
  'details',
  'autocomplete',
  'batchDetails',
  'health'
]);

const GOOGLE_PLACES_BASE = 'https://places.googleapis.com/v1';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gateway-key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || req.body?.action || '').toString();
  if (!ALLOWED.has(action)) return res.status(400).json({ error: 'invalid_action' });

  const gatewayKey = req.headers['x-gateway-key'];
  if (!process.env.GATEWAY_TOKEN || gatewayKey !== process.env.GATEWAY_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (action === 'health') {
    return res.json({ ok: true, cacheEntries: CACHE.size });
  }

  const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'missing_google_api_key' });

  try {
    if (action === 'batchDetails') {
      const { placeIds = [], fields = ['id','displayName','formattedAddress','rating','userRatingCount','reviews'] } = req.body || {};
      if (!Array.isArray(placeIds) || placeIds.length === 0) return res.status(400).json({ error: 'placeIds_required' });
      if (placeIds.length > 50) return res.status(400).json({ error: 'too_many_placeIds_max_50' });

      const results = await Promise.all(placeIds.map(async (pid: string) => {
        const cacheKey = `details:${pid}:${fields.sort().join(',')}`;
        const cached = get(cacheKey);
        if (cached) return { placeId: pid, data: cached, cached: true };

        const url = `${GOOGLE_PLACES_BASE}/places/${encodeURIComponent(pid)}?fields=${encodeURIComponent(fields.join(','))}`;
        const r = await fetch(url, {
          headers: {
            'X-Goog-Api-Key': GOOGLE_API_KEY!,
            'X-Goog-FieldMask': fields.join(',')
          }
        });
        if (!r.ok) {
          const t = await r.text();
          return { placeId: pid, error: true, status: r.status, body: t };
        }
        const json = await r.json();
        put(cacheKey, json, 3600);
        return { placeId: pid, data: json, cached: false };
      }));

      return res.json({ results });
    }

    if (action === 'details') {
      const { placeId, fields = ['id','displayName','formattedAddress','rating','userRatingCount','reviews'] } = req.body || {};
      if (!placeId) return res.status(400).json({ error: 'placeId_required' });

      const cacheKey = `details:${placeId}:${fields.sort().join(',')}`;
      const cached = get(cacheKey);
      if (cached) return res.json({ data: cached, cached: true });

      const url = `${GOOGLE_PLACES_BASE}/places/${encodeURIComponent(placeId)}?fields=${encodeURIComponent(fields.join(','))}`;
      const r = await fetch(url, {
        headers: {
          'X-Goog-Api-Key': GOOGLE_API_KEY!,
          'X-Goog-FieldMask': fields.join(',')
        }
      });
      if (!r.ok) return res.status(r.status).json({ error: 'google_error', body: await r.text() });
      const json = await r.json();
      put(cacheKey, json, 3600);
      return res.json({ data: json, cached: false });
    }

    if (action === 'searchText') {
      const { textQuery, regionCode, pageSize = 10, languageCode, includedType } = req.body || {};
      if (!textQuery) return res.status(400).json({ error: 'textQuery_required' });

      const body = { textQuery, regionCode, pageSize, languageCode, includedType };
      const url = `${GOOGLE_PLACES_BASE}/text:search`;
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Goog-Api-Key': GOOGLE_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
      });
      if (!r.ok) return res.status(r.status).json({ error: 'google_error', body: await r.text() });
      const json = await r.json();
      return res.json({ data: json });
    }

    if (action === 'nearbySearch') {
      const { lat, lng, radius = 1000, includedType, maxResultCount = 20 } = req.body || {};
      if (lat == null || lng == null) return res.status(400).json({ error: 'lat_lng_required' });

      const url = `${GOOGLE_PLACES_BASE}/places:searchNearby`;
      const body = {
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius }
        },
        includedTypes: includedType ? [includedType] : undefined,
        maxResultCount
      };
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Goog-Api-Key': GOOGLE_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
      });
      if (!r.ok) return res.status(r.status).json({ error: 'google_error', body: await r.text() });
      const json = await r.json();
      return res.json({ data: json });
    }

    if (action === 'autocomplete') {
      const { input, languageCode, regionCode, types } = req.body || {};
      if (!input) return res.status(400).json({ error: 'input_required' });
      const params = new URLSearchParams({
        input,
        ...(languageCode ? { languageCode } : {}),
        ...(regionCode ? { regionCode } : {}),
        ...(types ? { types } : {})
      });
      const url = `https://places.googleapis.com/v1/places:autocomplete?${params.toString()}`;
      const r = await fetch(url, {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': GOOGLE_API_KEY! }
      });
      if (!r.ok) return res.status(r.status).json({ error: 'google_error', body: await r.text() });
      const json = await r.json();
      return res.json({ data: json });
    }

    return res.status(400).json({ error: 'unhandled_action' });
  } catch (e: any) {
    return res.status(500).json({ error: 'gateway_exception', message: e?.message });
  }
}
