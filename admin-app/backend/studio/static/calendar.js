/* The calendar: a month of Calendly bookings, plus what is coming next.

   Read-only, like the dashboard panel. Booking, moving and cancelling all
   stay in Calendly, because those are the actions the invitee also has a
   stake in and Calendly is what tells them.

   The month shown is a LOCAL month. Calendly stores instants in UTC, so the
   boundaries are computed here and sent as instants -- a month asked for by
   name would be somebody else's month for part of the day. */

let viewMonth = startOfMonth(new Date());
let monthEvents = [];
let selectedDay = null;   // a local Date at midnight, or null for "next up"

function startOfMonth(d) {
  const m = new Date(d);
  m.setDate(1);
  m.setHours(0, 0, 0, 0);
  return m;
}

function addMonths(d, n) {
  const m = new Date(d);
  m.setMonth(m.getMonth() + n);
  return m;
}

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
  && a.getDate() === b.getDate();

const timeOf = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/* Monday-first, and always six rows: a grid that changes height as you page
   through the year makes the whole layout jump. */
function gridDays(month) {
  const first = startOfMonth(month);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
}

async function loadMonth() {
  const days = gridDays(viewMonth);
  const from = days[0];
  const to = new Date(days[41]);
  to.setHours(23, 59, 59, 999);

  const notice = document.getElementById("cal-notice");
  let data;
  try {
    const res = await fetch(`/studio/api/calendly/events?from=${from.toISOString()}`
                            + `&to=${to.toISOString()}`);
    data = await res.json();
  } catch (err) {
    notice.textContent = "Couldn't reach Calendly.";
    notice.classList.remove("hidden");
    return;
  }

  if (!data.configured) {
    notice.innerHTML = `Calendly isn't connected. Paste a personal access token
      into <code>studio/calendly.json</code> as <code>{"token": "…"}</code>
      and reload.`;
    notice.classList.remove("hidden");
    monthEvents = [];
  } else if (data.error) {
    notice.textContent = data.error;
    notice.classList.remove("hidden");
    monthEvents = [];
  } else {
    notice.classList.add("hidden");
    monthEvents = data.events || [];
  }

  renderMonth();
  renderSide();
  showInviteLinks();
}

/* ---------- links to share ----------

   Each bookable meeting type on the account, with the link that lets someone
   pick their own slot. Read from Calendly rather than written down here, so
   renaming one or adding a second shows up without an edit. */
async function showInviteLinks() {
  const panel = document.getElementById("cal-invite");
  const box = document.getElementById("cal-links");
  if (!panel || !box) return;

  let data;
  try {
    const res = await fetch("/studio/api/calendly/links");
    data = await res.json();
  } catch (err) {
    return;   // The calendar itself already says when Calendly is unreachable.
  }
  if (!data.configured || !(data.links || []).length) return;

  panel.hidden = false;
  box.innerHTML = data.links.map((link, i) => `
    <div class="cal-link" data-i="${i}">
      <div class="cal-link-main">
        <span class="cal-link-name">${escapeHtml(link.name)}</span>
        <span class="cal-link-meta">${link.duration ? link.duration + " min · " : ""}${
          escapeHtml(link.url)}</span>
      </div>
      <div class="cal-link-actions">
        <button type="button" class="btn-secondary btn-tiny cal-copy">Copy link</button>
        <a class="btn-secondary btn-tiny" href="${escapeHtml(mailtoFor(link))}">Email it</a>
        <a class="btn-secondary btn-tiny" href="${escapeHtml(link.url)}"
           target="_blank" rel="noopener">Preview</a>
      </div>
    </div>`).join("");

  box.querySelectorAll(".cal-link").forEach((row) => {
    const link = data.links[Number(row.dataset.i)];
    row.querySelector(".cal-copy").addEventListener("click", (e) =>
      copyLink(e.currentTarget, link.url));
  });
}

/* A mail draft rather than a send: the wording is usually worth a look, and
   nothing should leave without the person deciding it. */
function mailtoFor(link) {
  const subject = "Book a time with estly Studio";
  const body = "Hi,\n\nPick a time that suits you here:\n" + link.url
    + "\n\nThanks,\nAndrew";
  return "mailto:?subject=" + encodeURIComponent(subject)
    + "&body=" + encodeURIComponent(body);
}

async function copyLink(button, url) {
  const said = button.textContent;
  try {
    await navigator.clipboard.writeText(url);
  } catch (err) {
    // Clipboard access can be refused; falling back to a selection means the
    // link is still one keystroke away rather than unreachable.
    const box = document.createElement("textarea");
    box.value = url;
    document.body.appendChild(box);
    box.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing left to try */ }
    box.remove();
  }
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = said; }, 1400);
}

function renderMonth() {
  document.getElementById("cal-month").textContent =
    viewMonth.toLocaleDateString([], { month: "long", year: "numeric" });

  const today = new Date();
  const grid = document.getElementById("cal-grid");

  grid.innerHTML = gridDays(viewMonth).map((day) => {
    const mine = monthEvents.filter((e) => sameDay(new Date(e.start), day));
    const outside = day.getMonth() !== viewMonth.getMonth();
    const classes = [
      "cal-day",
      outside ? "is-outside" : "",
      sameDay(day, today) ? "is-today" : "",
      selectedDay && sameDay(day, selectedDay) ? "is-selected" : "",
      mine.length ? "has-events" : "",
    ].filter(Boolean).join(" ");

    return `
      <button type="button" class="${classes}" data-date="${day.toISOString()}">
        <span class="cal-daynum">${day.getDate()}</span>
        ${mine.slice(0, 2).map((e) => `
          <span class="cal-chip">
            <span class="cal-chip-time">${escapeHtml(timeOf(e.start))}</span>
            ${escapeHtml(e.name)}
          </span>`).join("")}
        ${mine.length > 2
          ? `<span class="cal-more">+${mine.length - 2} more</span>` : ""}
      </button>`;
  }).join("");

  grid.querySelectorAll(".cal-day").forEach((cell) => {
    cell.addEventListener("click", () => {
      const day = new Date(cell.dataset.date);
      // Clicking the selected day again clears it, rather than leaving no way
      // back to the upcoming list.
      selectedDay = selectedDay && sameDay(day, selectedDay) ? null : day;
      renderMonth();
      renderSide();
    });
  });
}

function renderSide() {
  const title = document.getElementById("cal-side-title");
  const box = document.getElementById("cal-side-list");

  let list;
  if (selectedDay) {
    title.textContent = selectedDay.toLocaleDateString(
      [], { weekday: "long", month: "long", day: "numeric" });
    list = monthEvents.filter((e) => sameDay(new Date(e.start), selectedDay));
  } else {
    title.textContent = "Next up";
    const now = Date.now();
    list = monthEvents.filter((e) => Date.parse(e.start) >= now).slice(0, 8);
  }

  if (!list.length) {
    box.innerHTML = `<p class="hint">${selectedDay
      ? "Nothing booked this day."
      : "Nothing booked in this month from here on."}</p>`;
    return;
  }

  box.innerHTML = `<ul class="cal-list">${list.map((e) => `
    <li class="cal-item">
      <span class="cal-when">${escapeHtml(dayAndTime(e))}</span>
      <span class="cal-name">${escapeHtml(e.name)}</span>
      ${e.invitee && e.invitee.name
        ? `<span class="cal-who">${escapeHtml(e.invitee.name)}${
            e.invitee.email ? " · " + escapeHtml(e.invitee.email) : ""}</span>` : ""}
      ${e.location ? `<span class="cal-where">${escapeHtml(e.location)}</span>` : ""}
    </li>`).join("")}</ul>`;
}

function dayAndTime(event) {
  const at = new Date(event.start);
  const span = event.end ? `${timeOf(event.start)}–${timeOf(event.end)}`
                         : timeOf(event.start);
  if (selectedDay) return span;
  return at.toLocaleDateString([], { month: "short", day: "numeric" }) + " · " + span;
}

document.getElementById("cal-prev").addEventListener("click", () => {
  viewMonth = addMonths(viewMonth, -1);
  selectedDay = null;
  loadMonth();
});
document.getElementById("cal-next").addEventListener("click", () => {
  viewMonth = addMonths(viewMonth, 1);
  selectedDay = null;
  loadMonth();
});
document.getElementById("cal-today").addEventListener("click", () => {
  viewMonth = startOfMonth(new Date());
  selectedDay = null;
  loadMonth();
});

loadMonth();
