import admin from "firebase-admin";

function usage() {
  console.log("Usage: node scripts/vectorHealthScan.mjs <storeId>");
  process.exit(1);
}

const storeId = process.argv[2];
if (!storeId) usage();

// --- Init Admin SDK ---
// Uses ADC (GOOGLE_APPLICATION_CREDENTIALS) or default environment.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

function normSq(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]) || 0;
    s += v * v;
  }
  return s;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

(async () => {
  const t0 = Date.now();

  const col = db.collection("productEmbeddings").doc(storeId).collection("items");

  // Field-mask to only pull vectors (reduces payload)
  const snap = await col.select("vector").get();

  const total = snap.size;

  let withVector = 0;
  let missingVector = 0;

  const dimCounts = new Map();     // dim -> count
  const norms = [];               // L2 norms
  const missingIds = [];
  const oddDims = [];             // { id, dim }
  const tinyNorms = [];           // { id, dim, norm }

  for (const d of snap.docs) {
    const vec = d.get("vector");

    if (!Array.isArray(vec) || vec.length === 0) {
      missingVector++;
      if (missingIds.length < 25) missingIds.push(d.id);
      continue;
    }

    withVector++;
    const dim = vec.length;
    dimCounts.set(dim, (dimCounts.get(dim) || 0) + 1);

    // Track odd dims if multiple dims exist
    // We'll decide "odd" after collecting dims, but store now anyway
    // (we'll filter once we know the modal dim).
    const nsq = normSq(vec);
    const n = Math.sqrt(nsq);
    norms.push(n);

    if (n < 0.01 && tinyNorms.length < 25) {
      tinyNorms.push({ id: d.id, dim, norm: n });
    }
  }

  // Determine modal dimension (most common)
  let modalDim = null;
  let modalCount = -1;
  for (const [dim, count] of dimCounts.entries()) {
    if (count > modalCount) {
      modalCount = count;
      modalDim = dim;
    }
  }

  // Find docs with non-modal dims
  if (modalDim != null && dimCounts.size > 1) {
    for (const d of snap.docs) {
      const vec = d.get("vector");
      if (!Array.isArray(vec) || !vec.length) continue;
      if (vec.length !== modalDim) {
        if (oddDims.length < 25) oddDims.push({ id: d.id, dim: vec.length });
      }
    }
  }

  norms.sort((a, b) => a - b);

  const ms = Date.now() - t0;

  console.log("\n=== Vector Health Scan ===");
  console.log("storeId:", storeId);
  console.log("collection:", `productEmbeddings/${storeId}/items`);
  console.log("tookMs:", ms);
  console.log("");

  console.log("Docs:");
  console.log("  total:", total);
  console.log("  withVector:", withVector);
  console.log("  missingVector:", missingVector, missingVector ? `(sample: ${missingIds.slice(0, 10).join(", ")})` : "");
  console.log("");

  console.log("Vector dimensions (dim -> count):");
  const dimsSorted = Array.from(dimCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [dim, count] of dimsSorted) {
    const pct = total ? ((count / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${dim}: ${count} (${pct}%)${dim === modalDim ? "  <-- modal" : ""}`);
  }
  if (!dimsSorted.length) console.log("  (none)");
  console.log("");

  if (norms.length) {
    console.log("Norm stats (L2):");
    console.log("  min:", norms[0].toFixed(6));
    console.log("  p50:", percentile(norms, 50).toFixed(6));
    console.log("  p90:", percentile(norms, 90).toFixed(6));
    console.log("  max:", norms[norms.length - 1].toFixed(6));
    console.log("");
  } else {
    console.log("Norm stats: (no vectors)");
  }

  if (oddDims.length) {
    console.log("Non-modal dimension docs (sample):");
    for (const x of oddDims) console.log(`  ${x.id} dim=${x.dim}`);
    console.log("");
  }

  if (tinyNorms.length) {
    console.log("Near-zero vectors (norm < 0.01) sample:");
    for (const x of tinyNorms) console.log(`  ${x.id} dim=${x.dim} norm=${x.norm.toFixed(6)}`);
    console.log("");
  }

  // Simple “health flags”
  const flags = [];
  if (missingVector > 0) flags.push(`missing_vector=${missingVector}`);
  if (dimCounts.size > 1) flags.push(`mixed_dims=${dimCounts.size} (modal=${modalDim})`);
  const p50 = percentile(norms, 50);
  if (p50 != null && p50 < 0.1) flags.push(`very_low_norms (p50=${p50.toFixed(4)})`);
  console.log("Health flags:", flags.length ? flags.join(", ") : "none");
  console.log("");
})();
