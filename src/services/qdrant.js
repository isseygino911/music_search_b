const { qdrantRequest, COLLECTION } = require('../config/qdrant');

async function upsertVector(trackId, vector) {
  await qdrantRequest('PUT', `/collections/${COLLECTION}/points`, {
    points: [{ id: trackId, vector }],
  });
}

async function searchVectors(queryVector, topK = 10) {
  const result = await qdrantRequest('POST', `/collections/${COLLECTION}/points/search`, {
    vector: queryVector,
    limit: topK,
    with_payload: false,
  });
  return result.result.map((r) => ({ trackId: r.id, score: r.score }));
}

module.exports = { upsertVector, searchVectors };
