"""
Bulk-load leads from a CSV export (e.g. from a licensed listings feed,
a spreadsheet of manually-researched agents, or another tool's export).

Expected columns (all optional except `address`):
address, city, state, zip_code, price, beds, baths, sqft, property_type,
listing_url, agent_name, agent_email, agent_phone, source, external_id
"""
import csv
import io

_INT_FIELDS = ("price", "sqft")
_FLOAT_FIELDS = ("beds", "baths")
_STR_FIELDS = (
    "address", "city", "state", "zip_code", "property_type", "listing_url",
    "agent_name", "agent_email", "agent_phone", "source", "external_id",
)


class CsvImportError(ValueError):
    pass


def run(file_stream):
    """
    file_stream: a file-like object opened in binary or text mode
    (e.g. Flask's request.files['file'].stream).
    Returns a list of dicts ready to pass into Lead(**kwargs).
    """
    raw = file_stream.read()
    text = raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw
    reader = csv.DictReader(io.StringIO(text))

    if reader.fieldnames is None or "address" not in reader.fieldnames:
        raise CsvImportError("CSV must include an 'address' column")

    leads = []
    for row_num, row in enumerate(reader, start=2):
        address = (row.get("address") or "").strip()
        if not address:
            continue

        lead = {"address": address, "status": "new", "source": (row.get("source") or "csv").strip() or "csv"}

        for field in _STR_FIELDS:
            if field in ("address", "source"):
                continue
            value = (row.get(field) or "").strip()
            if value:
                lead[field] = value

        for field in _INT_FIELDS:
            value = (row.get(field) or "").strip()
            if value:
                try:
                    lead[field] = int(float(value))
                except ValueError:
                    raise CsvImportError(f"Row {row_num}: invalid number for '{field}': {value!r}")

        for field in _FLOAT_FIELDS:
            value = (row.get(field) or "").strip()
            if value:
                try:
                    lead[field] = float(value)
                except ValueError:
                    raise CsvImportError(f"Row {row_num}: invalid number for '{field}': {value!r}")

        leads.append(lead)

    if not leads:
        raise CsvImportError("No valid rows found (each row needs at least an 'address')")

    return leads
