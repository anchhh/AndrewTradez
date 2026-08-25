const project = window.__PROJECT__;
const wasCompleted = project.status === "completed";
let currentName = project.name || "";

const el = (id) => document.getElementById(id);

function setStatus(node, message, kind) {
  node.textContent = message || "";
  node.className = "status" + (kind ? " " + kind : "");
}

document.querySelectorAll(".style-card").forEach((card) => {
  if (project.style === card.dataset.style) {
    card.classList.add("selected");
  }

  card.addEventListener("click", async () => {
    document.querySelectorAll(".style-card").forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");

    const style = card.dataset.style;
    setStatus(el("style-status"), "Saving…");
    await fetch(`/studio/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style }),
    });
    setStatus(
      el("style-status"),
      `Style set to "${card.querySelector(".style-name").textContent}". Video generation isn't wired up yet.`
    );
  });
});

function goBackToCreate() {
  window.location.href = `/studio/create?project=${project.id}`;
}

// Unified "leaving" modal -- same Save / Save as Draft / Don't Save choice as
// the Create Video page, opened by the top Save button, the Next button
// (terminal for now, since there's no page after style selection yet), and a
// trapped browser-back press.
function openLeaveModal() {
  el("modal-name-input").value = currentName;
  setStatus(el("modal-status"), "");
  el("name-modal").classList.remove("hidden");
  el("modal-name-input").focus();
}

function closeLeaveModal() {
  el("name-modal").classList.add("hidden");
}

async function finalizeAndLeave(status) {
  const name = el("modal-name-input").value.trim();
  if (status === "completed" && !name) {
    setStatus(el("modal-status"), "Give this project a name first.", "error");
    return;
  }
  if (name) currentName = name;
  await fetch(`/studio/api/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, name: currentName || "Untitled draft" }),
  });
  window.location.href = "/studio/dashboard";
}

async function discardAndLeave() {
  if (!wasCompleted) {
    await fetch(`/studio/api/projects/${project.id}`, { method: "DELETE" });
  }
  window.location.href = "/studio/dashboard";
}

function trapBrowserBack() {
  history.pushState(null, "", location.href);
  window.addEventListener("popstate", () => {
    history.pushState(null, "", location.href);
    goBackToCreate();
  });
}

el("back-btn").addEventListener("click", goBackToCreate);
el("next-btn").addEventListener("click", openLeaveModal);
el("save-top-btn").addEventListener("click", openLeaveModal);
el("modal-close-btn").addEventListener("click", closeLeaveModal);
el("modal-discard-btn").addEventListener("click", discardAndLeave);
el("modal-draft-btn").addEventListener("click", () => finalizeAndLeave("draft"));
el("modal-save-btn").addEventListener("click", () => finalizeAndLeave("completed"));
el("modal-name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") finalizeAndLeave("completed");
});

trapBrowserBack();
