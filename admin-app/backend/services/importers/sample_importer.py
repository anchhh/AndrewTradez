"""
Generates realistic-looking sample listings so the lead pipeline and
dashboard can be built/demoed before a real data source is wired in.
Not a scraper -- see the package docstring in __init__.py.
"""
import random

_STREETS = [
    "Maple Ave", "Oak Ridge Dr", "Sunset Blvd", "Harbor View Ln",
    "Willow Creek Rd", "Magnolia St", "Cedar Point Way", "Lakeshore Dr",
    "Birchwood Ct", "Pinehurst Ave",
]
_CITIES = [
    ("Austin", "TX"), ("Tampa", "FL"), ("Scottsdale", "AZ"),
    ("Charlotte", "NC"), ("Denver", "CO"), ("Nashville", "TN"),
    ("San Diego", "CA"), ("Raleigh", "NC"),
]
_TYPES = ["Single Family", "Condo", "Townhouse", "Multi-Family"]
_FIRST_NAMES = ["Jordan", "Taylor", "Casey", "Morgan", "Riley", "Alex"]
_LAST_NAMES = ["Reyes", "Chen", "Patel", "Nguyen", "Whitfield", "Brooks"]


def run(count=10, source="sample"):
    """Return a list of dicts ready to pass into Lead(**kwargs)."""
    leads = []
    for _ in range(count):
        city, state = random.choice(_CITIES)
        first, last = random.choice(_FIRST_NAMES), random.choice(_LAST_NAMES)
        agent_name = f"{first} {last}"
        beds = random.choice([2, 3, 3, 4, 5])
        baths = random.choice([1.5, 2, 2, 2.5, 3])
        sqft = random.randint(1100, 4200)
        price = random.randint(220, 1450) * 1000

        leads.append({
            "source": source,
            "external_id": f"SAMPLE-{random.randint(100000, 999999)}",
            "listing_url": "https://example.com/listing/sample",
            "address": f"{random.randint(100, 9999)} {random.choice(_STREETS)}",
            "city": city,
            "state": state,
            "zip_code": f"{random.randint(10000, 99999)}",
            "price": price,
            "beds": beds,
            "baths": baths,
            "sqft": sqft,
            "property_type": random.choice(_TYPES),
            "photo_urls": [],
            "agent_name": agent_name,
            "agent_email": f"{first.lower()}.{last.lower()}@example.com",
            "agent_phone": f"({random.randint(200,999)}) 555-{random.randint(1000,9999)}",
            "status": "new",
        })
    return leads
