# Wheres Matt At?

Blog for my Heysen Trail hike, hosted on GitHub Pages at <https://mattv52.github.io/blog/>.

## Writing a new post

1. In `_posts/`, add a file named `YYYY-MM-DD-post-name.md` (e.g. `2026-10-12-back-home.md`).
   The `post-name` part becomes the address: `mattv52.github.io/blog/back-home/`.
2. Start it with:

   ```markdown
   ---
   title: "Back home"
   ---

   Your text here, in Markdown.

   ![Photo description](/blog/assets/images/back-home/photo1.jpg)
   ```

3. Put the post's photos in `assets/images/<post-name>/`. Shrink phone photos first
   (about 2000px wide is plenty) to keep the repo small.
4. Commit and push (or save on github.com). The site updates in about a minute.

Posts in `_drafts/` (no date in the file name) are not published.

## Layout

| Path | What it is |
|---|---|
| `_config.yml` | Site title, theme (Minima), navigation |
| `_posts/` | Published posts |
| `_drafts/` | Unpublished drafts |
| `assets/images/` | Photos, one folder per post |
| `about.md`, `live-location.md` | Pages in the top menu |
| `tools/import_squarespace.py` | One-off script that imported the Squarespace posts and photos |
| `copies/` | Squarespace backups, local only (git-ignored) |
