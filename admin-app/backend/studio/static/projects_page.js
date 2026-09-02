/* Projects, arranged like files.

   A project is a lead that is qualified OR filed into a folder -- the same
   set the dashboard counts -- shown as a tile with its own photo rather than
   a row, and grouped into folders that hold several listings.

   Filing counts on its own, or a lead dragged into a folder without being
   qualified would disappear: the folder would say it holds two things and
   show nothing.

   Folders are flat: they hold projects, not other folders. Nesting is the
   part of a file tree that needs move-into-descendant guards and recursive
   deletes, and for a few dozen listings it buys nothing. */

let folders = [];
let projects = [];
let openFolder = null;          // folder id, or null for the top level
const selected = new Set();

const el = (id) => document.getElementById(id);

function thumbOf(lead) {
  return lead.thumbnail_url || (lead.photo_urls || [])[0] || "";
}

function place(lead) {
  return [lead.city, lead.state].filter(Boolean).join(", ");
}

async function loadProjects() {
  try {
    const [leadList, folderList] = await Promise.all([
      // Every lead, because the filter is no longer just "qualified".
      fetchJSON("/studio/api/leads"),
      fetchJSON("/studio/api/folders"),
    ]);
    projects = (leadList || []).filter(
      (l) => (l.qualified || l.folder_id) && l.status !== "dead");
    folders = folderList.folders || [];
  } catch (err) {
    el("pj-empty").textContent = "Couldn't load projects.";
    el("pj-empty").classList.remove("hidden");
    return;
  }
  render();
}

function render() {
  const inFolder = openFolder != null;
  const folder = folders.find((f) => f.id === openFolder);
  // A folder deleted elsewhere should not strand the page inside it.
  if (inFolder && !folder) {
    openFolder = null;
    return render();
  }

  el("pj-title").textContent = folder ? folder.name : "Projects";

  // Breadcrumbs only once there is somewhere to go back to.
  const crumbs = el("pj-crumbs");
  crumbs.hidden = !folder;
  if (folder) {
    // A real button rather than a breadcrumb link. The title changes to the
    // folder name inside one, so without an obvious way out the page reads
    // like the whole Projects page emptied itself.
    crumbs.innerHTML =
      '<button type="button" class="pj-back" data-up="1">' +
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
      '<path d="M9.5 3.5 5 8l4.5 4.5" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      'Back to projects</button>' +
      '<span class="pj-crumb-sep">/</span>' +
      '<span class="pj-crumb is-current">' + escapeHtml(folder.name) + "</span>" +
      '<span class="pj-crumb-actions">' +
      '<button type="button" class="pj-linkbtn" id="pj-rename">Rename</button>' +
      '<button type="button" class="pj-linkbtn" id="pj-delete">Delete folder</button>' +
      "</span>";
    crumbs.querySelector("[data-up]").addEventListener("click", leaveFolder);
    el("pj-rename").addEventListener("click", () => renameFolder(folder));
    el("pj-delete").addEventListener("click", () => deleteFolder(folder));
  }

  // Folders are a top-level idea, so they are not shown from inside one.
  el("pj-folders-wrap").hidden = inFolder || !folders.length;
  if (!inFolder) el("pj-folders").innerHTML = folders.map(folderTile).join("");

  const shown = projects.filter((p) =>
    inFolder ? p.folder_id === openFolder : !p.folder_id);

  el("pj-projects-head").textContent = inFolder ? "In this folder" : "Projects";
  el("pj-grid").innerHTML = shown.map(projectTile).join("");
  el("pj-empty").classList.toggle("hidden", shown.length > 0);
  el("pj-empty").textContent = inFolder
    ? "Nothing in this folder yet — drag a project onto it, or use Move to."
    : (projects.length
      ? "Everything is filed away in a folder."
      : "No active projects — mark a lead qualified, or file one into a "
        + "folder from its row menu.");

  wireTiles();
  renderSelection();
}

function leaveFolder() {
  if (openFolder == null) return;
  openFolder = null;
  selected.clear();
  render();
}

// Escape leaves a folder too, since going in was a click and going out
// should not have to be aimed at.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") leaveFolder();
});

function folderTile(f) {
  return `
    <button type="button" class="pj-folder" data-folder="${f.id}">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h9a1.5 1.5 0 0 1 1.5 1.5v7.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"
              fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linejoin="round"/></svg>
      <span class="pj-folder-name">${escapeHtml(f.name)}</span>
      <span class="pj-folder-count">${f.count || 0}</span>
    </button>`;
}

function projectTile(p) {
  const thumb = thumbOf(p);
  const on = selected.has(p.id);
  return `
    <div class="pj-card${on ? " is-selected" : ""}" data-id="${p.id}" draggable="true">
      <label class="pj-check" title="Select">
        <input type="checkbox" ${on ? "checked" : ""}>
      </label>
      <div class="pj-thumb">
        ${thumb
          ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy">`
          : '<span class="pj-thumb-none">No photo</span>'}
      </div>
      <div class="pj-body">
        <span class="pj-name">${escapeHtml(p.address || "Untitled")}</span>
        <span class="pj-sub">${escapeHtml([place(p), p.agent_name]
          .filter(Boolean).join(" · "))}</span>
      </div>
    </div>`;
}

/* ---------- interaction ---------- */

function wireTiles() {
  el("pj-folders").querySelectorAll(".pj-folder").forEach((tile) => {
    const id = Number(tile.dataset.folder);
    tile.addEventListener("click", () => {
      openFolder = id;
      selected.clear();
      render();
    });
    // Dropping onto a folder is the quickest way to file something, and the
    // reason the cards are draggable at all.
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      tile.classList.add("is-drop");
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("is-drop"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      tile.classList.remove("is-drop");
      const dragged = Number(e.dataTransfer.getData("text/plain"));
      // Dragging one of several selected cards moves the whole selection,
      // which is what dragging a selection does everywhere else.
      const ids = selected.has(dragged) ? [...selected] : [dragged];
      moveTo(ids, id);
    });
  });

  el("pj-grid").querySelectorAll(".pj-card").forEach((card) => {
    const id = Number(card.dataset.id);

    card.addEventListener("click", (e) => {
      if (e.target.closest(".pj-check")) return;   // selecting, not opening
      window.location.href = "/studio/leads/" + id;
    });
    card.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selected.add(id);
      else selected.delete(id);
      card.classList.toggle("is-selected", e.target.checked);
      renderSelection();
    });
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(id));
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
  });
}

function renderSelection() {
  const bar = el("pj-selbar");
  bar.hidden = selected.size === 0;
  if (!selected.size) return;

  el("pj-selcount").textContent = `${selected.size} selected`;

  const move = el("pj-move");
  move.innerHTML =
    '<option value="">Choose…</option>' +
    (openFolder != null ? '<option value="root">Projects (top level)</option>' : "") +
    folders.filter((f) => f.id !== openFolder)
      .map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("");
  move.value = "";
  move.onchange = () => {
    if (!move.value) return;
    moveTo([...selected], move.value === "root" ? null : Number(move.value));
  };
}

el("pj-clearsel").addEventListener("click", () => {
  selected.clear();
  render();
});

async function moveTo(leadIds, folderId) {
  try {
    const res = await fetch("/studio/api/folders/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_ids: leadIds, folder_id: folderId }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Couldn't move that.");
  } catch (err) {
    alert(err.message);
    return;
  }
  selected.clear();
  await loadProjects();
}

el("pj-new-folder").addEventListener("click", async () => {
  const name = prompt("Name this folder");
  if (!name || !name.trim()) return;
  try {
    const res = await fetch("/studio/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Couldn't create it.");
  } catch (err) {
    alert(err.message);
    return;
  }
  await loadProjects();
});

async function renameFolder(folder) {
  const name = prompt("Rename folder", folder.name);
  if (!name || !name.trim() || name.trim() === folder.name) return;
  await fetch(`/studio/api/folders/${folder.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadProjects();
}

async function deleteFolder(folder) {
  // Said plainly, because "delete" next to a folder full of work reads as
  // though the work goes with it.
  const inside = projects.filter((p) => p.folder_id === folder.id).length;
  const warning = inside
    ? `Delete "${folder.name}"? The ${inside} project${inside === 1 ? "" : "s"} inside `
      + "go back to the top level — nothing is deleted."
    : `Delete "${folder.name}"?`;
  if (!confirm(warning)) return;
  await fetch(`/studio/api/folders/${folder.id}`, { method: "DELETE" });
  openFolder = null;
  await loadProjects();
}

loadProjects();
