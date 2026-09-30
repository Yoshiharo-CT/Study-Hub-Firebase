const assert = require("node:assert/strict");

const projectId = process.env.GCLOUD_PROJECT || "demo-study-hub";
const hostingUrl = "http://127.0.0.1:5500";
const authEmulatorUrl = "http://127.0.0.1:9199";

async function post(path, payload, idToken) {
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const response = await fetch(`${hostingUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  if (process.argv.includes("--routes-only")) {
    const response = await post("/api/customers.php", { operation: "list" });
    assert.equal(response.status, 401, JSON.stringify(response.body));
    assert.equal(response.body.message, "Login required.");
    console.log(
      "Firebase Hosting rewrite and unauthenticated API gate passed.",
    );
    return;
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `firebase-smoke-${suffix}@example.com`;
  const password = "StudyHubSmoke123!";

  const registration = await post("/api/auth.php", {
    operation: "memberRegister",
    first_name: "Firebase",
    last_name: "Smoke",
    phone_number: suffix,
    email,
    password,
  });
  assert.equal(registration.status, 200, JSON.stringify(registration.body));
  assert.equal(registration.body.success, true);
  assert.ok(registration.body.customer_id);

  const login = await fetch(
    `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const authResult = await login.json();
  assert.equal(login.status, 200, JSON.stringify(authResult));
  assert.ok(authResult.idToken);

  const me = await post(
    "/api/auth.php",
    { operation: "me" },
    authResult.idToken,
  );
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.account_type, "customer");
  assert.equal(
    String(me.body.customer.customer_id),
    String(registration.body.customer_id),
  );

  const deniedStaffApi = await post(
    "/api/customers.php",
    { operation: "list" },
    authResult.idToken,
  );
  assert.equal(deniedStaffApi.status, 403, JSON.stringify(deniedStaffApi.body));

  const deniedFirestore = await fetch(
    `http://127.0.0.1:8180/v1/projects/${projectId}/databases/(default)/documents/users/${authResult.localId}`,
  );
  assert.equal(deniedFirestore.status, 403, await deniedFirestore.text());

  console.log(
    "Firebase emulator smoke test passed: signup, Auth token, profile, role gate, Firestore rules.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
