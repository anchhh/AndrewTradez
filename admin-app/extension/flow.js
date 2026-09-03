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
  /* Written against what the page actually reports, not against a guess.
   *
   *   FILE INPUTS (1)
   *     [0] accept="image/*" visible=false
   *         at div#__next > div.sc-…> input.sc-…
   *   TYPABLE (1)
   *     [0] div  w=566            <- contenteditable, not a textarea
   *   CONTROLS NEAR THE PROMPT
   *     "add_2Create"  "Agent"  "Nano Banana Pro…"  "arrow_forwardCreate"
   *
   * One hidden input for the whole page means attaching is not a second
   * upload -- it is the SAME input, reached through the composer's "+".
   * Feeding it cold is what put the images in the library twice. So the
   * order matters: press "+", take whatever it offers, and only then hand
   * over the files.
   *
   * Every step is reported, so a failure says which one stopped rather than
   * leaving another round of guessing.
   */
  const steps = [];
  const found = { prompt: null, fileInput: null, added: 0, via: null, steps };
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const visible = (el) => el && el.offsetParent !== null;
  const labelOf = (el) =>
    ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).trim();

  // ---- the prompt: a contenteditable, so execCommand rather than .value
  const box = [
    ...document.querySelectorAll('[contenteditable="true"]'),
    ...document.querySelectorAll("textarea"),
  ].filter(visible).sort(
    (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];

  if (box) {
    found.prompt = box.isContentEditable ? "contenteditable" : "textarea";
    box.focus();
    if (box.isContentEditable) {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, prompt);
    } else {
      const proto = box instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(box, prompt);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    steps.push("prompt typed");
  } else {
    steps.push("no prompt box found");
  }

  // ---- the "+" beside the prompt. Its text is the icon ligature plus a
  // label, which is why it reads as "add_2Create".
  let scope = box ? box.parentElement : document.body;
  for (let up = 0; up < 5 && scope && scope !== document.body; up += 1) {
    scope = scope.parentElement;
  }
  const plus = [...(scope || document).querySelectorAll('button, [role="button"]')]
    .filter(visible)
    // The label is an icon ligature run together with the button's
    // text -- "add_2Create" -- so there is no word boundary after the
    // icon to anchor on. Matching the start is what works.
    .find((el) => /^\s*add(_\d+)?/i.test(labelOf(el)) ||
                  /add reference|add image|attach/i.test(labelOf(el)));

  if (plus) {
    plus.click();
    steps.push(`pressed "${labelOf(plus).slice(0, 24)}"`);
    await wait(700);
  } else {
    steps.push("no + button found beside the prompt");
  }

  // ---- whatever that opened. Usually a menu with an upload item; taking it
  // is what tells the app the files belong to the prompt.
  const menuItem = [...document.querySelectorAll(
    '[role="menuitem"], [role="option"], [role="dialog"] button, [role="menu"] button')]
    .filter(visible)
    .find((el) => /upload|computer|device|from file|browse|add image/i.test(labelOf(el)));

  if (menuItem) {
    menuItem.click();
    steps.push(`chose "${labelOf(menuItem).slice(0, 24)}"`);
    found.via = `the composer's "${labelOf(menuItem).slice(0, 24)}"`;
    await wait(500);
  } else if (plus) {
    steps.push("no upload item in what the + opened");
    found.via = "the composer's plus button";
  }

  // ---- and now the input, which by this point the composer is listening to.
  const input = [...document.querySelectorAll('input[type="file"]')]
    .find((el) => (el.getAttribute("accept") || "").includes("image")) ||
    document.querySelector('input[type="file"]');

  if (!input) {
    steps.push("no file input on the page at all");
    return found;
  }

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
  steps.push(`${found.added} files handed to the input`);

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
    if (found.steps) console.log("[Estly] Flow steps:", found.steps.join(" → "));
    if (!found.fileInput) {
      throw new Error(found.prompt
        ? `Typed the prompt into the ${found.prompt}, but couldn't find the ` +
          `attachment box on the composer. Open its "+" yourself, then press ` +
          `Deploy again.`
        : "Couldn't find a prompt box or an attachment box on that page. " +
          "Open the panel where you would normally type the prompt, then " +
          "press Deploy again.");
    }
    // The steps are the message. When this lands in the library again, the
    // line says which stage did not happen rather than claiming success.
    setFlowStatus((found.steps || []).join(" → ") +
      ". Check whether they attached to the prompt or went to the library.",
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

/* ---------- looking at the page, when the guesswork is wrong ----------

   Flow's markup is undocumented and this script has now guessed it wrong
   twice: first taking the library uploader for the composer's, then finding
   nothing at all where the attachment box should be. Guessing a third time
   is not a plan.

   So this reports what is actually there -- every file input with where it
   sits, the prompt box's ancestry, the controls around it, and any dialog
   that is open -- in a form that can be pasted straight back. It reads and
   changes nothing. */

function inspectFlowPage() {
  const lines = [];
  const say = (text) => lines.push(text);

  const path = (el, depth = 5) => {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < depth && node !== document.body; i += 1) {
      const id = node.id ? `#${node.id}` : "";
      const cls = (node.className && typeof node.className === "string")
        ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
      parts.unshift(node.tagName.toLowerCase() + id + cls);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const attrs = (el, names) => names
    .map((name) => (el.getAttribute(name) ? `${name}="${el.getAttribute(name)}"` : ""))
    .filter(Boolean).join(" ");

  say(`URL ${location.pathname}`);

  const inputs = [...document.querySelectorAll('input[type="file"]')];
  say(`\nFILE INPUTS (${inputs.length})`);
  inputs.forEach((el, i) => {
    say(`  [${i}] ${attrs(el, ["accept", "multiple", "name", "id", "aria-label"]) || "no attributes"}`);
    say(`      visible=${el.offsetParent !== null} at ${path(el)}`);
  });

  const typables = [
    ...document.querySelectorAll("textarea"),
    ...document.querySelectorAll('[contenteditable="true"]'),
  ].filter((el) => el.offsetParent !== null);
  say(`\nTYPABLE (${typables.length})`);
  typables.forEach((el, i) => {
    say(`  [${i}] ${el.tagName.toLowerCase()} ${attrs(el, ["placeholder", "aria-label", "id"])}`);
    say(`      w=${Math.round(el.getBoundingClientRect().width)} at ${path(el)}`);
  });

  // Everything clickable near the widest typable thing, which is where an
  // "attach" control would live.
  const box = typables.sort(
    (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (box) {
    let scope = box.parentElement;
    for (let up = 0; up < 4 && scope && scope !== document.body; up += 1) {
      scope = scope.parentElement;
    }
    const near = [...(scope || document).querySelectorAll('button, [role="button"]')]
      .filter((el) => el.offsetParent !== null)
      .slice(0, 25);
    say(`\nCONTROLS NEAR THE PROMPT (${near.length})`);
    near.forEach((el, i) => {
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      say(`  [${i}] "${label.slice(0, 40)}" ${attrs(el, ["id", "data-testid", "title"])}`);
    });
  }

  const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    .filter((el) => el.offsetParent !== null);
  say(`\nOPEN DIALOGS ${dialogs.length}`);
  dialogs.forEach((el, i) => say(`  [${i}] ${path(el, 3)}`));

  return lines.join("\n");
}

async function lookAtFlow() {
  const report = $("flow-report");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/labs\.google\//.test(tab.url || "")) {
      throw new Error("Open Flow in this window's active tab first.");
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: inspectFlowPage,
    });
    report.value = (result || {}).result || "(nothing came back)";
    report.hidden = false;
    try {
      await navigator.clipboard.writeText(report.value);
      setFlowStatus("Copied. Paste it back and the selectors can be fixed.", "ok");
    } catch (err) {
      setFlowStatus("Select the text below and copy it.", "ok");
    }
  } catch (err) {
    setFlowStatus(err.message, "error");
  }
}

$("btn-flow-look").addEventListener("click", lookAtFlow);
