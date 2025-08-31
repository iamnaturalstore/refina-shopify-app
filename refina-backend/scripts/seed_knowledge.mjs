#!/usr/bin/env node
// refina-backend/scripts/seed_knowledge.mjs
// Seeds ingredientFacts and concernToIngredients (global scope) from NDJSON files.

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { db } from "../bff/lib/firestore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node scripts/seed_knowledge.mjs \\
    --ingredients ./seed/ingredient_facts.ndjson \\
    --mapping ./seed/concern_to_ingredients.ndjson \\
    [--commit]
  
  NDJSON formats:
  - ingredient_facts.ndjson:
    {"slug":"niacinamide","name":"Niacinamide","synonyms":["vitamin B3"],"benefits":"Supports barrier, oil balance.","cautions":"None for most."}
  - concern_to_ingredients.ndjson:
    {"concern":"acne-prone skin","ingredients":["salicylic acid","niacinamide","azelaic acid","sulfur"]}
`);
}

function arg(name, def = "") {
  const i = process.argv.indexOf(name);
  return i > -1 ? String(process.argv[i + 1] || "") : def;
}
const ING_PATH = arg("--ingredients");
const MAP_PATH = arg("--mapping");
const COMMIT = process.argv.includes("--commit");

if (!ING_PATH && !MAP_PATH) {
  usage();
  process.exit(1);
}

async function* readNdjson(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    const s = line.trim();
    if (!s || s.startsWith("//")) continue;
    try {
      yield JSON.parse(s);
    } catch (e) {
      console.warn(`[seed] skip invalid JSON line in ${filePath}:`, s.slice(0, 120));
    }
  }
}

async function seedIngredients(filePath) {
  const base = db.collection("ingredientFacts").doc("global").collection("items");
  const batchSize = 400;
  let batch = db.batch();
  let count = 0, writes = 0;

  for await (const row of readNdjson(filePath)) {
    const slug = String(row.slug || row.id || row.name || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .trim();
    if (!slug) continue;

    const doc = {
      name: row.name || slug,
      synonyms: Array.isArray(row.synonyms) ? row.synonyms.slice(0, 10) : [],
      benefits: String(row.benefits || "").slice(0, 600),
      cautions: String(row.cautions || "").slice(0, 300),
      aliases: Array.isArray(row.aliases) ? row.aliases.slice(0, 10) : [],
      typicalRange: row.typicalRange || null,
      refs: Array.isArray(row.refs) ? row.refs.slice(0, 8) : []
    };

    if (COMMIT) {
      batch.set(base.doc(slug), doc, { merge: true });
      writes++;
      if (writes % batchSize === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
    count++;
  }
  if (COMMIT && writes % batchSize !== 0) await batch.commit();
  return { count, written: COMMIT ? writes : 0 };
}

async function seedMapping(filePath) {
  const base = db.collection("concernToIngredients").doc("global").collection("items");
  const batchSize = 400;
  let batch = db.batch();
  let count = 0, writes = 0;

  for await (const row of readNdjson(filePath)) {
    const concern = String(row.concern || row.id || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
    if (!concern) continue;

    const ingredients = Array.isArray(row.ingredients)
      ? row.ingredients.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
      : [];

    const doc = { ingredients };

    if (COMMIT) {
      batch.set(base.doc(concern), doc, { merge: true });
      writes++;
      if (writes % batchSize === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
    count++;
  }
  if (COMMIT && writes % batchSize !== 0) await batch.commit();
  return { count, written: COMMIT ? writes : 0 };
}

(async function main() {
  try {
    const results = {};
    if (ING_PATH) results.ingredients = await seedIngredients(ING_PATH);
    if (MAP_PATH) results.mapping = await seedMapping(MAP_PATH);
    console.log(JSON.stringify({ ok: true, commit: COMMIT, results }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
    process.exit(1);
  }
})();
