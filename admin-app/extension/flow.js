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

/* The images, held in the panel as base64 the moment a brief arrives.
 *
 * "Auto download into the extension" is the point: by the time Deploy is
 * pressed, Flow is the active tab and Studio may not even be open, so
 * fetching then would be fetching from a server the user has navigated away
 * from. Pulled once, up front, and Deploy is instant afterwards.
 */
let flowFiles = [];

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
    $("btn-flow-fill").disabled = true;
    setFlowStatus(`Downloading ${flowBrief.images.length} images…`);
    flowFiles = await downloadBrief(flowBrief.images);
    $("btn-flow-fill").disabled = !flowFiles.length;
    setFlowStatus(flowFiles.length === flowBrief.images.length
      ? `${flowFiles.length} images ready. Open your Flow project, then Deploy.`
      : `${flowFiles.length} of ${flowBrief.images.length} images downloaded.`,
      flowFiles.length ? "ok" : "error");
  } catch (err) {
    box.textContent = "";
    setFlowStatus(err.message, "error");
  }
}

/* Bytes, not URLs. A File has to be built from real bytes to be handed to a
 * page, and base64 is what survives being passed across the extension
 * boundary into an injected function. */
async function downloadBrief(urls) {
  const files = [];
  for (const url of urls) {
    try {
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
    } catch (err) {
      // One missing image should not lose the other ten.
    }
  }
  return files;
}

/* Runs INSIDE the Flow page. It can see nothing from this panel's scope, so
 * everything it needs is passed in.
 *
 * Async on purpose: attaching to the prompt sometimes means opening the
 * composer's own picker first, and that needs a beat before the input it
 * reveals exists.
 */
async function fillFlowPage(prompt, files) {
  const found = { prompt: null, fileInput: null, added: 0, via: null };
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));

  const visible = (el) => el && el.offsetParent !== null;

  // The prompt box: the widest visible thing you can type into.
  const box = [
    ...document.querySelectorAll("textarea"),
    ...document.querySelectorAll('[contenteditable="true"]'),
    ...document.querySelectorAll('input[type="text"]'),
  ].filter(visible).sort(
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

  /* Which file input to feed.
   *
   * NOT simply the first one on the page: that is the library uploader, and
   * feeding it puts the images in Flow's asset shelf rather than on the
   * prompt -- which is exactly what happened the first time this ran. The
   * one that matters belongs to the composer, so the search starts at the
   * prompt box and walks outward, taking the nearest.
   */
  function inputNear(node) {
    let scope = node;
    for (let up = 0; scope && up < 8; up += 1) {
      // Stop before the document itself. Walking as far as <body> finds
      // EVERY file input on the page, including the library uploader, and
      // then reports it as "the composer" -- which is exactly how the first
      // run put the images in Flow's asset shelf instead of on the prompt.
      if (scope === document.body || scope === document.documentElement) return null;
      const input = [...scope.querySelectorAll('input[type="file"]')].pop();
      if (input) return input;
      scope = scope.parentElement;
    }
    return null;
  }

  let input = box ? inputNear(box.parentElement) : null;
  if (input) found.via = "the composer";

  // Still nothing: the composer's picker is usually behind a "+", and the
  // input it owns may not exist until that is pressed.
  if (!input && box) {
    let scope = box.parentElement;
    for (let up = 0; scope && up < 6 && !input; up += 1) {
      const opener = [...scope.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find((el) => /add|attach|upload|image|reference|\+/i.test(
          (el.getAttribute("aria-label") || "") + " " + (el.textContent || "").trim()));
      if (opener) {
        opener.click();
        await wait(600);
        input = inputNear(box.parentElement);
        if (input) found.via = `the "${(opener.getAttribute("aria-label") ||
          opener.textContent || "+").trim().slice(0, 24)}" button`;
      }
      scope = scope.parentElement;
    }
  }

  // Nothing near the prompt. The page-wide input is NOT used as a fallback:
  // on Flow that is the library uploader, and quietly filling it looks like
  // success while putting the images somewhere they do nothing. Better to
  // say so and let the selector be fixed.
  if (!input) {
    found.via = null;
  }

  if (input) {
    found.fileInput = input.getAttribute("accept") || "any";
    // DataTransfer is the only way to hand a page a File it did not choose
    // itself.
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

    // Some composers listen for a drop rather than for the input, so the
    // same files are offered that way too. Harmless when unhandled.
    const target = input.closest("form, [role='textbox']") || box || input;
    ["dragenter", "dragover", "drop"].forEach((name) =>
      target.dispatchEvent(new DragEvent(name, {
        bubbles: true, cancelable: true, dataTransfer: data,
      })));
  }

  return found;
}

async function fillFlow() {
  if (!flowBrief || !flowFiles.length) return;
  const button = $("btn-flow-fill");
  button.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/labs\.google\//.test(tab.url || "")) {
      throw new Error("Open your Flow project in this window's active tab, " +
                      "then press Deploy.");
    }

    setFlowStatus("Deploying…");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillFlowPage,
      args: [flowBrief.prompt, flowFiles],
    });

    const found = (result || {}).result || {};
    if (!found.fileInput) {
      throw new Error(found.prompt
        ? `Typed the prompt into the ${found.prompt}, but couldn't find the ` +
          `attachment box on the composer. Open its "+" yourself, then press ` +
          `Deploy again.`
        : "Couldn't find a prompt box or an attachment box on that page. " +
          "Open the panel where you would normally type the prompt, then " +
          "press Deploy again.");
    }
    setFlowStatus(
      `${found.added} image${found.added === 1 ? "" : "s"} attached via ` +
        `${found.via || "an unknown input"}` +
        (found.prompt ? `, prompt typed into the ${found.prompt}` : "") +
        ". Check the attachments, then send it yourself.",
      "ok");
  } catch (err) {
    setFlowStatus(err.message, "error");
  }
  button.disabled = false;
}

/* ---------- the shot coming back ---------- */

function setReturnStatus(text, kind) {
  const el = $("flow-return-status");
  el.textContent = text || "";
  el.className = kind || "";
}

async function returnShot(file) {
  if (!file) return;
  if (!flowBrief) {
    setReturnStatus("No brief loaded, so there is nothing to file this " +
                    "against.", "error");
    return;
  }
  if (!/^image\//.test(file.type)) {
    setReturnStatus("That isn't an image.", "error");
    return;
  }

  setReturnStatus("Sending it back to Studio…");
  try {
    const data = await new Promise((done, fail) => {
      const reader = new FileReader();
      reader.onload = () => done(reader.result);
      reader.onerror = () => fail(new Error("that file couldn't be read"));
      reader.readAsDataURL(file);
    });

    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/leads/${flowBrief.lead_id}/flow-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
      body: JSON.stringify({ side: flowBrief.side, image: data }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Studio refused it (${res.status})`);

    setReturnStatus(`Filed as the ${flowBrief.side} shot. The drone step will ` +
                    `fly from it.`, "ok");
  } catch (err) {
    setReturnStatus(err.message, "error");
  }
}

$("flow-return-file").addEventListener("change", (e) => {
  returnShot(e.target.files[0]);
  e.target.value = "";
});

const flowDrop = $("flow-drop");
["dragenter", "dragover"].forEach((name) =>
  flowDrop.addEventListener(name, (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    flowDrop.classList.add("is-over");
  }));
["dragleave", "drop"].forEach((name) =>
  flowDrop.addEventListener(name, () => flowDrop.classList.remove("is-over")));
flowDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  returnShot((e.dataTransfer.files || [])[0]);
});

$("btn-flow-fill").addEventListener("click", fillFlow);
