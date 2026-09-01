"""
Running the agent-email lookup automatically when a lead arrives.

The lookup opens a search and several pages, so it takes some seconds -- far
too long to hold up a capture. It runs on a background thread instead: the
lead saves immediately, and the email appears on it shortly after.

It fails often and that is expected: the search endpoint rate-limits after a
dozen or so queries, plenty of agents publish no address anywhere, and some
pages refuse us. Nothing is written to the lead's notes -- those belong to
the user. What it found is kept as ranked candidates on the lead, each with
the case for and against, and the Check email button re-runs it live.
"""
import logging
import threading

log = logging.getLogger(__name__)

# One lookup at a time. Firing several at once is the quickest way to get the
# search endpoint to start refusing us, and captures arrive in bursts.
_lock = threading.Lock()


def known_domains_for(brokerage):
    """Mail domains already confirmed for this brokerage on other leads.

    Used to spot a bad address: a directory really did publish
    "rolando@searsrealestate.co" when the brokerage's domain is
    searsrealestate.com, and mail to that would simply vanish.
    """
    if not brokerage:
        return set()
    from models import Lead

    rows = (
        Lead.query.filter(Lead.brokerage == brokerage, Lead.agent_email.isnot(None))
        .with_entities(Lead.agent_email)
        .all()
    )
    return {r[0].split("@")[-1].lower() for r in rows if r[0] and "@" in r[0]}


def _run(app, lead_id):
    from extensions import db
    from models import Lead
    from services.email_lookup import find_agent_email

    with _lock, app.app_context():
        lead = db.session.get(Lead, lead_id)
        # Re-read rather than trusting the caller: the lead may have been
        # deleted, or an email filled in by hand, while this waited its turn.
        if lead is None or lead.agent_email or not lead.agent_name:
            return

        try:
            found = find_agent_email(
                lead.agent_name,
                brokerage=lead.brokerage,
                city=lead.city,
                state=lead.state,
                phone=lead.agent_phone,
                known_domains=known_domains_for(lead.brokerage),
            )
        except Exception:  # noqa: BLE001 -- enrichment must never break a lead
            log.exception("email lookup failed for lead %s", lead_id)
            return

        # Keep every candidate, ranked, even when one was good enough to use:
        # the choice should be reviewable rather than a black box.
        lead.email_candidates = found.get("candidates") or []

        if found.get("email") and found.get("autofill"):
            lead.agent_email = found["email"]

        db.session.commit()
        log.info("email lookup for lead %s: %s", lead_id, found.get("email") or "nothing")


def enrich_lead_async(app, lead_id):
    """Kick off the lookup for a lead that arrived without an email."""
    threading.Thread(
        target=_run, args=(app, lead_id), name=f"enrich-lead-{lead_id}", daemon=True
    ).start()


def _sort_rooms(app, lead_id):
    from extensions import db
    from models import Lead
    from services.rooms import RoomsError, RoomsNotConfigured, classify_photos

    with app.app_context():
        lead = db.session.get(Lead, lead_id)
        if lead is None:
            return
        photos = lead.photo_urls or []
        if not photos:
            return

        try:
            rooms = classify_photos(photos)
        except RoomsNotConfigured:
            return  # not connected; the lead keeps its photos unsorted
        except RoomsError as exc:
            log.warning("room sorting failed for lead %s: %s", lead_id, exc)
            return
        except Exception:  # noqa: BLE001 -- sorting must never break a lead
            log.exception("room sorting crashed for lead %s", lead_id)
            return

        # Re-read: the lead may have been deleted, or had photos re-fetched,
        # while this was running.
        lead = db.session.get(Lead, lead_id)
        if lead is None:
            return
        existing = lead.photo_rooms
        existing.update(rooms)
        lead.photo_rooms = existing
        db.session.commit()
        log.info("sorted %s of %s photos for lead %s", len(rooms), len(photos), lead_id)


def sort_rooms_async(app, lead_id):
    """Label a lead's photos by room, in the background.

    Separate from the email lookup rather than sharing its thread: the two
    fail independently, and the email lookup serialises behind a lock that
    this has no reason to wait on.
    """
    threading.Thread(
        target=_sort_rooms, args=(app, lead_id), name=f"sort-rooms-{lead_id}", daemon=True
    ).start()
