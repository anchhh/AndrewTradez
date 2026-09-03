"""
Image editing through Atlas Cloud, which is where the video already goes.

Same model as calling Google directly -- Nano Banana Pro -- reached through
the account that already pays for the clips, which is most of the reason to
prefer it: one balance, one bill, and the balance that matters is the one
already topped up for video.

It is also cheaper at the resolution this app wants. Google charges $0.24 an
image at 4K; Atlas lists `nano-banana-pro/edit-ultra` at $0.15 and offers 8K,
which Google's own API does not.

The shape differs from the Gemini path in one way that decides the code: the
model reads its inputs from URLs rather than from inline bytes, so every
local file has to be uploaded to Atlas first. That is the same uploadMedia
endpoint the video clips already use, so the reference photographs travel
exactly the way a start frame does.
"""
import os

import requests

from services import video

# Ultra rather than plain edit: $0.15 against $0.14, and it is the one that
# takes a resolution at all. These become the first frame of a 1080p clip.
MODEL = "google/nano-banana-pro/edit-ultra"
RESOLUTION = "4k"

# The model's own ceiling. A front set can run to eleven with the neighbours
# in it, so this is a real limit rather than a formality -- and the plan
# orders them, so the ones that fall off the end are the least important.
MAX_IMAGES = 10

# Generation is a minute or two at 4K; the video path's own ceiling is longer
# because a clip is longer.
POLL_TIMEOUT = 300


class AtlasImageError(Exception):
    """Atlas Cloud refused the edit, or never finished it."""


def settings(cfg=None):
    """Which model and resolution, config first so both can be changed."""
    cfg = cfg or video.load_config()
    return (cfg.get("image_model") or MODEL,
            cfg.get("image_resolution") or RESOLUTION)


def is_configured():
    return bool(video.load_config().get("api_key"))


def edit(paths, prompt, cfg=None, on_tick=None):
    """Edit the first image, using the rest as reference. Returns bytes.

    Order matters and is the caller's business: Atlas passes the list
    straight through, and the model treats the first as the subject.
    """
    cfg = cfg or video.load_config()
    if not cfg.get("api_key"):
        raise AtlasImageError(
            "Atlas Cloud isn't connected. Put an API key in "
            "studio/atlascloud.json (or set ATLASCLOUD_API_KEY).")

    if not paths:
        raise AtlasImageError("nothing to edit")

    model, resolution = settings(cfg)

    # Uploaded rather than inlined, because this model reads URLs. Done here
    # rather than by the caller so a half-uploaded set is this function's
    # problem and not something the page has to unpick.
    urls = []
    for path in paths[:MAX_IMAGES]:
        if not os.path.exists(path):
            continue
        try:
            urls.append(video.upload_image(path, cfg))
        except video.VideoError as exc:
            raise AtlasImageError("couldn't upload %s: %s"
                                  % (os.path.basename(path), exc)) from exc
    if not urls:
        raise AtlasImageError("none of those images are on disk any more")

    payload = {
        "model": model,
        "prompt": prompt,
        "images": urls,
        "resolution": resolution,
        "output_format": "png",
    }

    try:
        resp = requests.post(
            "%s/model/generateVideo" % video.BASE_URL,
            headers={"Authorization": "Bearer %s" % cfg["api_key"],
                     "Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )
    except requests.RequestException as exc:
        raise AtlasImageError("could not reach Atlas Cloud: %s" % exc) from exc

    if resp.status_code >= 400:
        raise AtlasImageError(video._explain(resp))

    try:
        body = resp.json()
    except ValueError as exc:
        raise AtlasImageError("Atlas Cloud returned something unreadable") from exc

    data = body.get("data") or body
    prediction = data.get("id") or data.get("prediction_id")
    if not prediction:
        raise AtlasImageError("no prediction id in the response: %s" % body)

    # Same polling the clips use, because it is the same queue.
    try:
        state = video.wait_for_clip(prediction, cfg, timeout=POLL_TIMEOUT,
                                    on_tick=on_tick)
    except video.VideoError as exc:
        raise AtlasImageError(str(exc)) from exc

    url = _output_url(state)
    if not url:
        raise AtlasImageError("Atlas Cloud finished without returning an image")

    try:
        got = requests.get(url, timeout=120)
        got.raise_for_status()
    except requests.RequestException as exc:
        raise AtlasImageError("the finished image could not be fetched: %s" % exc) from exc
    return got.content


def _output_url(state):
    """The finished image's address.

    check_clip normalises every generation into the same shape, and that
    shape is named for video because video is what it was written for: the
    output lands in `video_url`, from `outputs[0]`. An image comes back the
    same way. The fallbacks below are kept because Atlas has already renamed
    one field on this API once -- uploads return `download_url` where the
    docs say `url`.
    """
    if not isinstance(state, dict):
        return None

    direct = state.get("video_url")
    if isinstance(direct, str) and direct.startswith("http"):
        return direct

    for key in ("download_url", "url", "image", "output"):
        value = state.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
        if isinstance(value, list) and value and isinstance(value[0], str):
            return value[0]

    for key in ("raw", "data", "result", "outputs"):
        value = state.get(key)
        if isinstance(value, list) and value and isinstance(value[0], str):
            return value[0]
        found = _output_url(value)
        if found:
            return found
    return None
