from . import airbnb_feed, realtor_feed, sample_feed, zillow_feed

FEEDS = {
    "sample": sample_feed,
    "zillow": zillow_feed,
    "realtor": realtor_feed,
    "airbnb": airbnb_feed,
}
