const mysql = require("mysql2/promise");
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const projectId = process.env.GCLOUD_PROJECT || "study-hub-bf7e1";
initializeApp({ credential: applicationDefault(), projectId });

const auth = getAuth();
const db = getFirestore();
const tables = {
  staff_roles: "role_id",
  staff: "staff_id",
  customers: "customer_id",
  space_types: "space_type_id",
  study_spaces: "space_id",
  space_maintenance: "maintenance_id",
  reservations: "reservation_id",
  space_sessions: "session_id",
  session_extensions: "extension_id",
  walkin_queue: "queue_id",
  product_categories: "category_id",
  products_services: "product_id",
  paper_sizes: "paper_size_id",
  print_types: "print_type_id",
  orders: "order_id",
  order_items: "order_item_id",
  printing_jobs: "print_job_id",
  promotions: "promotion_id",
  payment_methods: "payment_method_id",
  billing_transactions: "transaction_id",
  payments: "payment_id",
  receipts: "receipt_id",
  notifications: "notification_id",
  audit_log: "audit_id",
};

async function queryTable(connection, name) {
  const [rows] = await connection.query(`SELECT * FROM \`${name}\``);
  return rows;
}

async function writeCollection(name, rows, primaryKey, uidBySqlId) {
  for (let start = 0; start < rows.length; start += 400) {
    const batch = db.batch();
    rows.slice(start, start + 400).forEach((row) => {
      const data = { ...row };
      if (["customers", "staff"].includes(name) && data.user_id != null) {
        data.user_id = uidBySqlId.get(String(data.user_id)) || null;
        if (data.user_id) data.uid = data.user_id;
      }
      batch.set(db.collection(name).doc(String(row[primaryKey])), data, {
        merge: true,
      });
    });
    await batch.commit();
  }
}

async function importAccounts(connection, customers, staff, roles) {
  const [users] = await connection.query(
    "SELECT * FROM `users` ORDER BY `user_id`",
  );
  const customerByUser = new Map(
    customers.map((row) => [String(row.user_id), row]),
  );
  const staffByUser = new Map(staff.map((row) => [String(row.user_id), row]));
  const roleById = new Map(roles.map((row) => [String(row.role_id), row]));
  const uidBySqlId = new Map(
    users.map((row) => [String(row.user_id), `legacy-${row.user_id}`]),
  );
  const importRecords = users.map((row) => {
    const uid = uidBySqlId.get(String(row.user_id));
    const customer = customerByUser.get(String(row.user_id));
    const staffMember = staffByUser.get(String(row.user_id));
    const role = staffMember && roleById.get(String(staffMember.role_id));
    const email =
      customer?.email || `${row.username}@study-hub-bf7e1.firebaseapp.com`;
    const passwordHash = String(row.password_hash || "").replace(
      /^\$2y\$/,
      "$2a$",
    );
    if (!passwordHash)
      throw new Error(`Missing password hash for SQL user ${row.user_id}.`);
    return {
      uid,
      email,
      displayName: customer
        ? `${customer.first_name} ${customer.last_name}`
        : staffMember
          ? `${staffMember.first_name} ${staffMember.last_name}`
          : row.username,
      disabled: row.account_status !== "active",
      passwordHash: Buffer.from(passwordHash),
    };
  });

  const missingAccounts = await Promise.all(
    importRecords.map(async (record) => {
      try {
        await auth.getUser(record.uid);
        return null;
      } catch (error) {
        if (error.code === "auth/user-not-found") return record;
        throw error;
      }
    }),
  );
  const recordsToImport = missingAccounts.filter(Boolean);
  if (recordsToImport.length) {
    const importResult = await auth.importUsers(recordsToImport, {
      hash: { algorithm: "BCRYPT" },
    });
    if (importResult.failureCount) {
      const details = importResult.errors
        .map((error) => `${error.index}: ${error.error.message}`)
        .join("; ");
      throw new Error(
        `Firebase Auth import had ${importResult.failureCount} failure(s): ${details}`,
      );
    }
  }

  const profiles = users.map((row) => {
    const uid = uidBySqlId.get(String(row.user_id));
    const customer = customerByUser.get(String(row.user_id));
    const staffMember = staffByUser.get(String(row.user_id));
    const role = staffMember && roleById.get(String(staffMember.role_id));
    return {
      uid,
      email:
        customer?.email || `${row.username}@study-hub-bf7e1.firebaseapp.com`,
      username: row.username,
      phone_number: customer?.phone_number || staffMember?.phone_number || "",
      account_type: row.account_type,
      account_status: row.account_status,
      customer_id: customer?.customer_id ?? null,
      staff_id: staffMember?.staff_id ?? null,
      role_id: staffMember?.role_id ?? null,
      role_name: role?.role_name || null,
      permissions: role?.permissions || "",
      first_name: customer?.first_name || staffMember?.first_name || "",
      last_name: customer?.last_name || staffMember?.last_name || "",
      created_at: row.created_at,
    };
  });
  for (let start = 0; start < profiles.length; start += 400) {
    const batch = db.batch();
    profiles.slice(start, start + 400).forEach((profile) => {
      batch.set(db.collection("users").doc(profile.uid), profile, {
        merge: true,
      });
    });
    await batch.commit();
  }
  return uidBySqlId;
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    database: process.env.DB_NAME || "study_hub_db",
    dateStrings: true,
  });
  try {
    const [customers, staff, roles] = await Promise.all([
      queryTable(connection, "customers"),
      queryTable(connection, "staff"),
      queryTable(connection, "staff_roles"),
    ]);
    const uidBySqlId = await importAccounts(
      connection,
      customers,
      staff,
      roles,
    );
    for (const [table, primaryKey] of Object.entries(tables)) {
      const records = await queryTable(connection, table);
      await writeCollection(table, records, primaryKey, uidBySqlId);
      console.log(`Imported ${records.length} ${table} record(s).`);
    }
    console.log(
      `Imported ${uidBySqlId.size} Firebase Auth account(s) and profile(s).`,
    );
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
