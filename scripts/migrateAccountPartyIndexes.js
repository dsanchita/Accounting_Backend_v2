import { initializeDatabaseConnections } from "../src/config/databases.js";

const connectionMap = await initializeDatabaseConnections();
const accounting = connectionMap.accounting;

if (!accounting) {
  throw new Error("Accounting database connection is not configured");
}

try {
  const accounts = accounting.collection("accounts");
  const indexes = await accounts.indexes();
  const indexDefinitions = [
    {
      field: "linkedClientId",
      indexName: "uniq_linkedClientId_companyId_nonnull",
    },
    {
      field: "linkedVendorId",
      indexName: "uniq_linkedVendorId_companyId_nonnull",
    },
  ];

  for (const { field, indexName } of indexDefinitions) {
    const duplicates = await accounts
      .aggregate([
        { $match: { [field]: { $type: "string" } } },
        {
          $group: {
            _id: { companyId: "$companyId", linkedPartyId: `$${field}` },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ])
      .toArray();

    if (duplicates.length > 0) {
      throw new Error(
        `Cannot migrate ${field} index: duplicate linked party IDs exist within a company`
      );
    }

    const legacyIndex = indexes.find(
      (index) =>
        index.unique === true &&
        index.sparse === true &&
        !index.partialFilterExpression &&
        Object.keys(index.key).length === 2 &&
        index.key[field] === 1 &&
        index.key.companyId === 1
    );

    if (legacyIndex) {
      await accounts.dropIndex(legacyIndex.name);
    }

    await accounts.createIndex(
      { [field]: 1, companyId: 1 },
      {
        name: indexName,
        unique: true,
        partialFilterExpression: { [field]: { $type: "string" } },
      }
    );
  }

  console.log("Account linked-party indexes migrated successfully");
} finally {
  await Promise.all(Object.values(connectionMap).map((connection) => connection.close()));
}
