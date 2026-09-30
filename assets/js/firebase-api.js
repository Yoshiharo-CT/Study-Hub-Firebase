const now = () => new Date().toISOString();
const id = (value) => String(value ?? "");
const value = (input, key, fallback = "") => input[key] ?? fallback;
const numeric = (input, fallback = 0) => {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const dateTime = (input) => Date.parse(input) || 0;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function makeApi(db, sdk) {
  const ref = (name, key) =>
    key === undefined ? sdk.collection(db, name) : sdk.doc(db, name, id(key));
  const read = async (name, key) => {
    const result = await sdk.getDoc(ref(name, key));
    return result.exists() ? { ...result.data(), id: result.id } : null;
  };
  const list = async (name, key) => {
    const result = await sdk.getDocs(ref(name));
    return result.docs.map((item) => ({ [key]: item.id, ...item.data() }));
  };
  const add = async (name, key, data) => {
    const result = await sdk.addDoc(ref(name), {
      ...data,
      created_at: data.created_at || now(),
    });
    return { id: result.id, [key]: result.id };
  };
  const writeAudit = async (user, action, table, recordId, details) => {
    await add("audit_log", "audit_id", {
      user_id: user.uid,
      actor_label:
        `${user.first_name || ""} ${user.last_name || ""} (${user.account_type})`.trim(),
      action,
      table_name: table,
      record_id: recordId == null ? null : id(recordId),
      details: details || "",
    });
  };
  const notify = async (type, recipientId, message) =>
    add("notifications", "notification_id", {
      recipient_type: type,
      recipient_id: id(recipientId),
      message,
      is_read: false,
      created_at: now(),
    });
  const notifyStaff = async (message) => {
    const staff = await list("staff", "staff_id");
    await Promise.all(
      staff.map((item) => notify("staff", item.staff_id, message)),
    );
  };
  const currentProfile = async (auth) => {
    if (!auth.currentUser) fail("Login required.", 401);
    const profile = await read("users", auth.currentUser.uid);
    if (!profile || profile.account_status !== "active")
      fail("This account is inactive or unavailable.", 403);
    return { ...profile, uid: auth.currentUser.uid };
  };
  const staff = (user) => {
    if (user.account_type !== "staff") fail("Staff login required.", 403);
  };
  const permission = (user, name) => {
    staff(user);
    const permissions = Array.isArray(user.permissions)
      ? user.permissions
      : String(user.permissions || "")
          .split(",")
          .map((item) => item.trim());
    if (!permissions.includes(name))
      fail("You do not have permission to do that.", 403);
  };
  const joinedName = (person) =>
    `${person?.first_name || ""} ${person?.last_name || ""}`.trim();

  async function authOperation(operation, input, context) {
    const { auth, authSdk } = context;
    if (operation === "login") {
      const identifier = String(input.identifier || "")
        .trim()
        .toLowerCase();
      if (!identifier) fail("Enter your email or staff username.");
      const email = identifier.includes("@")
        ? identifier
        : `${identifier}@study-hub-bf7e1.firebaseapp.com`;
      await authSdk.signInWithEmailAndPassword(
        auth,
        email,
        String(input.password || ""),
      );
      const profile = await currentProfile(auth);
      return {
        success: true,
        account_type: profile.account_type,
        staff:
          profile.account_type === "staff"
            ? await read("staff", profile.staff_id)
            : undefined,
        customer_id: profile.customer_id,
      };
    }
    if (operation === "memberRegister") {
      const first = String(input.first_name || "").trim();
      const last = String(input.last_name || "").trim();
      const phone = String(input.phone_number || "").trim();
      const email = String(input.email || "")
        .trim()
        .toLowerCase();
      const password = String(input.password || "");
      if (!first || !last || !phone || !email || password.length < 6)
        fail("Fill in all fields (password must be at least 6 characters).");
      const credential = await authSdk.createUserWithEmailAndPassword(
        auth,
        email,
        password,
      );
      const customerRef = sdk.doc(ref("customers"));
      const customerId = customerRef.id;
      const batch = sdk.writeBatch(db);
      batch.set(customerRef, {
        customer_id: customerId,
        user_id: credential.user.uid,
        uid: credential.user.uid,
        first_name: first,
        last_name: last,
        phone_number: phone,
        email,
        created_at: now(),
      });
      batch.set(ref("users", credential.user.uid), {
        uid: credential.user.uid,
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
      try {
        await batch.commit();
      } catch (error) {
        await authSdk.deleteUser(credential.user).catch(() => {});
        throw error;
      }
      await authSdk.signOut(auth);
      return {
        success: true,
        message: "Account created.",
        customer_id: customerId,
      };
    }
    if (operation === "me") {
      const profile = await currentProfile(auth);
      if (profile.account_type === "staff") {
        const staffRecord = await read("staff", profile.staff_id);
        if (!staffRecord) fail("Staff record not found for this account.", 404);
        return {
          success: true,
          account_type: "staff",
          staff: {
            ...staffRecord,
            role_name: profile.role_name,
            permissions: profile.permissions,
          },
        };
      }
      return {
        success: true,
        account_type: profile.account_type,
        customer: await read("customers", profile.customer_id),
      };
    }
    if (operation === "logout") {
      await authSdk.signOut(auth);
      return { success: true, message: "Logged out." };
    }
    fail("Unknown operation.");
  }

  async function customersAndStaff(group, operation, input, user, context) {
    staff(user);
    if (group === "customers") {
      const customers = await list("customers", "customer_id");
      if (operation === "list") {
        return {
          data: customers.map((customer) => {
            return {
              ...customer,
              username: customer.username || null,
              account_status: customer.account_status || null,
            };
          }),
        };
      }
      if (operation === "get")
        return { data: await read("customers", input.customer_id) };
      if (operation === "add") {
        permission(user, "customers");
        const first = String(input.first_name || "").trim(),
          last = String(input.last_name || "").trim();
        const phone = String(input.phone_number || "").trim(),
          email = String(input.email || "")
            .trim()
            .toLowerCase();
        if (!first || !last || !phone || !email)
          fail("All fields are required.");
        const result = await add("customers", "customer_id", {
          first_name: first,
          last_name: last,
          phone_number: phone,
          email,
        });
        return { customer_id: result.id };
      }
    }
    if (group === "staff") {
      if (operation === "roles")
        return {
          data: (await list("staff_roles", "role_id"))
            .filter((item) => item.is_active !== false)
            .sort((a, b) => a.role_name.localeCompare(b.role_name)),
        };
      if (operation === "list") {
        const [members, roles] = await Promise.all([
          list("staff", "staff_id"),
          list("staff_roles", "role_id"),
        ]);
        return {
          data: members.map((member) => {
            const role = roles.find(
              (item) => id(item.role_id) === id(member.role_id),
            );
            return {
              ...member,
              role_name: role?.role_name || member.role_name,
              account_status: member.account_status || "active",
            };
          }),
        };
      }
      if (operation === "setStatus") {
        permission(user, "staff");
        const member = await read("staff", input.staff_id);
        if (!member?.user_id) fail("Staff account not found.");
        const status = String(input.account_status);
        if (!["active", "inactive", "suspended"].includes(status))
          fail("Invalid status.");
        await sdk.updateDoc(ref("users", member.user_id), {
          account_status: status,
        });
        await sdk.updateDoc(ref("staff", input.staff_id), {
          account_status: status,
        });
        return {};
      }
      if (operation === "add") {
        permission(user, "staff");
        const first = String(input.first_name || "").trim(),
          last = String(input.last_name || "").trim();
        const username = String(input.username || "")
          .trim()
          .toLowerCase();
        const password = String(input.password || ""),
          role = await read("staff_roles", input.role_id);
        if (!first || !last || !username || password.length < 6 || !role)
          fail("Fill in all fields (password must be at least 6 characters).");
        const secondaryName = `staff-${Date.now()}`;
        const secondaryApp = context.appSdk.initializeApp(
          context.firebaseConfig,
          secondaryName,
        );
        const secondaryAuth = context.authSdk.getAuth(secondaryApp);
        if (
          ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
          window.location.port === "5500"
        ) {
          context.authSdk.connectAuthEmulator(
            secondaryAuth,
            "http://127.0.0.1:9199",
            { disableWarnings: true },
          );
        }
        try {
          const credential =
            await context.authSdk.createUserWithEmailAndPassword(
              secondaryAuth,
              `${username}@study-hub-bf7e1.firebaseapp.com`,
              password,
            );
          const staffRef = sdk.doc(ref("staff"));
          const member = {
            staff_id: staffRef.id,
            user_id: credential.user.uid,
            uid: credential.user.uid,
            role_id: id(input.role_id),
            role_name: role.role_name,
            first_name: first,
            last_name: last,
            phone_number: String(input.phone_number || ""),
          };
          const batch = sdk.writeBatch(db);
          batch.set(staffRef, member);
          batch.set(ref("users", credential.user.uid), {
            uid: credential.user.uid,
            account_type: "staff",
            account_status: "active",
            username,
            email: credential.user.email,
            staff_id: staffRef.id,
            role_id: id(input.role_id),
            role_name: role.role_name,
            permissions: Array.isArray(role.permissions)
              ? role.permissions
              : String(role.permissions || "")
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
            first_name: first,
            last_name: last,
          });
          await batch.commit();
          await context.appSdk.deleteApp(secondaryApp);
          return { staff_id: staffRef.id };
        } catch (error) {
          await context.appSdk.deleteApp(secondaryApp).catch(() => {});
          throw error;
        }
      }
    }
    fail("Unknown operation.");
  }

  async function spaces(operation, input, user) {
    staff(user);
    if (operation === "listTypes")
      return {
        data: (await list("space_types", "space_type_id")).sort(
          (a, b) => numeric(a.base_rate) - numeric(b.base_rate),
        ),
      };
    if (operation === "listSpaces") {
      const [spaces, types] = await Promise.all([
        list("study_spaces", "space_id"),
        list("space_types", "space_type_id"),
      ]);
      return {
        data: spaces
          .filter(
            (space) =>
              (!input.space_type_id ||
                id(space.space_type_id) === id(input.space_type_id)) &&
              (!input.status || space.status === input.status) &&
              (!input.capacity ||
                numeric(space.capacity) >= numeric(input.capacity)),
          )
          .map((space) => ({
            ...space,
            ...(types.find(
              (type) => id(type.space_type_id) === id(space.space_type_id),
            ) || {}),
          })),
      };
    }
    if (operation === "checkAvailability") {
      const date = String(input.date || ""),
        start = String(input.start_time || ""),
        end = String(input.end_time || "");
      const [spaces, types] = await Promise.all([
        list("study_spaces", "space_id"),
        list("space_types", "space_type_id"),
      ]);
      const from = dateTime(`${date}T${start}`),
        to = dateTime(`${date}T${end}`);
      return {
        data: spaces
          .filter(
            (space) =>
              !["maintenance", "inactive"].includes(space.status) &&
              !(space.reservation_windows || []).some(
                (row) =>
                  row.reservation_date === date &&
                  ["pending", "confirmed"].includes(row.status) &&
                  row.start_time < end &&
                  row.end_time > start,
              ) &&
              !(space.maintenance_windows || []).some(
                (row) =>
                  ["scheduled", "active"].includes(row.status) &&
                  dateTime(row.end_datetime) > from &&
                  dateTime(row.start_datetime) < to,
              ),
          )
          .map((space) => ({
            ...space,
            ...(types.find(
              (type) => id(type.space_type_id) === id(space.space_type_id),
            ) || {}),
          })),
      };
    }
    if (operation === "addType") {
      permission(user, "spaces");
      const name = String(input.type_name || "").trim();
      if (!name) fail("Type name is required.");
      await add("space_types", "space_type_id", {
        type_name: name,
        base_rate: numeric(input.base_rate),
        default_capacity: numeric(input.default_capacity, 1),
        description: String(input.description || ""),
        waiting_walkins: [],
      });
      return {};
    }
    if (operation === "addSpace") {
      permission(user, "spaces");
      const type = await read("space_types", input.space_type_id),
        name = String(input.space_name || "").trim();
      if (!type || !name) fail("Space type and name are required.");
      await add("study_spaces", "space_id", {
        space_type_id: id(input.space_type_id),
        space_name: name,
        capacity: numeric(input.capacity, type.default_capacity),
        status: "available",
        reservation_windows: [],
        maintenance_windows: [],
      });
      return {};
    }
    if (operation === "updateStatus") {
      permission(user, "spaces");
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
      await sdk.updateDoc(ref("study_spaces", input.space_id), {
        status: input.status,
      });
      return {};
    }
    if (operation === "scheduleMaintenance") {
      permission(user, "spaces");
      const spaceRef = ref("study_spaces", input.space_id);
      const maintenanceRef = sdk.doc(ref("space_maintenance"));
      await sdk.runTransaction(db, async (transaction) => {
        const space = await transaction.get(spaceRef);
        if (!space.exists()) fail("Space not found.");
        const windows = space.data().maintenance_windows || [];
        const maintenanceWindow = {
          maintenance_id: maintenanceRef.id,
          start_datetime: input.start_datetime,
          end_datetime: input.end_datetime,
          status: "scheduled",
        };
        transaction.set(maintenanceRef, {
          maintenance_id: maintenanceRef.id,
          space_id: id(input.space_id),
          start_datetime: input.start_datetime,
          end_datetime: input.end_datetime,
          reason: input.reason || "",
          created_by: user.staff_id,
          status: "scheduled",
          created_at: now(),
        });
        transaction.update(spaceRef, {
          maintenance_windows: [...windows, maintenanceWindow],
          ...(dateTime(input.start_datetime) <= Date.now() &&
          dateTime(input.end_datetime) >= Date.now()
            ? { status: "maintenance" }
            : {}),
        });
      });
      return { maintenance_id: maintenanceRef.id };
    }
    if (operation === "listMaintenance") {
      const [maintenance, spaces] = await Promise.all([
        list("space_maintenance", "maintenance_id"),
        list("study_spaces", "space_id"),
      ]);
      return {
        data: maintenance
          .map((item) => ({
            ...item,
            space_name:
              spaces.find((space) => id(space.space_id) === id(item.space_id))
                ?.space_name || "",
          }))
          .sort((a, b) =>
            String(b.start_datetime).localeCompare(String(a.start_datetime)),
          ),
      };
    }
    if (operation === "completeMaintenance") {
      permission(user, "spaces");
      const record = await read("space_maintenance", input.maintenance_id);
      if (!record) fail("Maintenance record not found.");
      const maintenanceRef = ref("space_maintenance", input.maintenance_id);
      const spaceRef = ref("study_spaces", record.space_id);
      await sdk.runTransaction(db, async (transaction) => {
        const [maintenance, space] = await Promise.all([
          transaction.get(maintenanceRef),
          transaction.get(spaceRef),
        ]);
        if (!maintenance.exists() || !space.exists())
          fail("Maintenance record or space not found.");
        transaction.update(maintenanceRef, { status: "completed" });
        transaction.update(spaceRef, {
          status: "available",
          maintenance_windows: (space.data().maintenance_windows || []).filter(
            (item) => id(item.maintenance_id) !== id(input.maintenance_id),
          ),
        });
      });
      return {};
    }
    fail("Unknown operation.");
  }

  async function reservations(operation, input, user) {
    staff(user);
    if (operation === "list") {
      const [records, customers, spaces, types] = await Promise.all([
        list("reservations", "reservation_id"),
        list("customers", "customer_id"),
        list("study_spaces", "space_id"),
        list("space_types", "space_type_id"),
      ]);
      return {
        data: records
          .filter((row) => !input.status || row.status === input.status)
          .map((row) => {
            const customer = customers.find(
              (item) => id(item.customer_id) === id(row.customer_id),
            );
            const space = spaces.find(
              (item) => id(item.space_id) === id(row.space_id),
            );
            return {
              ...row,
              customer_name: joinedName(customer),
              space_name: space?.space_name || "",
              space_type:
                types.find(
                  (item) => id(item.space_type_id) === id(space?.space_type_id),
                )?.type_name || "",
            };
          })
          .sort((a, b) =>
            `${b.reservation_date} ${b.start_time}`.localeCompare(
              `${a.reservation_date} ${a.start_time}`,
            ),
          ),
      };
    }
    if (operation === "create") {
      permission(user, "reservations");
      const date = String(input.reservation_date || ""),
        start = String(input.start_time || ""),
        end = String(input.end_time || "");
      const spaceRef = ref("study_spaces", input.space_id),
        reservationRef = sdk.doc(ref("reservations"));
      const people = numeric(input.number_of_people, 1);
      if (!date || !start || !end || end <= start || people < 1)
        fail("Enter a valid reservation date, time, and party size.");
      await sdk.runTransaction(db, async (transaction) => {
        const space = await transaction.get(spaceRef);
        if (!space.exists()) fail("Space not found.");
        const spaceData = space.data();
        if (["maintenance", "inactive"].includes(spaceData.status))
          fail(`That space is not bookable right now (${spaceData.status}).`);
        if (people > numeric(spaceData.capacity))
          fail(`That space only fits ${spaceData.capacity} people.`);
        const reservations = spaceData.reservation_windows || [];
        const maintenance = spaceData.maintenance_windows || [];
        if (
          reservations.some(
            (reservation) =>
              reservation.reservation_date === date &&
              ["pending", "confirmed"].includes(reservation.status) &&
              reservation.start_time < end &&
              reservation.end_time > start,
          )
        )
          fail("That space is already booked for an overlapping time.");
        const from = dateTime(`${date}T${start}`),
          to = dateTime(`${date}T${end}`);
        if (
          maintenance.some(
            (window) =>
              dateTime(window.end_datetime) > from &&
              dateTime(window.start_datetime) < to,
          )
        )
          fail("That space is scheduled for maintenance during that window.");
        const reservation = {
          reservation_id: reservationRef.id,
          customer_id: id(input.customer_id),
          reservation_date: date,
          start_time: start,
          end_time: end,
          status: "pending",
        };
        transaction.update(spaceRef, {
          reservation_windows: [...reservations, reservation],
        });
        transaction.set(reservationRef, {
          reservation_id: reservationRef.id,
          customer_id: id(input.customer_id),
          space_id: id(input.space_id),
          reservation_date: date,
          start_time: start,
          end_time: end,
          number_of_people: people,
          status: "pending",
          created_at: now(),
        });
      });
      await notifyStaff(
        `New reservation #${reservationRef.id} is pending review.`,
      );
      return { reservation_id: reservationRef.id };
    }
    if (["confirm", "cancel", "noShow"].includes(operation)) {
      permission(user, "reservations");
      const record = await read("reservations", input.reservation_id);
      if (!record) fail("Reservation not found.");
      const status =
        operation === "confirm"
          ? "confirmed"
          : operation === "cancel"
            ? "cancelled"
            : "no_show";
      const reservationRef = ref("reservations", input.reservation_id);
      const spaceRef = ref("study_spaces", record.space_id);
      await sdk.runTransaction(db, async (transaction) => {
        const [reservation, space] = await Promise.all([
          transaction.get(reservationRef),
          transaction.get(spaceRef),
        ]);
        if (!reservation.exists() || !space.exists())
          fail("Reservation or space not found.");
        const windows = space.data().reservation_windows || [];
        transaction.update(reservationRef, { status });
        transaction.update(spaceRef, {
          status: operation === "confirm" ? "reserved" : "available",
          reservation_windows:
            operation === "confirm"
              ? windows.map((item) =>
                  id(item.reservation_id) === id(input.reservation_id)
                    ? { ...item, status }
                    : item,
                )
              : windows.filter(
                  (item) =>
                    id(item.reservation_id) !== id(input.reservation_id),
                ),
        });
      });
      if (operation !== "noShow")
        await notify(
          "customer",
          record.customer_id,
          `Your reservation #${input.reservation_id} ${operation === "confirm" ? "has been confirmed" : "was cancelled"}.`,
        );
      return {};
    }
    fail("Unknown operation.");
  }

  async function operations(group, operation, input, user) {
    if (group !== "notifications") staff(user);
    if (group === "walkin") {
      if (operation === "list") {
        const [queue, customers, types] = await Promise.all([
          list("walkin_queue", "queue_id"),
          list("customers", "customer_id"),
          list("space_types", "space_type_id"),
        ]);
        return {
          data: queue
            .map((item) => ({
              ...item,
              customer_name: joinedName(
                customers.find(
                  (row) => id(row.customer_id) === id(item.customer_id),
                ),
              ),
              type_name:
                types.find(
                  (row) => id(row.space_type_id) === id(item.space_type_id),
                )?.type_name || "",
            }))
            .sort(
              (a, b) =>
                Number(b.status === "waiting") -
                  Number(a.status === "waiting") ||
                String(a.queued_at).localeCompare(String(b.queued_at)),
            ),
        };
      }
      if (operation === "add") {
        permission(user, "walkins");
        if (!(await read("customers", input.customer_id)))
          fail("Customer not found.");
        const typeRef = ref("space_types", input.space_type_id);
        const queueRef = sdk.doc(ref("walkin_queue"));
        const queuedAt = now();
        await sdk.runTransaction(db, async (transaction) => {
          const type = await transaction.get(typeRef);
          if (!type.exists()) fail("Space type not found.");
          transaction.update(typeRef, {
            waiting_walkins: [
              ...(type.data().waiting_walkins || []),
              {
                queue_id: queueRef.id,
                customer_id: id(input.customer_id),
                queued_at: queuedAt,
              },
            ],
          });
          transaction.set(queueRef, {
            queue_id: queueRef.id,
            customer_id: id(input.customer_id),
            space_type_id: id(input.space_type_id),
            status: "waiting",
            queued_at: queuedAt,
          });
        });
        return { queue_id: queueRef.id };
      }
      if (operation === "cancel") {
        permission(user, "walkins");
        const queueRef = ref("walkin_queue", input.queue_id);
        const existing = await read("walkin_queue", input.queue_id);
        if (!existing || existing.status !== "waiting") return {};
        const typeRef = ref("space_types", existing.space_type_id);
        await sdk.runTransaction(db, async (transaction) => {
          const [queue, type] = await Promise.all([
            transaction.get(queueRef),
            transaction.get(typeRef),
          ]);
          if (!queue.exists() || queue.data().status !== "waiting") return;
          if (!type.exists()) fail("Space type not found.");
          transaction.update(queueRef, { status: "cancelled" });
          transaction.update(typeRef, {
            waiting_walkins: (type.data().waiting_walkins || []).filter(
              (item) => id(item.queue_id) !== id(input.queue_id),
            ),
          });
        });
        return {};
      }
    }
    if (group === "sessions") {
      if (["list", "listActive"].includes(operation)) {
        const [sessions, customers, spaces, types] = await Promise.all([
          list("space_sessions", "session_id"),
          list("customers", "customer_id"),
          list("study_spaces", "space_id"),
          list("space_types", "space_type_id"),
        ]);
        return {
          data: sessions
            .filter((row) => operation === "list" || !row.check_out_time)
            .map((row) => {
              const space = spaces.find(
                (item) => id(item.space_id) === id(row.space_id),
              );
              const rate = numeric(
                types.find(
                  (item) => id(item.space_type_id) === id(space?.space_type_id),
                )?.base_rate,
              );
              const fee = row.check_out_time
                ? numeric(row.study_fee)
                : Math.max(
                    (Date.now() - dateTime(row.check_in_time)) / 3600000,
                    0,
                  ) * rate;
              return {
                ...row,
                customer_name: joinedName(
                  customers.find(
                    (item) => id(item.customer_id) === id(row.customer_id),
                  ),
                ),
                space_name: space?.space_name || "",
                base_rate: rate,
                fee_so_far: Number(fee.toFixed(2)),
              };
            }),
        };
      }
      if (operation === "checkInReservation") {
        const today = now().slice(0, 10),
          current = new Date().toTimeString().slice(0, 8);
        const space = await read("study_spaces", input.space_id);
        const reservation = (space?.reservation_windows || []).find(
          (item) =>
            id(item.customer_id) === id(input.customer_id) &&
            item.reservation_date === today &&
            item.status === "confirmed" &&
            item.start_time <= current &&
            item.end_time >= current,
        );
        return { data: reservation?.reservation_id || null };
      }
      if (operation === "checkIn") {
        permission(user, "sessions");
        const spaceRef = ref("study_spaces", input.space_id),
          sessionRef = sdk.doc(ref("space_sessions"));
        const today = now().slice(0, 10),
          current = new Date().toTimeString().slice(0, 8);
        const wifi = `SH-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
        await sdk.runTransaction(db, async (transaction) => {
          const space = await transaction.get(spaceRef);
          if (!space.exists()) fail("Space not found.");
          const details = space.data();
          const reservation = (details.reservation_windows || []).find(
            (item) =>
              id(item.customer_id) === id(input.customer_id) &&
              item.reservation_date === today &&
              item.status === "confirmed" &&
              item.start_time <= current &&
              item.end_time >= current,
          );
          if (details.status === "reserved" && !reservation)
            fail("This space is reserved for another customer.");
          if (!["available", "reserved"].includes(details.status))
            fail(`That space is currently ${details.status}.`);
          const reservationRef = reservation
            ? ref("reservations", reservation.reservation_id)
            : null;
          if (
            reservationRef &&
            !(await transaction.get(reservationRef)).exists()
          )
            fail("Reservation not found.");
          transaction.set(sessionRef, {
            session_id: sessionRef.id,
            customer_id: id(input.customer_id),
            space_id: id(input.space_id),
            reservation_id: reservation?.reservation_id || null,
            check_in_time: now(),
            wifi_password: wifi,
            check_out_time: null,
            study_fee: 0,
          });
          transaction.update(spaceRef, {
            status: "occupied",
            reservation_windows: reservation
              ? (details.reservation_windows || []).filter(
                  (item) =>
                    id(item.reservation_id) !== id(reservation.reservation_id),
                )
              : details.reservation_windows || [],
          });
          if (reservationRef)
            transaction.update(reservationRef, { status: "completed" });
        });
        return { session_id: sessionRef.id, wifi_password: wifi };
      }
      if (operation === "extendSession") {
        permission(user, "sessions");
        const session = await read("space_sessions", input.session_id);
        if (!session || session.check_out_time)
          fail("Active session not found.");
        const space = await read("study_spaces", session.space_id),
          type = await read("space_types", space?.space_type_id);
        const minutes = Math.max(1, numeric(input.extra_minutes, 60));
        const amount = Number(
          ((minutes / 60) * numeric(type?.base_rate)).toFixed(2),
        );
        await add("session_extensions", "extension_id", {
          session_id: id(input.session_id),
          extension_start: now(),
          extension_end: new Date(Date.now() + minutes * 60000).toISOString(),
          additional_amount: amount,
        });
        return { additional_amount: amount };
      }
      if (operation === "checkOut") {
        permission(user, "sessions");
        const sessionRef = ref("space_sessions", input.session_id),
          session = await read("space_sessions", input.session_id);
        if (!session || session.check_out_time)
          fail("Active session not found.");
        const spaceRef = ref("study_spaces", session.space_id),
          space = await read("study_spaces", session.space_id);
        const type = await read("space_types", space?.space_type_id);
        const typeRef = ref("space_types", space?.space_type_id);
        const fee = Number(
          (
            Math.max(
              (Date.now() - dateTime(session.check_in_time)) / 3600000,
              0,
            ) * numeric(type?.base_rate)
          ).toFixed(2),
        );
        await sdk.runTransaction(db, async (transaction) => {
          const [liveSession, liveSpace, type] = await Promise.all([
            transaction.get(sessionRef),
            transaction.get(spaceRef),
            transaction.get(typeRef),
          ]);
          if (!liveSession.exists() || liveSession.data().check_out_time)
            fail("Session already checked out.");
          if (!liveSpace.exists() || !type.exists())
            fail("Space or space type not found.");
          const waiting = type.data().waiting_walkins || [];
          const next = waiting[0] || null;
          const nextRef = next ? ref("walkin_queue", next.queue_id) : null;
          if (nextRef && !(await transaction.get(nextRef)).exists())
            fail("Walk-in queue entry not found.");
          transaction.update(sessionRef, {
            check_out_time: now(),
            study_fee: fee,
          });
          transaction.update(spaceRef, {
            status: next ? "occupied" : "available",
          });
          if (next)
            transaction.update(typeRef, { waiting_walkins: waiting.slice(1) });
          if (next) {
            const newSession = sdk.doc(ref("space_sessions"));
            transaction.update(nextRef, {
              status: "served",
              served_at: now(),
            });
            transaction.set(newSession, {
              session_id: newSession.id,
              customer_id: id(next.customer_id),
              space_id: id(session.space_id),
              reservation_id: null,
              check_in_time: now(),
              wifi_password: `SH-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
              check_out_time: null,
              study_fee: 0,
            });
          }
        });
        return { study_fee: fee };
      }
    }
    if (group === "products") {
      const sources = {
        listCategories: ["product_categories", "category_id"],
        listProducts: ["products_services", "product_id"],
        listPaperSizes: ["paper_sizes", "paper_size_id"],
        listPrintTypes: ["print_types", "print_type_id"],
      };
      if (sources[operation]) {
        const [name, key] = sources[operation],
          records = await list(name, key);
        if (operation === "listProducts") {
          const categories = await list("product_categories", "category_id");
          return {
            data: records
              .filter(
                (item) =>
                  !input.category_id ||
                  id(item.category_id) === id(input.category_id),
              )
              .map((item) => ({
                ...item,
                category_name:
                  categories.find(
                    (row) => id(row.category_id) === id(item.category_id),
                  )?.category_name || "",
              })),
          };
        }
        return { data: records.filter((item) => item.is_active !== false) };
      }
      permission(user, "spaces");
      if (operation === "addCategory") {
        const result = await add("product_categories", "category_id", {
          category_name: String(input.category_name || "").trim(),
          description: input.description || "",
          is_active: true,
        });
        return result;
      }
      if (operation === "addProduct") {
        const result = await add("products_services", "product_id", {
          category_id: id(input.category_id),
          item_name: input.item_name,
          unit_price: numeric(input.unit_price),
          stock_quantity: numeric(input.stock_quantity),
        });
        return result;
      }
    }
    if (group === "orders") {
      if (operation === "activeSession") {
        const queryResult = await sdk.getDocs(
          sdk.query(
            ref("space_sessions"),
            sdk.where("customer_id", "==", id(input.customer_id)),
            sdk.where("check_out_time", "==", null),
          ),
        );
        const active = queryResult.docs[0];
        const space =
          active && (await read("study_spaces", active.data().space_id));
        return {
          data: active
            ? {
                session_id: active.id,
                check_in_time: active.data().check_in_time,
                space_name: space?.space_name || "",
              }
            : null,
        };
      }
      if (operation === "list") {
        const [orders, customers, staffList] = await Promise.all([
          list("orders", "order_id"),
          list("customers", "customer_id"),
          list("staff", "staff_id"),
        ]);
        return {
          data: orders
            .map((order) => ({
              ...order,
              customer_name: joinedName(
                customers.find(
                  (item) => id(item.customer_id) === id(order.customer_id),
                ),
              ),
              staff_name: joinedName(
                staffList.find(
                  (item) => id(item.staff_id) === id(order.staff_id),
                ),
              ),
            }))
            .sort((a, b) =>
              String(b.order_datetime).localeCompare(String(a.order_datetime)),
            ),
        };
      }
      if (operation === "getItems") {
        const [items, products, jobs, sizes, printTypes] = await Promise.all([
          list("order_items", "order_item_id"),
          list("products_services", "product_id"),
          list("printing_jobs", "print_job_id"),
          list("paper_sizes", "paper_size_id"),
          list("print_types", "print_type_id"),
        ]);
        return {
          data: items
            .filter((item) => id(item.order_id) === id(input.order_id))
            .map((item) => {
              const job = jobs.find(
                (row) => id(row.order_item_id) === id(item.order_item_id),
              );
              return {
                ...item,
                item_name:
                  products.find(
                    (row) => id(row.product_id) === id(item.product_id),
                  )?.item_name || "",
                ...(job
                  ? {
                      ...job,
                      size_name: sizes.find(
                        (row) =>
                          id(row.paper_size_id) === id(job.paper_size_id),
                      )?.size_name,
                      print_label: printTypes.find(
                        (row) =>
                          id(row.print_type_id) === id(job.print_type_id),
                      )?.label,
                    }
                  : {}),
              };
            }),
        };
      }
      if (operation === "create") {
        permission(user, "orders");
        const items =
          typeof input.items === "string"
            ? JSON.parse(input.items)
            : input.items;
        if (!Array.isArray(items) || !items.length)
          fail("Add at least one product to the order.");
        const products = items.map((item) =>
          ref("products_services", item.product_id),
        );
        const orderRef = sdk.doc(ref("orders")),
          itemRefs = items.map(() => sdk.doc(ref("order_items")));
        const activeSessions = await sdk.getDocs(
          sdk.query(
            ref("space_sessions"),
            sdk.where("customer_id", "==", id(input.customer_id)),
            sdk.where("check_out_time", "==", null),
          ),
        );
        const activeSessionId = activeSessions.docs[0]?.id || null;
        const total = await sdk.runTransaction(db, async (transaction) => {
          const snapshots = await Promise.all(
            products.map((product) => transaction.get(product)),
          );
          const deductions = new Map();
          let amount = 0;
          const orderItems = items.map((item, index) => {
            const product = snapshots[index].data(),
              quantity = Math.max(1, numeric(item.quantity, 1));
            if (!product) fail(`Product #${item.product_id} not found.`);
            const deducted =
              (deductions.get(id(item.product_id))?.quantity || 0) + quantity;
            if (numeric(product.stock_quantity) < deducted)
              fail(`Not enough stock for ${product.item_name}.`);
            deductions.set(id(item.product_id), {
              product,
              quantity: deducted,
            });
            const subtotal = Number(
              (numeric(product.unit_price) * quantity).toFixed(2),
            );
            amount += subtotal;
            return {
              productId: id(item.product_id),
              quantity,
              subtotal,
              printing: item.printing,
            };
          });
          transaction.set(orderRef, {
            order_id: orderRef.id,
            customer_id: id(input.customer_id),
            staff_id: id(input.staff_id),
            session_id: activeSessionId,
            order_datetime: now(),
            total_amount: amount,
          });
          orderItems.forEach((item, index) => {
            transaction.set(itemRefs[index], {
              order_item_id: itemRefs[index].id,
              order_id: orderRef.id,
              product_id: item.productId,
              quantity: item.quantity,
              subtotal: item.subtotal,
            });
            if (item.printing) {
              const printRef = sdk.doc(ref("printing_jobs"));
              transaction.set(printRef, {
                print_job_id: printRef.id,
                order_item_id: itemRefs[index].id,
                paper_size_id: id(item.printing.paper_size_id),
                print_type_id: id(item.printing.print_type_id),
                page_count: numeric(item.printing.page_count, 1),
              });
            }
          });
          deductions.forEach(({ product, quantity }, productId) =>
            transaction.update(ref("products_services", productId), {
              stock_quantity: numeric(product.stock_quantity) - quantity,
            }),
          );
          return amount;
        });
        return { order_id: orderRef.id, total_amount: total };
      }
    }
    if (group === "promotions") {
      const promos = await list("promotions", "promotion_id"),
        today = now().slice(0, 10);
      if (operation === "list")
        return {
          data: promos.sort((a, b) =>
            String(b.valid_to).localeCompare(String(a.valid_to)),
          ),
        };
      if (operation === "validate") {
        const promo = promos.find(
          (item) =>
            item.code ===
              String(input.code || "")
                .trim()
                .toUpperCase() &&
            item.is_active !== false &&
            item.valid_from <= today &&
            item.valid_to >= today,
        );
        if (!promo) fail("That promo code is invalid, expired, or inactive.");
        return { data: promo };
      }
      if (operation === "add") {
        permission(user, "promotions");
        return add("promotions", "promotion_id", {
          code: String(input.code || "")
            .trim()
            .toUpperCase(),
          description: input.description || "",
          discount_type: input.discount_type || "percent",
          discount_value: numeric(input.discount_value),
          valid_from: input.valid_from,
          valid_to: input.valid_to,
          is_active: true,
        });
      }
      if (operation === "deactivateExpired") {
        permission(user, "promotions");
        const expired = promos.filter(
          (item) => item.is_active !== false && item.valid_to < today,
        );
        const batch = sdk.writeBatch(db);
        expired.forEach((item) =>
          batch.update(ref("promotions", item.promotion_id), {
            is_active: false,
          }),
        );
        await batch.commit();
        return { deactivated: expired.length };
      }
    }
    if (group === "notifications") {
      const targetId =
        user.account_type === "staff" ? user.staff_id : user.customer_id;
      const notificationsQuery = sdk.query(
        ref("notifications"),
        sdk.where("recipient_type", "==", user.account_type),
        sdk.where("recipient_id", "==", id(targetId)),
      );
      const notifications = (await sdk.getDocs(notificationsQuery)).docs.map(
        (item) => ({ notification_id: item.id, ...item.data() }),
      );
      if (operation === "list")
        return {
          data: notifications
            .sort((a, b) =>
              String(b.created_at).localeCompare(String(a.created_at)),
            )
            .slice(0, 50),
        };
      const batch = sdk.writeBatch(db);
      notifications
        .filter(
          (item) =>
            !item.is_read &&
            (operation === "markAllRead" ||
              id(item.notification_id) === id(input.notification_id)),
        )
        .forEach((item) =>
          batch.update(ref("notifications", item.notification_id), {
            is_read: true,
          }),
        );
      await batch.commit();
      return {};
    }
    if (group === "billing") return billing(operation, input, user);
    if (group === "payments") return payments(operation, input, user);
    if (group === "reports") return reports(operation, input, user);
    fail("Unknown operation.");
  }

  async function billing(operation, input, user) {
    const transactions = await list("billing_transactions", "transaction_id");
    if (operation === "list") {
      const [customers, promos] = await Promise.all([
        list("customers", "customer_id"),
        list("promotions", "promotion_id"),
      ]);
      return {
        data: transactions.map((item) => ({
          ...item,
          customer_name: joinedName(
            customers.find(
              (row) => id(row.customer_id) === id(item.customer_id),
            ),
          ),
          promo_code:
            promos.find((row) => id(row.promotion_id) === id(item.promotion_id))
              ?.code || "",
        })),
      };
    }
    if (operation === "get")
      return { data: await read("billing_transactions", input.transaction_id) };
    if (operation === "options") {
      const customerId = id(input.customer_id),
        [sessions, orders, extensions, promos] = await Promise.all([
          list("space_sessions", "session_id"),
          list("orders", "order_id"),
          list("session_extensions", "extension_id"),
          list("promotions", "promotion_id"),
        ]);
      const alreadyBilledSession = new Set(
        transactions
          .filter((row) => row.status !== "cancelled")
          .map((row) => id(row.session_id)),
      );
      const alreadyBilledOrder = new Set(
        transactions
          .filter((row) => row.status !== "cancelled")
          .map((row) => id(row.order_id)),
      );
      return {
        sessions: sessions
          .filter(
            (row) =>
              id(row.customer_id) === customerId &&
              row.check_out_time &&
              !alreadyBilledSession.has(id(row.session_id)),
          )
          .map((row) => ({
            session_id: row.session_id,
            check_out_time: row.check_out_time,
            total_amount:
              numeric(row.study_fee) +
              extensions
                .filter((item) => id(item.session_id) === id(row.session_id))
                .reduce(
                  (sum, item) => sum + numeric(item.additional_amount),
                  0,
                ),
          })),
        orders: orders.filter(
          (row) =>
            id(row.customer_id) === customerId &&
            !alreadyBilledOrder.has(id(row.order_id)),
        ),
        promotions: promos.filter(
          (row) =>
            row.is_active !== false &&
            row.valid_from <= now().slice(0, 10) &&
            row.valid_to >= now().slice(0, 10),
        ),
      };
    }
    if (operation === "create") {
      permission(user, "billing");
      const customerId = id(input.customer_id),
        sessionId = input.session_id ? id(input.session_id) : null,
        orderId = input.order_id ? id(input.order_id) : null;
      if (!sessionId && !orderId)
        fail("Provide a session and/or an order to bill.");
      let subtotal = 0,
        reservationId = null;
      if (sessionId) {
        const session = await read("space_sessions", sessionId);
        if (
          !session ||
          id(session.customer_id) !== customerId ||
          !session.check_out_time
        )
          fail(
            "Session must belong to the customer and be checked out before billing.",
          );
        if (
          transactions.some(
            (row) =>
              id(row.session_id) === sessionId && row.status !== "cancelled",
          )
        )
          fail("This session has already been billed.");
        const extensions = await list("session_extensions", "extension_id");
        subtotal +=
          numeric(session.study_fee) +
          extensions
            .filter((row) => id(row.session_id) === sessionId)
            .reduce((sum, row) => sum + numeric(row.additional_amount), 0);
        reservationId = session.reservation_id || null;
      }
      if (orderId) {
        const order = await read("orders", orderId);
        if (!order || id(order.customer_id) !== customerId)
          fail("Order does not belong to this customer.");
        if (
          transactions.some(
            (row) => id(row.order_id) === orderId && row.status !== "cancelled",
          )
        )
          fail("This order has already been billed.");
        subtotal += numeric(order.total_amount);
      }
      let discount = 0,
        promotionId = null;
      if (input.promo_code) {
        const promo = (await list("promotions", "promotion_id")).find(
          (row) =>
            row.code === String(input.promo_code).trim().toUpperCase() &&
            row.is_active !== false &&
            row.valid_from <= now().slice(0, 10) &&
            row.valid_to >= now().slice(0, 10),
        );
        if (!promo) fail("Invalid or expired promo code.");
        promotionId = promo.promotion_id;
        discount =
          promo.discount_type === "percent"
            ? Number(
                ((subtotal * numeric(promo.discount_value)) / 100).toFixed(2),
              )
            : Math.min(subtotal, numeric(promo.discount_value));
      }
      const billingRef = sdk.doc(ref("billing_transactions"));
      const sessionRef = sessionId ? ref("space_sessions", sessionId) : null;
      const orderRef = orderId ? ref("orders", orderId) : null;
      const bill = {
        customer_id: customerId,
        reservation_id: reservationId,
        session_id: sessionId,
        order_id: orderId,
        promotion_id: promotionId,
        subtotal,
        discount_amount: discount,
        total_amount: Number(Math.max(subtotal - discount, 0).toFixed(2)),
        pending_amount: 0,
        verified_amount: 0,
        status: "pending",
        transaction_date: now(),
      };
      await sdk.runTransaction(db, async (transaction) => {
        const sourceRefs = [sessionRef, orderRef].filter(Boolean);
        const sources = await Promise.all(
          sourceRefs.map((sourceRef) => transaction.get(sourceRef)),
        );
        if (sources.some((source) => !source.exists()))
          fail("A session or order selected for billing no longer exists.");
        if (sources.some((source) => source.data().billing_transaction_id))
          fail("A session or order selected for billing was already billed.");
        transaction.set(billingRef, {
          transaction_id: billingRef.id,
          ...bill,
          created_at: now(),
        });
        sourceRefs.forEach((sourceRef) =>
          transaction.update(sourceRef, {
            billing_transaction_id: billingRef.id,
          }),
        );
      });
      return {
        transaction_id: billingRef.id,
        subtotal,
        discount_amount: discount,
        total_amount: Number(Math.max(subtotal - discount, 0).toFixed(2)),
      };
    }
    fail("Unknown operation.");
  }

  async function payments(operation, input, user) {
    const paymentList = await list("payments", "payment_id");
    if (operation === "methods")
      return {
        data: (await list("payment_methods", "payment_method_id")).filter(
          (item) => item.is_active !== false,
        ),
      };
    if (operation === "list") {
      const [customers, methods, staffList] = await Promise.all([
        list("customers", "customer_id"),
        list("payment_methods", "payment_method_id"),
        list("staff", "staff_id"),
      ]);
      return {
        data: paymentList.map((item) => ({
          ...item,
          customer_name: joinedName(
            customers.find(
              (row) => id(row.customer_id) === id(item.customer_id),
            ),
          ),
          payment_method:
            methods.find(
              (row) => id(row.payment_method_id) === id(item.payment_method_id),
            )?.method_name || "",
          verified_by_name: joinedName(
            staffList.find((row) => id(row.staff_id) === id(item.verified_by)),
          ),
        })),
      };
    }
    if (operation === "transactions") {
      const transactions = await list("billing_transactions", "transaction_id");
      return {
        data: transactions
          .filter(
            (row) =>
              id(row.customer_id) === id(input.customer_id) &&
              ["pending", "partially_paid"].includes(row.status),
          )
          .map((row) => ({
            transaction_id: row.transaction_id,
            total_amount: row.total_amount,
            balance_due:
              numeric(row.total_amount) -
              paymentList
                .filter(
                  (item) =>
                    id(item.transaction_id) === id(row.transaction_id) &&
                    ["pending", "verified"].includes(item.payment_status),
                )
                .reduce((sum, item) => sum + numeric(item.amount_paid), 0),
          }))
          .filter((row) => row.balance_due > 0),
      };
    }
    if (operation === "record") {
      permission(user, "payments");
      const transactionRef = ref("billing_transactions", input.transaction_id),
        paymentRef = sdk.doc(ref("payments")),
        amount = numeric(input.amount_paid);
      const reference = `PAY-${now().slice(0, 10).replaceAll("-", "")}-${paymentRef.id}`;
      await sdk.runTransaction(db, async (transaction) => {
        const billing = await transaction.get(transactionRef);
        if (
          !billing.exists() ||
          id(billing.data().customer_id) !== id(input.customer_id)
        )
          fail("Transaction does not belong to this customer.");
        const billingData = billing.data();
        const pendingAmount = numeric(billingData.pending_amount);
        const verifiedAmount = numeric(billingData.verified_amount);
        const balance =
          numeric(billingData.total_amount) - pendingAmount - verifiedAmount;
        if (amount <= 0 || amount > balance)
          fail(
            "Payment amount must be positive and no greater than the remaining balance.",
          );
        transaction.set(paymentRef, {
          payment_id: paymentRef.id,
          customer_id: id(input.customer_id),
          transaction_id: id(input.transaction_id),
          payment_method_id: id(input.payment_method_id),
          amount_paid: amount,
          payment_status: "pending",
          payment_date: now(),
          reference_number: reference,
        });
        transaction.update(transactionRef, {
          pending_amount: pendingAmount + amount,
        });
      });
      await notifyStaff(
        `Payment #${paymentRef.id} (${amount}) needs verification.`,
      );
      return { payment_id: paymentRef.id, reference_number: reference };
    }
    if (operation === "verify" || operation === "reject") {
      permission(user, "payments");
      const paymentRef = ref("payments", input.payment_id),
        payment = await read("payments", input.payment_id);
      if (!payment || payment.payment_status !== "pending")
        fail("Pending payment not found.");
      if (operation === "reject") {
        const transactionRef = ref(
          "billing_transactions",
          payment.transaction_id,
        );
        await sdk.runTransaction(db, async (transaction) => {
          const [livePayment, billing] = await Promise.all([
            transaction.get(paymentRef),
            transaction.get(transactionRef),
          ]);
          if (
            !livePayment.exists() ||
            livePayment.data().payment_status !== "pending"
          )
            fail("Payment has already been processed.");
          if (!billing.exists()) fail("Billing transaction not found.");
          transaction.update(paymentRef, { payment_status: "rejected" });
          transaction.update(transactionRef, {
            pending_amount: Math.max(
              0,
              numeric(billing.data().pending_amount) -
                numeric(payment.amount_paid),
            ),
          });
        });
        return {};
      }
      const transactionRef = ref(
          "billing_transactions",
          payment.transaction_id,
        ),
        receiptRef = ref("receipts", payment.transaction_id);
      await sdk.runTransaction(db, async (transaction) => {
        const [livePayment, billing, receipt] = await Promise.all([
          transaction.get(paymentRef),
          transaction.get(transactionRef),
          transaction.get(receiptRef),
        ]);
        if (
          !livePayment.exists() ||
          livePayment.data().payment_status !== "pending"
        )
          fail("Payment has already been processed.");
        if (!billing.exists()) fail("Billing transaction not found.");
        const billingData = billing.data();
        const paid =
          numeric(billingData.verified_amount) + numeric(payment.amount_paid);
        const status =
          paid >= numeric(billing.data().total_amount)
            ? "paid"
            : "partially_paid";
        transaction.update(paymentRef, {
          payment_status: "verified",
          verified_by: user.staff_id,
        });
        transaction.update(transactionRef, {
          pending_amount: Math.max(
            0,
            numeric(billingData.pending_amount) - numeric(payment.amount_paid),
          ),
          verified_amount: paid,
          status,
        });
        if (status === "paid" && !receipt.exists())
          transaction.set(receiptRef, {
            receipt_id: receiptRef.id,
            transaction_id: payment.transaction_id,
            receipt_number: `RCP-${now().slice(0, 10).replaceAll("-", "")}-${payment.transaction_id}`,
            total_paid: paid,
            created_at: now(),
          });
      });
      await notify(
        "customer",
        payment.customer_id,
        `Your payment of ${payment.amount_paid} has been verified.`,
      );
      return {};
    }
    if (operation === "receipt")
      return { data: await read("receipts", input.transaction_id) };
    fail("Unknown operation.");
  }

  async function reports(operation, input, user) {
    const [
      spaces,
      sessions,
      reservations,
      queue,
      paymentsList,
      customers,
      types,
    ] = await Promise.all([
      list("study_spaces", "space_id"),
      list("space_sessions", "session_id"),
      list("reservations", "reservation_id"),
      list("walkin_queue", "queue_id"),
      list("payments", "payment_id"),
      list("customers", "customer_id"),
      list("space_types", "space_type_id"),
    ]);
    if (operation === "dashboard") {
      const today = now().slice(0, 10);
      return {
        data: {
          occupied: spaces.filter((row) => row.status === "occupied").length,
          available: spaces.filter((row) => row.status === "available").length,
          active_sessions: sessions.filter((row) => !row.check_out_time).length,
          pending_reservations_today: reservations.filter(
            (row) => row.status === "pending" && row.reservation_date === today,
          ).length,
          waiting_walkins: queue.filter((row) => row.status === "waiting")
            .length,
          today_revenue: paymentsList
            .filter(
              (row) =>
                row.payment_status === "verified" &&
                String(row.payment_date).slice(0, 10) === today,
            )
            .reduce((sum, row) => sum + numeric(row.amount_paid), 0),
        },
      };
    }
    if (operation === "spaceAvailability")
      return {
        data: spaces.map((space) => ({
          ...space,
          type_name:
            types.find(
              (type) => id(type.space_type_id) === id(space.space_type_id),
            )?.type_name || "",
          base_rate:
            types.find(
              (type) => id(type.space_type_id) === id(space.space_type_id),
            )?.base_rate || 0,
        })),
      };
    if (operation === "activeSessionsView")
      return {
        data: sessions
          .filter((row) => !row.check_out_time)
          .map((row) => ({
            ...row,
            customer_name: joinedName(
              customers.find(
                (item) => id(item.customer_id) === id(row.customer_id),
              ),
            ),
            space_name:
              spaces.find((item) => id(item.space_id) === id(row.space_id))
                ?.space_name || "",
          })),
      };
    if (operation === "dailyRevenue") {
      const total = {};
      paymentsList
        .filter((row) => row.payment_status === "verified")
        .forEach((row) => {
          const day = String(row.payment_date).slice(0, 10);
          total[day] = (total[day] || 0) + numeric(row.amount_paid);
        });
      return {
        data: Object.entries(total)
          .sort(([a], [b]) => b.localeCompare(a))
          .slice(0, 30)
          .map(([revenue_date, total_collected]) => ({
            revenue_date,
            total_collected,
          })),
      };
    }
    if (operation === "auditLog") {
      permission(user, "reports");
      const logs = await list("audit_log", "audit_id");
      return {
        data: logs
          .filter(
            (row) =>
              (!input.table_name || row.table_name === input.table_name) &&
              (!input.date_from || row.created_at >= input.date_from) &&
              (!input.date_to || row.created_at <= `${input.date_to}T23:59:59`),
          )
          .sort((a, b) =>
            String(b.created_at).localeCompare(String(a.created_at)),
          )
          .slice(0, 300),
      };
    }
    if (operation === "endOfDay") {
      permission(user, "reports");
      const date = input.date || now().slice(0, 10),
        orders = await list("orders", "order_id"),
        items = await list("order_items", "order_item_id"),
        products = await list("products_services", "product_id"),
        bills = await list("billing_transactions", "transaction_id");
      const todaysOrders = orders.filter(
        (row) => String(row.order_datetime).slice(0, 10) === date,
      );
      const topProducts = products
        .map((product) => {
          const matching = items.filter(
            (item) =>
              id(item.product_id) === id(product.product_id) &&
              todaysOrders.some(
                (order) => id(order.order_id) === id(item.order_id),
              ),
          );
          return {
            item_name: product.item_name,
            qty: matching.reduce(
              (sum, item) => sum + numeric(item.quantity),
              0,
            ),
            revenue: matching.reduce(
              (sum, item) => sum + numeric(item.subtotal),
              0,
            ),
          };
        })
        .filter((item) => item.qty)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);
      return {
        data: {
          date,
          revenue: paymentsList
            .filter(
              (row) =>
                row.payment_status === "verified" &&
                String(row.payment_date).slice(0, 10) === date,
            )
            .reduce((sum, row) => sum + numeric(row.amount_paid), 0),
          sessions_count: sessions.filter(
            (row) => String(row.check_in_time).slice(0, 10) === date,
          ).length,
          walkins_count: sessions.filter(
            (row) =>
              String(row.check_in_time).slice(0, 10) === date &&
              !row.reservation_id,
          ).length,
          reserved_count: sessions.filter(
            (row) =>
              String(row.check_in_time).slice(0, 10) === date &&
              row.reservation_id,
          ).length,
          top_products: topProducts,
          outstanding_balances: bills.filter(
            (row) => row.status === "partially_paid",
          ),
        },
      };
    }
    if (operation === "markOverdueNoShows") {
      permission(user, "reports");
      const overdue = reservations.filter(
        (row) =>
          row.status === "confirmed" &&
          !sessions.some(
            (session) => id(session.reservation_id) === id(row.reservation_id),
          ) &&
          dateTime(`${row.reservation_date}T${row.end_time}`) < Date.now(),
      );
      await Promise.all(
        overdue.map((row) =>
          sdk.runTransaction(db, async (transaction) => {
            const reservationRef = ref("reservations", row.reservation_id);
            const spaceRef = ref("study_spaces", row.space_id);
            const [reservation, space] = await Promise.all([
              transaction.get(reservationRef),
              transaction.get(spaceRef),
            ]);
            if (
              !reservation.exists() ||
              reservation.data().status !== "confirmed" ||
              !space.exists()
            )
              return;
            transaction.update(reservationRef, { status: "no_show" });
            transaction.update(spaceRef, {
              status: "available",
              reservation_windows: (
                space.data().reservation_windows || []
              ).filter(
                (item) => id(item.reservation_id) !== id(row.reservation_id),
              ),
            });
          }),
        ),
      );
      return { marked: overdue.length };
    }
    fail("Unknown operation.");
  }

  return async function handle(group, operation, input, context) {
    const user =
      ["login", "memberRegister", "logout", "me"].includes(operation) &&
      group === "auth"
        ? null
        : await currentProfile(context.auth);
    let result;
    if (group === "auth")
      result = await authOperation(operation, input, context);
    else if (group === "customers" || group === "staff")
      result = await customersAndStaff(group, operation, input, user, context);
    else if (group === "spaces") result = await spaces(operation, input, user);
    else if (group === "reservations")
      result = await reservations(operation, input, user);
    else result = await operations(group, operation, input, user);

    const mutations = {
      customers: ["add"],
      staff: ["add", "setStatus"],
      spaces: [
        "addType",
        "addSpace",
        "updateStatus",
        "scheduleMaintenance",
        "completeMaintenance",
      ],
      reservations: ["create", "confirm", "cancel", "noShow"],
      walkin: ["add", "cancel"],
      sessions: ["checkIn", "extendSession", "checkOut"],
      products: ["addCategory", "addProduct"],
      orders: ["create"],
      promotions: ["add", "deactivateExpired"],
      billing: ["create"],
      payments: ["record", "verify", "reject"],
      reports: ["markOverdueNoShows"],
    };
    if (
      user?.account_type === "staff" &&
      mutations[group]?.includes(operation)
    ) {
      const collection =
        group === "spaces"
          ? "study_spaces"
          : group === "walkin"
            ? "walkin_queue"
            : group;
      const recordId =
        result?.reservation_id ||
        result?.session_id ||
        result?.order_id ||
        result?.transaction_id ||
        result?.payment_id ||
        result?.customer_id ||
        result?.staff_id ||
        result?.queue_id ||
        result?.maintenance_id ||
        result?.id ||
        null;
      await writeAudit(
        user,
        operation,
        collection,
        recordId,
        `${operation} via Firebase client`,
      );
    }
    return result;
  };
}

export async function handleFirebaseOperation(
  group,
  operation,
  input,
  context,
) {
  try {
    return await makeApi(context.db, context.firestoreSdk)(
      group,
      operation,
      input,
      context,
    );
  } catch (error) {
    return {
      success: false,
      message: error.message || "Firebase request failed.",
      status: error.status || 400,
    };
  }
}
