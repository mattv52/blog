// Offline-first blog writer: drafts and photos live on the phone (IndexedDB) and
// are committed to GitHub when there's signal. See README.md for setup.
/* global BlogDB, Publisher */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const view = $("#view");
  const heading = $("#heading");
  const backBtn = $("#back");
  const photoInput = $("#photo-input");

  let objectUrls = [];
  let current = null; // { draft, photos } while editing
  let saveTimer = null;

  // ------------------------------------------------------------------ helpers

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function urlFor(blob) {
    const u = URL.createObjectURL(blob);
    objectUrls.push(u);
    return u;
  }

  function releaseUrls() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function prettyDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  const STATUS_TEXT = {
    draft: "Draft",
    queued: "Waiting for signal",
    published: "Published",
    error: "Couldn't publish",
  };

  // Fields the editor owns; publish state (status, url, slug…) is written by Publisher
  const EDIT_FIELDS = ["title", "date", "excerpt", "body", "cover", "nextPhoto", "updatedAt"];
  const PUBLISH_FIELDS = ["status", "error", "progress", "url", "slug", "path", "frontMatterDate", "publishStartedAt", "publishedAt"];

  function pick(obj, keys) {
    const out = {};
    keys.forEach((k) => (out[k] = obj[k]));
    return out;
  }

  /** Edited since the last publish began? */
  function isDirty(d) {
    return d.status === "published" && d.updatedAt > (d.publishStartedAt || 0);
  }

  function statusOf(d) {
    if (isDirty(d)) return { cls: "draft", text: "Published · unsent changes" };
    return { cls: d.status, text: STATUS_TEXT[d.status] || d.status };
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  /** Small Markdown renderer for the preview (paragraphs, headings, lists, bold, italic, links, photos). */
  function renderPreview(body, photoUrls) {
    const inline = (s) =>
      escapeHtml(s)
        .replace(/!\[([^\]]*)\]\(photo:(\d+)\)/g, (_, alt, n) => (photoUrls[n] ? `<img src="${photoUrls[n]}" alt="${alt}">` : `[missing photo ${n}]`))
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    return Publisher.normaliseBody(body)
      .split("\n\n")
      .map((block) => {
        const hm = block.match(/^(#{1,6})\s+(.*)$/);
        if (hm) return `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`;
        const lines = block.split("\n");
        if (/^\s*\d+\.\s/.test(lines[0])) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
        if (/^\s*[-*+]\s/.test(lines[0])) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ""))}</li>`).join("")}</ul>`;
        return `<p>${inline(block)}</p>`;
      })
      .join("");
  }

  // ------------------------------------------------------------------ network status

  function updateNet() {
    const net = $("#net");
    net.textContent = navigator.onLine ? "" : "Offline";
    net.className = "net" + (navigator.onLine ? "" : " offline");
  }

  async function tryPublishQueued() {
    if (!navigator.onLine) return;
    try {
      await Publisher.publishQueued(onDraftUpdate);
    } catch (e) {
      /* still offline — Background Sync / the next 'online' event will retry */
    }
  }

  function onDraftUpdate(draft) {
    if (!draft) return;
    if (current && current.draft.id === draft.id) {
      // Keep the text being edited; just take the publish state from storage
      Object.assign(current.draft, pick(draft, PUBLISH_FIELDS));
      renderPublishBar();
    } else if (location.hash === "" || location.hash === "#") {
      showList();
    }
  }

  // ------------------------------------------------------------------ routing

  function route() {
    releaseUrls();
    current = null;
    const hash = location.hash.slice(1);
    if (hash === "settings") return showSettings();
    if (hash.startsWith("edit/")) return showEditor(hash.slice(5));
    return showList();
  }

  backBtn.addEventListener("click", () => {
    flushSave();
    location.hash = "";
  });
  $("#settings-btn").addEventListener("click", () => {
    flushSave();
    location.hash = "settings";
  });

  // ------------------------------------------------------------------ list view

  async function showList() {
    heading.textContent = "Drafts";
    backBtn.hidden = true;
    const [drafts, settings] = await Promise.all([BlogDB.listDrafts(), BlogDB.getSettings()]);
    const items = [];
    for (const d of drafts) {
      const photos = await BlogDB.listPhotos(d.id);
      const used = Publisher.photoNumbers(d.body);
      const coverN = d.cover && used.includes(d.cover) ? d.cover : used[0];
      const cover = photos.find((p) => p.n === coverN);
      const st = statusOf(d);
      items.push(
        h(
          "li",
          { class: "draft", onclick: () => (location.hash = `edit/${d.id}`) },
          cover ? h("img", { src: urlFor(cover.blob), alt: "" }) : h("div", { class: "ph" }),
          h(
            "div",
            { class: "meta" },
            h("div", { class: "title" }, d.title || "Untitled"),
            h("div", { class: "sub" }, prettyDate(d.date), " · ", h("span", { class: `badge ${st.cls}` }, st.text))
          )
        )
      );
    }
    view.replaceChildren(
      settings.token ? "" : h("div", { class: "notice warn" }, "Publishing isn't set up yet. You can still write; add your GitHub token in ", h("a", { href: "#settings" }, "Settings"), " before publishing."),
      h("button", { class: "btn primary block", onclick: newDraft }, "+ New post"),
      items.length ? h("ul", { class: "drafts" }, items) : h("p", { class: "empty" }, "No drafts yet.")
    );
  }

  async function newDraft() {
    const draft = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "",
      date: today(),
      excerpt: "",
      body: "",
      cover: null,
      nextPhoto: 1,
      status: "draft",
      updatedAt: Date.now(),
    };
    await BlogDB.saveDraft(draft);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    location.hash = `edit/${draft.id}`;
  }

  // ------------------------------------------------------------------ editor

  async function showEditor(id) {
    const draft = await BlogDB.getDraft(id);
    if (!draft) {
      location.hash = "";
      return;
    }
    const photos = await BlogDB.listPhotos(id);
    current = { draft, photos, preview: false, busy: "" };
    heading.textContent = draft.title || "New post";
    backBtn.hidden = false;
    renderEditor();
  }

  function scheduleSave() {
    const d = current.draft;
    d.updatedAt = Date.now();
    if (d.status === "error") {
      // Editing after a failed publish goes back to a normal draft
      d.status = "draft";
      d.error = "";
      current.statusChanged = true;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
    renderPublishBar();
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!current) return Promise.resolve();
    const fields = pick(current.draft, EDIT_FIELDS);
    if (current.statusChanged) {
      Object.assign(fields, pick(current.draft, ["status", "error"]));
      current.statusChanged = false;
    }
    return BlogDB.updateDraft(current.draft.id, fields);
  }

  function renderEditor() {
    const d = current.draft;
    const field = (key, el) => {
      el.value = d[key] || "";
      el.addEventListener("input", () => {
        d[key] = el.value;
        if (key === "title") heading.textContent = el.value || "New post";
        scheduleSave();
      });
      return el;
    };

    const body = field("body", h("textarea", { class: "body", id: "body", placeholder: "Write here. Each new line becomes a new paragraph.\n\nTap 📷 to add photos where the cursor is." }));
    const previewBox = h("div", { class: "preview", id: "preview", hidden: true });

    view.replaceChildren(
      h("label", { for: "title" }, "Title"),
      field("title", h("input", { type: "text", class: "title-input", id: "title", placeholder: "Day 1", autocapitalize: "sentences" })),
      h(
        "div",
        { class: "row" },
        // The date is part of the post's file name, so it's fixed once published
        h("div", {}, h("label", { for: "date" }, "Date"), field("date", h("input", { type: "date", id: "date", disabled: !!d.path }))),
        h("div", {}, h("label", { for: "excerpt" }, "Summary (shown on home page)"), field("excerpt", h("input", { type: "text", id: "excerpt", placeholder: "Quorn to Wilmington" })))
      ),
      h(
        "div",
        { class: "toolbar" },
        h("button", { class: "btn primary", onclick: () => photoInput.click() }, "📷 Photos"),
        h("button", { class: "btn", onclick: () => wrapSelection("**", "**", "bold") }, h("b", {}, "B")),
        h("button", { class: "btn", onclick: () => prefixLine("## ") }, "Heading"),
        h("button", { class: "btn", onclick: () => prefixLine("- ") }, "• List"),
        h("button", { class: "btn", id: "preview-btn", onclick: togglePreview }, "Preview")
      ),
      body,
      previewBox,
      h("div", { class: "busy", id: "busy" }),
      h("div", { class: "photos", id: "photos" }),
      h("div", { class: "publish-bar", id: "publish-bar" })
    );
    renderPhotos();
    renderPublishBar();
  }

  function renderPhotos() {
    const d = current.draft;
    const used = Publisher.photoNumbers(d.body);
    const coverN = d.cover && used.includes(d.cover) ? d.cover : used[0];
    const box = $("#photos");
    if (!box) return;
    box.replaceChildren(
      ...current.photos.map((p) =>
        h(
          "div",
          { class: "photo" },
          h("img", { src: p.url || (p.url = urlFor(p.blob)), alt: `Photo ${p.n}`, class: used.includes(p.n) ? "" : "unused" }),
          h("span", { class: "num" }, used.includes(p.n) ? `#${p.n}` : `#${p.n} not in post`),
          p.n === coverN ? h("span", { class: "cover-tag" }, "Cover") : "",
          h(
            "div",
            { class: "acts" },
            h("button", { onclick: () => insertPhotos([p.n]) }, "Insert"),
            h("button", { onclick: () => setCover(p.n) }, "Cover"),
            h("button", { onclick: () => removePhoto(p.n), "aria-label": `Remove photo ${p.n}` }, "✕")
          )
        )
      )
    );
  }

  function renderPublishBar() {
    const bar = $("#publish-bar");
    if (!bar || !current) return;
    const d = current.draft;
    const dirty = isDirty(d);
    let status = "";
    if (d.progress) status = h("div", { class: "status queued" }, d.progress);
    else if (d.status === "queued") status = h("div", { class: "status queued" }, d.error || "Waiting for signal. It will publish automatically, even if you close the app.");
    else if (d.status === "error") status = h("div", { class: "status error" }, d.error);
    else if (d.status === "published")
      status = h(
        "div",
        { class: "status published" },
        dirty ? "Published. You have changes that aren't on the blog yet. " : "Published (the site takes about a minute to update). ",
        h("a", { href: d.url, target: "_blank", rel: "noopener" }, "View post")
      );

    const label = d.status === "published" ? "Update post" : d.status === "queued" ? "Waiting for signal…" : "Publish";
    const disabled = d.status === "queued" || (d.status === "published" && !dirty);
    bar.replaceChildren(
      status,
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn primary", disabled, onclick: publish }, label),
        h("button", { class: "btn danger", onclick: deleteDraft, style: "flex: 0 0 auto" }, "Delete")
      )
    );
  }

  // -- text helpers

  function insertAtCursor(text) {
    const ta = $("#body");
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.setRangeText(text, start, end, "end");
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  }

  function wrapSelection(before, after, placeholder) {
    const ta = $("#body");
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const sel = value.slice(s, e) || placeholder;
    ta.setRangeText(before + sel + after, s, e, "select");
    ta.setSelectionRange(s + before.length, s + before.length + sel.length);
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  }

  function prefixLine(prefix) {
    const ta = $("#body");
    const lineStart = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    if (ta.value.startsWith(prefix, lineStart)) return ta.focus();
    ta.setRangeText(prefix, lineStart, lineStart, "end");
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  }

  function togglePreview() {
    current.preview = !current.preview;
    const ta = $("#body");
    const pv = $("#preview");
    if (current.preview) {
      const urls = {};
      current.photos.forEach((p) => (urls[p.n] = p.url || (p.url = urlFor(p.blob))));
      pv.innerHTML = renderPreview(current.draft.body, urls) || "<p><em>Nothing written yet.</em></p>";
    }
    ta.hidden = current.preview;
    pv.hidden = !current.preview;
    $("#preview-btn").textContent = current.preview ? "Edit" : "Preview";
  }

  // -- photos

  photoInput.addEventListener("change", async () => {
    const files = [...photoInput.files];
    photoInput.value = "";
    if (!files.length || !current) return;
    const d = current.draft;
    const busy = $("#busy");
    const added = [];
    for (let i = 0; i < files.length; i++) {
      busy.textContent = `Shrinking photo ${i + 1} of ${files.length}…`;
      try {
        const small = await Publisher.resizeImage(files[i], Publisher.MAX_SIDE, Publisher.JPEG_QUALITY);
        const photo = { draftId: d.id, n: d.nextPhoto++, blob: small.blob, width: small.width, height: small.height };
        await BlogDB.savePhoto(photo);
        current.photos.push(photo);
        added.push(photo.n);
      } catch (e) {
        alert(`Couldn't read ${files[i].name || "that photo"}: ${e.message}`);
      }
    }
    busy.textContent = "";
    if (added.length) insertPhotos(added);
    scheduleSave(); // nextPhoto changed
  });

  function insertPhotos(numbers) {
    if (current.preview) togglePreview();
    const ta = $("#body");
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    insertAtCursor(lead + numbers.map((n) => `![](photo:${n})`).join("\n") + "\n");
    renderPhotos();
  }

  function setCover(n) {
    current.draft.cover = n;
    if (!Publisher.photoNumbers(current.draft.body).includes(n)) insertPhotos([n]);
    scheduleSave();
    renderPhotos();
  }

  async function removePhoto(n) {
    if (!confirm(`Remove photo #${n} from this post?`)) return;
    const d = current.draft;
    d.body = d.body.replace(new RegExp(`^.*!\\[[^\\]]*\\]\\(photo:${n}\\).*\\n?`, "gm"), "");
    $("#body").value = d.body;
    if (d.cover === n) d.cover = null;
    await BlogDB.deletePhoto(d.id, n);
    current.photos = current.photos.filter((p) => p.n !== n);
    scheduleSave();
    renderPhotos();
  }

  // -- publish / delete

  async function publish() {
    const d = current.draft;
    if (!d.title.trim()) {
      alert("Give the post a title first.");
      $("#title").focus();
      return;
    }
    const missing = Publisher.photoNumbers(d.body).filter((n) => !current.photos.some((p) => p.n === n));
    if (missing.length) {
      alert(`The text mentions photo ${missing.join(", ")}, which isn't attached any more. Remove that line first.`);
      return;
    }
    const settings = await BlogDB.getSettings();
    if (!settings.token) {
      alert("Add your GitHub token in Settings first. Your draft is saved.");
      return;
    }
    d.status = "queued";
    d.error = "";
    current.statusChanged = true;
    await flushSave();
    renderPublishBar();

    // Ask Android to publish when signal returns, even if the app is closed
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg.sync) await reg.sync.register("publish");
      if (!navigator.onLine && window.Notification && Notification.permission === "default") {
        await Notification.requestPermission();
      }
    } catch (e) {
      /* Background Sync unavailable: we'll retry whenever the app is open and online */
    }
    await tryPublishQueued();
  }

  async function deleteDraft() {
    const d = current.draft;
    const msg = d.status === "published" ? "Delete this draft from your phone? The published post stays on the blog." : "Delete this draft and its photos?";
    if (!confirm(msg)) return;
    clearTimeout(saveTimer);
    await BlogDB.deleteDraft(d.id);
    current = null;
    location.hash = "";
  }

  // ------------------------------------------------------------------ settings

  async function showSettings() {
    heading.textContent = "Settings";
    backBtn.hidden = false;
    const s = await BlogDB.getSettings();
    const input = (key, attrs) => {
      const el = h("input", Object.assign({ id: key, autocomplete: "off", autocapitalize: "off", spellcheck: "false" }, attrs));
      el.value = s[key] || "";
      return el;
    };
    const result = h("div", { class: "result" });
    const read = () => {
      for (const k of ["token", "owner", "repo", "branch", "siteUrl"]) s[k] = $(`#${k}`).value.trim();
      return s;
    };

    let usage = "";
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      usage = `Drafts and photos on this phone use ${(est.usage / 1e6).toFixed(1)} MB.`;
    }

    view.replaceChildren(
      h(
        "div",
        { class: "settings" },
        h("div", { class: "notice" },
          h("strong", {}, "One-time setup: "),
          "create a GitHub token that can only edit your blog.",
          h("ol", {},
            h("li", {}, "Open ", h("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener" }, "GitHub → New fine-grained token"), "."),
            h("li", {}, "Name it “Blog writer”. Set Expiration to the longest allowed."),
            h("li", {}, "Repository access: ", h("b", {}, "Only select repositories"), " → ", h("b", {}, "blog"), "."),
            h("li", {}, "Permissions → Repository permissions → ", h("b", {}, "Contents: Read and write"), "."),
            h("li", {}, "Generate token, copy it, and paste it below.")
          ),
          "The token is stored only on this phone."
        ),
        h("label", { for: "token" }, "GitHub token"),
        input("token", { type: "password", placeholder: "github_pat_…" }),
        h("div", { class: "row" },
          h("div", {}, h("label", { for: "owner" }, "GitHub user"), input("owner", { type: "text" })),
          h("div", {}, h("label", { for: "repo" }, "Repository"), input("repo", { type: "text" })),
          h("div", {}, h("label", { for: "branch" }, "Branch"), input("branch", { type: "text" }))
        ),
        h("label", { for: "siteUrl" }, "Blog address"),
        input("siteUrl", { type: "url" }),
        h("div", { class: "actions" },
          h("button", {
            class: "btn primary",
            onclick: async () => {
              await BlogDB.saveSettings(read());
              result.className = "result ok";
              result.textContent = "Saved.";
            },
          }, "Save"),
          h("button", {
            class: "btn",
            onclick: async () => {
              await BlogDB.saveSettings(read());
              result.className = "result";
              result.textContent = "Checking…";
              try {
                await Publisher.testConnection(s);
                result.className = "result ok";
                result.textContent = `Saved. Connected to ${s.owner}/${s.repo} and can publish.`;
                tryPublishQueued();
              } catch (e) {
                result.className = "result bad";
                result.textContent = e.message;
              }
            },
          }, "Save & test")
        ),
        result,
        h("p", { class: "hint" }, usage)
      )
    );
  }

  // ------------------------------------------------------------------ start

  window.addEventListener("hashchange", () => {
    flushSave();
    route();
  });
  window.addEventListener("online", () => {
    updateNet();
    tryPublishQueued();
  });
  window.addEventListener("offline", updateNet);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
    navigator.serviceWorker.addEventListener("message", async (e) => {
      if (e.data && e.data.type === "draft-updated") onDraftUpdate(await BlogDB.getDraft(e.data.id));
    });
  }

  updateNet();
  route();
  tryPublishQueued();
})();
