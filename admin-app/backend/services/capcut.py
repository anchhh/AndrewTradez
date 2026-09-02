"""
Handing finished clips to CapCut as an editable project.

There is no CapCut API. Their Open Platform builds plugins that run inside the
editor and their AI API does text-to-video and template search -- neither can
be driven from a server. So this does not talk to CapCut at all: it writes a
project into the folder CapCut reads its drafts from, and the listing shows up
in the project list ready to edit and export.

    %LOCALAPPDATA%/CapCut/User Data/Projects/com.lveditor.draft/<name>/
        draft_content.json     the timeline
        draft_meta_info.json   what the project list shows
        Resources/

The format is undocumented and ByteDance changes it between versions, so
nothing here is built from a spec. The shapes are COPIED from the user's own
existing drafts -- a real video material has 56 keys and a segment 45, and
guessing which matter is how a draft ends up refusing to open. Taking the
prototypes from drafts CapCut itself wrote means this follows the installed
version rather than the version that happened to be current when it was
written.
"""
import copy
import json
import os
import time
import uuid

DEFAULT_DRAFTS_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~\\AppData\\Local")),
    "CapCut", "User Data", "Projects", "com.lveditor.draft",
)

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "studio", "capcut.json"
)

# CapCut counts in microseconds.
US = 1_000_000


class CapCutError(Exception):
    """The draft could not be written."""


def drafts_dir():
    """Where CapCut keeps its projects. Overridable for a non-default install."""
    if os.environ.get("CAPCUT_DRAFTS_DIR"):
        return os.environ["CAPCUT_DRAFTS_DIR"]
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                folder = (json.load(fh) or {}).get("drafts_dir")
            if folder:
                return folder
        except (ValueError, OSError):
            pass
    return DEFAULT_DRAFTS_DIR


def is_available():
    return os.path.isdir(drafts_dir())


def _uid():
    """CapCut's ids are upper-case UUIDs with a lower-case third group."""
    raw = str(uuid.uuid4()).upper().split("-")
    raw[2] = raw[2].lower()
    return "-".join(raw)


def _prototypes():
    """A real video material, segment and track from the user's own drafts.

    Copying beats constructing: a material carries 56 keys whose defaults are
    version-specific, and a draft missing one CapCut expects simply will not
    open. Falls back to a minimal set only if no existing draft has video in
    it, which is the case where this is guesswork anyway.
    """
    folder = drafts_dir()
    if not os.path.isdir(folder):
        raise CapCutError("CapCut's drafts folder isn't where it was expected: %s" % folder)

    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name, "draft_content.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                draft = json.load(fh)
        except (ValueError, OSError):
            continue

        videos = (draft.get("materials") or {}).get("videos") or []
        track = next((t for t in draft.get("tracks") or []
                      if t.get("type") == "video" and t.get("segments")), None)
        if videos and track:
            return {
                "draft": draft,
                "material": copy.deepcopy(videos[0]),
                "segment": copy.deepcopy(track["segments"][0]),
                "track": copy.deepcopy({k: v for k, v in track.items() if k != "segments"}),
                "from": name,
            }

    raise CapCutError(
        "No existing CapCut project with video in it was found to copy the "
        "format from. Make one clip in CapCut by hand first, then try again."
    )


def create_draft(name, clips, width=1920, height=1080, fps=30):
    """Write a CapCut project for these clips, in this order.

    `clips` is [{path, duration}] -- an absolute path to an mp4 on disk and a
    length in SECONDS. Clips are laid end to end on one video track, which is
    the assembly; trimming, music and titles are what CapCut is for.
    """
    if not clips:
        raise CapCutError("No clips to send.")

    missing = [c["path"] for c in clips if not os.path.exists(c["path"])]
    if missing:
        raise CapCutError("These clips aren't on disk: %s"
                          % ", ".join(os.path.basename(m) for m in missing))

    proto = _prototypes()
    folder = drafts_dir()

    # CapCut shows the folder name in its project list, so it is the name --
    # and it must not collide with an existing project.
    safe = "".join(ch for ch in name if ch.isalnum() or ch in " -_").strip() or "estly"
    target = os.path.join(folder, safe)
    suffix = 1
    while os.path.exists(target):
        suffix += 1
        target = os.path.join(folder, "%s (%d)" % (safe, suffix))
    os.makedirs(os.path.join(target, "Resources"), exist_ok=True)

    draft = copy.deepcopy(proto["draft"])
    draft_id = _uid()

    materials, segments, cursor = [], [], 0
    for clip in clips:
        length = int(round(float(clip.get("duration") or 5) * US))

        material = copy.deepcopy(proto["material"])
        material["id"] = _uid()
        # CapCut stores forward slashes even on Windows.
        material["path"] = os.path.abspath(clip["path"]).replace("\\", "/")
        material["material_name"] = os.path.basename(clip["path"])
        material["duration"] = length
        material["width"], material["height"] = width, height
        material["has_audio"] = False
        materials.append(material)

        segment = copy.deepcopy(proto["segment"])
        segment["id"] = _uid()
        segment["material_id"] = material["id"]
        # Laid end to end: the target range is where it sits on the timeline,
        # the source range is which part of the file is used.
        segment["target_timerange"] = {"start": cursor, "duration": length}
        segment["source_timerange"] = {"start": 0, "duration": length}
        segment["render_index"] = len(segments)
        segments.append(segment)
        cursor += length

    # Everything from the donor draft that is not ours goes, or the project
    # opens carrying somebody else's clips.
    draft["materials"] = {k: ([] if isinstance(v, list) else v)
                          for k, v in (draft.get("materials") or {}).items()}
    draft["materials"]["videos"] = materials

    track = copy.deepcopy(proto["track"])
    track["id"] = _uid()
    track["segments"] = segments
    draft["tracks"] = [track]

    draft["id"] = draft_id
    draft["duration"] = cursor
    draft["name"] = ""
    draft["canvas_config"] = {"background": None, "width": width,
                              "height": height, "ratio": "original"}
    draft["fps"] = fps
    draft["path"] = target.replace("\\", "/")
    for key in ("keyframes", "keyframe_graph_list", "relationships", "time_marks"):
        if key in draft and isinstance(draft[key], list):
            draft[key] = []

    now_us = int(time.time() * US)
    meta = {
        "draft_id": draft_id,
        "draft_name": os.path.basename(target),
        "draft_fold_path": target.replace("\\", "/"),
        "draft_root_path": folder,
        "draft_removable_storage_device": "",
        "draft_cover": "",
        "draft_timeline_materials_size_": 0,
        "tm_draft_create": now_us,
        "tm_draft_modified": now_us,
        "tm_duration": cursor,
        "draft_materials": [
            {"type": 0, "value": [
                {
                    "create_time": int(time.time()),
                    "duration": int(round(float(c.get("duration") or 5) * US)),
                    "extra_info": os.path.basename(c["path"]),
                    "file_Path": os.path.abspath(c["path"]).replace("\\", "/"),
                    "height": height,
                    "id": _uid(),
                    "import_time": int(time.time()),
                    "import_time_ms": now_us,
                    "item_source": 1,
                    "md5": "",
                    "metetype": "video",
                    "roughcut_time_range": {"duration": -1, "start": -1},
                    "sub_time_range": {"duration": -1, "start": -1},
                    "type": 0,
                    "width": width,
                }
                for c in clips
            ]},
        ] + [{"type": t, "value": []} for t in (1, 2, 3, 6, 7, 8)],
    }

    with open(os.path.join(target, "draft_content.json"), "w", encoding="utf-8") as fh:
        json.dump(draft, fh, ensure_ascii=False)
    with open(os.path.join(target, "draft_meta_info.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)

    return {
        "path": target,
        "name": os.path.basename(target),
        "clips": len(clips),
        "duration": round(cursor / US, 1),
        "format_from": proto["from"],
    }
