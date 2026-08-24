"""
Not implemented: Realtor.com has no self-serve public listings API, and
scraping realtor.com directly violates their Terms of Service and is
bot-protected.

Legitimate paths:
  - Your local MLS's IDX/RETS/RESO Web API feed (what actually powers
    Realtor.com's listings in the first place) -- available to licensed
    real estate professionals through their MLS.
  - A licensed aggregator such as ATTOM Data or RentCast.
"""


def fetch():
    raise NotImplementedError(
        "Realtor.com feed not configured: no public API, and scraping "
        "realtor.com violates its Terms of Service. Wire this up via your "
        "MLS's IDX/RESO Web API feed or a licensed data API instead."
    )
