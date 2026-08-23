"use strict";

const DEFAULT_API_BASE = "http://localhost:5050";

async function load() {
  const { apiBase } = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE });
  document.getElementById("api-base").value = apiBase;
}

document.getElementById("save").addEventListener("click", async () => {
  const value = document.getElementById("api-base").value.trim().replace(/\/$/, "") || DEFAULT_API_BASE;
  await chrome.storage.sync.set({ apiBase: value });
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => { status.textContent = ""; }, 2000);
});

load();
