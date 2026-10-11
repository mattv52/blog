// Turning drafts into Jekyll posts and committing them to GitHub.
// Shared by the page and the service worker (Background Sync), so no DOM APIs.
/* global self, BlogDB */
(function (scope) {
  "use strict";

  const MAX_SIDE = 1600; // matches the imported Squarespace photos
  const THUMB_SIDE = 800; // home-page cover images
  const JPEG_QUALITY = 0.82;

  // ------------------------------------------------------------------ images

  /** Resize an image Blob/File to a JPEG no larger than maxSide. Re-encoding drops EXIF (incl. GPS). */
  async function resizeImage(blob, maxSide, quality) {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: quality || JPEG_QUALITY });
    return { blob: out, width: w, height: h };
  }

  // ------------------------------------------------------------------ markdown

  function slugify(title) {
    return (
      (title || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "post"
    );
  }

  const LIST_LINE = /^\s*([-*+]|\d+\.)\s/;

  /**
   * Phone keyboards make Enter feel like "new paragraph", so every non-empty line
   * becomes its own paragraph — except consecutive list lines, which stay together.
   */
  function normaliseBody(body) {
    const blocks = [];
    let prevList = false;
    for (const raw of (body || "").replace(/\r/g, "").split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) {
        prevList = false;
        continue;
      }
      const isList = LIST_LINE.test(line);
      if (isList && prevList) blocks[blocks.length - 1] += "\n" + line;
      else blocks.push(line);
      prevList = isList;
    }
    return blocks.join("\n\n");
  }

  /** Photo references in the editor look like ![caption](photo:3). */
  const PHOTO_REF = /!\[([^\]]*)\]\(photo:(\d+)\)/g;

  function photoNumbers(body) {
    return [...new Set([...(body || "").matchAll(PHOTO_REF)].map((m) => Number(m[2])))];
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /** "2026-10-12 18:04:00 +1030" using the phone's clock and time zone. */
  function frontMatterDate(dateStr, now) {
    now = now || new Date();
    const off = -now.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const tz = sign + pad(Math.floor(Math.abs(off) / 60)) + pad(Math.abs(off) % 60);
    return `${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${tz}`;
  }

  function imagePath(slug, n) {
    return `/assets/images/${slug}/${n}.jpg`;
  }

  function coverPath(slug, n) {
    return `/assets/images/${slug}/${n}-small.jpg`;
  }

  /** The chosen cover (which needn't appear in the post), else the first photo in the post. */
  function coverNumber(draft, photoNs) {
    if (draft.cover && photoNs.includes(draft.cover)) return draft.cover;
    return photoNumbers(draft.body).find((n) => photoNs.includes(n)) || null;
  }

  function buildPost(draft, slug, coverN) {
    const body = normaliseBody(draft.body).replace(
      PHOTO_REF,
      (_, alt, n) => `![${alt}]({{ "${imagePath(slug, n)}" | relative_url }})`
    );
    const fm = [
      `title: ${JSON.stringify(draft.title || "Untitled")}`,
      `date: ${draft.frontMatterDate}`,
    ];
    if (draft.excerpt && draft.excerpt.trim()) fm.push(`excerpt: ${JSON.stringify(draft.excerpt.trim())}`);
    if (coverN) {
      // A cover that isn't in the post only gets its small copy uploaded, so share previews use that
      const inPost = photoNumbers(draft.body).includes(coverN);
      fm.push(`image: ${inPost ? imagePath(slug, coverN) : coverPath(slug, coverN)}`);
      fm.push(`thumbnail: ${coverPath(slug, coverN)}`);
    }
    return `---\n${fm.join("\n")}\n---\n\n${body}\n`;
  }

  // ------------------------------------------------------------------ GitHub

  class GitHubError extends Error {
    constructor(message, status, retryable) {
      super(message);
      this.status = status;
      this.retryable = retryable;
    }
  }

  function github(settings) {
    const base = `https://api.github.com/repos/${settings.owner}/${settings.repo}`;
    return async function api(method, path, body) {
      let res;
      try {
        res = await fetch(base + path, {
          method,
          headers: {
            Authorization: `Bearer ${settings.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
        });
      } catch (e) {
        throw new GitHubError("No connection to GitHub", 0, true);
      }
      if (res.status === 404 && method === "GET") return null;
      if (!res.ok) {
        let msg = `GitHub said ${res.status}`;
        try {
          msg += ": " + (await res.json()).message;
        } catch (e) {
          /* not JSON */
        }
        if (res.status === 401) msg = "GitHub token is missing, wrong or expired. Check Settings.";
        if (res.status === 403 || res.status === 404)
          msg = "Token can't write to the repo. Check it has Contents: Read and write on " + settings.repo + ".";
        throw new GitHubError(msg, res.status, res.status >= 500 || res.status === 429);
      }
      return res.status === 204 ? null : res.json();
    };
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function utf8ToBase64(text) {
    return blobToBase64(new Blob([text], { type: "text/plain" }));
  }

  async function testConnection(settings) {
    const api = github(settings);
    const repo = await api("GET", "");
    if (!repo) throw new GitHubError(`Can't see ${settings.owner}/${settings.repo}. Check the token's repository access.`, 404, false);
    if (repo.permissions && !repo.permissions.push) {
      throw new GitHubError("Token can read the repo but not write to it. Give it Contents: Read and write.", 403, false);
    }
    return repo;
  }

  /**
   * Publish (or update) one draft as a single commit: new photos, the cover's small
   * copy and the post file. Uploaded blob SHAs are saved as we go so a dropped
   * connection doesn't mean re-uploading every photo.
   */
  async function publishDraft(draft, settings, onProgress) {
    const progress = onProgress || (() => {});
    const api = github(settings);
    const branch = settings.branch || "main";

    const used = photoNumbers(draft.body);
    const coverN = coverNumber(draft, (await BlogDB.listPhotos(draft.id)).map((p) => p.n));

    // Pick the post's file name once; later updates keep it even if the title changes
    let slug = draft.slug;
    let path = draft.path;
    if (!path) {
      progress("Checking the post name…");
      const existing = new Set(
        ((await api("GET", `/contents/_posts?ref=${branch}`)) || []).map((f) => f.name.replace(/^\d{4}-\d\d-\d\d-/, ""))
      );
      const base = slugify(draft.title);
      slug = base;
      for (let i = 2; existing.has(`${slug}.md`); i++) slug = `${base}-${i}`;
      path = `_posts/${draft.date}-${slug}.md`;
      draft.slug = slug;
      draft.path = path;
      draft.frontMatterDate = frontMatterDate(draft.date);
      await BlogDB.updateDraft(draft.id, { slug, path, frontMatterDate: draft.frontMatterDate });
    }
    if (!draft.frontMatterDate) draft.frontMatterDate = frontMatterDate(draft.date);

    // Upload photo blobs (skipping ones already uploaded on an earlier attempt)
    const tree = [];
    let i = 0;
    for (const n of used) {
      i++;
      const photo = await BlogDB.getPhoto(draft.id, n);
      if (!photo) throw new GitHubError(`Photo ${n} is referenced in the text but no longer exists.`, 0, false);
      const target = imagePath(slug, n).slice(1);
      if (photo.uploadedPath !== target || !photo.blobSha) {
        progress(`Uploading photo ${i} of ${used.length}…`);
        const res = await api("POST", "/git/blobs", { content: await blobToBase64(photo.blob), encoding: "base64" });
        photo.blobSha = res.sha;
        photo.uploadedPath = target;
        await BlogDB.savePhoto(photo);
      }
      tree.push({ path: target, mode: "100644", type: "blob", sha: photo.blobSha });
    }

    if (coverN) {
      progress("Making the cover image…");
      const photo = await BlogDB.getPhoto(draft.id, coverN);
      const small = await resizeImage(photo.blob, THUMB_SIDE, 0.8);
      const res = await api("POST", "/git/blobs", { content: await blobToBase64(small.blob), encoding: "base64" });
      tree.push({ path: coverPath(slug, coverN).slice(1), mode: "100644", type: "blob", sha: res.sha });
    }

    progress("Uploading the post…");
    const postBlob = await api("POST", "/git/blobs", { content: await utf8ToBase64(buildPost(draft, slug, coverN)), encoding: "base64" });
    tree.push({ path, mode: "100644", type: "blob", sha: postBlob.sha });

    // Commit; retry if something else was pushed in the meantime
    for (let attempt = 1; ; attempt++) {
      progress("Saving to GitHub…");
      const ref = await api("GET", `/git/ref/heads/${branch}`);
      if (!ref) throw new GitHubError(`Branch ${branch} not found.`, 404, false);
      const head = await api("GET", `/git/commits/${ref.object.sha}`);

      // Delete photos in this post's folder that it no longer uses (replaced cover, removed photos).
      // The folder belongs to this post alone: its slug was checked unique when first published.
      const folder = `assets/images/${slug}/`;
      const keep = new Set(tree.map((t) => t.path));
      const existing = (await api("GET", `/contents/${folder.slice(0, -1)}?ref=${ref.object.sha}`)) || [];
      const removals = (Array.isArray(existing) ? existing : [])
        .filter((f) => f.type === "file" && f.path.startsWith(folder) && !keep.has(f.path))
        .map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: null }));

      const newTree = await api("POST", "/git/trees", { base_tree: head.tree.sha, tree: tree.concat(removals) });
      const verb = draft.url ? "Update" : "Add";
      const commit = await api("POST", "/git/commits", {
        message: `${verb} post: ${draft.title || "Untitled"}`,
        tree: newTree.sha,
        parents: [ref.object.sha],
      });
      try {
        await api("PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha });
        break;
      } catch (e) {
        if (e.status === 422 && attempt < 3) continue; // branch moved on; rebuild on the new head
        throw e;
      }
    }

    draft.url = `${settings.siteUrl.replace(/\/$/, "")}/${slug}/`;
    return draft;
  }

  /** Publish every draft that's waiting for signal. Safe to call from page and worker at once. */
  async function publishQueued(onUpdate) {
    const notify = onUpdate || (() => {});
    // Only publish-state fields are written here; the editor owns the text.
    const update = async (id, fields) => {
      const saved = await BlogDB.updateDraft(id, fields);
      if (saved) await notify(saved);
      return saved;
    };
    const run = async () => {
      const settings = await BlogDB.getSettings();
      const queued = (await BlogDB.listDrafts()).filter((d) => d.status === "queued");
      const published = [];
      for (const d of queued) {
        const publishStartedAt = Date.now();
        const draft = await update(d.id, { publishStartedAt, progress: "Starting…" });
        if (!draft || draft.status !== "queued") continue;
        try {
          await publishDraft(draft, settings, (msg) => update(draft.id, { progress: msg }));
          published.push(
            await update(draft.id, {
              status: "published",
              error: "",
              progress: "",
              url: draft.url,
              slug: draft.slug,
              path: draft.path,
              frontMatterDate: draft.frontMatterDate,
              publishedAt: Date.now(),
            })
          );
        } catch (e) {
          await update(draft.id, e.retryable ? { error: "Waiting for signal…", progress: "" } : { status: "error", error: e.message, progress: "" });
          if (e.retryable) throw e; // lets Background Sync try again later
        }
      }
      return published.filter(Boolean);
    };
    if (scope.navigator && navigator.locks) {
      return navigator.locks.request("blog-writer-publish", run);
    }
    return run();
  }

  scope.Publisher = {
    MAX_SIDE,
    JPEG_QUALITY,
    resizeImage,
    slugify,
    normaliseBody,
    photoNumbers,
    coverNumber,
    PHOTO_REF,
    publishQueued,
    testConnection,
  };
})(typeof self !== "undefined" ? self : window);
