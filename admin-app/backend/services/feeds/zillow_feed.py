"""
Not implemented: Zillow has no public listings API, and scraping
zillow.com directly violates their Terms of Service and triggers
aggressive bot-detection/IP blocking (they have pursued scrapers legally
before). Don't build that here.

Legitimate paths, either of which slots in as this module's fetch():
  - Bridge Interactive (https://www.bridgeinteractive.com/) -- Zillow's
    official MLS/IDX data partner program, for licensed brokers/agents.
  - A licensed aggregator such as ATTOM Data or RentCast, which relicense
    property data (including Zillow-sourced fields in some plans) via a
    normal REST API with an API key.
"""


def fetch():
    raise NotImplementedError(
        "Zillow feed not configured: no public API, and scraping zillow.com "
        "violates its Terms of Service. Wire this up via Bridge Interactive "
        "(official MLS/IDX partner feed) or a licensed data API (ATTOM Data, "
        "RentCast) instead."
    )
