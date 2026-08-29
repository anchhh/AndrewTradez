"""
Matching a listing agent to an email address found on their listing page.

Listing pages publish agent emails; the extension simply wasn't collecting
them. Reading a published address is fact, so it can be filled in
automatically -- unlike *deriving* one from a brokerage pattern, which is a
guess and gets people wrong. Measured on real pages: Redfin uses
first.last@redfin.com while Comey & Shepherd uses agetgey@comey.com, so no
single pattern would have worked anyway.

The catch is that a page carries several addresses -- other agents at the
same brokerage, plus shared mailboxes like cincinnati-all@redfin.com. So an
address is only accepted when its local part actually matches the agent whose
name was captured from the listing, and only in an arrangement strong enough
to be that person rather than a namesake.
"""
import re
import unicodedata

# Shared or automated mailboxes: never a specific person.
GENERIC_MAILBOXES = (
    "info", "contact", "support", "noreply", "no-reply", "admin", "hello",
    "sales", "help", "team", "office", "all", "inquiries", "enquiries",
    "leads", "press", "careers", "webmaster", "postmaster", "marketing",
)

# Addresses that belong to the site's plumbing rather than to a person.
INFRASTRUCTURE_DOMAINS = ("sentry.io", "wixpress.com", "example.com", "sentry-cdn.com")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

# Below this a match is a suggestion, not a fact. first+last / last+first /
# initial+last are specific enough to be the person named; "surname appears
# somewhere" is not -- two agents at one brokerage can share a surname.
AUTOFILL_THRESHOLD = 85


def _letters(value):
    normalised = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z]", "", normalised.lower())


def find_emails(text):
    """Every plausible personal address in a blob of page source."""
    out = []
    seen = set()
    for match in EMAIL_RE.findall(text or ""):
        email = match.strip().strip(".").lower()
        if email in seen:
            continue
        if email.rsplit(".", 1)[-1] in ("png", "jpg", "jpeg", "gif", "svg", "webp"):
            continue
        if any(domain in email for domain in INFRASTRUCTURE_DOMAINS):
            continue
        seen.add(email)
        out.append(email)
    return out


def score_email_for_agent(email, agent_name):
    """How confident we are that `email` belongs to `agent_name`.

    Returns (score, reason). 100 is an exact first+last; 0 means no match and
    the address must not be used.
    """
    local = (email or "").split("@")[0].lower()
    bare = _letters(local)
    parts = [p for p in re.split(r"[^A-Za-z]+", agent_name or "") if len(p) > 1]
    if len(parts) < 2 or not bare:
        return 0, "no usable agent name"

    first, last = _letters(parts[0]), _letters(parts[-1])
    if not first or not last:
        return 0, "no usable agent name"

    head = local.split(".")[0]
    if head in GENERIC_MAILBOXES or bare in GENERIC_MAILBOXES:
        return 0, "shared mailbox"

    if bare == first + last:
        return 100, "first+last"
    if bare == last + first:
        return 95, "last+first"
    if bare == first[0] + last:
        return 90, "initial+last"
    if bare == last + first[0]:
        return 85, "last+initial"
    if bare == first + last[0]:
        return 60, "first+initial"
    if len(last) >= 5 and last in bare:
        return 55, "surname present"
    # Small brokerages hand out first-name addresses -- karent@searsrealestate.com
    # is the listing agent's real address. On its own that is far too weak (any
    # Amy at that brokerage matches), so it sits below the autofill threshold
    # and only becomes usable when the same page also carries the lead's phone.
    if len(first) >= 4 and bare == first:
        return 70, "first name only"
    return 0, "no match"


def phone_digits(value):
    """Last 10 digits, so (970) 330-7700 and 970-330-7700 compare equal."""
    digits = re.sub(r"\D", "", value or "")
    return digits[-10:] if len(digits) >= 10 else ""


def page_confirms_phone(page_text, phone):
    """Whether the page carrying an address also carries the lead's phone.

    This is the check that separates the right agent from a namesake, and it
    is what caught a same-name appraiser in another state during a manual
    pass. A weak name match on a page that also shows the agent's number is
    worth more than a strong name match on a page about someone else.
    """
    wanted = phone_digits(phone)
    if not wanted:
        return False
    return wanted in re.sub(r"\D", "", page_text or "")


def pick_agent_email(candidates, agent_name):
    """Best address for this agent from those found on the page.

    Returns (email, score, reason), or (None, 0, reason) when nothing is
    confident enough. Callers should only autofill at AUTOFILL_THRESHOLD and
    above; weaker hits are worth recording for a human to confirm, never
    worth sending mail to.
    """
    ranked = []
    for email in candidates or []:
        score, reason = score_email_for_agent(email, agent_name)
        if score:
            ranked.append((score, email, reason))
    if not ranked:
        return None, 0, "no address on the page matched the agent's name"

    ranked.sort(reverse=True)
    score, email, reason = ranked[0]

    # Two different addresses matching equally well means we cannot tell them
    # apart -- two agents sharing a surname, most likely.
    tied = [r for r in ranked if r[0] == score and r[1] != email]
    if tied:
        return None, score, f"ambiguous: {len(tied) + 1} addresses matched equally ({reason})"

    return email, score, reason
