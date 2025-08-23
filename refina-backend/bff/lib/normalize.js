function normalizeConcern(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { normalizeConcern };
