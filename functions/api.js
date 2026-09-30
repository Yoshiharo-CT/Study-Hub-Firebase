const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const db = getFirestore();
const auth = getAuth();

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const fail = (message, status) => {
  throw new ApiError(message, status);
};
const now = () => new Date().toISOString();
const idOf = (value) => String(value ?? "");
const text = (value) => String(value ?? "").trim();
const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const time = (value) => Date.parse(value) || 0;

async function getDoc(collection, id) {
  const snapshot = await db.collection(collection).doc(idOf(id)).get();
  return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null;
}

async function rows(collection, idField) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((doc) => ({ [idField]: doc.id, ...doc.data() }));
}

async function create(collection, idField, data) {
  const ref = db.collection(collection).doc();
  await ref.set({ ...data, created_at: data.created_at || now() });
  return { id: ref.id, [idField]: ref.id };
}

async function requireUser(request) {
  const match = /^Bearer (.+)$/i.exec(request.get("authorization") || "");
  if (!match) fail("Login required.", 401);
  let token;
  try {
    token = await auth.verifyIdToken(match[1]);
  } catch {
    fail("Login required.", 401);
  }
  const profile = await getDoc("users", token.uid);
  if (!profile || profile.account_status !== "active")
    fail("This account is inactive or unavailable.", 403);
  return { ...profile, uid: token.uid };
}

function requireStaff(user) {
  if (user.account_type !== "staff") fail("Staff login required.", 403);
}

function requirePermission(user, permission) {
  requireStaff(user);
  const permissions = Array.isArray(user.permissions)
    ? user.permissions
    : String(user.permissions || "")
        .split(",")
        .map((item) => item.trim());
  if (!permissions.includes(permission))
    fail("You do not have permission to do that.", 403);
}

async function audit(user, action, table, id, details) {
  const name =
    `${user?.first_name || "System"} ${user?.last_name || ""}`.trim();
  await create("audit_log", "audit_id", {
    user_id: user?.uid || null,
    actor_label: `${name} (${user?.account_type || "system"})`,
    action,
    table_name: table,
    record_id: id == null ? null : String(id),
    details: details || "",
    created_at: now(),
  });
}

async function notify(type, recipientId, message) {
  return create("notifications", "notification_id", {
    recipient_type: type,
    recipient_id: String(recipientId),
    message,
    is_read: false,
    created_at: now(),
  });
}

async function notifyAllStaff(message) {
  const staff = await rows("staff", "staff_id");
  await Promise.all(
    staff.map((member) => notify("staff", member.staff_id, message)),
  );
}

async function authOperation(operation, input) {
  if (operation === "resolveLogin") {
    const identifier = text(input.identifier).toLowerCase();
    if (!identifier) fail("Enter your username/email/phone and password.");
    const accounts = await rows("users", "uid");
    const account = accounts.find((row) =>
      [row.username, row.email, row.phone_number]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === identifier),
    );
    if (!account || account.account_status !== "active" || !account.email) {
      fail("Incorrect username/email/phone or password.", 401);
    }
    return { success: true, email: account.email };
  }

  if (operation === "memberRegister") {
    const first = text(input.first_name),
      last = text(input.last_name);
    const phone = text(input.phone_number),
      email = text(input.email).toLowerCase();
    const password = String(input.password || "");
    if (!first || !last || !phone || !email || password.length < 6) {
      fail("Fill in all fields (password must be at least 6 characters).");
    }
    const customers = await rows("customers", "customer_id");
    if (
      customers.some(
        (item) =>
          item.email?.toLowerCase() === email || item.phone_number === phone,
      )
    ) {
      fail("An account with that email or phone number already exists.");
    }
    let createdUser;
    try {
      createdUser = await auth.createUser({
        email,
        password,
        displayName: `${first} ${last}`,
      });
      const customerRef = db.collection("customers").doc();
      const customerId = customerRef.id;
      const batch = db.batch();
      batch.set(customerRef, {
        customer_id: customerId,
        user_id: createdUser.uid,
        uid: createdUser.uid,
        first_name: first,
        last_name: last,
        phone_number: phone,
        email,
        created_at: now(),
      });
      batch.set(db.collection("users").doc(createdUser.uid), {
        uid: createdUser.uid,
        account_type: "customer",
        account_status: "active",
        username: email,
        email,
        phone_number: phone,
        customer_id: customerId,
        first_name: first,
        last_name: last,
        created_at: now(),
      });
      await batch.commit();
      return {
        success: true,
        message: "Account created.",
        customer_id: customerId,
        username: email,
      };
    } catch (error) {
      if (createdUser) await auth.deleteUser(createdUser.uid).catch(() => {});
      throw error;
    }
  }

  if (operation === "me") {
    const user = await requireUser(input.request);
    if (user.account_type === "staff") {
      const staff = await getDoc("staff", user.staff_id);
      if (!staff) fail("Staff record not found for this account.", 404);
      return {
        success: true,
        account_type: "staff",
        staff: {
          ...staff,
          permissions: user.permissions || staff.permissions,
          role_name: user.role_name || staff.role_name,
        },
      };
    }
    const customer = await getDoc("customers", user.customer_id);
    return {
      success: true,
      account_type: "customer",
      customer: customer
        ? { ...customer, user_id: customer.uid || customer.user_id }
        : null,
    };
  }
  fail("Unknown operation.", 400);
}

async function staffAndCustomer(group, operation, input, user) {
  requireStaff(user);
  if (group === "customers") {
    const customers = await rows("customers", "customer_id");
    if (operation === "list") {
      const users = await rows("users", "uid");
      return customers.map((customer) => {
        const account = users.find((row) => row.uid === customer.user_id);
        return {
          ...customer,
          username: account?.username || null,
          account_status: account?.account_status || null,
        };
      });
    }
    if (operation === "get")
      return await getDoc("customers", input.customer_id);
    if (operation === "add") {
      requirePermission(user, "customers");
      const first = text(input.first_name),
        last = text(input.last_name);
      const phone = text(input.phone_number),
        email = text(input.email).toLowerCase();
      if (!first || !last || !phone || !email) fail("All fields are required.");
      if (
        customers.some(
          (item) =>
            item.email?.toLowerCase() === email || item.phone_number === phone,
        )
      )
        fail("A customer with that email or phone already exists.");
      const result = await create("customers", "customer_id", {
        first_name: first,
        last_name: last,
        phone_number: phone,
        email,
      });
      await audit(
        user,
        "create",
        "customers",
        result.id,
        `Added customer ${first} ${last}`,
      );
      return { customer_id: result.id };
    }
  }

  if (group === "staff") {
    if (operation === "list") {
      const [members, roles, users] = await Promise.all([
        rows("staff", "staff_id"),
        rows("staff_roles", "role_id"),
        rows("users", "uid"),
      ]);
      return members.map((member) => {
        const role = roles.find(
          (item) => String(item.role_id) === String(member.role_id),
        );
        const account = users.find((item) => item.uid === member.user_id);
        return {
          ...member,
          role_name: role?.role_name || member.role_name,
          username: account?.username,
          account_status: account?.account_status,
        };
      });
    }
    if (operation === "roles")
      return (await rows("staff_roles", "role_id"))
        .filter((role) => role.is_active !== false)
        .sort((a, b) => a.role_name.localeCompare(b.role_name));
    if (operation === "add") {
      requirePermission(user, "staff");
      const first = text(input.first_name),
        last = text(input.last_name);
      const phone = text(input.phone_number),
        username = text(input.username).toLowerCase();
      const password = String(input.password || ""),
        role = await getDoc("staff_roles", input.role_id);
      if (
        !first ||
        !last ||
        !phone ||
        !username ||
        password.length < 6 ||
        !role
      )
        fail("Fill in all fields (password must be at least 6 characters).");
      const email = `${username}@study-hub-bf7e1.firebaseapp.com`;
      const createdUser = await auth.createUser({
        email,
        password,
        displayName: `${first} ${last}`,
      });
      try {
        const staffRef = db.collection("staff").doc(),
          staffId = staffRef.id;
        const batch = db.batch();
        batch.set(staffRef, {
          staff_id: staffId,
          user_id: createdUser.uid,
          uid: createdUser.uid,
          role_id: String(input.role_id),
          role_name: role.role_name,
          first_name: first,
          last_name: last,
          phone_number: phone,
        });
        batch.set(db.collection("users").doc(createdUser.uid), {
          uid: createdUser.uid,
          account_type: "staff",
          account_status: "active",
          username,
          email,
          phone_number: phone,
          staff_id: staffId,
          role_id: String(input.role_id),
          role_name: role.role_name,
          permissions: role.permissions,
          first_name: first,
          last_name: last,
          created_at: now(),
        });
        await batch.commit();
        await audit(
          user,
          "create",
          "staff",
          staffId,
          `Added staff ${first} ${last}`,
        );
        return { staff_id: staffId };
      } catch (error) {
        await auth.deleteUser(createdUser.uid).catch(() => {});
        throw error;
      }
    }
    if (operation === "setStatus") {
      requirePermission(user, "staff");
      const status = text(input.account_status);
      if (!["active", "inactive", "suspended"].includes(status))
        fail("Invalid status.");
      const member = await getDoc("staff", input.staff_id);
      if (!member?.user_id) fail("Staff account not found.");
      await db
        .collection("users")
        .doc(member.user_id)
        .update({ account_status: status });
      await auth.updateUser(member.user_id, { disabled: status !== "active" });
      await audit(
        user,
        "update",
        "users",
        member.user_id,
        `Set staff #${input.staff_id} status to ${status}`,
      );
      return {};
    }
  }
  fail("Unknown operation.", 400);
}

async function spaces(operation, input, user) {
  requireStaff(user);
  if (operation === "listTypes")
    return (await rows("space_types", "space_type_id")).sort(
      (a, b) => number(a.base_rate) - number(b.base_rate),
    );
  if (operation === "listSpaces") {
    const [list, types] = await Promise.all([
      rows("study_spaces", "space_id"),
      rows("space_types", "space_type_id"),
    ]);
    return list
      .filter(
        (space) =>
          (!input.space_type_id ||
            String(space.space_type_id) === String(input.space_type_id)) &&
          (!input.status || space.status === input.status) &&
          (!input.capacity || number(space.capacity) >= number(input.capacity)),
      )
      .map((space) => ({
        ...space,
        ...(types.find(
          (type) => String(type.space_type_id) === String(space.space_type_id),
        ) || {}),
      }))
      .sort((a, b) => String(a.space_name).localeCompare(String(b.space_name)));
  }
  if (operation === "checkAvailability") {
    const date = text(input.date),
      start = text(input.start_time),
      end = text(input.end_time);
    if (!date || !start || !end)
      fail("Date, start time, and end time are required.");
    const [list, types, reservations, maintenance] = await Promise.all([
      rows("study_spaces", "space_id"),
      rows("space_types", "space_type_id"),
      rows("reservations", "reservation_id"),
      rows("space_maintenance", "maintenance_id"),
    ]);
    const from = time(`${date}T${start}`),
      to = time(`${date}T${end}`);
    return list
      .filter(
        (space) =>
          !["maintenance", "inactive"].includes(space.status) &&
          !reservations.some(
            (item) =>
              String(item.space_id) === String(space.space_id) &&
              item.reservation_date === date &&
              ["pending", "confirmed"].includes(item.status) &&
              item.start_time < end &&
              item.end_time > start,
          ) &&
          !maintenance.some(
            (item) =>
              String(item.space_id) === String(space.space_id) &&
              ["scheduled", "active"].includes(item.status) &&
              time(item.end_datetime) > from &&
              time(item.start_datetime) < to,
          ),
      )
      .map((space) => ({
        ...space,
        ...(types.find(
          (type) => String(type.space_type_id) === String(space.space_type_id),
        ) || {}),
      }));
  }
  if (operation === "addType") {
    requirePermission(user, "spaces");
    const name = text(input.type_name);
    if (!name) fail("Type name is required.");
    const result = await create("space_types", "space_type_id", {
      type_name: name,
      base_rate: number(input.base_rate),
      default_capacity: number(input.default_capacity, 1),
      description: text(input.description),
    });
    await audit(
      user,
      "create",
      "space_types",
      result.id,
      `Added space type ${name}`,
    );
    return {};
  }
  if (operation === "addSpace") {
    requirePermission(user, "spaces");
    const type = await getDoc("space_types", input.space_type_id),
      name = text(input.space_name);
    if (!type || !name) fail("Space type and name are required.");
    const result = await create("study_spaces", "space_id", {
      space_type_id: String(input.space_type_id),
      space_name: name,
      capacity: number(input.capacity, type.default_capacity),
      status: "available",
    });
    await audit(
      user,
      "create",
      "study_spaces",
      result.id,
      `Added space ${name}`,
    );
    return {};
  }
  if (operation === "updateStatus") {
    requirePermission(user, "spaces");
    if (
      ![
        "available",
        "occupied",
        "reserved",
        "maintenance",
        "inactive",
      ].includes(input.status)
    )
      fail("Invalid status.");
    await db
      .collection("study_spaces")
      .doc(idOf(input.space_id))
      .update({ status: input.status });
    await audit(
      user,
      "update",
      "study_spaces",
      input.space_id,
      `Status manually set to ${input.status}`,
    );
    return {};
  }
  if (operation === "scheduleMaintenance") {
    requirePermission(user, "spaces");
    if (
      !(await getDoc("study_spaces", input.space_id)) ||
      !input.start_datetime ||
      !input.end_datetime
    )
      fail("Space, start, and end are required.");
    const result = await create("space_maintenance", "maintenance_id", {
      space_id: String(input.space_id),
      start_datetime: input.start_datetime,
      end_datetime: input.end_datetime,
      reason: text(input.reason),
      created_by: user.staff_id,
      status: "scheduled",
    });
    if (
      time(input.start_datetime) <= Date.now() &&
      time(input.end_datetime) >= Date.now()
    )
      await db
        .collection("study_spaces")
        .doc(idOf(input.space_id))
        .update({ status: "maintenance" });
    await audit(
      user,
      "create",
      "space_maintenance",
      result.id,
      `Scheduled maintenance for space #${input.space_id}`,
    );
    return { maintenance_id: result.id };
  }
  if (operation === "listMaintenance") {
    const [list, allSpaces] = await Promise.all([
      rows("space_maintenance", "maintenance_id"),
      rows("study_spaces", "space_id"),
    ]);
    return list
      .map((item) => ({
        ...item,
        space_name:
          allSpaces.find(
            (space) => String(space.space_id) === String(item.space_id),
          )?.space_name || "",
      }))
      .sort((a, b) =>
        String(b.start_datetime).localeCompare(String(a.start_datetime)),
      );
  }
  if (operation === "completeMaintenance") {
    requirePermission(user, "spaces");
    const record = await getDoc("space_maintenance", input.maintenance_id);
    if (!record) fail("Maintenance record not found.", 404);
    const batch = db.batch();
    batch.update(
      db.collection("space_maintenance").doc(idOf(input.maintenance_id)),
      { status: "completed" },
    );
    batch.update(db.collection("study_spaces").doc(idOf(record.space_id)), {
      status: "available",
    });
    await batch.commit();
    await audit(
      user,
      "update",
      "space_maintenance",
      input.maintenance_id,
      "Maintenance completed, space freed",
    );
    return {};
  }
  fail("Unknown operation.", 400);
}

async function reservations(operation, input, user) {
  requireStaff(user);
  if (operation === "list") {
    const [list, customers, locations, types] = await Promise.all([
      rows("reservations", "reservation_id"),
      rows("customers", "customer_id"),
      rows("study_spaces", "space_id"),
      rows("space_types", "space_type_id"),
    ]);
    return list
      .filter((item) => !input.status || item.status === input.status)
      .map((item) => {
        const customer = customers.find(
          (row) => String(row.customer_id) === String(item.customer_id),
        );
        const space = locations.find(
          (row) => String(row.space_id) === String(item.space_id),
        );
        const type = types.find(
          (row) => String(row.space_type_id) === String(space?.space_type_id),
        );
        return {
          ...item,
          customer_name: customer
            ? `${customer.first_name} ${customer.last_name}`
            : "",
          space_name: space?.space_name || "",
          space_type: type?.type_name || "",
        };
      })
      .sort((a, b) =>
        `${b.reservation_date} ${b.start_time}`.localeCompare(
          `${a.reservation_date} ${a.start_time}`,
        ),
      );
  }
  if (operation === "create") {
    requirePermission(user, "reservations");
    const customer = await getDoc("customers", input.customer_id),
      space = await getDoc("study_spaces", input.space_id);
    const date = text(input.reservation_date),
      start = text(input.start_time),
      end = text(input.end_time),
      people = number(input.number_of_people, 1);
    if (!customer || !space || !date || !start || !end)
      fail("All reservation fields are required.");
    if (end <= start) fail("End time must be after start time.");
    if (people <= 0) fail("Number of people must be greater than zero.");
    if (["maintenance", "inactive"].includes(space.status))
      fail(`That space is not bookable right now (${space.status}).`);
    if (people > number(space.capacity))
      fail(`That space only fits ${space.capacity} people.`);
    const spaceRef = db.collection("study_spaces").doc(idOf(input.space_id));
    const reservationRef = db.collection("reservations").doc();
    await db.runTransaction(async (transaction) => {
      const [lockedSpace, existing, maintenance] = await Promise.all([
        transaction.get(spaceRef),
        transaction.get(db.collection("reservations")),
        transaction.get(db.collection("space_maintenance")),
      ]);
      if (!lockedSpace.exists) fail("Space not found.", 404);
      if (
        existing.docs.some((doc) => {
          const item = doc.data();
          return (
            String(item.space_id) === String(input.space_id) &&
            item.reservation_date === date &&
            ["pending", "confirmed"].includes(item.status) &&
            item.start_time < end &&
            item.end_time > start
          );
        })
      )
        fail("That space is already booked for an overlapping time.");
      const from = time(`${date}T${start}`),
        to = time(`${date}T${end}`);
      if (
        maintenance.docs.some((doc) => {
          const item = doc.data();
          return (
            String(item.space_id) === String(input.space_id) &&
            ["scheduled", "active"].includes(item.status) &&
            time(item.end_datetime) > from &&
            time(item.start_datetime) < to
          );
        })
      )
        fail("That space is scheduled for maintenance during that window.");
      transaction.update(spaceRef, { reservation_lock_at: now() });
      transaction.set(reservationRef, {
        reservation_id: reservationRef.id,
        customer_id: String(input.customer_id),
        space_id: String(input.space_id),
        reservation_date: date,
        start_time: start,
        end_time: end,
        number_of_people: people,
        status: "pending",
        created_at: now(),
      });
    });
    await notifyAllStaff(
      `New reservation #${reservationRef.id} is pending review.`,
    );
    await audit(
      user,
      "create",
      "reservations",
      reservationRef.id,
      "Reservation created (pending)",
    );
    return { reservation_id: reservationRef.id };
  }
  if (["confirm", "cancel", "noShow"].includes(operation)) {
    requirePermission(user, "reservations");
    const id = idOf(input.reservation_id),
      record = await getDoc("reservations", id);
    if (!record) fail("Reservation not found.", 404);
    if (operation === "confirm" && record.status !== "pending")
      fail("Only pending reservations can be confirmed.");
    const status =
      operation === "confirm"
        ? "confirmed"
        : operation === "cancel"
          ? "cancelled"
          : "no_show";
    const batch = db.batch();
    batch.update(db.collection("reservations").doc(id), { status });
    batch.update(db.collection("study_spaces").doc(idOf(record.space_id)), {
      status: operation === "confirm" ? "reserved" : "available",
    });
    await batch.commit();
    if (operation !== "noShow")
      await notify(
        "customer",
        record.customer_id,
        operation === "confirm"
          ? `Your reservation #${id} has been confirmed.`
          : `Your reservation #${id} was cancelled.`,
      );
    await audit(
      user,
      "update",
      "reservations",
      id,
      `Reservation ${status.replace("_", " ")}`,
    );
    return {};
  }
  fail("Unknown operation.", 400);
}

async function otherOperations(group, operation, input, user) {
  if (group !== "notifications") requireStaff(user);
  if (group === "walkin") {
    if (operation === "list") {
      const [queue, customers, types] = await Promise.all([
        rows("walkin_queue", "queue_id"),
        rows("customers", "customer_id"),
        rows("space_types", "space_type_id"),
      ]);
      return queue
        .map((item) => ({
          ...item,
          customer_name: customers.find(
            (row) => String(row.customer_id) === String(item.customer_id),
          )
            ? `${customers.find((row) => String(row.customer_id) === String(item.customer_id)).first_name} ${customers.find((row) => String(row.customer_id) === String(item.customer_id)).last_name}`
            : "",
          type_name:
            types.find(
              (row) => String(row.space_type_id) === String(item.space_type_id),
            )?.type_name || "",
        }))
        .sort(
          (a, b) =>
            Number(b.status === "waiting") - Number(a.status === "waiting") ||
            String(a.queued_at).localeCompare(String(b.queued_at)),
        );
    }
    if (operation === "add") {
      requirePermission(user, "walkins");
      if (
        !(await getDoc("customers", input.customer_id)) ||
        !(await getDoc("space_types", input.space_type_id))
      )
        fail("Customer and desired space type are required.");
      const result = await create("walkin_queue", "queue_id", {
        customer_id: String(input.customer_id),
        space_type_id: String(input.space_type_id),
        status: "waiting",
        queued_at: now(),
      });
      await audit(
        user,
        "create",
        "walkin_queue",
        result.id,
        "Added to walk-in queue",
      );
      return { queue_id: result.id };
    }
    if (operation === "cancel") {
      requirePermission(user, "walkins");
      const ref = db.collection("walkin_queue").doc(idOf(input.queue_id));
      const entry = await getDoc("walkin_queue", input.queue_id);
      if (entry?.status === "waiting")
        await ref.update({ status: "cancelled" });
      await audit(
        user,
        "update",
        "walkin_queue",
        input.queue_id,
        "Removed from queue",
      );
      return {};
    }
  }

  if (group === "sessions") {
    const [sessions, customers, spacesList, types, reservationsList] =
      await Promise.all([
        rows("space_sessions", "session_id"),
        rows("customers", "customer_id"),
        rows("study_spaces", "space_id"),
        rows("space_types", "space_type_id"),
        rows("reservations", "reservation_id"),
      ]);
    if (operation === "listActive" || operation === "list") {
      return sessions
        .filter((session) => operation === "list" || !session.check_out_time)
        .map((session) => {
          const customer = customers.find(
            (row) => String(row.customer_id) === String(session.customer_id),
          );
          const space = spacesList.find(
            (row) => String(row.space_id) === String(session.space_id),
          );
          const type = types.find(
            (row) => String(row.space_type_id) === String(space?.space_type_id),
          );
          const reservation = reservationsList.find(
            (row) =>
              String(row.reservation_id) === String(session.reservation_id),
          );
          const fee = session.check_out_time
            ? number(session.study_fee)
            : Math.max(
                (Date.now() - time(session.check_in_time)) / 3600000,
                0,
              ) * number(type?.base_rate);
          return {
            ...session,
            customer_name: customer
              ? `${customer.first_name} ${customer.last_name}`
              : "",
            space_name: space?.space_name || "",
            base_rate: type?.base_rate || 0,
            reservation_date: reservation?.reservation_date || null,
            fee_so_far: Number(fee.toFixed(2)),
            study_fee: session.study_fee || fee,
          };
        })
        .sort((a, b) =>
          String(a.check_in_time).localeCompare(String(b.check_in_time)),
        );
    }
    if (operation === "checkInReservation") {
      const today = new Date().toISOString().slice(0, 10),
        current = new Date().toTimeString().slice(0, 8);
      const match = reservationsList.find(
        (item) =>
          String(item.customer_id) === String(input.customer_id) &&
          String(item.space_id) === String(input.space_id) &&
          item.status === "confirmed" &&
          item.reservation_date === today &&
          item.start_time <= current &&
          item.end_time >= current,
      );
      return match?.reservation_id || null;
    }
    if (operation === "checkIn") {
      requirePermission(user, "sessions");
      const customer = await getDoc("customers", input.customer_id);
      const spaceRef = db.collection("study_spaces").doc(idOf(input.space_id));
      const sessionRef = db.collection("space_sessions").doc();
      if (!customer) fail("Customer and space are required.");
      const wifi = `SH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await db.runTransaction(async (transaction) => {
        const space = await transaction.get(spaceRef);
        const allReservations = await transaction.get(
          db.collection("reservations"),
        );
        if (!space.exists) fail("Space not found.", 404);
        const details = space.data();
        if (!["available", "reserved"].includes(details.status))
          fail(`That space is currently ${details.status}.`);
        const today = new Date().toISOString().slice(0, 10),
          current = new Date().toTimeString().slice(0, 8);
        const reservation = allReservations.docs.find((doc) => {
          const item = doc.data();
          return (
            String(item.customer_id) === String(input.customer_id) &&
            String(item.space_id) === String(input.space_id) &&
            item.status === "confirmed" &&
            item.reservation_date === today &&
            item.start_time <= current &&
            item.end_time >= current
          );
        });
        transaction.set(sessionRef, {
          session_id: sessionRef.id,
          customer_id: String(input.customer_id),
          space_id: String(input.space_id),
          reservation_id: reservation?.id || null,
          check_in_time: now(),
          wifi_password: wifi,
          check_out_time: null,
          study_fee: 0,
        });
        transaction.update(spaceRef, { status: "occupied" });
        if (reservation)
          transaction.update(reservation.ref, { status: "completed" });
      });
      await audit(
        user,
        "create",
        "space_sessions",
        sessionRef.id,
        `Checked in customer #${input.customer_id} to space #${input.space_id}`,
      );
      return { session_id: sessionRef.id, wifi_password: wifi };
    }
    if (operation === "extendSession") {
      requirePermission(user, "sessions");
      const session = await getDoc("space_sessions", input.session_id);
      if (!session || session.check_out_time) fail("Active session not found.");
      const space = await getDoc("study_spaces", session.space_id),
        type = await getDoc("space_types", space?.space_type_id);
      const minutes = Math.max(1, number(input.extra_minutes, 60)),
        amount = Number(((minutes / 60) * number(type?.base_rate)).toFixed(2));
      const start = now(),
        end = new Date(Date.now() + minutes * 60000).toISOString();
      const result = await create("session_extensions", "extension_id", {
        session_id: String(input.session_id),
        extension_start: start,
        extension_end: end,
        additional_amount: amount,
      });
      await audit(
        user,
        "create",
        "session_extensions",
        result.id,
        `Extended session #${input.session_id} by ${minutes} min (+${amount})`,
      );
      return { additional_amount: amount };
    }
    if (operation === "checkOut") {
      requirePermission(user, "sessions");
      const sessionRef = db
        .collection("space_sessions")
        .doc(idOf(input.session_id));
      const session = await getDoc("space_sessions", input.session_id);
      if (!session) fail("Session not found.", 404);
      if (session.check_out_time) fail("Session already checked out.");
      const space = await getDoc("study_spaces", session.space_id),
        type = await getDoc("space_types", space?.space_type_id);
      const fee = Number(
        (
          Math.max((Date.now() - time(session.check_in_time)) / 3600000, 0) *
          number(type?.base_rate)
        ).toFixed(2),
      );
      const queue = await rows("walkin_queue", "queue_id");
      const next = queue
        .filter(
          (item) =>
            item.status === "waiting" &&
            String(item.space_type_id) === String(space?.space_type_id),
        )
        .sort((a, b) =>
          String(a.queued_at).localeCompare(String(b.queued_at)),
        )[0];
      const batch = db.batch();
      batch.update(sessionRef, { check_out_time: now(), study_fee: fee });
      batch.update(db.collection("study_spaces").doc(idOf(session.space_id)), {
        status: next ? "occupied" : "available",
      });
      if (next) {
        batch.update(db.collection("walkin_queue").doc(idOf(next.queue_id)), {
          status: "served",
          served_at: now(),
        });
        const newSession = db.collection("space_sessions").doc();
        batch.set(newSession, {
          session_id: newSession.id,
          customer_id: String(next.customer_id),
          space_id: String(session.space_id),
          reservation_id: null,
          check_in_time: now(),
          wifi_password: `SH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          check_out_time: null,
          study_fee: 0,
        });
      }
      await batch.commit();
      if (next)
        await notify(
          "customer",
          next.customer_id,
          "A space just opened up for you — please check in at the front desk.",
        );
      await audit(
        user,
        "update",
        "space_sessions",
        input.session_id,
        `Checked out, study_fee=${fee}`,
      );
      return { study_fee: fee };
    }
  }

  if (group === "products") {
    const lists = {
      listCategories: ["product_categories", "category_id"],
      listProducts: ["products_services", "product_id"],
      listPaperSizes: ["paper_sizes", "paper_size_id"],
      listPrintTypes: ["print_types", "print_type_id"],
    };
    if (lists[operation]) {
      const [table, key] = lists[operation];
      const records = await rows(table, key);
      if (operation === "listProducts") {
        const categories = await rows("product_categories", "category_id");
        return records
          .filter(
            (item) =>
              !input.category_id ||
              String(item.category_id) === String(input.category_id),
          )
          .map((item) => ({
            ...item,
            category_name:
              categories.find(
                (category) =>
                  String(category.category_id) === String(item.category_id),
              )?.category_name || "",
          }));
      }
      return records
        .filter((item) => item.is_active !== false)
        .sort((a, b) =>
          String(a.category_name || a.size_name || a.label || "").localeCompare(
            String(b.category_name || b.size_name || b.label || ""),
          ),
        );
    }
    requirePermission(user, "spaces");
    if (operation === "addCategory") {
      const name = text(input.category_name);
      if (!name) fail("Category name is required.");
      const result = await create("product_categories", "category_id", {
        category_name: name,
        description: text(input.description),
        is_active: true,
      });
      await audit(
        user,
        "create",
        "product_categories",
        result.id,
        `Added category ${name}`,
      );
      return {};
    }
    if (operation === "addProduct") {
      const category = await getDoc("product_categories", input.category_id),
        name = text(input.item_name);
      if (!category || !name) fail("Category and item name are required.");
      const result = await create("products_services", "product_id", {
        category_id: String(input.category_id),
        item_name: name,
        unit_price: number(input.unit_price),
        stock_quantity: number(input.stock_quantity),
      });
      await audit(
        user,
        "create",
        "products_services",
        result.id,
        `Added product ${name}`,
      );
      return {};
    }
  }

  if (group === "orders") {
    const [ordersList, customers, staffList] = await Promise.all([
      rows("orders", "order_id"),
      rows("customers", "customer_id"),
      rows("staff", "staff_id"),
    ]);
    if (operation === "list")
      return ordersList
        .map((order) => ({
          ...order,
          customer_name: customers.find(
            (item) => String(item.customer_id) === String(order.customer_id),
          )
            ? `${customers.find((item) => String(item.customer_id) === String(order.customer_id)).first_name} ${customers.find((item) => String(item.customer_id) === String(order.customer_id)).last_name}`
            : "",
          staff_name: staffList.find(
            (item) => String(item.staff_id) === String(order.staff_id),
          )
            ? `${staffList.find((item) => String(item.staff_id) === String(order.staff_id)).first_name} ${staffList.find((item) => String(item.staff_id) === String(order.staff_id)).last_name}`
            : "",
        }))
        .sort((a, b) =>
          String(b.order_datetime).localeCompare(String(a.order_datetime)),
        );
    if (operation === "activeSession") {
      const active = (await rows("space_sessions", "session_id"))
        .filter(
          (item) =>
            String(item.customer_id) === String(input.customer_id) &&
            !item.check_out_time,
        )
        .sort((a, b) =>
          String(b.check_in_time).localeCompare(String(a.check_in_time)),
        )[0];
      const location =
        active && (await getDoc("study_spaces", active.space_id));
      return active
        ? {
            session_id: active.session_id,
            check_in_time: active.check_in_time,
            space_name: location?.space_name || "",
          }
        : null;
    }
    if (operation === "getItems") {
      const [items, products, jobs, sizes, printTypes] = await Promise.all([
        rows("order_items", "order_item_id"),
        rows("products_services", "product_id"),
        rows("printing_jobs", "printing_job_id"),
        rows("paper_sizes", "paper_size_id"),
        rows("print_types", "print_type_id"),
      ]);
      return items
        .filter((item) => String(item.order_id) === String(input.order_id))
        .map((item) => {
          const job = jobs.find(
            (row) => String(row.order_item_id) === String(item.order_item_id),
          );
          return {
            ...item,
            item_name:
              products.find(
                (row) => String(row.product_id) === String(item.product_id),
              )?.item_name || "",
            ...(job
              ? {
                  ...job,
                  size_name: sizes.find(
                    (row) =>
                      String(row.paper_size_id) === String(job.paper_size_id),
                  )?.size_name,
                  print_label: printTypes.find(
                    (row) =>
                      String(row.print_type_id) === String(job.print_type_id),
                  )?.label,
                }
              : {}),
          };
        });
    }
    if (operation === "create") {
      requirePermission(user, "orders");
      let items = input.items;
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch {
          items = null;
        }
      }
      if (
        !(await getDoc("customers", input.customer_id)) ||
        !(await getDoc("staff", input.staff_id)) ||
        !Array.isArray(items) ||
        !items.length
      )
        fail("Customer, staff, and at least one item are required.");
      const orderRef = db.collection("orders").doc(),
        orderItems = items.map(() => db.collection("order_items").doc());
      const productsRefs = items.map((item) =>
        db.collection("products_services").doc(idOf(item.product_id)),
      );
      let total = 0;
      await db.runTransaction(async (transaction) => {
        const productSnapshots = await Promise.all(
          productsRefs.map((ref) => transaction.get(ref)),
        );
        const active = (
          await transaction.get(db.collection("space_sessions"))
        ).docs.find(
          (doc) =>
            String(doc.data().customer_id) === String(input.customer_id) &&
            !doc.data().check_out_time,
        );
        const stockDeductions = new Map();
        const rowsForItems = items.map((item, index) => {
          const product = productSnapshots[index].data(),
            quantity = Math.max(1, number(item.quantity, 1));
          if (!product) fail(`Product #${item.product_id} not found.`);
          const deduction =
            (stockDeductions.get(String(item.product_id))?.quantity || 0) +
            quantity;
          if (number(product.stock_quantity) < deduction)
            fail(`Not enough stock for ${product.item_name}.`);
          stockDeductions.set(String(item.product_id), {
            quantity: deduction,
            product,
          });
          const subtotal = Number(
            (number(product.unit_price) * quantity).toFixed(2),
          );
          total += subtotal;
          return { product, quantity, subtotal };
        });
        transaction.set(orderRef, {
          order_id: orderRef.id,
          customer_id: String(input.customer_id),
          staff_id: String(input.staff_id),
          session_id: active?.id || null,
          order_datetime: now(),
          total_amount: total,
        });
        rowsForItems.forEach((item, index) => {
          const itemRef = orderItems[index];
          transaction.set(itemRef, {
            order_item_id: itemRef.id,
            order_id: orderRef.id,
            product_id: String(items[index].product_id),
            quantity: item.quantity,
            subtotal: item.subtotal,
          });
          if (items[index].printing) {
            const printRef = db.collection("printing_jobs").doc();
            const printing = items[index].printing;
            transaction.set(printRef, {
              printing_job_id: printRef.id,
              order_item_id: itemRef.id,
              paper_size_id: String(printing.paper_size_id || ""),
              print_type_id: String(printing.print_type_id || ""),
              page_count: number(printing.page_count, 1),
            });
          }
        });
        stockDeductions.forEach(({ quantity, product }, productId) => {
          transaction.update(
            db.collection("products_services").doc(productId),
            { stock_quantity: number(product.stock_quantity) - quantity },
          );
        });
      });
      await audit(
        user,
        "create",
        "orders",
        orderRef.id,
        `Order placed, total ${total}`,
      );
      return { order_id: orderRef.id, total_amount: total };
    }
  }

  if (group === "promotions") {
    const promos = await rows("promotions", "promotion_id"),
      today = now().slice(0, 10);
    if (operation === "list")
      return promos.sort((a, b) =>
        String(b.valid_to).localeCompare(String(a.valid_to)),
      );
    if (operation === "validate") {
      const promo = promos.find(
        (item) =>
          item.code === text(input.code).toUpperCase() &&
          item.is_active !== false &&
          item.valid_from <= today &&
          item.valid_to >= today,
      );
      if (!promo) fail("That promo code is invalid, expired, or inactive.");
      return promo;
    }
    if (operation === "add") {
      requirePermission(user, "promotions");
      const code = text(input.code).toUpperCase();
      if (!code || !input.valid_from || !input.valid_to)
        fail("Code, valid_from, and valid_to are required.");
      const result = await create("promotions", "promotion_id", {
        code,
        description: text(input.description),
        discount_type: input.discount_type || "percent",
        discount_value: number(input.discount_value),
        valid_from: input.valid_from,
        valid_to: input.valid_to,
        is_active: true,
      });
      await audit(
        user,
        "create",
        "promotions",
        result.id,
        `Added promo ${code}`,
      );
      return {};
    }
    if (operation === "deactivateExpired") {
      requirePermission(user, "promotions");
      const expired = promos.filter(
        (item) => item.is_active !== false && item.valid_to < today,
      );
      const batch = db.batch();
      expired.forEach((item) =>
        batch.update(db.collection("promotions").doc(idOf(item.promotion_id)), {
          is_active: false,
        }),
      );
      if (expired.length) await batch.commit();
      return { deactivated: expired.length };
    }
  }

  if (group === "billing") {
    const [transactions, customers, ordersList, sessionsList, promotions] =
      await Promise.all([
        rows("billing_transactions", "transaction_id"),
        rows("customers", "customer_id"),
        rows("orders", "order_id"),
        rows("space_sessions", "session_id"),
        rows("promotions", "promotion_id"),
      ]);
    if (operation === "list")
      return transactions
        .map((item) => ({
          ...item,
          customer_name: customers.find(
            (row) => String(row.customer_id) === String(item.customer_id),
          )
            ? `${customers.find((row) => String(row.customer_id) === String(item.customer_id)).first_name} ${customers.find((row) => String(row.customer_id) === String(item.customer_id)).last_name}`
            : "",
          promo_code:
            promotions.find(
              (promo) =>
                String(promo.promotion_id) === String(item.promotion_id),
            )?.code || "",
        }))
        .sort((a, b) =>
          String(b.transaction_date || b.created_at).localeCompare(
            String(a.transaction_date || a.created_at),
          ),
        );
    if (operation === "get")
      return await getDoc("billing_transactions", input.transaction_id);
    if (operation === "options") {
      const customerId = String(input.customer_id || "");
      if (!customerId) fail("Customer is required.");
      const billedSessions = new Set(
        transactions
          .filter((item) => item.status !== "cancelled")
          .map((item) => String(item.session_id)),
      );
      const billedOrders = new Set(
        transactions
          .filter((item) => item.status !== "cancelled")
          .map((item) => String(item.order_id)),
      );
      const extensions = await rows("session_extensions", "extension_id");
      const sessions = sessionsList
        .filter(
          (item) =>
            String(item.customer_id) === customerId &&
            item.check_out_time &&
            !billedSessions.has(String(item.session_id)),
        )
        .map((item) => ({
          session_id: item.session_id,
          check_out_time: item.check_out_time,
          total_amount:
            number(item.study_fee) +
            extensions
              .filter(
                (row) => String(row.session_id) === String(item.session_id),
              )
              .reduce((sum, row) => sum + number(row.additional_amount), 0),
        }));
      const ordersForCustomer = ordersList
        .filter(
          (item) =>
            String(item.customer_id) === customerId &&
            !billedOrders.has(String(item.order_id)),
        )
        .map(({ order_id, order_datetime, total_amount }) => ({
          order_id,
          order_datetime,
          total_amount,
        }));
      const promos = (await rows("promotions", "promotion_id"))
        .filter(
          (item) =>
            item.is_active !== false &&
            item.valid_from <= now().slice(0, 10) &&
            item.valid_to >= now().slice(0, 10),
        )
        .map(({ promotion_id, code, discount_type, discount_value }) => ({
          promotion_id,
          code,
          discount_type,
          discount_value,
        }));
      return { sessions, orders: ordersForCustomer, promotions: promos };
    }
    if (operation === "create") {
      requirePermission(user, "billing");
      const customerId = String(input.customer_id || ""),
        sessionId = input.session_id ? String(input.session_id) : null,
        orderId = input.order_id ? String(input.order_id) : null;
      if (!customerId) fail("Customer is required.");
      if (!sessionId && !orderId)
        fail("Provide a session and/or an order to bill.");
      let subtotal = 0,
        reservationId = null;
      if (sessionId) {
        const session = await getDoc("space_sessions", sessionId);
        if (!session || String(session.customer_id) !== customerId)
          fail("Session does not belong to this customer.");
        if (!session.check_out_time)
          fail("Session must be checked out before billing.");
        if (
          transactions.some(
            (item) =>
              String(item.session_id) === sessionId &&
              item.status !== "cancelled",
          )
        )
          fail("This session has already been billed.");
        reservationId = session.reservation_id || null;
        const extensions = await rows("session_extensions", "extension_id");
        subtotal +=
          number(session.study_fee) +
          extensions
            .filter((item) => String(item.session_id) === sessionId)
            .reduce((sum, item) => sum + number(item.additional_amount), 0);
      }
      if (orderId) {
        const order = await getDoc("orders", orderId);
        if (!order || String(order.customer_id) !== customerId)
          fail("Order does not belong to this customer.");
        if (
          transactions.some(
            (item) =>
              String(item.order_id) === orderId && item.status !== "cancelled",
          )
        )
          fail("This order has already been billed.");
        subtotal += number(order.total_amount);
      }
      let discount = 0,
        promotionId = null;
      if (text(input.promo_code)) {
        const promo = (await rows("promotions", "promotion_id")).find(
          (item) =>
            item.code === text(input.promo_code).toUpperCase() &&
            item.is_active !== false &&
            item.valid_from <= now().slice(0, 10) &&
            item.valid_to >= now().slice(0, 10),
        );
        if (!promo) fail("Invalid or expired promo code.");
        promotionId = promo.promotion_id;
        discount =
          promo.discount_type === "percent"
            ? Number(
                ((subtotal * number(promo.discount_value)) / 100).toFixed(2),
              )
            : Math.min(subtotal, number(promo.discount_value));
      }
      const total = Number(Math.max(subtotal - discount, 0).toFixed(2));
      const result = await create("billing_transactions", "transaction_id", {
        customer_id: customerId,
        reservation_id: reservationId,
        session_id: sessionId,
        order_id: orderId,
        promotion_id: promotionId,
        subtotal,
        discount_amount: discount,
        total_amount: total,
        status: "pending",
        transaction_date: now(),
      });
      await notifyAllStaff(
        `Transaction #${result.id} (${total}) is ready for payment.`,
      );
      await audit(
        user,
        "create",
        "billing_transactions",
        result.id,
        `Billed ${total} (subtotal ${subtotal}, discount ${discount})`,
      );
      return {
        transaction_id: result.id,
        subtotal,
        discount_amount: discount,
        total_amount: total,
      };
    }
  }

  if (group === "payments") {
    const payments = await rows("payments", "payment_id"),
      transactions = await rows("billing_transactions", "transaction_id");
    if (operation === "methods")
      return (await rows("payment_methods", "payment_method_id")).filter(
        (item) => item.is_active !== false,
      );
    if (operation === "list") {
      const [customers, methods, staffList] = await Promise.all([
        rows("customers", "customer_id"),
        rows("payment_methods", "payment_method_id"),
        rows("staff", "staff_id"),
      ]);
      return payments
        .map((payment) => ({
          ...payment,
          customer_name: customers.find(
            (item) => String(item.customer_id) === String(payment.customer_id),
          )
            ? `${customers.find((item) => String(item.customer_id) === String(payment.customer_id)).first_name} ${customers.find((item) => String(item.customer_id) === String(payment.customer_id)).last_name}`
            : "",
          payment_method:
            methods.find(
              (item) =>
                String(item.payment_method_id) ===
                String(payment.payment_method_id),
            )?.method_name || "",
          verified_by_name: staffList.find(
            (item) => String(item.staff_id) === String(payment.verified_by),
          )
            ? `${staffList.find((item) => String(item.staff_id) === String(payment.verified_by)).first_name} ${staffList.find((item) => String(item.staff_id) === String(payment.verified_by)).last_name}`
            : null,
        }))
        .sort((a, b) =>
          String(b.payment_date || b.created_at).localeCompare(
            String(a.payment_date || a.created_at),
          ),
        );
    }
    if (operation === "transactions") {
      const customerId = String(input.customer_id || "");
      if (!customerId) fail("Customer is required.");
      return transactions
        .filter(
          (tx) =>
            String(tx.customer_id) === customerId &&
            ["pending", "partially_paid"].includes(tx.status),
        )
        .map((tx) => {
          const paid = payments
            .filter(
              (item) =>
                String(item.transaction_id) === String(tx.transaction_id) &&
                ["pending", "verified"].includes(item.payment_status),
            )
            .reduce((sum, item) => sum + number(item.amount_paid), 0);
          return {
            transaction_id: tx.transaction_id,
            total_amount: tx.total_amount,
            balance_due: number(tx.total_amount) - paid,
          };
        })
        .filter((item) => item.balance_due > 0);
    }
    if (operation === "record") {
      requirePermission(user, "payments");
      const customerId = String(input.customer_id || ""),
        txId = String(input.transaction_id || ""),
        amount = number(input.amount_paid);
      const tx = await getDoc("billing_transactions", txId);
      if (!customerId || !txId || !input.payment_method_id || amount <= 0)
        fail(
          "Customer, transaction, method, and a positive amount are required.",
        );
      if (!tx || String(tx.customer_id) !== customerId)
        fail("Transaction does not belong to this customer.");
      if (tx.status === "paid") fail("This transaction is already fully paid.");
      const prior = payments
        .filter(
          (item) =>
            String(item.transaction_id) === txId &&
            ["pending", "verified"].includes(item.payment_status),
        )
        .reduce((sum, item) => sum + number(item.amount_paid), 0);
      const balance = number(tx.total_amount) - prior;
      if (amount > balance)
        fail(
          `Payment exceeds the remaining balance of ${Math.max(balance, 0).toFixed(2)}.`,
        );
      const result = await create("payments", "payment_id", {
        customer_id: customerId,
        transaction_id: txId,
        payment_method_id: String(input.payment_method_id),
        amount_paid: amount,
        payment_status: "pending",
        payment_date: now(),
      });
      const reference = `PAY-${now().slice(0, 10).replaceAll("-", "")}-${result.id}`;
      await db
        .collection("payments")
        .doc(result.id)
        .update({ reference_number: reference });
      await notifyAllStaff(
        `Payment #${result.id} (${amount}) for transaction #${txId} needs verification.`,
      );
      await audit(
        user,
        "create",
        "payments",
        result.id,
        `Recorded payment ${amount} for transaction #${txId}`,
      );
      return { payment_id: result.id, reference_number: reference };
    }
    if (operation === "verify" || operation === "reject") {
      requirePermission(user, "payments");
      const paymentId = idOf(input.payment_id),
        ref = db.collection("payments").doc(paymentId),
        payment = await getDoc("payments", paymentId);
      if (!payment) fail("Payment not found.", 404);
      if (operation === "reject") {
        if (payment.payment_status === "pending")
          await ref.update({ payment_status: "rejected" });
        await audit(user, "update", "payments", paymentId, "Payment rejected");
        return {};
      }
      if (payment.payment_status !== "pending")
        fail(`Payment already ${payment.payment_status}.`);
      const txRef = db
        .collection("billing_transactions")
        .doc(idOf(payment.transaction_id));
      const tx = await getDoc("billing_transactions", payment.transaction_id);
      await ref.update({
        payment_status: "verified",
        verified_by: user.staff_id,
      });
      const verifiedTotal =
        payments
          .filter(
            (item) =>
              String(item.transaction_id) === String(payment.transaction_id) &&
              item.payment_status === "verified",
          )
          .reduce((sum, item) => sum + number(item.amount_paid), 0) +
        number(payment.amount_paid);
      const status =
        verifiedTotal >= number(tx?.total_amount) &&
        number(tx?.total_amount) > 0
          ? "paid"
          : "partially_paid";
      if (tx) await txRef.update({ status });
      if (
        status === "paid" &&
        !(await rows("receipts", "receipt_id")).some(
          (item) =>
            String(item.transaction_id) === String(payment.transaction_id),
        )
      ) {
        const result = await create("receipts", "receipt_id", {
          transaction_id: String(payment.transaction_id),
          receipt_number: `RCP-${now().slice(0, 10).replaceAll("-", "")}-${payment.transaction_id}`,
          total_paid: verifiedTotal,
        });
        void result;
      }
      await notify(
        "customer",
        payment.customer_id,
        `Your payment of ${payment.amount_paid} has been verified.`,
      );
      await audit(user, "update", "payments", paymentId, "Payment verified");
      return {};
    }
    if (operation === "receipt")
      return (
        (await rows("receipts", "receipt_id")).find(
          (item) =>
            String(item.transaction_id) === String(input.transaction_id),
        ) || null
      );
  }

  if (group === "notifications") {
    const type = user.account_type,
      id = type === "staff" ? user.staff_id : user.customer_id;
    const list = await rows("notifications", "notification_id");
    if (operation === "list")
      return list
        .filter(
          (item) =>
            item.recipient_type === type &&
            String(item.recipient_id) === String(id),
        )
        .sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)),
        )
        .slice(0, 50);
    if (operation === "markRead") {
      const record = await getDoc("notifications", input.notification_id);
      if (
        record &&
        record.recipient_type === type &&
        String(record.recipient_id) === String(id)
      )
        await db
          .collection("notifications")
          .doc(idOf(input.notification_id))
          .update({ is_read: true });
      return {};
    }
    if (operation === "markAllRead") {
      const batch = db.batch();
      list
        .filter(
          (item) =>
            item.recipient_type === type &&
            String(item.recipient_id) === String(id) &&
            !item.is_read,
        )
        .forEach((item) =>
          batch.update(
            db.collection("notifications").doc(idOf(item.notification_id)),
            { is_read: true },
          ),
        );
      await batch.commit();
      return {};
    }
  }

  if (group === "reports") {
    const [
      spaceList,
      activeSessions,
      reservationList,
      queue,
      paymentsList,
      auditList,
      customers,
      spaceTypes,
    ] = await Promise.all([
      rows("study_spaces", "space_id"),
      rows("space_sessions", "session_id"),
      rows("reservations", "reservation_id"),
      rows("walkin_queue", "queue_id"),
      rows("payments", "payment_id"),
      rows("audit_log", "audit_id"),
      rows("customers", "customer_id"),
      rows("space_types", "space_type_id"),
    ]);
    if (operation === "dashboard") {
      const today = now().slice(0, 10);
      return {
        occupied: spaceList.filter((item) => item.status === "occupied").length,
        available: spaceList.filter((item) => item.status === "available")
          .length,
        active_sessions: activeSessions.filter((item) => !item.check_out_time)
          .length,
        pending_reservations_today: reservationList.filter(
          (item) =>
            item.status === "pending" && item.reservation_date === today,
        ).length,
        waiting_walkins: queue.filter((item) => item.status === "waiting")
          .length,
        today_revenue: paymentsList
          .filter(
            (item) =>
              item.payment_status === "verified" &&
              String(item.payment_date).slice(0, 10) === today,
          )
          .reduce((sum, item) => sum + number(item.amount_paid), 0),
      };
    }
    if (operation === "spaceAvailability")
      return spaceList.map((space) => ({
        ...space,
        type_name:
          spaceTypes.find(
            (type) =>
              String(type.space_type_id) === String(space.space_type_id),
          )?.type_name || "",
        base_rate:
          spaceTypes.find(
            (type) =>
              String(type.space_type_id) === String(space.space_type_id),
          )?.base_rate || 0,
      }));
    if (operation === "activeSessionsView")
      return activeSessions
        .filter((item) => !item.check_out_time)
        .map((session) => ({
          ...session,
          customer_name: customers.find(
            (customer) =>
              String(customer.customer_id) === String(session.customer_id),
          )
            ? `${customers.find((customer) => String(customer.customer_id) === String(session.customer_id)).first_name} ${customers.find((customer) => String(customer.customer_id) === String(session.customer_id)).last_name}`
            : "",
          space_name:
            spaceList.find(
              (space) => String(space.space_id) === String(session.space_id),
            )?.space_name || "",
        }));
    if (operation === "dailyRevenue") {
      const totals = {};
      paymentsList
        .filter((item) => item.payment_status === "verified")
        .forEach((item) => {
          const date = String(item.payment_date).slice(0, 10);
          totals[date] = (totals[date] || 0) + number(item.amount_paid);
        });
      return Object.entries(totals)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 30)
        .map(([revenue_date, total_collected]) => ({
          revenue_date,
          total_collected,
          payment_count: paymentsList.filter(
            (item) =>
              item.payment_status === "verified" &&
              String(item.payment_date).slice(0, 10) === revenue_date,
          ).length,
        }));
    }
    if (operation === "auditLog") {
      requirePermission(user, "reports");
      return auditList
        .filter(
          (item) =>
            (!input.table_name || item.table_name === input.table_name) &&
            (!input.date_from || String(item.created_at) >= input.date_from) &&
            (!input.date_to ||
              String(item.created_at) <= `${input.date_to}T23:59:59`),
        )
        .sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)),
        )
        .slice(0, 300);
    }
    if (operation === "endOfDay") {
      requirePermission(user, "reports");
      const date = input.date || now().slice(0, 10),
        ordersList = await rows("orders", "order_id"),
        items = await rows("order_items", "order_item_id"),
        products = await rows("products_services", "product_id"),
        txs = await rows("billing_transactions", "transaction_id");
      const orderToday = ordersList.filter(
        (item) => String(item.order_datetime).slice(0, 10) === date,
      );
      const topProducts = products
        .map((product) => {
          const productItems = items.filter(
            (item) =>
              String(item.product_id) === String(product.product_id) &&
              orderToday.some(
                (order) => String(order.order_id) === String(item.order_id),
              ),
          );
          return {
            item_name: product.item_name,
            qty: productItems.reduce(
              (sum, item) => sum + number(item.quantity),
              0,
            ),
            revenue: productItems.reduce(
              (sum, item) => sum + number(item.subtotal),
              0,
            ),
          };
        })
        .filter((item) => item.qty)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);
      return {
        date,
        revenue: paymentsList
          .filter(
            (item) =>
              item.payment_status === "verified" &&
              String(item.payment_date).slice(0, 10) === date,
          )
          .reduce((sum, item) => sum + number(item.amount_paid), 0),
        sessions_count: activeSessions.filter(
          (item) => String(item.check_in_time).slice(0, 10) === date,
        ).length,
        walkins_count: activeSessions.filter(
          (item) =>
            String(item.check_in_time).slice(0, 10) === date &&
            !item.reservation_id,
        ).length,
        reserved_count: activeSessions.filter(
          (item) =>
            String(item.check_in_time).slice(0, 10) === date &&
            item.reservation_id,
        ).length,
        top_products: topProducts,
        outstanding_balances: txs.filter(
          (item) => item.status === "partially_paid",
        ),
      };
    }
    if (operation === "markOverdueNoShows") {
      requirePermission(user, "reports");
      const nowTime = Date.now(),
        sessions = await rows("space_sessions", "session_id"),
        overdue = reservationList.filter(
          (item) =>
            item.status === "confirmed" &&
            !sessions.some(
              (session) =>
                String(session.reservation_id) === String(item.reservation_id),
            ) &&
            time(`${item.reservation_date}T${item.end_time}`) < nowTime,
        );
      const batch = db.batch();
      overdue.forEach((item) => {
        batch.update(
          db.collection("reservations").doc(idOf(item.reservation_id)),
          { status: "no_show" },
        );
        batch.update(db.collection("study_spaces").doc(idOf(item.space_id)), {
          status: "available",
        });
      });
      if (overdue.length) await batch.commit();
      return { marked: overdue.length };
    }
  }
  fail("Unknown operation.", 400);
}

async function dispatch(group, operation, input, user) {
  if (group === "auth") return authOperation(operation, input);
  if (group === "customers" || group === "staff") {
    const result = await staffAndCustomer(group, operation, input, user);
    return operation === "add"
      ? { success: true, ...result }
      : { success: true, data: result };
  }
  if (group === "spaces") {
    const result = await spaces(operation, input, user);
    if (["scheduleMaintenance"].includes(operation))
      return { success: true, ...result };
    if (
      ["addType", "addSpace", "updateStatus", "completeMaintenance"].includes(
        operation,
      )
    )
      return { success: true, ...result };
    return { success: true, data: result };
  }
  if (group === "reservations") {
    const result = await reservations(operation, input, user);
    return operation === "create"
      ? { success: true, ...result }
      : { success: true, data: result };
  }
  if (
    [
      "walkin",
      "sessions",
      "products",
      "orders",
      "promotions",
      "billing",
      "payments",
      "notifications",
      "reports",
    ].includes(group)
  ) {
    const data = await otherOperations(group, operation, input, user);
    const topLevel = {
      walkin: ["add"],
      sessions: ["checkIn", "extendSession", "checkOut"],
      products: ["addCategory", "addProduct"],
      orders: ["create"],
      promotions: ["add", "deactivateExpired"],
      billing: ["options", "create"],
      payments: ["record", "verify", "reject"],
      notifications: ["markRead", "markAllRead"],
      reports: ["markOverdueNoShows"],
    };
    if (topLevel[group]?.includes(operation)) return { success: true, ...data };
    return { success: true, data };
  }
  fail("Unknown operation.", 400);
}

async function handleApiRequest(request, response) {
  if (request.method === "OPTIONS") return response.status(204).send("");
  try {
    const group = (request.path.split("/").pop() || "").replace(/\.php$/, "");
    const input = request.method === "GET" ? request.query : request.body || {};
    const operation = String(input.operation || "");
    if (!operation) fail("Unknown operation.", 400);
    const publicOperation =
      group === "auth" &&
      ["resolveLogin", "memberRegister"].includes(operation);
    const user =
      group === "auth" && operation === "me"
        ? null
        : publicOperation
          ? null
          : await requireUser(request);
    const result = await dispatch(
      group,
      operation,
      { ...input, request },
      user,
    );
    return response
      .status(200)
      .json(
        result.success === undefined ? { success: true, ...result } : result,
      );
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 500) console.error("Firebase API error:", error);
    return response
      .status(status)
      .json({
        success: false,
        message:
          status === 500 ? "The Firebase request failed." : error.message,
      });
  }
}

module.exports = { handleApiRequest };
