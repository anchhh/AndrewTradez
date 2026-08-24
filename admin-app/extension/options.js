"use strict";

const DEFAULT_API_BASE = "http://localhost:5050";
const DEFAULT_DASHBOARD_BASE = "http://localhost:5173";

async function load() {
  const { apiBase, dashboardBase } = await chrome.storage.sync.get({
    apiBase: DEFAULT_API_BASE,
    dashboardBase: DEFAULT_DASHBOARD_BASE,
  });
  document.getElementById("api-base").value = apiBase;
  document.getElementById("dashboard-base").value = dashboardBase;
}

document.getElementById("save").addEventListener("click", async () => {
  const apiBase = document.getElementById("api-base").value.trim().replace(/\/$/, "") || DEFAULT_API_BASE;
  const dashboardBase = document.getElementById("dashboard-base").value.trim().replace(/\/$/, "") || DEFAULT_DASHBOARD_BASE;
  await chrome.storage.sync.set({ apiBase, dashboardBase });
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => { status.textContent = ""; }, 2000);
});

load();
