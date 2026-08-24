"""
Working demo feed -- stands in for a real listings source so the
auto-ingestion + dedup pipeline has something to run against today.

Each fetch() call returns a mix of brand-new fake listings and re-emitted
ones from earlier calls, so running the pipeline repeatedly demonstrates
the upsert behavior: repeats bump times_seen/last_seen_at on the existing
Lead instead of creating a second row.
"""
import random

from services.importers.sample_importer import run as generate_sample_rows

_seen_pool = []  # addresses already "seen" by this feed, this process


def fetch():
    new_rows = generate_sample_rows(count=random.randint(2, 5), source="sample")

    repeat_rows = []
    if _seen_pool and random.random() < 0.6:
        repeat_rows = [dict(r) for r in random.sample(_seen_pool, k=min(len(_seen_pool), random.randint(1, 3)))]

    _seen_pool.extend(new_rows)
    if len(_seen_pool) > 200:
        del _seen_pool[: len(_seen_pool) - 200]

    return new_rows + repeat_rows
