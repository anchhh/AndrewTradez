"""
Running the agent-email lookup automatically when a lead arrives.

The lookup opens a search and several pages, so it takes some seconds -- far
too long to hold up a capture. It runs on a background thread instead: the
lead saves immediately, and the email appears on it shortly after.

It fails often and that is expected. The search endpoint rate-limits after a
dozen or so queries, plenty of agents publish no address anywhere, and some
pages refuse us. Every outcome is written into the lead's notes so a blank
email field is never a mystery -- you can see whether nothing was found,
whether something was found but wasn't trustworthy, or whether the search
itself was blocked.
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


def _append_note(lead, text):
    lead.notes = ((lead.notes + "\n") if lead.notes else "") + text


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
            _append_note(
                lead,
                f"Email {found['email']} found automatically ({found['reason']}"
                + (", phone confirmed on the same page" if found["phone_confirmed"] else "")
                + f"). Source: {found['source']}",
            )
        elif found.get("email"):
            _append_note(
                lead,
                f"Possible email {found['email']} ({found['reason']}) - not confident "
                f"enough to fill in. Source: {found['source']}",
            )
        elif found.get("blocked"):
            _append_note(
                lead,
                "Automatic email lookup could not run: the search endpoint is rate limiting us. "
                "This is temporary - the lookup can be retried later.",
            )
        else:
            _append_note(lead, "Automatic email lookup found nothing published for this agent.")

        db.session.commit()
        log.info("email lookup for lead %s: %s", lead_id, found.get("email") or "nothing")


def enrich_lead_async(app, lead_id):
    """Kick off the lookup for a lead that arrived without an email."""
    threading.Thread(
        target=_run, args=(app, lead_id), name=f"enrich-lead-{lead_id}", daemon=True
    ).start()
