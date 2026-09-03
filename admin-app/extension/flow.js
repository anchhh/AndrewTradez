"use strict";

/* The Flow tab.
 *
 * Studio can open Flow and hand you files; it cannot put them INTO Flow,
 * because one origin may not touch another's app. An extension may, and that
 * is the whole reason this tab exists.
 *
 * Deliberately a button rather than a watcher. Nothing happens until it is
 * pressed, it only ever touches the tab you are looking at, and it stops
 * after filling -- pressing Generate stays yours. That is the line between
 * shortening a manual job and running someone else's product unattended.
 *
 * The selectors in fillFlowPage are a guess at Flow's markup. Flow is not
 * documented and its DOM will change, so a failure reports what it DID find
 * rather than only saying no -- that is what makes the next fix a two-minute
 * one instead of an investigation.
 */

let flowBrief = null;

function setFlowStatus(text, kind) {
  const el = $("flow-status");
  el.textContent = text || "";
  el.className = kind || "";
}

function escapeText(value) {
  const node = document.createElement("div");
  node.textContent = value == null ? "" : String(value);
  return node.innerHTML;
}

async function loadFlowBrief() {
  const box = $("flow-brief");
  box.textContent = "Looking for a brief…";
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/leads/flow-brief`, {
      headers: await getAuthHeaders(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Couldn't read it (${res.status})`);

    flowBrief = body.brief;
    if (!flowBrief) {
      box.textContent = "Nothing queued. In Studio, open the Generate step " +
        "and press Open in Flow for the front or the back.";
      $("flow-shots").innerHTML = "";
      $("btn-flow-fill").disabled = true;
      return;
    }

    box.innerHTML = `
      <strong>${escapeText(flowBrief.address)}</strong>
      ${escapeText(flowBrief.side)} — ${flowBrief.images.length} images
      <div class="flow-prompt">${escapeText(flowBrief.prompt)}</div>`;
    $("flow-shots").innerHTML = flowBrief.images
      .map((url) => `<img src="${url}" alt="">`).join("");
    $("btn-flow-fill").disabled = false;
    setFlowStatus("");
  } catch (err) {
    box.textContent = "";
    setFlowStatus(err.message, "error");
  }
}

/* Runs INSIDE the Flow page. It can see nothing from this panel's scope, so
 * everything it needs is passed in. */
function fillFlowPage(prompt, files) {
  const found = { prompt: null, fileInput: null, added: 0 };

  // The prompt box. Flow's markup is not documented, so this tries the
  // shapes a prompt box takes, prefers the widest visible one, and reports
  // which it matched.
  const candidates = [
    ...document.querySelectorAll("textarea"),
    ...document.querySelectorAll('[contenteditable="true"]'),
    ...document.querySelectorAll('input[type="text"]'),
  ].filter((el) => el.offsetParent !== null);

  const box = candidates.sort(
    (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];

  if (box) {
    found.prompt = box.tagName.toLowerCase() +
      (box.getAttribute("placeholder") ? ` ("${box.getAttribute("placeholder")}")` : "");
    if (box.isContentEditable) {
      box.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, prompt);
    } else {
      // React and friends listen to the native setter, not to .value, so a
      // plain assignment types into a field the app never notices.
      const proto = box instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(box, prompt);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // The images. A file input is fed through DataTransfer, which is the only
  // way to hand a page a File it did not choose itself.
  const input = document.querySelector('input[type="file"]');
  if (input) {
    found.fileInput = input.getAttribute("accept") || "any";
    const data = new DataTransfer();
    files.forEach((file) => {
      const binary = atob(file.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      data.items.add(new File([bytes], file.name, { type: file.type }));
      found.added += 1;
    });
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return found;
}

async function fillFlow() {
  if (!flowBrief) return;
  const button = $("btn-flow-fill");
  button.disabled = true;
  setFlowStatus("Reading the images…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/labs\.google\//.test(tab.url || "")) {
      throw new Error("Open Flow in this window's active tab first, then press this.");
    }

    // Fetched here rather than in the page: the images live on the Studio
    // server, and a fetch from labs.google to it would be blocked.
    const files = [];
    for (const url of flowBrief.images) {
      const res = await fetch(url);
      const blob = await res.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      files.push({
        name: url.split("/").pop(),
        type: blob.type || "image/png",
        data: btoa(binary),
      });
    }

    setFlowStatus("Filling Flow…");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillFlowPage,
      args: [flowBrief.prompt, files],
    });

    const found = (result || {}).result || {};
    if (!found.prompt && !found.fileInput) {
      throw new Error("Couldn't find a prompt box or a file input on that " +
        "page. Open the panel where you would normally type the prompt, " +
        "then try again.");
    }
    setFlowStatus(
      `${found.added} image${found.added === 1 ? "" : "s"} attached` +
        (found.prompt ? `, prompt typed into the ${found.prompt}` : "") +
        ". Check it, then press Generate yourself.",
      "ok");
  } catch (err) {
    setFlowStatus(err.message, "error");
  }
  button.disabled = false;
}

$("btn-flow-fill").addEventListener("click", fillFlow);
