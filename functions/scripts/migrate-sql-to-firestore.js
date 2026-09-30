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

async function writeCollection(
  name,
  rows,
  primaryKey,
  uidBySqlId,
  accountBySqlId,
) {
  for (let start = 0; start < rows.length; start += 400) {
    const batch = db.batch();
    rows.slice(start, start + 400).forEach((row) => {
      const data = { ...row };
      if (["customers", "staff"].includes(name) && data.user_id != null) {
        const sqlUserId = String(data.user_id);
        data.user_id = uidBySqlId.get(sqlUserId) || null;
        if (data.user_id) data.uid = data.user_id;
        const account = accountBySqlId.get(sqlUserId);
        if (account) {
          data.username = account.username;
          data.account_status = account.account_status;
        }
      }
      if (name === "notifications") {
        data.recipient_id = String(data.recipient_id);
      }
      const documentId =
        name === "receipts"
          ? String(row.transaction_id)
          : String(row[primaryKey]);
      if (name === "staff_roles") {
        data.permissions = String(data.permissions || "")
          .split(",")
          .map((permission) => permission.trim())
          .filter(Boolean);
      }
      if (Object.hasOwn(data, "is_active")) {
        data.is_active = Boolean(Number(data.is_active));
      }
      batch.set(db.collection(name).doc(documentId), data, {
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
      customer_id: customer ? String(customer.customer_id) : null,
      staff_id: staffMember ? String(staffMember.staff_id) : null,
      role_id: staffMember ? String(staffMember.role_id) : null,
      role_name: role?.role_name || null,
      permissions: String(role?.permissions || "")
        .split(",")
        .map((permission) => permission.trim())
        .filter(Boolean),
      first_name: customer?.first_name || staffMember?.first_name || "",
      last_name: customer?.last_name || staffMember?.last_name || "",
      created_at: row.created_at,
    };
  });
  const accountBySqlId = new Map(
    users.map((row) => [
      String(row.user_id),
      {
        username: row.username,
        account_status: row.account_status,
      },
    ]),
  );
  for (let start = 0; start < profiles.length; start += 400) {
    const batch = db.batch();
    profiles.slice(start, start + 400).forEach((profile) => {
      batch.set(db.collection("users").doc(profile.uid), profile, {
        merge: true,
      });
    });
    await batch.commit();
  }
  return { uidBySqlId, accountBySqlId };
}

async function rebuildOperationalIndexes() {
  const [spaces, reservations, maintenance, types, walkins] = await Promise.all(
    [
      db.collection("study_spaces").get(),
      db.collection("reservations").get(),
      db.collection("space_maintenance").get(),
      db.collection("space_types").get(),
      db.collection("walkin_queue").get(),
    ],
  );
  const reservationsBySpace = new Map();
  reservations.docs.forEach((snapshot) => {
    const item = snapshot.data();
    if (!["pending", "confirmed"].includes(item.status)) return;
    const key = String(item.space_id);
    const list = reservationsBySpace.get(key) || [];
    list.push({
      reservation_id: snapshot.id,
      customer_id: String(item.customer_id),
      reservation_date: item.reservation_date,
      start_time: item.start_time,
      end_time: item.end_time,
      status: item.status,
    });
    reservationsBySpace.set(key, list);
  });
  const maintenanceBySpace = new Map();
  maintenance.docs.forEach((snapshot) => {
    const item = snapshot.data();
    if (!["scheduled", "active"].includes(item.status)) return;
    const key = String(item.space_id);
    const list = maintenanceBySpace.get(key) || [];
    list.push({
      maintenance_id: snapshot.id,
      start_datetime: item.start_datetime,
      end_datetime: item.end_datetime,
      status: item.status,
    });
    maintenanceBySpace.set(key, list);
  });
  const walkinsByType = new Map();
  walkins.docs.forEach((snapshot) => {
    const item = snapshot.data();
    if (item.status !== "waiting") return;
    const key = String(item.space_type_id);
    const list = walkinsByType.get(key) || [];
    list.push({
      queue_id: snapshot.id,
      customer_id: String(item.customer_id),
      queued_at: item.queued_at,
    });
    walkinsByType.set(key, list);
  });
  walkinsByType.forEach((list) =>
    list.sort((left, right) =>
      String(left.queued_at).localeCompare(String(right.queued_at)),
    ),
  );

  const writes = [
    ...spaces.docs.map((snapshot) => ({
      ref: snapshot.ref,
      data: {
        reservation_windows: reservationsBySpace.get(snapshot.id) || [],
        maintenance_windows: maintenanceBySpace.get(snapshot.id) || [],
      },
    })),
    ...types.docs.map((snapshot) => ({
      ref: snapshot.ref,
      data: { waiting_walkins: walkinsByType.get(snapshot.id) || [] },
    })),
  ];
  for (let start = 0; start < writes.length; start += 400) {
    const batch = db.batch();
    writes
      .slice(start, start + 400)
      .forEach(({ ref, data }) => batch.set(ref, data, { merge: true }));
    await batch.commit();
  }

  const payments = await db.collection("payments").get();
  const paymentTotals = new Map();
  payments.docs.forEach((snapshot) => {
    const payment = snapshot.data();
    const key = String(payment.transaction_id);
    const totals = paymentTotals.get(key) || { pending: 0, verified: 0 };
    if (payment.payment_status === "pending")
      totals.pending += Number(payment.amount_paid || 0);
    if (payment.payment_status === "verified")
      totals.verified += Number(payment.amount_paid || 0);
    paymentTotals.set(key, totals);
  });
  const bills = await db.collection("billing_transactions").get();
  const sourceLocks = [];
  for (let start = 0; start < bills.docs.length; start += 400) {
    const batch = db.batch();
    bills.docs.slice(start, start + 400).forEach((snapshot) => {
      const totals = paymentTotals.get(snapshot.id) || {
        pending: 0,
        verified: 0,
      };
      batch.set(
        snapshot.ref,
        { pending_amount: totals.pending, verified_amount: totals.verified },
        { merge: true },
      );
      const bill = snapshot.data();
      if (bill.session_id)
        sourceLocks.push({
          collection: "space_sessions",
          id: String(bill.session_id),
          billId: snapshot.id,
        });
      if (bill.order_id)
        sourceLocks.push({
          collection: "orders",
          id: String(bill.order_id),
          billId: snapshot.id,
        });
    });
    await batch.commit();
  }
  for (let start = 0; start < sourceLocks.length; start += 400) {
    const batch = db.batch();
    sourceLocks.slice(start, start + 400).forEach((lock) => {
      batch.set(
        db.collection(lock.collection).doc(lock.id),
        { billing_transaction_id: lock.billId },
        { merge: true },
      );
    });
    await batch.commit();
  }
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
    const { uidBySqlId, accountBySqlId } = await importAccounts(
      connection,
      customers,
      staff,
      roles,
    );
    for (const [table, primaryKey] of Object.entries(tables)) {
      const records = await queryTable(connection, table);
      await writeCollection(
        table,
        records,
        primaryKey,
        uidBySqlId,
        accountBySqlId,
      );
      console.log(`Imported ${records.length} ${table} record(s).`);
    }
    await rebuildOperationalIndexes();
    console.log(
      "Rebuilt reservation, maintenance, walk-in, and payment indexes.",
    );
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
