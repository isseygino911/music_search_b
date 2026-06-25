const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION = process.env.QDRANT_COLLECTION || 'music_tracks';

async function qdrantRequest(method, path, body) {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Qdrant ${method} ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function ensureCollection() {
  try {
    await qdrantRequest('PUT', `/collections/${COLLECTION}`, {
      vectors: { size: 768, distance: 'Cosine' },
    });
    console.log(`Qdrant collection "${COLLECTION}" ready`);
  } catch (err) {
    // Collection already exists with same config — safe to ignore
    if (err.message.includes('already exists')) return;
    console.warn('Qdrant ensureCollection failed:', err.message);
  }
}

module.exports = { qdrantRequest, ensureCollection, COLLECTION };
