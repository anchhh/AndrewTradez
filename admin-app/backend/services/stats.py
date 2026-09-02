"""What happened in a period, and what is currently on the plate.

Two kinds of number live here and they are deliberately kept apart:

  ACTIVITY is period-scoped -- leads added, emails sent, clips rendered,
  money taken. It answers "what did I do today".

  PIPELINE is a snapshot of right now -- active projects, leads waiting on a
  reply. It answers "what should I do next", and it does NOT move when the
  period changes, because a lead waiting on a reply is waiting whether or not
  it was contacted this week.

Presenting the two in one undifferentiated row is how a dashboard ends up
implying that you have three active projects *today*.
"""
from datetime import datetime, timedelta, timezone

RANGES = ("day", "week", "month", "all")

LABELS = {
    "day": "Today",
    "week": "This week",
    "month": "This month",
    "all": "All time",
}


def period_start(window):
    """UTC cutoff for a window, computed from LOCAL calendar boundaries.

    The boundaries have to be local. "Today" means the day the user is
    having, and a UTC midnight cutoff would start their day at 6pm the
    evening before -- so the morning's work would land in "yesterday" and
    the previous evening's would count as today.

    Rows are stored as naive UTC, so the local boundary is converted to UTC
    and stripped of its tzinfo to be comparable. Returns None for "all",
    meaning no cutoff.
    """
    if window not in RANGES or window == "all":
        return None

    # astimezone() with no argument attaches the machine's local zone, which
    # is the user's own -- this app runs on their computer.
    now = datetime.now().astimezone()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "week":
        start -= timedelta(days=start.weekday())  # Monday
    elif window == "month":
        start = start.replace(day=1)
    return start.astimezone(timezone.utc).replace(tzinfo=None)


def _in_period(when, since):
    return when is not None and (since is None or when >= since)


def collect(owner_id, window, leads, video_jobs, staging_jobs):
    """Every figure the dashboard shows, for one owner and one window."""
    from services.video import job_spend

    since = period_start(window)
    within = lambda when: _in_period(when, since)  # noqa: E731

    # ---- activity: what was done in the period ----
    sold = [l for l in leads if l.sold_amount and within(l.sold_at)]
    revenue = sum(l.sold_amount for l in sold)

    period_video = [j for j in video_jobs if within(j.created_at)]
    spend = sum(job_spend(j) for j in period_video)
    clips = sum(1 for j in period_video for c in (j.clips or [])
                if c.get("video_url"))

    rooms = sum(
        1
        for j in staging_jobs if within(j.created_at)
        for r in (j.rooms or []) if r.get("staged_url")
    )

    activity = {
        "leads_added": sum(1 for l in leads if within(l.created_at)),
        "emails_sent": sum(1 for l in leads if within(l.outreach_email_sent_at)),
        "calls_made": sum(1 for l in leads if within(l.outreach_phone_called_at)),
        "videos_sent": sum(1 for l in leads if within(l.outreach_video_sent_at)),
        "clips_rendered": clips,
        "renders": len(period_video),
        "rooms_staged": rooms,
        "deals_closed": len(sold),
    }

    money = {
        "revenue": round(revenue, 2),
        "spend": round(spend, 2),
        "profit": round(revenue - spend, 2),
        # What a closed deal was worth on average, which is the number that
        # says whether to chase more deals or bigger ones.
        "avg_deal": round(revenue / len(sold), 2) if sold else 0.0,
    }

    # ---- pipeline: the state of things right now ----
    #
    # A "project" is a lead that is qualified OR filed into a folder, and
    # deliberately not a row in projects.json. That file gets a row every
    # time Create Video or Scenery is opened, so one listing worked on seven
    # times counted seven times.
    #
    # Filing counts on its own because putting a listing in a folder is
    # itself a statement that you are working on it -- and because otherwise
    # a lead dragged into a folder would vanish from the Projects page,
    # leaving a folder that says it holds two things and shows nothing.
    qualified = [l for l in leads
                 if (l.qualified or l.folder_id) and l.status != "dead"]

    # Which leads have had any media made for them at all. Started means
    # something was actually produced, not that a page was opened.
    started = {j.lead_id for j in video_jobs
               for c in (j.clips or []) if c.get("video_url") and j.lead_id}
    started |= {j.lead_id for j in staging_jobs
                for r in (j.rooms or []) if r.get("staged_url") and j.lead_id}

    # Contacted and still waiting. Not "status == contacted": the status is
    # set by hand and the timestamp is set by the act of sending, so the
    # timestamp is the more reliable of the two.
    awaiting = [
        l for l in qualified
        if l.outreach_email_sent_at is not None
        and l.status not in ("responded", "converted", "dead")
    ]
    untouched = [
        l for l in qualified
        if not l.outreach_skipped
        and l.outreach_email_sent_at is None
        and l.outreach_phone_called_at is None
    ]

    pipeline = {
        "active_projects": len(qualified),
        "projects_todo": sum(1 for l in qualified if l.id not in started),
        "hot_leads": sum(1 for l in leads if l.status == "responded"),
        "to_follow_up": len(awaiting),
        "to_contact": len(untouched),
        "unsold_qualified": sum(1 for l in qualified if not l.sold_amount),
    }

    return {
        "range": window if window in RANGES else "all",
        "label": LABELS.get(window, "All time"),
        "since": since.replace(tzinfo=timezone.utc).isoformat() if since else None,
        "money": money,
        "activity": activity,
        "pipeline": pipeline,
    }
