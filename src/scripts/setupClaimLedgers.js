import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.ACCOUNTING_DB_URI;
if (!uri) {
  console.error("ACCOUNTING_DB_URI not configured");
  process.exit(1);
}

async function run() {
  const conn = await mongoose.createConnection(uri).asPromise();
  console.log("Connected to accounting database");

  const companyId = "6ac49e78625546545709f566";
  const groupId = new mongoose.Types.ObjectId("6ac8b3823b75b750ff9c104e"); // Indirect Expenses

  const accountsCol = conn.collection("accounts");
  const configsCol = conn.collection("hrmsintegrationconfigs");

  // 1. Ensure Tour and Travel Expenses
  let tourTravelAcc = await accountsCol.findOne({
    companyId,
    $or: [{ code: "TOURTRAVELEXP" }, { name: "Tour and Travel Expenses" }],
  });
  if (!tourTravelAcc) {
    const res = await accountsCol.insertOne({
      code: "TOURTRAVELEXP",
      name: "Tour and Travel Expenses",
      type: "revenueAccount",
      subType: null,
      groupId,
      groupName: "Indirect Expenses",
      companyId,
      openingBalance: 0,
      openingType: "debit",
      scheduleMapping: {
        scheduleMainHead: "P&L",
        scheduleGroup: "Expenses",
        scheduleLineItem: "Other Expenses",
        noteNo: null,
        reportType: "profit_and_loss",
      },
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tourTravelAcc = { _id: res.insertedId, name: "Tour and Travel Expenses" };
    console.log("Created 'Tour and Travel Expenses' account:", res.insertedId);
  } else {
    console.log("Found existing 'Tour and Travel Expenses' account:", tourTravelAcc._id);
  }

  // 2. Ensure Miscellaneous account
  let miscAcc = await accountsCol.findOne({
    companyId,
    $or: [{ code: "MISCEXP" }, { name: "Miscellaneous" }, { name: "Miscellaneous Expenses" }],
  });
  if (!miscAcc) {
    const res = await accountsCol.insertOne({
      code: "MISCEXP",
      name: "Miscellaneous",
      type: "revenueAccount",
      subType: null,
      groupId,
      groupName: "Indirect Expenses",
      companyId,
      openingBalance: 0,
      openingType: "debit",
      scheduleMapping: {
        scheduleMainHead: "P&L",
        scheduleGroup: "Expenses",
        scheduleLineItem: "Other Expenses",
        noteNo: null,
        reportType: "profit_and_loss",
      },
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    miscAcc = { _id: res.insertedId, name: "Miscellaneous" };
    console.log("Created 'Miscellaneous' account:", res.insertedId);
  } else {
    console.log("Found existing 'Miscellaneous' account:", miscAcc._id);
  }

  // 3. Ensure Office Expenses account
  let officeAcc = await accountsCol.findOne({
    companyId,
    $or: [{ code: "OFFICEEXPENS" }, { name: "Office Expenses" }, { name: "Office Expense" }],
  });
  if (!officeAcc) {
    console.error("Office Expenses account not found!");
  } else {
    console.log("Found 'Office Expenses' account:", officeAcc._id);
  }

  // 4. Update HRMS integration config category mappings
  // The 6 HRMS categories:
  // 1. Travel Allowance (69ae6963242d7b93ddc7478d) -> Tour and Travel Expenses
  // 2. Food Expenses for travel (69d39cd417c33ab5608e129c) -> Tour and Travel Expenses
  // 3. Shift Allowance (69afe3e9d2064e6b3aa80ae3) -> Office Expenses
  // 4. Recharge of Internet (69d391a017c33ab5608e0faf) -> Office Expenses
  // 5. Food (69afe7cb7a1905fc9e9865e2) -> Office Expenses
  // 6. Miscellaneous (69ce2d01c1ea9c95e2c0bb3f) -> Miscellaneous
  const categoryMappings = [
    {
      categoryId: "69ae6963242d7b93ddc7478d",
      categoryName: "Travel Allowance",
      expenseAccountId: tourTravelAcc._id,
    },
    {
      categoryId: "69d39cd417c33ab5608e129c",
      categoryName: "Food Expenses for travel",
      expenseAccountId: tourTravelAcc._id,
    },
    {
      categoryId: "69afe3e9d2064e6b3aa80ae3",
      categoryName: "Shift Allowance",
      expenseAccountId: officeAcc._id,
    },
    {
      categoryId: "69d391a017c33ab5608e0faf",
      categoryName: "Recharge of Internet",
      expenseAccountId: officeAcc._id,
    },
    {
      categoryId: "69afe7cb7a1905fc9e9865e2",
      categoryName: "Food",
      expenseAccountId: officeAcc._id,
    },
    {
      categoryId: "69ce2d01c1ea9c95e2c0bb3f",
      categoryName: "Miscellaneous",
      expenseAccountId: miscAcc._id,
    },
  ];

  await configsCol.updateOne(
    { key: "HRMS", companyId },
    {
      $set: {
        "claims.categoryMappings": categoryMappings,
        updatedAt: new Date(),
        updatedBy: "Setup Script",
      },
    }
  );
  console.log("Updated HrmsIntegrationConfig category mappings successfully!");

  await conn.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
