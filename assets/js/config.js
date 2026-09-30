// Resolves the API folder relative to wherever this project is served from.
const baseApiUrl = (() => {
  const path = window.location.pathname;
  const dir = path.substring(0, path.lastIndexOf("/"));
  return `${dir}/api`;
})();

const firebaseConfig = {
  apiKey: "AIzaSyAyadwi4cbli0qX2FXuInsxTYPN71dXguY",
  authDomain: "study-hub-bf7e1.firebaseapp.com",
  projectId: "study-hub-bf7e1",
  storageBucket: "study-hub-bf7e1.firebasestorage.app",
  messagingSenderId: "373050932793",
  appId: "1:373050932793:web:9c6a59b7f7edc1114ed7e8",
};

const firebaseReady = (async () => {
  const appSdk =
    await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js");
  const authSdk =
    await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js");
  const firestoreSdk =
    await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
  const firebaseApi = await import("./firebase-api.js");
  const app = appSdk.initializeApp(firebaseConfig);
  const auth = authSdk.getAuth(app);
  const db = firestoreSdk.getFirestore(app);
  if (
    ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
    window.location.port === "5500"
  ) {
    authSdk.connectAuthEmulator(auth, "http://127.0.0.1:9199", {
      disableWarnings: true,
    });
    firestoreSdk.connectFirestoreEmulator(db, "127.0.0.1", 8180);
  }
  await new Promise((resolve) => {
    const unsubscribe = authSdk.onAuthStateChanged(auth, () => {
      unsubscribe();
      resolve();
    });
  });
  return { app, appSdk, auth, authSdk, db, firestoreSdk, firebaseApi };
})();

const themeStorageKey = "study-hub-theme";
let initialTheme = "dark";
try {
  const savedTheme = localStorage.getItem(themeStorageKey);
  if (savedTheme === "light" || savedTheme === "dark")
    initialTheme = savedTheme;
} catch {}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(themeStorageKey, theme);
  } catch {}

  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    button.textContent = theme === "dark" ? "☼" : "☾";
    button.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
    button.title = `Switch to ${nextTheme} theme`;
    button.setAttribute("aria-pressed", String(theme === "light"));
  });
}

applyTheme(initialTheme);
document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const nextTheme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
  });
});

const apiClient = {
  async post(url, formData) {
    try {
      const context = await firebaseReady;
      const payload = Object.fromEntries(formData.entries());
      const group = new URL(url, window.location.href).pathname
        .split("/")
        .pop()
        .replace(/\.php$/, "");
      const result = await context.firebaseApi.handleFirebaseOperation(
        group,
        payload.operation,
        payload,
        { ...context, firebaseConfig },
      );
      const data =
        result.success === undefined ? { success: true, ...result } : result;
      return { status: data.status || (data.success ? 200 : 400), data };
    } catch (err) {
      return {
        status: 0,
        data: { success: false, message: err.message || "Network error." },
      };
    }
  },
};

// Small helper: build a FormData from a plain object, used all over app.js.
function toFormData(obj) {
  const fd = new FormData();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null) fd.append(k, v);
  });
  return fd;
}
