/**
 * Universal Mongo → PostgreSQL data migration for Strapi v4
 * ---------------------------------------------------------
 * ✅ Handles UTF-8/UTF-8 BOM/UTF-16LE/BE decoding & BOM stripping
 * ✅ Supports JSON arrays & NDJSON (bsondump output)
 * ✅ Attribute-aware field mapping (respects actual schema keys, even Capitalized)
 * ✅ Skips Strapi system collections & corrupt files
 * ✅ Converts Mongo Extended JSON dates safely ($date.$numberLong, epoch, ISO)
 * ✅ Writes a migration.log summary
 */

const fs = require("fs");
const path = require("path");
const Strapi = require("@strapi/strapi");

(async () => {
  const dataDir = path.join(__dirname, "data");
  const logFile = path.join(__dirname, "migration.log");
  const logs = [];
  const DEBUG_FIRST_RECORD = true; // set false after you verify the mapping

  // -------- Helpers

  // Robust decode (UTF-8/UTF-8 BOM/UTF-16LE/UTF-16BE) + strip BOM
  const decodeFile = (filePath) => {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return buf.slice(2).toString("utf16le").replace(/^\uFEFF/, "").trim();
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      return buf.slice(2).toString("utf16be").replace(/^\uFEFF/, "").trim();
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return buf.slice(3).toString("utf8").trim();
    }
    return buf.toString("utf8").replace(/^\uFEFF/, "").trim();
  };

  // Normalize/unwrap Mongo Extended JSON dates to ISO string
  const normalizeDate = (value) => {
    if (!value) return null;
    try {
      const unwrap = (val) => {
        if (val && typeof val === "object") {
          if ("$date" in val) return unwrap(val.$date);
          if ("$numberLong" in val) return val.$numberLong;
        }
        return val;
      };
      let v = unwrap(value);

      if (typeof v === "number") {
        const d = new Date(v);
        return isNaN(d) ? null : d.toISOString();
      }
      if (typeof v === "string") {
        const s = v.trim();
        if (/^\d+$/.test(s)) {
          const d = new Date(parseInt(s, 10));
          return isNaN(d) ? null : d.toISOString();
        }
        const withoutOrdinals = s.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
        const d = new Date(withoutOrdinals);
        return isNaN(d) ? null : d.toISOString();
      }
    } catch {}
    return null;
  };

  // Naive plural → singular (with a few irregular overrides if needed)
  const toSingular = (name) => {
    const overrides = { people: "person", children: "child", men: "man", women: "woman" };
    if (overrides[name]) return overrides[name];
    return name.replace(/s$/, "");
  };

  // ----- Attribute-aware key mapping helpers -----

  // convert "Title" / "book_title" / "bookTitle" → canonical form
  const normalizeKey = (k) =>
    String(k)
      .trim()
      .replace(/[\s\-]+/g, "_")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();

  // Build lookup: normalizedName -> actual attribute key (respecting capitalization as in schema)
  const buildAttrIndex = (attributes) => {
    const idx = new Map();
    for (const attrName of Object.keys(attributes)) {
      idx.set(normalizeKey(attrName), attrName);
    }
    return idx;
  };

  // Map incoming record keys to real attribute names using the schema
  const coerceKeysToAttributes = (record, attributes) => {
    const attrIndex = buildAttrIndex(attributes);
    const out = {};
    for (const [k, v] of Object.entries(record)) {
      if (attributes[k]) {
        out[k] = v; // already exact attribute key
        continue;
      }
      const n = normalizeKey(k);
      if (attrIndex.has(n)) {
        const realKey = attrIndex.get(n);
        out[realKey] = v; // map to actual key (could be Capitalized or camelCase)
        continue;
      }
      out[k] = v; // keep; we'll drop unknowns later
    }
    return out;
  };

  // Per-collection UID overrides (adjust if needed)
  const uidOverrides = {
    books: "api::book.book",
    // If you decide to import plugins later, set these and remove from skipList:
    // "upload_file": "plugin::upload.file",
    // "users-permissions_user": "plugin::users-permissions.user",
    // "users-permissions_role": "plugin::users-permissions.role",
    // "users-permissions_permission": "plugin::users-permissions.permission",
  };

  // Explicit renames per collection (sourceKey → targetAttributeName).
  // NOTE: We only apply a rename if target exists in attributes, to avoid creating unknown keys.
  const explicitRenames = {
    books: {
      Title: "title",
      Slug: "slug",
      Description: "description",
      Author: "author",
    },
  };

  // Per-collection record mapper
  const mapRecord = (collectionName, rec, attributes) => {
    let tmp = { ...rec };

    // 1) Apply explicit renames ONLY if the target attribute exists
    const renames = explicitRenames[collectionName];
    if (renames) {
      for (const [src, dst] of Object.entries(renames)) {
        if (tmp[src] !== undefined && attributes[dst]) {
          if (tmp[dst] === undefined) tmp[dst] = tmp[src];
        }
      }
    }

    // 2) Coerce keys to real attribute names based on schema
    let coerced = coerceKeysToAttributes(tmp, attributes);

    // 3) Final cleanup: remove keys that are NOT real attributes
    const attrSet = new Set(Object.keys(attributes));
    for (const key of Object.keys(coerced)) {
      if (!attrSet.has(key)) {
        delete coerced[key];
      }
    }

    return coerced;
  };

  // -------- Start

  if (!fs.existsSync(dataDir)) {
    console.error("❌ Data folder not found:", dataDir);
    process.exit(1);
  }

  console.log("🚀 Booting Strapi...");
  await Strapi().load(); // exposes global "strapi"

  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("⚠️ No JSON files found in /data");
    process.exit(0);
  }

  console.log(`📦 Found ${files.length} collection(s): ${files.join(", ")}`);

  // Strapi internal/system collections to skip
  const skipList = [
    "core_store",
    "i18n_locales",
    "strapi_administrator",
    "strapi_permission",
    "strapi_role",
    "strapi_webhooks",
    "prelude",
    // Skip plugins until you explicitly import them
    "upload_file",
    "users-permissions_permission",
    "users-permissions_role",
    "users-permissions_user",
  ];

  for (const file of files) {
    const collectionName = path.basename(file, ".json");
    if (skipList.includes(collectionName)) {
      console.log(`⏭️  Skipping internal/corrupt collection: ${collectionName}`);
      logs.push(`SKIPPED: ${collectionName}`);
      continue;
    }

    const filePath = path.join(dataDir, file);

    // Step 1: Decode content robustly
    let fileContent;
    try {
      fileContent = decodeFile(filePath);
    } catch (e) {
      console.error(`❌ ${file}: Cannot read/decode file (${e.message})`);
      logs.push(`FAILED: ${file} - read/decode error`);
      continue;
    }

    // Step 2: Parse JSON or NDJSON
    let jsonData;
    try {
      jsonData = JSON.parse(fileContent);
    } catch (err) {
      try {
        jsonData = fileContent
          .split(/\r?\n/)
          .filter((line) => line.trim().length)
          .map((line) => JSON.parse(line.replace(/^\uFEFF/, "")));
      } catch (innerErr) {
        console.error(`❌ ${file}: Cannot parse JSON (${innerErr.message})`);
        logs.push(`FAILED: ${file} - Parse error`);
        continue;
      }
    }

    if (!Array.isArray(jsonData)) jsonData = [jsonData];
    if (jsonData.length === 0) {
      console.log(`⚠️ Skipping ${collectionName}: empty file`);
      logs.push(`EMPTY: ${collectionName}`);
      continue;
    }

    // Step 3: Build UID & get query + attributes
    const singularName = toSingular(collectionName);
    const uid = uidOverrides[collectionName] || `api::${singularName}.${singularName}`;

    let query, attributes;
    try {
      query = strapi.db.query(uid);
      attributes = strapi.contentType(uid)?.attributes || {};
    } catch {
      console.warn(
        `⚠️ Skipping ${collectionName}: no matching collection type found in Strapi for UID "${uid}"`
      );
      logs.push(`MISSING MODEL: ${collectionName}`);
      continue;
    }

    console.log(`\n📥 Importing ${jsonData.length} records into "${uid}"...`);
    let successCount = 0;
    let failCount = 0;

    for (const [index, raw] of jsonData.entries()) {
      try {
        const record = { ...raw };

        // Clean Mongo/system fields you don't want to insert
        delete record._id;
        delete record.__v;
        delete record.created_by;
        delete record.updated_by;

        // Normalize legacy dates -> camelCase
        if (record.created_at && !record.createdAt)
          record.createdAt = normalizeDate(record.created_at);
        if (record.updated_at && !record.updatedAt)
          record.updatedAt = normalizeDate(record.updated_at);
        if (record.published_at && !record.publishedAt)
          record.publishedAt = normalizeDate(record.published_at);

        // Also normalize if already present but extended
        if (record.createdAt)
          record.createdAt = normalizeDate(record.createdAt) || record.createdAt;
        if (record.updatedAt)
          record.updatedAt = normalizeDate(record.updatedAt) || record.updatedAt;
        if (record.publishedAt)
          record.publishedAt =
            normalizeDate(record.publishedAt) || record.publishedAt;

        // Attribute-aware mapping (keeps only real attributes)
        const toInsert = mapRecord(collectionName, record, attributes);

        // Optional one-time debug: see actual attributes & payload
        if (DEBUG_FIRST_RECORD && index === 0) {
          console.log("→ Attributes on", uid, ":", Object.keys(attributes));
          console.log("→ Sample payload:", toInsert);
        }

        await query.create({ data: toInsert });
        successCount++;
      } catch (err) {
        failCount++;
        console.error(`❌ Error importing record in ${collectionName}: ${err.message}`);
      }
    }

    console.log(`✅ Imported ${successCount}/${jsonData.length} records into "${uid}"`);
    logs.push(`DONE: ${collectionName} → ${successCount} success, ${failCount} failed (Total: ${jsonData.length})`);
  }

  // Summary log
  try {
    fs.writeFileSync(logFile, logs.join("\n"), "utf8");
    console.log(`\n🗒️  Migration summary saved to: ${logFile}`);
  } catch (e) {
    console.warn(`⚠️ Could not write migration log: ${e.message}`);
  }

  console.log("\n🎉 Migration complete!");
  process.exit(0);
})();
