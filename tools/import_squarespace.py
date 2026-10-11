"""One-off import of the Squarespace WordPress export into Jekyll posts.

Reads the export XML, converts each post's HTML to Markdown, copies and resizes
its photos from the HTTrack download (falling back to the Squarespace CDN for any
that are missing), and writes `_posts/` + `assets/images/<slug>/`.

Usage (from the repo root, needs Pillow):
    python tools/import_squarespace.py copies/Squarespace-Wordpress-Export-09-06-2026.xml "copies/download/Heysen Blog"
"""

import argparse
import html as htmllib
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse

from PIL import Image, ImageOps

NS = {
    "wp": "http://wordpress.org/export/1.2/",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "excerpt": "http://wordpress.org/export/1.2/excerpt/",
}
CDN_HOST = "images.squarespace-cdn.com"
LOCAL_TZ = timezone(timedelta(hours=9, minutes=30))  # Adelaide (ACST) during the hike
MAX_SIDE = 1600
JPEG_QUALITY = 82

# Slugs that Squarespace mangled; old address kept working via redirect_from
SLUG_FIXES = {"day-5-": "day-5"}


# --------------------------------------------------------------------------- HTML -> Markdown

def escape_md(text):
    """Escape characters that kramdown would otherwise treat as formatting."""
    text = re.sub(r"([\\`*_\[\]<>|])", r"\\\1", text)
    return text


def escape_line_start(line):
    """Stop paragraphs like '1. Backpack' or '- note' turning into lists/headings."""
    line = re.sub(r"^(\s*)(\d+)\.(?=\s|$)", r"\1\2\\.", line)
    line = re.sub(r"^(\s*)([#+\-:])(?=\s|$)", r"\1\\\2", line)
    return line


class SquarespaceToMarkdown(HTMLParser):
    """Converts the small tag set Squarespace posts use: p, h1-h4, strong/b, em/i,
    a, ul/ol/li, img, br. Everything else (div wrappers) is ignored."""

    def __init__(self, image_url):
        super().__init__(convert_charrefs=True)
        self.image_url = image_url  # callback: CDN src -> Markdown image path (or None)
        self.blocks = []
        self.inline = None  # list of text pieces for the current block
        self.block_prefix = ""
        self.lists = []  # stack of [type, counter]
        self.link_stack = []

    # -- block handling
    def _start_block(self, prefix=""):
        self._end_block()
        self.inline = []
        self.block_prefix = prefix

    def _end_block(self):
        if self.inline is None:
            return
        text = "".join(self.inline)
        text = re.sub(r"[ \t]+", " ", text).strip()
        self.inline = None
        if not text or text in ("**", "****"):
            return
        lines = [escape_line_start(l.strip()) for l in text.split("\n")]
        text = "<br>\n".join(l for l in lines if l)
        self.blocks.append(self.block_prefix + text)

    def _text(self, s):
        if self.inline is None:
            if not s.strip():
                return
            self._start_block()
        self.inline.append(s)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "p":
            if self.lists and self.inline is not None:
                return  # <li><p>…</p></li>: keep the li's block
            self._start_block()
        elif tag in ("h1", "h2", "h3", "h4"):
            self._start_block("#" * int(tag[1]) + " ")
        elif tag in ("ul", "ol"):
            self._end_block()
            self.lists.append([tag, 0])
        elif tag == "li":
            kind = self.lists[-1] if self.lists else ["ul", 0]
            kind[1] += 1
            marker = f"{kind[1]}. " if kind[0] == "ol" else "- "
            self._start_block(marker)
        elif tag in ("strong", "b"):
            self._text("**")
        elif tag in ("em", "i"):
            self._text("*")
        elif tag == "br":
            self._text("\n")
        elif tag == "a":
            self.link_stack.append(attrs.get("href", ""))
            self._text("[")
        elif tag == "img":
            src = attrs.get("src") or attrs.get("data-src")
            path = self.image_url(src) if src else None
            if path:
                self._end_block()
                alt = escape_md(attrs.get("alt") or "")
                self.blocks.append(f'![{alt}]({{{{ "{path}" | relative_url }}}})')

    def handle_endtag(self, tag):
        if tag == "p" and self.lists:
            return
        if tag in ("p", "h1", "h2", "h3", "h4", "li"):
            self._end_block()
        elif tag in ("ul", "ol"):
            self._end_block()
            if self.lists:
                self.lists.pop()
        elif tag in ("strong", "b"):
            self._text("**")
        elif tag in ("em", "i"):
            self._text("*")
        elif tag == "a":
            href = self.link_stack.pop() if self.link_stack else ""
            self._text(f"]({rewrite_link(href)})")

    def handle_data(self, data):
        if self.inline is None and not data.strip():
            return
        self._text(escape_md(data))

    def markdown(self):
        self._end_block()
        # List items sit on consecutive lines; everything else is separated by a blank line.
        # (Paragraphs that merely look like list items were escaped, so this regex is exact.)
        out, prev_item = [], False
        for b in self.blocks:
            is_item = bool(re.match(r"^(\d+\. |- )", b))
            out.append(("\n" if prev_item and is_item else "\n\n") + b)
            prev_item = is_item
        md = "".join(out)
        # Move spaces outside bold markers: "**Stats Summary **" -> "**Stats Summary** "
        md = re.sub(r"\*\*(\s*)(.+?)(\s*)\*\*", lambda m: f"{m[1]}**{m[2]}**{m[3]}" if m[2].strip() else m[0], md)
        return md.strip() + "\n"


def rewrite_link(href):
    """Old internal links (/blog/day-20, /live-location) -> Jekyll relative_url."""
    if href.startswith("/"):
        path = href[len("/blog"):] if href.startswith("/blog/") else href
        slug = path.strip("/")
        slug = SLUG_FIXES.get(slug, slug)
        return f'{{{{ "/{slug}/" | relative_url }}}}'
    return href


def html_to_text(html):
    text = re.sub(r"<[^>]+>", " ", html or "")
    return re.sub(r"\s+", " ", htmllib.unescape(text)).strip()


# --------------------------------------------------------------------------- images

class ImageStore:
    def __init__(self, download_root, repo_root, cache_dir):
        self.download_root = download_root
        self.repo_root = repo_root
        self.cache_dir = cache_dir
        self.done = {}  # cdn path -> site path
        self.from_cdn, self.failed = [], []
        self.bytes_in = self.bytes_out = 0

    def _source(self, url):
        """Find the original on disk (HTTrack copy), else download from the CDN."""
        parsed = urlparse(url if "//" in url else "https://" + url)
        rel = parsed.path.lstrip("/")
        for candidate in (rel, unquote(rel)):
            p = self.download_root / CDN_HOST / candidate
            if p.is_file():
                return p
        cached = self.cache_dir / unquote(rel)
        if cached.is_file():
            return cached
        cdn_url = f"https://{CDN_HOST}/{rel}?format=original"
        try:
            with urllib.request.urlopen(cdn_url, timeout=60) as resp:
                data = resp.read()
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(data)
            self.from_cdn.append(cdn_url)
            return cached
        except Exception as e:  # noqa: BLE001 - report and carry on
            self.failed.append(f"{cdn_url} ({e})")
            return None

    def add(self, url, slug, prefix=""):
        """Copy + resize one image; return its site path (e.g. /assets/images/day-10/x.jpg)."""
        key = urlparse(url if "//" in url else "https://" + url).path
        if key in self.done:
            return self.done[key]
        src = self._source(url)
        if src is None:
            return None
        name = unquote(Path(key).name).replace("processed_", "").replace("+", "-").replace(" ", "-")
        stem, ext = Path(name).stem, Path(name).suffix.lower()
        if ext == ".jpeg":
            ext = ".jpg"
        out_rel = Path("assets/images") / slug / f"{prefix}{stem}{ext}"
        out = self.repo_root / out_rel
        out.parent.mkdir(parents=True, exist_ok=True)
        self._write_resized(src, out, ext)
        self.bytes_in += src.stat().st_size
        self.bytes_out += out.stat().st_size
        site_path = "/" + out_rel.as_posix()
        self.done[key] = site_path
        return site_path

    @staticmethod
    def _write_resized(src, out, ext):
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
            if ext == ".jpg":
                im.convert("RGB").save(out, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
            elif ext == ".webp":
                im.save(out, "WEBP", quality=JPEG_QUALITY)
            elif ext == ".png":
                im.save(out, "PNG", optimize=True)
            else:
                im.save(out)


# --------------------------------------------------------------------------- main

def text(item, tag):
    return item.findtext(tag, namespaces=NS) or ""


def yaml_str(s):
    return json.dumps(s, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xml", type=Path)
    ap.add_argument("download", type=Path, help="HTTrack folder containing images.squarespace-cdn.com/")
    ap.add_argument("--repo", type=Path, default=Path.cwd())
    args = ap.parse_args()

    repo = args.repo.resolve()
    store = ImageStore(args.download.resolve(), repo, repo / "copies" / "cdn-cache")
    items = list(ET.parse(args.xml).getroot().iter("item"))

    # Attachments are each post's thumbnail; they share the post's exact timestamp
    thumbs = {}
    for it in items:
        if text(it, "wp:post_type") == "attachment":
            thumbs.setdefault(text(it, "wp:post_date"), text(it, "wp:attachment_url"))

    posts = [it for it in items if text(it, "wp:post_type") == "post"]
    published = {text(it, "wp:post_name"): it for it in posts if text(it, "wp:status") == "publish"}
    report = {"posts": [], "drafts": [], "skipped_drafts": [], "warnings": []}

    for it in posts:
        status = text(it, "wp:status")
        title = it.findtext("title") or ""
        old_slug = text(it, "wp:post_name")
        html = text(it, "content:encoded")

        if status != "publish":
            # Squarespace "(Copy)" drafts: skip if identical to a published post's body
            twin = next((p for p in published.values() if text(p, "content:encoded") == html), None)
            if twin is not None or not html.strip():
                report["skipped_drafts"].append(f"{title} ({old_slug}) - same as published '{twin.findtext('title') if twin is not None else '?'}'" if twin is not None else f"{title} ({old_slug}) - empty")
                continue
            base = re.sub(r"\s*\(Copy\)", "", title)
            orig = next((p for p in published.values() if p.findtext("title") == base), None)
            if orig is not None and len(html) <= len(text(orig, "content:encoded")):
                report["skipped_drafts"].append(f"{title} ({old_slug}) - older/shorter copy of published '{base}'")
                continue

        slug = SLUG_FIXES.get(old_slug, old_slug)
        img_slug = slug if status == "publish" else f"drafts/{slug}"
        utc = datetime.strptime(text(it, "wp:post_date"), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        local = utc.astimezone(LOCAL_TZ)

        conv = SquarespaceToMarkdown(lambda src: store.add(src, img_slug) if CDN_HOST in src else None)
        conv.feed(html)
        body = conv.markdown()

        front = [f"title: {yaml_str(title)}", f"date: {local.strftime('%Y-%m-%d %H:%M:%S %z')}"]
        excerpt = html_to_text(text(it, "excerpt:encoded"))
        if excerpt:
            front.append(f"excerpt: {yaml_str(excerpt)}")
        thumb_url = thumbs.get(text(it, "wp:post_date"))
        if thumb_url:
            # Reuse the inline copy when the thumbnail is one of the post's photos
            stem = Path(urlparse(thumb_url).path).stem
            inline = next((p for p in store.done.values() if p.startswith(f"/assets/images/{img_slug}/") and Path(p).stem == stem), None)
            thumb = inline or store.add(thumb_url, img_slug, prefix="thumb-")
            if thumb:
                front.append(f"image: {thumb}")
        if old_slug != slug:
            front.append(f"redirect_from:\n  - /{old_slug}/")

        if status == "publish":
            out = repo / "_posts" / f"{local:%Y-%m-%d}-{slug}.md"
            report["posts"].append(out.name)
        else:
            out = repo / "_drafts" / f"{slug}.md"
            report["drafts"].append(f"{out.name} ({title})")
        out.write_text("---\n" + "\n".join(front) + "\n---\n\n" + body, encoding="utf-8", newline="\n")

        if CDN_HOST in body:
            report["warnings"].append(f"{out.name}: still references {CDN_HOST}")

    print(f"Published posts written: {len(report['posts'])}")
    print(f"Drafts written:          {len(report['drafts'])}")
    for d in report["drafts"]:
        print(f"   {d}")
    print(f"Drafts skipped:          {len(report['skipped_drafts'])}")
    for d in report["skipped_drafts"]:
        print(f"   {d}")
    print(f"Images: {len(store.done)} written, {store.bytes_in / 1e6:.0f} MB -> {store.bytes_out / 1e6:.0f} MB")
    for u in store.from_cdn:
        print(f"   fetched from CDN: {u}")
    for u in store.failed:
        print(f"   FAILED: {u}")
    for w in report["warnings"]:
        print(f"   WARNING: {w}")
    return 1 if store.failed or report["warnings"] else 0


if __name__ == "__main__":
    sys.exit(main())
