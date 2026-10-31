"use strict";

const {
  Plugin,
  EditorSuggest,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  TFile,
  TFolder,
  AbstractInputSuggest,
  normalizePath,
  parseFrontMatterAliases,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  enabled: true,
  above: true,
  showForms: true,
  extraIrregular: "",
  // Mỗi thư mục: path = nơi chứa ghi chú, tag = bộ thẻ ôn Spaced Repetition (trống = không tạo thẻ)
  folders: [],
  minChars: 2,
  maxWords: 4,
  limit: 12,
};
const DEFAULT_FOLDER = { path: "Tiếng Anh/Từ vựng", tag: "flashcards/tieng-anh", enabled: true };

// Từ dạng ASCII, cho phép số, _, ' và - ở giữa (don't, well-known, GPIO_Init, ADC1)
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_'’-]*/g;
const LETTER_RE = /[\p{L}\p{N}_]/u;

// ---------- Gợi ý khi gõ ----------

class WordSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.suffixes = [];
    this.limit = plugin.settings.limit;
  }

  onTrigger(cursor, editor) {
    const s = this.plugin.settings;
    if (!s.enabled) return null;

    const before = editor.getLine(cursor.line).slice(0, cursor.ch);

    // Đang gõ bên trong [[...]] thì để gợi ý mặc định của Obsidian lo
    if (before.lastIndexOf("[[") > before.lastIndexOf("]]")) return null;
    // Bỏ qua trong inline code
    if ((before.match(/`/g) || []).length % 2 === 1) return null;

    const tokens = [];
    for (const m of before.matchAll(TOKEN_RE)) {
      tokens.push({ start: m.index, end: m.index + m[0].length });
    }
    const last = tokens[tokens.length - 1];
    if (!last || last.end !== before.length) return null;
    // "đi" -> token "i" đứng sau chữ "đ": không phải từ tiếng Anh
    if (last.start > 0 && LETTER_RE.test(before[last.start - 1])) return null;

    // Các đoạn đuôi 1..maxWords từ, nối nhau chỉ bằng dấu cách: "u", "look u", ...
    const suffixes = [];
    for (let k = 1; k <= s.maxWords && k <= tokens.length; k++) {
      const first = tokens[tokens.length - k];
      if (k > 1) {
        const gap = before.slice(first.end, tokens[tokens.length - k + 1].start);
        if (!/^ +$/.test(gap)) break;
      }
      if (first.start > 0 && LETTER_RE.test(before[first.start - 1])) break;
      const raw = before.slice(first.start);
      // Số ký tự tối thiểu tính cho cả cụm: "look u" vẫn gợi ý dù "u" chỉ 1 chữ
      if (raw.length < s.minChars) continue;
      suffixes.push({ start: first.start, raw, text: normalize(raw), words: k });
    }
    if (!suffixes.length) return null;
    this.suffixes = suffixes;

    const longest = suffixes[suffixes.length - 1];
    return {
      start: { line: cursor.line, ch: longest.start },
      end: cursor,
      query: longest.text,
    };
  }

  getSuggestions() {
    const entries = this.plugin.getIndex();
    const found = new Map();

    // Đoạn đuôi dài nhất trước: "look u" khớp "look up" được ưu tiên hơn "u" khớp "use"
    for (let i = this.suffixes.length - 1; i >= 0; i--) {
      const sfx = this.suffixes[i];
      for (const entry of entries) {
        if (found.has(entry.path)) continue;
        const key = entry.keys.find((k) => k.norm.startsWith(sfx.text));
        if (!key) continue;
        found.set(entry.path, {
          entry,
          key,
          sfx,
          exact: key.norm === sfx.text,
        });
      }
    }

    return [...found.values()]
      .sort(
        (a, b) =>
          b.sfx.words - a.sfx.words ||
          b.exact - a.exact ||
          a.key.norm.length - b.key.norm.length ||
          a.key.norm.localeCompare(b.key.norm)
      )
      .slice(0, this.plugin.settings.limit);
  }

  // reposition() là API nội bộ của Obsidian (mặc định đặt popup dưới con trỏ).
  // Đẩy popup lên trên dòng đang gõ nếu phía trên đủ chỗ.
  reposition(rect, align) {
    if (super.reposition) super.reposition(rect, align);
    if (!this.plugin.settings.above || !rect) return;
    const el = this.suggestEl;
    const top = rect.top - el.offsetHeight - 5;
    if (top >= 0) el.style.top = `${top}px`;
  }

  renderSuggestion(item, el) {
    const { entry, key } = item;
    el.addClass("gyta-item");
    const top = el.createDiv({ cls: "gyta-top" });
    if (key.isForm) {
      // "went → go"
      top.createSpan({ cls: "gyta-term", text: key.text });
      top.createSpan({ cls: "gyta-alias", text: `→ ${entry.term}` });
    } else {
      top.createSpan({ cls: "gyta-term", text: entry.term });
      if (key.isAlias) top.createSpan({ cls: "gyta-alias", text: `(${key.text})` });
    }
    if (entry.ipa) top.createSpan({ cls: "gyta-ipa", text: entry.ipa });
    if (entry.loai) top.createSpan({ cls: "gyta-type", text: entry.loai });
    if (this.plugin.activeFolders().length > 1) {
      top.createSpan({ cls: "gyta-folder", text: entry.folder.split("/").pop() });
    }
    const meaning = [key.isForm ? `${key.label} của ${entry.term}` : "", entry.nghia].filter(Boolean).join(" · ");
    if (meaning) el.createDiv({ cls: "gyta-meaning", text: meaning });
  }

  selectSuggestion(item) {
    const ctx = this.context;
    if (!ctx) return;
    const { entry, key, sfx } = item;

    // Giữ chữ hoa đầu câu: gõ "Hel" -> [[hello|Hello]]; biến thể giữ chữ đã chia: [[go|went]]
    let display = key.isAlias || key.isForm ? key.text : entry.term;
    if (/^[A-Z]/.test(sfx.raw) && /^[a-z]/.test(display)) {
      display = display[0].toUpperCase() + display.slice(1);
    }
    const link = display === entry.term ? `[[${entry.term}]]` : `[[${entry.term}|${display}]]`;

    const from = { line: ctx.end.line, ch: sfx.start };
    ctx.editor.replaceRange(link, from, ctx.end);
    ctx.editor.setCursor({ line: from.line, ch: from.ch + link.length });
  }
}

// ---------- Hộp thoại thêm từ ----------

class AddWordModal extends Modal {
  constructor(plugin, term, onDone) {
    super(plugin.app);
    this.plugin = plugin;
    this.data = { term, ipa: "", loai: "", nghia: "", vidu: "" };
    this.folders = plugin.activeFolders();
    this.folder = this.folders[0];
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle("Thêm từ vựng");
    if (!this.folder) {
      contentEl.setText("Chưa có thư mục nào được bật. Vào Cài đặt → Gợi ý tiếng Anh để thêm.");
      return;
    }
    if (this.folders.length > 1) {
      new Setting(contentEl).setName("Thư mục").addDropdown((d) => {
        this.folders.forEach((f, i) => d.addOption(String(i), f.path));
        d.onChange((v) => (this.folder = this.folders[Number(v)]));
      });
    }
    const field = (name, prop, placeholder, area) =>
      new Setting(contentEl).setName(name).then((st) => {
        const add = area ? st.addTextArea.bind(st) : st.addText.bind(st);
        add((t) => {
          t.setPlaceholder(placeholder).setValue(this.data[prop]);
          t.onChange((v) => (this.data[prop] = v));
          if (prop === "term") setTimeout(() => t.inputEl.focus(), 0);
        });
      });

    field("Từ / cụm từ", "term", "hello, look up…");
    field("Phiên âm", "ipa", "/həˈloʊ/");
    field("Từ loại", "loai", "danh từ, động từ, thán từ…");
    field("Nghĩa", "nghia", "xin chào");
    field("Ví dụ", "vidu", "Hello, how are you? — Chào bạn, bạn khỏe không?", true);

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Lưu").setCta().onClick(() => this.save())
    );
    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        this.save();
      }
    });
  }

  async save() {
    const term = this.data.term.trim();
    if (!term) return new Notice("Chưa nhập từ");
    if (/[\\/:*?"<>|#^\[\]]/.test(term)) return new Notice("Tên từ có ký tự không hợp lệ");
    try {
      const file = await this.plugin.createWordNote({ ...this.data, term }, this.folder);
      this.close();
      this.onDone?.(file);
    } catch (e) {
      new Notice(e.message);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------- Cài đặt ----------

// Gõ vào ô đường dẫn thì gợi ý các thư mục đang có trong vault
class FolderSuggest extends AbstractInputSuggest {
  constructor(app, inputEl, onPick) {
    super(app, inputEl);
    this.onPick = onPick;
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && !f.isRoot() && f.path.toLowerCase().includes(q))
      .slice(0, 30);
  }

  renderSuggestion(folder, el) {
    el.setText(folder.path);
  }

  selectSuggestion(folder) {
    this.setValue(folder.path);
    this.onPick(folder.path);
    this.close();
  }
}

class SettingTab extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl).setName("Bật gợi ý khi gõ").addToggle((t) =>
      t.setValue(p.settings.enabled).onChange(async (v) => {
        p.settings.enabled = v;
        await p.saveSettings();
      })
    );
    new Setting(containerEl)
      .setName("Hiện gợi ý phía trên con trỏ")
      .setDesc("Tắt thì popup nằm dưới như gợi ý mặc định của Obsidian.")
      .addToggle((t) =>
        t.setValue(p.settings.above).onChange(async (v) => {
          p.settings.above = v;
          await p.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Hiện biến thể trong ghi chú từ vựng")
      .setDesc("Dòng \"Biến thể: goes · went · gone · going\" dưới tiêu đề. Chỉ hiển thị, không ghi vào file.")
      .addToggle((t) =>
        t.setValue(p.settings.showForms).onChange(async (v) => {
          p.settings.showForms = v;
          await p.saveSettings();
          p.refreshForms();
        })
      );
    new Setting(containerEl)
      .setName("Thư mục từ vựng")
      .setDesc(
        "Mỗi ghi chú trong các thư mục này (kể cả thư mục con) là một từ/cụm từ. " +
          "Cột thứ hai là tag bộ thẻ ôn, ví dụ flashcards/stm32; để trống nếu không muốn tạo thẻ."
      )
      .setHeading();

    const update = async (fn) => {
      fn();
      p.index = null;
      await p.saveSettings();
    };
    p.settings.folders.forEach((f, i) => {
      new Setting(containerEl)
        .setClass("gyta-folder-row")
        .addText((t) => {
          t.setPlaceholder("Tiếng Anh/Từ vựng").setValue(f.path);
          const setPath = (v) => update(() => (f.path = cleanPath(v)));
          t.onChange(setPath);
          new FolderSuggest(this.app, t.inputEl, setPath);
        })
        .addText((t) =>
          t
            .setPlaceholder("flashcards/… (trống = không tạo thẻ)")
            .setValue(f.tag)
            .onChange((v) => update(() => (f.tag = v.trim().replace(/^#/, ""))))
        )
        .addToggle((t) =>
          t
            .setTooltip("Bật/tắt thư mục này")
            .setValue(f.enabled)
            .onChange((v) => update(() => (f.enabled = v)))
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Xoá khỏi danh sách (không xoá ghi chú)")
            .onClick(async () => {
              await update(() => p.settings.folders.splice(i, 1));
              this.display();
            })
        );
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("+ Thêm thư mục").onClick(async () => {
        await update(() => p.settings.folders.push({ path: "", tag: "", enabled: true }));
        this.display();
      })
    );

    new Setting(containerEl).setName("Bảng bất quy tắc bổ sung").setHeading();
    const status = (r) =>
      `Đang dùng ${r.count} dòng.` + (r.bad.length ? ` Bỏ qua dòng ${r.bad.join(", ")} (phải có 2 hoặc 3 từ).` : "");
    const info = new Setting(containerEl)
      .setDesc(
        "Mỗi dòng một từ, áp dụng cho mọi ghi chú và ưu tiên hơn bảng có sẵn. " +
          "3 từ: động từ (dwell dwelt dwelt) hoặc tính từ (far further furthest), dùng theo loai của ghi chú. " +
          "2 từ: danh từ số nhiều (crisis crises). Dạng thay thế cách nhau bằng /. Dòng bắt đầu bằng # là ghi chú."
      )
      .setClass("gyta-irregular");
    const statusEl = info.descEl.createDiv({ cls: "gyta-irregular-status", text: status(setUserIrregular(p.settings.extraIrregular)) });
    info.addTextArea((t) => {
      t.setPlaceholder("dwell dwelt dwelt\ncrisis crises\ncactus cacti/cactuses\nsheep sheep")
        .setValue(p.settings.extraIrregular)
        .onChange(async (v) => {
          p.settings.extraIrregular = v;
          statusEl.setText(status(setUserIrregular(v)));
          p.index = null;
          p.refreshForms();
          await p.saveSettings();
        });
      t.inputEl.rows = 8;
    });

    new Setting(containerEl).setName("Tuỳ chỉnh gợi ý").setHeading();
    const num = (name, desc, prop, min, max) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addSlider((sl) =>
          sl
            .setLimits(min, max, 1)
            .setValue(p.settings[prop])
            .setDynamicTooltip()
            .onChange(async (v) => {
              p.settings[prop] = v;
              await p.saveSettings();
            })
        );
    num("Số ký tự tối thiểu", "Gõ bao nhiêu chữ thì bắt đầu gợi ý.", "minChars", 1, 5);
    num("Số từ tối đa của cụm", "Dò cụm từ dài tối đa bao nhiêu từ.", "maxWords", 1, 6);
    num("Số gợi ý tối đa", "", "limit", 3, 30);
  }
}

// ---------- Plugin ----------

module.exports = class GoiYTiengAnh extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Bản cũ chỉ có một ô "folder"
    if (!Array.isArray(data.folders)) {
      this.settings.folders = [{ ...DEFAULT_FOLDER, path: data.folder ?? DEFAULT_FOLDER.path }];
    }
    delete this.settings.folder;
    setUserIrregular(this.settings.extraIrregular);
    this.index = null;

    this.registerEditorSuggest(new WordSuggest(this));
    this.addSettingTab(new SettingTab(this));

    const invalidate = (file) => {
      if (!file || this.inFolder(file.path) || this.inFolder(file.oldPath || "")) this.index = null;
    };
    this.registerEvent(this.app.metadataCache.on("changed", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(this.app.vault.on("rename", (f, old) => {
      if (this.inFolder(f.path) || this.inFolder(old)) this.index = null;
    }));
    this.registerEvent(this.app.metadataCache.on("resolved", () => (this.index = null)));

    // Dòng "Biến thể" dưới tiêu đề ghi chú từ vựng (chỉ hiển thị, không ghi file)
    const ws = this.app.workspace;
    this.registerEvent(ws.on("file-open", () => this.refreshForms()));
    this.registerEvent(ws.on("layout-change", () => this.refreshForms()));
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) => {
        if (this.inFolder(f.path)) setTimeout(() => this.refreshForms(), 0);
      })
    );
    ws.onLayoutReady(() => this.refreshForms());
    this.register(() => document.querySelectorAll(".gyta-forms").forEach((e) => e.remove()));

    this.addCommand({
      id: "toggle",
      name: "Bật/tắt gợi ý khi gõ",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        new Notice(`Gợi ý tiếng Anh: ${this.settings.enabled ? "BẬT" : "TẮT"}`);
      },
    });

    this.addCommand({
      id: "add-word",
      name: "Thêm từ vựng mới",
      editorCallback: (editor) => {
        // Lấy chữ đang bôi đen, hoặc từ ngay tại con trỏ
        let from = editor.getCursor("from");
        let to = editor.getCursor("to");
        let term = editor.getSelection();
        if (!term) {
          const range = editor.wordAt?.(from);
          if (range) {
            from = range.from;
            to = range.to;
            term = editor.getRange(from, to);
          }
        }
        new AddWordModal(this, term.trim(), (file) => {
          if (term) editor.replaceRange(`[[${file.basename}]]`, from, to);
        }).open();
      },
    });

    this.addCommand({
      id: "add-missing-cards",
      name: "Tạo thẻ ôn cho các từ chưa có thẻ",
      callback: () => this.addMissingCards(),
    });

    this.addCommand({
      id: "add-word-global",
      name: "Thêm từ vựng mới (không chèn link)",
      callback: () => new AddWordModal(this, "").open(),
    });
  }

  refreshForms() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      view.containerEl.querySelectorAll(".gyta-forms").forEach((e) => e.remove());
      const file = view.file;
      if (!this.settings.showForms || !file || !this.inFolder(file.path)) continue;
      const entry = this.getIndex().find((e) => e.path === file.path);
      const forms = entry ? entry.keys.filter((k) => k.isForm) : [];
      if (!forms.length) continue;

      // Đặt ngay dưới tiêu đề, ở cả chế độ soạn thảo lẫn chế độ đọc
      let anchors = [...view.containerEl.querySelectorAll(".inline-title")];
      const after = anchors.length > 0;
      if (!after) anchors = [...view.containerEl.querySelectorAll(".cm-sizer, .markdown-preview-sizer")];
      for (const anchor of anchors) {
        const box = createDiv({ cls: "gyta-forms" });
        box.createSpan({ cls: "gyta-forms-title", text: "Biến thể" });
        for (const f of forms) {
          const chip = box.createSpan({ cls: "gyta-form", attr: { "aria-label": f.label } });
          chip.createSpan({ text: f.text });
          chip.createSpan({ cls: "gyta-form-label", text: f.label });
        }
        if (after) anchor.after(box);
        else anchor.prepend(box);
      }
    }
  }

  activeFolders() {
    return this.settings.folders.filter((f) => f.enabled && f.path);
  }

  // Thư mục (đang bật) chứa file này; thư mục sâu nhất thắng nếu lồng nhau
  folderFor(path) {
    if (!path) return null;
    return (
      this.activeFolders()
        .filter((f) => path.startsWith(f.path + "/"))
        .sort((a, b) => b.path.length - a.path.length)[0] || null
    );
  }

  inFolder(path) {
    return !!this.folderFor(path);
  }

  getIndex() {
    if (this.index) return this.index;
    const cache = this.app.metadataCache;
    this.index = this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.inFolder(f.path))
      .map((file) => {
        const fm = cache.getFileCache(file)?.frontmatter || {};
        const aliases = parseFrontMatterAliases(fm) || [];
        // khong_chia: bỏ phần tự sinh, chỉ dùng đúng danh sách bien_the bạn ghi
        const forms = inflect(file.basename, fm.khong_chia === true ? "" : str(fm.loai), list(fm.bien_the));
        return {
          path: file.path,
          folder: this.folderFor(file.path).path,
          term: file.basename,
          ipa: str(fm.ipa),
          loai: str(fm.loai),
          nghia: str(fm.nghia),
          keys: [
            { text: file.basename, norm: normalize(file.basename), isAlias: false },
            ...aliases.map((a) => ({ text: a, norm: normalize(a), isAlias: true })),
            ...forms.map((f) => ({ text: f.text, norm: normalize(f.text), isForm: true, label: f.label })),
          ],
        };
      });
    return this.index;
  }

  async createWordNote({ term, ipa, loai, nghia, vidu }, cfg = this.activeFolders()[0]) {
    if (!cfg) throw new Error("Chưa có thư mục từ vựng nào được bật");
    const folder = normalizePath(cfg.path);
    const withCard = !!(cfg.tag && nghia.trim());
    const path = normalizePath(`${folder}/${term}.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      new Notice(`"${term}" đã có, dùng ghi chú cũ`);
      return existing;
    }
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    const q = (v) => JSON.stringify((v || "").trim());
    const examples = (vidu || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `- ${l}`)
      .join("\n");
    const content = [
      "---",
      `ipa: ${q(ipa)}`,
      `loai: ${q(loai)}`,
      `nghia: ${q(nghia)}`,
      "aliases: []",
      "bien_the: []",
      `tags: [tu-vung${withCard ? ", " + cfg.tag : ""}]`,
      "---",
      "",
      "## Ví dụ",
      examples || "- ",
      "",
      ...(withCard ? [CARD_HEADING, "", ...cardLines({ term, ipa, loai, nghia }).flatMap((l) => [l, ""])] : []),
      "## Ghi chú",
      "",
    ].join("\n");
    const file = await this.app.vault.create(path, content);
    this.index = null;
    new Notice(`Đã thêm "${term}"`);
    return file;
  }

  // Thêm thẻ ôn cho các ghi chú từ vựng chưa có (ví dụ ghi chú tự viết tay)
  async addMissingCards() {
    let added = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cfg = this.folderFor(file.path);
      if (!cfg || !cfg.tag) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      if (!str(fm.nghia).trim()) continue;
      const text = await this.app.vault.read(file);
      // Chỉ thêm những dòng thẻ chưa có (so theo phần câu hỏi), giữ nguyên lịch ôn của thẻ cũ
      const data = { term: file.basename, ipa: str(fm.ipa), loai: str(fm.loai), nghia: str(fm.nghia) };
      const wanted = text.includes(CARD_HEADING)
        ? [fm.khong_chia === true ? null : irregularCard(data.term, data.loai)] // đã có thẻ chính
        : [cardLine(data), fm.khong_chia === true ? null : irregularCard(data.term, data.loai)];
      const missing = wanted.filter((l) => l && !text.includes(l.split(/:::?/)[0]));
      if (!missing.length) continue;

      const lines = missing.map((l) => `${l}\n\n`).join("");
      await this.app.vault.process(file, (t) => {
        const h = t.indexOf(CARD_HEADING);
        if (h >= 0) {
          const at = h + CARD_HEADING.length;
          return t.slice(0, at) + "\n\n" + lines.trimEnd() + t.slice(at);
        }
        const block = `${CARD_HEADING}\n\n${lines}`;
        const i = t.indexOf("## Ghi chú");
        return i >= 0 ? t.slice(0, i) + block + t.slice(i) : t.replace(/\s*$/, `\n\n${block}`);
      });
      await this.app.fileManager.processFrontMatter(file, (f) => {
        const tags = [].concat(f.tags || []).flatMap((t) => String(t).split(/[,\s]+/)).filter(Boolean);
        if (!tags.includes(cfg.tag)) tags.push(cfg.tag);
        f.tags = tags;
      });
      added++;
    }
    new Notice(`Đã thêm thẻ ôn cho ${added} từ`);
    return added;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

// Dòng thẻ theo cú pháp của plugin Spaced Repetition (":::" = thẻ hai chiều)
const CARD_HEADING = "## Thẻ ôn";

function cleanPath(v) {
  return v.trim().replace(/^\/+|\/+$/g, "");
}

function cardLine({ term, ipa, loai, nghia }) {
  const q = [`**${term}**`, (ipa || "").trim()].filter(Boolean).join(" ");
  const a = loai && loai.trim() ? `${nghia.trim()} (${loai.trim()})` : nghia.trim();
  return `${q}:::${a}`;
}

function cardLines(data) {
  return [cardLine(data), irregularCard(data.term, data.loai)].filter(Boolean);
}

// ---------- Biến thể từ (chia động từ, số nhiều, so sánh) ----------

// "nguyên mẫu quá khứ phân_từ", dạng thay thế cách nhau bằng "/"
const IRREGULAR_VERBS = `
arise arose arisen|awake awoke awoken|be was/were been|bear bore born/borne|beat beat beaten
become became become|begin began begun|bend bent bent|bet bet bet|bind bound bound|bite bit bitten
bleed bled bled|blow blew blown|break broke broken|breed bred bred|bring brought brought
broadcast broadcast broadcast|build built built|burn burnt/burned burnt/burned|burst burst burst
buy bought bought|catch caught caught|choose chose chosen|cling clung clung|come came come
cost cost cost|creep crept crept|cut cut cut|deal dealt dealt|dig dug dug|do did done|draw drew drawn
dream dreamt/dreamed dreamt/dreamed|drink drank drunk|drive drove driven|eat ate eaten|fall fell fallen
feed fed fed|feel felt felt|fight fought fought|find found found|flee fled fled|fly flew flown
forbid forbade forbidden|forecast forecast forecast|forget forgot forgotten|forgive forgave forgiven
freeze froze frozen|get got got/gotten|give gave given|go went gone|grind ground ground|grow grew grown
hang hung hung|have had had|hear heard heard|hide hid hidden|hit hit hit|hold held held|hurt hurt hurt
keep kept kept|kneel knelt knelt|know knew known|lay laid laid|lead led led|lean leant/leaned leant/leaned
learn learnt/learned learnt/learned|leave left left|lend lent lent|let let let|lie lay lain|light lit lit
lose lost lost|make made made|mean meant meant|meet met met|mistake mistook mistaken
misunderstand misunderstood misunderstood|overcome overcame overcome|pay paid paid|prove proved proven/proved
put put put|quit quit quit|read read read|ride rode ridden|ring rang rung|rise rose risen|run ran run
say said said|see saw seen|seek sought sought|sell sold sold|send sent sent|set set set|sew sewed sewn
shake shook shaken|shine shone shone|shoot shot shot|show showed shown|shrink shrank shrunk|shut shut shut
sing sang sung|sink sank sunk|sit sat sat|sleep slept slept|slide slid slid|smell smelt/smelled smelt/smelled
speak spoke spoken|speed sped sped|spell spelt/spelled spelt/spelled|spend spent spent|spill spilt/spilled spilt/spilled
spin spun spun|spit spat spat|split split split|spoil spoilt/spoiled spoilt/spoiled|spread spread spread
spring sprang sprung|stand stood stood|steal stole stolen|stick stuck stuck|sting stung stung|stink stank stunk
strike struck struck|strive strove striven|swear swore sworn|sweep swept swept|swim swam swum|swing swung swung
take took taken|teach taught taught|tear tore torn|tell told told|think thought thought|throw threw thrown
understand understood understood|undertake undertook undertaken|upset upset upset|wake woke woken
wear wore worn|weave wove woven|weep wept wept|win won won|wind wound wound|withdraw withdrew withdrawn
write wrote written`;

const IRREGULAR = new Map(
  IRREGULAR_VERBS.split(/[|\n]/)
    .map((s) => s.trim().split(/\s+/))
    .filter((p) => p.length === 3)
    .map(([base, v2, v3]) => [base, { v2: v2.split("/"), v3: v3.split("/") }])
);

const THIRD_PERSON = { be: ["is", "am", "are"], have: ["has"], do: ["does"] };

const IRREGULAR_NOUNS = {
  man: "men", woman: "women", child: "children", person: "people", foot: "feet", tooth: "teeth",
  mouse: "mice", goose: "geese", knife: "knives", leaf: "leaves", life: "lives", wife: "wives",
  half: "halves", wolf: "wolves", shelf: "shelves",
};

const IRREGULAR_ADJ = {
  good: ["better", "best"], bad: ["worse", "worst"], far: ["farther", "farthest"],
  little: ["less", "least"], many: ["more", "most"], much: ["more", "most"],
};

// Bảng bổ sung từ cài đặt, ưu tiên hơn bảng có sẵn.
// 3 từ: động từ (V1 V2 V3) hoặc tính từ (gốc hơn nhất), dùng theo loai của ghi chú. 2 từ: danh từ số nhiều.
let userTriples = new Map();
let userNouns = new Map();

function setUserIrregular(text) {
  userTriples = new Map();
  userNouns = new Map();
  const bad = [];
  (text || "").split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const p = line.toLowerCase().split(/\s+/);
    if (p.length === 3) userTriples.set(p[0], { a: p[1].split("/"), b: p[2].split("/") });
    else if (p.length === 2) userNouns.set(p[0], p[1].split("/"));
    else bad.push(i + 1);
  });
  return { count: userTriples.size + userNouns.size, bad };
}

function verbForms(head) {
  const u = userTriples.get(head);
  return u ? { v2: u.a, v3: u.b } : IRREGULAR.get(head);
}

function syllables(w) {
  // Bỏ "e" câm cuối từ (nice, large) nhưng giữ "-le" (simple)
  return (w.replace(/(?<!l)e$/, "").match(/[aeiouy]+/g) || []).length;
}

// Một âm tiết, kết thúc phụ âm-nguyên âm-phụ âm: stop -> stopp-, big -> bigg-
function doubles(w) {
  return syllables(w) === 1 && /[^aeiou][aeiou][^aeiouwxy]$/.test(w);
}

function thirdPerson(w) {
  if (THIRD_PERSON[w]) return THIRD_PERSON[w];
  if (/(s|x|z|ch|sh|o)$/.test(w)) return [w + "es"];
  if (/[^aeiou]y$/.test(w)) return [w.slice(0, -1) + "ies"];
  return [w + "s"];
}

function pastRegular(w) {
  if (w.endsWith("e")) return w + "d";
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + "ied";
  if (doubles(w)) return w + w.slice(-1) + "ed";
  return w + "ed";
}

function ing(w) {
  if (w === "be") return "being";
  if (w.endsWith("ie")) return w.slice(0, -2) + "ying";
  if (/[^eioy]e$/.test(w) && w.length > 2) return w.slice(0, -1) + "ing";
  if (doubles(w)) return w + w.slice(-1) + "ing";
  return w + "ing";
}

function plural(w) {
  if (userNouns.has(w)) return userNouns.get(w);
  if (IRREGULAR_NOUNS[w]) return [IRREGULAR_NOUNS[w]];
  if (/(s|x|z|ch|sh)$/.test(w)) return [w + "es"];
  if (/[^aeiou]y$/.test(w)) return [w.slice(0, -1) + "ies"];
  return [w + "s"];
}

function comparatives(w) {
  const u = userTriples.get(w);
  if (u) return [u.a[0], u.b[0]];
  if (IRREGULAR_ADJ[w]) return IRREGULAR_ADJ[w];
  const n = syllables(w);
  // Tính từ dài (beautiful) dùng more/most, không chia
  if (n > 2 || (n === 2 && !w.endsWith("y"))) return [];
  if (/[^aeiou]y$/.test(w)) return [w.slice(0, -1) + "ier", w.slice(0, -1) + "iest"];
  if (w.endsWith("e")) return [w + "r", w + "st"];
  if (doubles(w)) return [w + w.slice(-1) + "er", w + w.slice(-1) + "est"];
  return [w + "er", w + "est"];
}

// Trả về [{ text, label }] các dạng biến thể của từ/cụm từ, theo từ loại
function inflect(term, loai, extra) {
  const out = new Map();
  const add = (text, label) => {
    const t = text.trim();
    if (t && normalize(t) !== normalize(term) && !out.has(normalize(t))) out.set(normalize(t), { text: t, label });
  };

  for (const t of extra) add(t, "biến thể");

  const type = (loai || "").toLowerCase();
  const words = term.trim().split(/\s+/);
  // Chỉ chia từ tiếng Anh thường (bỏ qua GPIO, HAL_GPIO_WritePin…)
  if (!words.every((w) => /^[a-z][a-z'-]*$/.test(w))) return [...out.values()];

  if (type.includes("động từ")) {
    // Cụm động từ: chia từ đầu, giữ phần sau (look up -> looked up)
    const [head, ...rest] = words;
    const tail = rest.length ? " " + rest.join(" ") : "";
    const irr = verbForms(head);
    for (const f of thirdPerson(head)) add(f + tail, "ngôi 3 số ít");
    for (const f of irr ? irr.v2 : [pastRegular(head)]) add(f + tail, "quá khứ");
    for (const f of irr ? irr.v3 : [pastRegular(head)]) add(f + tail, "quá khứ phân từ");
    add(ing(head) + tail, "V-ing");
  }
  if (type.includes("danh từ")) {
    // Cụm danh từ: số nhiều ở từ cuối
    const last = words[words.length - 1];
    for (const f of plural(last)) add([...words.slice(0, -1), f].join(" "), "số nhiều");
  }
  if (type.includes("tính từ") && words.length === 1) {
    const [er, est] = comparatives(words[0]);
    if (er) add(er, "so sánh hơn");
    if (est) add(est, "so sánh nhất");
  }
  return [...out.values()];
}

// Thẻ ôn V2 – V3 cho động từ bất quy tắc (kể cả cụm: give up -> gave up – given up)
function irregularCard(term, loai) {
  if (!(loai || "").toLowerCase().includes("động từ")) return null;
  const [head, ...rest] = term.trim().split(/\s+/);
  const irr = verbForms(head);
  if (!irr) return null;
  const tail = rest.length ? " " + rest.join(" ") : "";
  const v2 = irr.v2.map((f) => f + tail).join("/");
  const v3 = irr.v3.map((f) => f + tail).join("/");
  return `**${term}** (V2 – V3)::${v2} – ${v3}`;
}

function normalize(s) {
  return s.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
}

function list(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);
}

function str(v) {
  if (v == null) return "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}
