# Wheres Matt At?

Blog for my Heysen Trail hike, hosted on GitHub Pages at <https://mattv52.github.io/blog/>.

## Writing a new post (phone)

Open <https://mattv52.github.io/blog/write/> in Chrome on your phone and choose
**⋮ → Add to Home screen → Install**. After that it opens like an app and works without signal.

1. **First time only:** tap ⚙ and add a GitHub token (the steps are on that screen).
2. Tap **+ New post**, then fill in the title, date and summary (the line shown under the title on the home page).
3. Write. Each new line becomes its own paragraph.
4. Tap **📷 Photos** to pick photos or take one. They're shrunk on the phone (1600px, about 300 KB),
   their GPS location is removed, and they're added where the cursor is, shown as `![](photo:3)`.
   You can type a caption inside the `[ ]`. The first photo is the cover unless you tap **Cover** on another one.
5. Tap **Publish**. With no signal, the post waits and publishes itself when signal comes back,
   even if the app is closed. The site updates about a minute after publishing.

Drafts and photos stay on the phone until they're published. To fix a typo later, open the draft, edit it,
and tap **Update post**. Posts imported from Squarespace can only be edited on GitHub.

## Writing a new post (computer)

1. In `_posts/`, add a file named `YYYY-MM-DD-post-name.md`. The `post-name` part becomes the address.
2. Start it with front matter (`title`, optionally `excerpt`, `image` and `thumbnail`), then Markdown.
   Put photos in `assets/images/<post-name>/`, shrunk to about 1600px first.
3. Commit and push. The site updates in about a minute.

## Layout

| Path | What it is |
|---|---|
| `_config.yml` | Site title, theme (Minima), navigation |
| `_posts/` | Published posts |
| `_drafts/` | Unpublished drafts |
| `assets/images/` | Photos, one folder per post |
| `write/` | The phone writing app (offline, installable) |
| `about.md`, `live-location.md` | Pages in the top menu |
| `tools/import_squarespace.py` | One-off script that imported the Squarespace posts and photos |
| `copies/` | Squarespace backups, local only (git-ignored) |
