"use strict";

const DEFAULT_API_BASE = "http://127.0.0.1:5051";
const DEFAULT_DASHBOARD_BASE = "http://127.0.0.1:5051/studio/dashboard";

async function load() {
  const { apiBase, dashboardBase, authUser, authPass, apiKey } = await chrome.storage.sync.get({
    apiBase: DEFAULT_API_BASE,
    dashboardBase: DEFAULT_DASHBOARD_BASE,
    authUser: "",
    authPass: "",
    apiKey: "",
  });
  document.getElementById("api-base").value = apiBase;
  document.getElementById("dashboard-base").value = dashboardBase;
  document.getElementById("auth-user").value = authUser;
  document.getElementById("auth-pass").value = authPass;
  document.getElementById("api-key").value = apiKey;
}

document.getElementById("save").addEventListener("click", async () => {
  const apiBase = document.getElementById("api-base").value.trim().replace(/\/$/, "") || DEFAULT_API_BASE;
  const dashboardBase = document.getElementById("dashboard-base").value.trim().replace(/\/$/, "") || DEFAULT_DASHBOARD_BASE;
  const authUser = document.getElementById("auth-user").value.trim();
  const authPass = document.getElementById("auth-pass").value;
  const apiKey = document.getElementById("api-key").value.trim();
  await chrome.storage.sync.set({ apiBase, dashboardBase, authUser, authPass, apiKey });
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => { status.textContent = ""; }, 2000);
});

load();
