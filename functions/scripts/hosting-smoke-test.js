const assert = require("node:assert/strict");

const baseUrl = "http://127.0.0.1:5500";

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response.text();
}

async function main() {
  const [login, config, api] = await Promise.all([
    get("/login.html"),
    get("/assets/js/config.js"),
    get("/assets/js/firebase-api.js"),
  ]);
  assert.match(login, /Email address or staff username/);
  assert.match(config, /firebase-firestore\.js/);
  assert.match(api, /handleFirebaseOperation/);
  assert.doesNotMatch(config, /fetch\(/);
  console.log("Firebase Spark Hosting assets smoke test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
