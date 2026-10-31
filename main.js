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
  // Từ điển có sẵn: gợi ý cả từ chưa có ghi chú, chọn thì mới tạo ghi chú trong dictFolder
  dictEnabled: true,
  dictFolder: "Tiếng Anh/Từ vựng",
  dictMinChars: 3,
  // Gốc từ: dòng "Phân tích" tô màu, khung "Họ từ", ghi chú cho từng tiền tố / gốc / hậu tố
  showMorph: true,
  morphFolder: "Tiếng Anh/Gốc từ",
  morphCards: true,
};
const DEFAULT_FOLDER = { path: "Tiếng Anh/Từ vựng", tag: "flashcards/tieng-anh", enabled: true };

// Từ dạng ASCII, cho phép số, _, ' và - ở giữa (don't, well-known, GPIO_Init, ADC1)
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_'’-]*/g;
const LETTER_RE = /[\p{L}\p{N}_]/u;
// Dòng có chữ tiếng Việt -> đang gõ tiếng Việt, "con", "the"… chưa thành dấu không phải tiếng Anh
const VIET_RE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

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
    this.vietLine = VIET_RE.test(before);

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
    const dictMin = this.plugin.settings.dictMinChars;

    // Đoạn đuôi dài nhất trước: "look u" khớp "look up" được ưu tiên hơn "u" khớp "use"
    for (let i = this.suffixes.length - 1; i >= 0; i--) {
      const sfx = this.suffixes[i];
      const allowDict = !this.vietLine && sfx.text.length >= dictMin;
      for (const entry of entries) {
        if (found.has(entry.path)) continue;
        if (entry.dict && !allowDict) continue;
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
          !!a.entry.dict - !!b.entry.dict || // từ đã có ghi chú đứng trước từ điển
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
    if (entry.dict) {
      top.createSpan({ cls: "gyta-folder gyta-dict", text: "từ điển" });
    } else if (this.plugin.activeFolders().length > 1) {
      top.createSpan({ cls: "gyta-folder", text: entry.folder.split("/").pop() });
    }
    const meaning = [key.isForm ? `${key.label} của ${entry.term}` : "", entry.nghia].filter(Boolean).join(" · ");
    if (meaning) el.createDiv({ cls: "gyta-meaning", text: meaning });
    if (this.plugin.settings.showMorph) {
      const parts = (!entry.dict && this.plugin.partsOf(entry)) || analyze(entry.term);
      if (parts && parts.length > 1) el.createDiv({ cls: "gyta-pop-parts", text: formatParts(parts) });
    }
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

    // Từ trong từ điển: giờ mới tạo ghi chú (kèm thẻ ôn) để link không bị trống
    if (entry.dict) this.plugin.createFromDict(entry).catch((e) => new Notice(e.message));
  }
}

// ---------- Hộp thoại thêm từ ----------

class AddWordModal extends Modal {
  constructor(plugin, term, onDone) {
    super(plugin.app);
    this.plugin = plugin;
    // Có trong từ điển thì điền sẵn phiên âm, từ loại, nghĩa
    const d = dictLookup(term);
    const parts = analyze(term);
    this.data = {
      term,
      ipa: d?.ipa || "",
      loai: d?.loai || "",
      nghia: d?.nghia || "",
      phan_tich: parts && parts.length > 1 ? formatParts(parts) : "",
      vidu: "",
    };
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
    field("Phân tích", "phan_tich", "in- + spir + e  (tiền tố-  gốc  -hậu tố, để trống nếu không cần)");
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

    new Setting(containerEl)
      .setName("Từ điển có sẵn")
      .setDesc(`${dictEntries().length} từ thông dụng kèm phiên âm, nghĩa. Chọn một từ thì mới tạo ghi chú và thẻ ôn cho từ đó.`)
      .setHeading();
    new Setting(containerEl).setName("Gợi ý cả từ trong từ điển").addToggle((t) =>
      t.setValue(p.settings.dictEnabled).onChange((v) => update(() => (p.settings.dictEnabled = v)))
    );
    new Setting(containerEl)
      .setName("Tạo ghi chú vào thư mục")
      .addText((t) => {
        t.setValue(p.settings.dictFolder);
        const setPath = (v) => update(() => (p.settings.dictFolder = cleanPath(v)));
        t.onChange(setPath);
        new FolderSuggest(this.app, t.inputEl, setPath);
      });
    new Setting(containerEl)
      .setName("Số ký tự tối thiểu cho từ điển")
      .setDesc("Từ điển chỉ gợi ý khi gõ đủ số chữ này, và không gợi ý trên dòng đang có chữ tiếng Việt.")
      .addSlider((sl) =>
        sl
          .setLimits(2, 6, 1)
          .setValue(p.settings.dictMinChars)
          .setDynamicTooltip()
          .onChange((v) => update(() => (p.settings.dictMinChars = v)))
      );

    new Setting(containerEl)
      .setName("Gốc từ (tiền tố, gốc, hậu tố)")
      .setDesc(
        "Ghi chú từ vựng hiện dòng Phân tích tô màu (in- + spir + e) và các từ cùng gốc. " +
          "Bấm vào một mảnh để mở ghi chú của mảnh đó, trong đó có khung Họ từ."
      )
      .setHeading();
    new Setting(containerEl).setName("Hiện phân tích và họ từ").addToggle((t) =>
      t.setValue(p.settings.showMorph).onChange((v) => update(() => (p.settings.showMorph = v)))
    );
    new Setting(containerEl)
      .setName("Thư mục ghi chú gốc từ")
      .setDesc("Nơi tạo ghi chú con-.md, spir.md, -ation.md khi bấm vào một mảnh.")
      .addText((t) => {
        t.setValue(p.settings.morphFolder);
        const setPath = (v) => update(() => (p.settings.morphFolder = cleanPath(v)));
        t.onChange(setPath);
        new FolderSuggest(this.app, t.inputEl, setPath);
      });
    new Setting(containerEl)
      .setName("Thẻ ôn gốc từ và tách từ")
      .setDesc("Thẻ **spir** (gốc từ)::thở… cho ghi chú gốc từ, và **inspire** (tách từ)::in- (vào trong) + spir (thở) + e khi lưu cách tách.")
      .addToggle((t) => t.setValue(p.settings.morphCards).onChange((v) => update(() => (p.settings.morphCards = v))));

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
        if (this.inFolder(f.path) || this.inMorphFolder(f.path)) setTimeout(() => this.refreshForms(), 0);
      })
    );
    ws.onLayoutReady(() => this.refreshForms());
    this.register(() => document.querySelectorAll(".gyta-deco").forEach((e) => e.remove()));

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

  // Phần hiển thị dưới tiêu đề (không ghi file): Biến thể, Phân tích, Cùng gốc; ghi chú gốc từ thì Họ từ
  refreshForms() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      view.containerEl.querySelectorAll(".gyta-deco").forEach((e) => e.remove());
      const file = view.file;
      if (!file) continue;
      const build = this.inFolder(file.path)
        ? () => this.buildWordDeco(file)
        : this.settings.showMorph && this.inMorphFolder(file.path)
          ? () => this.buildMorphDeco(file)
          : null;
      if (!build) continue;

      // Đặt ngay dưới tiêu đề, ở cả chế độ soạn thảo lẫn chế độ đọc
      let anchors = [...view.containerEl.querySelectorAll(".inline-title")];
      const after = anchors.length > 0;
      if (!after) anchors = [...view.containerEl.querySelectorAll(".cm-sizer, .markdown-preview-sizer")];
      for (const anchor of anchors) {
        const box = build();
        if (!box) break;
        if (after) anchor.after(box);
        else anchor.prepend(box);
      }
    }
  }

  buildWordDeco(file) {
    const entry = this.getIndex().find((e) => e.path === file.path);
    if (!entry) return null;
    const box = createDiv({ cls: "gyta-deco" });

    const forms = entry.keys.filter((k) => k.isForm);
    if (this.settings.showForms && forms.length) {
      const row = box.createDiv({ cls: "gyta-forms" });
      row.createSpan({ cls: "gyta-forms-title", text: "Biến thể" });
      for (const f of forms) {
        const chip = row.createSpan({ cls: "gyta-form", attr: { "aria-label": f.label } });
        chip.createSpan({ text: f.text });
        chip.createSpan({ cls: "gyta-form-label", text: f.label });
      }
    }

    if (this.settings.showMorph) {
      const saved = this.partsOf(entry);
      const parts = saved || analyze(entry.term);
      if (parts) {
        if (saved || parts.length > 1) {
          const row = box.createDiv({ cls: "gyta-forms gyta-morph" + (saved ? "" : " is-suggested") });
          row.createSpan({ cls: "gyta-forms-title", text: saved ? "Phân tích" : "Đề xuất tách" });
          parts.forEach((p, i) => {
            if (i) row.createSpan({ cls: "gyta-plus", text: "+" });
            this.renderPart(row, p, file.path);
          });
          if (!saved) {
            const btn = row.createEl("button", { cls: "gyta-use", text: "Dùng cách tách này" });
            btn.onclick = () => this.setPhanTich(file, formatParts(parts));
          }
        }

        // Các từ khác cùng gốc
        const seen = new Set([normalize(entry.term)]);
        const family = [];
        for (const r of parts.filter((p) => p.kind === "root")) {
          for (const e of this.family(r)) {
            if (seen.has(normalize(e.term))) continue;
            seen.add(normalize(e.term));
            family.push(e);
          }
        }
        if (family.length) {
          const fam = box.createDiv({ cls: "gyta-forms" });
          fam.createSpan({ cls: "gyta-forms-title", text: "Cùng gốc" });
          for (const e of family.slice(0, 12)) this.renderWordChip(fam, e, file.path);
          if (family.length > 12) fam.createSpan({ cls: "gyta-forms-title", text: `+${family.length - 12}` });
        }
      }
    }
    return box.childElementCount ? box : null;
  }

  buildMorphDeco(file) {
    const part = this.morphPartOf(file);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const meaning = str(fm.nghia) || MORPH[part.kind]?.get(part.key)?.meaning || "";
    const box = createDiv({ cls: "gyta-deco gyta-family" });
    const head = box.createDiv({ cls: "gyta-forms" });
    const chip = head.createSpan({ cls: `gyta-part is-${part.kind}` });
    chip.createSpan({ text: morphNoteName(part.kind, part.key) });
    head.createSpan({ cls: "gyta-forms-title", text: `${MORPH_LABEL[part.kind]} · ${meaning}` });

    const family = this.family(part);
    const groups = new Map();
    for (const e of family) {
      const t = (e.loai || "").toLowerCase();
      const g = ["động từ", "danh từ", "tính từ", "trạng từ"].find((x) => t.includes(x)) || "khác";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    const title = box.createDiv({ cls: "gyta-family-title", text: `Họ từ (${family.length})` });
    if (!family.length) title.setText("Họ từ: chưa tìm thấy từ nào có mảnh này.");
    for (const g of ["động từ", "danh từ", "tính từ", "trạng từ", "khác"]) {
      const list = groups.get(g);
      if (!list) continue;
      const row = box.createDiv({ cls: "gyta-forms" });
      row.createSpan({ cls: "gyta-forms-title", text: g });
      for (const e of list.slice(0, 60)) this.renderWordChip(row, e, file.path);
      if (list.length > 60) row.createSpan({ cls: "gyta-forms-title", text: `+${list.length - 60}` });
    }
    return box;
  }

  // Mảnh tô màu: tiền tố đỏ, gốc xanh, hậu tố cam, từ xanh lá; bấm để mở ghi chú của mảnh
  renderPart(row, p, sourcePath) {
    const chip = row.createSpan({ cls: `gyta-part is-${p.kind}` });
    chip.createSpan({ text: p.kind === "prefix" ? `${p.text}-` : p.kind === "suffix" ? `-${p.text}` : p.text });
    const m = this.partMeaning(p);
    if (m) chip.createSpan({ cls: "gyta-part-meaning", text: m });
    if (p.kind === "link") return;
    chip.addClass("is-clickable");
    chip.onclick = () => this.openPart(p, sourcePath).catch((e) => new Notice(e.message));
  }

  renderWordChip(row, e, sourcePath) {
    const chip = row.createSpan({ cls: "gyta-form gyta-word" + (e.dict ? " is-dict" : ""), attr: { "aria-label": e.nghia } });
    chip.createSpan({ text: e.term });
    chip.onclick = () => this.openWord(e, sourcePath).catch((err) => new Notice(err.message));
  }

  partsOf(entry) {
    if (entry.dict) return null;
    if (entry._parts === undefined) entry._parts = parseParts(entry.phanTich);
    return entry._parts;
  }

  // Mọi từ (ghi chú + từ điển) có mảnh này; ghi chú chưa xác nhận cách tách thì dùng đề xuất
  family(part) {
    return this.getIndex().filter((e) => {
      const parts = this.partsOf(e) || analyze(e.term);
      return parts && parts.some((p) => samePart(p, part));
    });
  }

  partMeaning(p) {
    if (p.kind === "link") return "";
    if (p.kind === "word") return this.getIndex().find((e) => normalize(e.term) === normalize(p.text))?.nghia || "";
    const file = this.morphFile(p);
    const fm = file && this.app.metadataCache.getFileCache(file)?.frontmatter;
    return str(fm?.nghia) || MORPH[p.kind]?.get(p.text.toLowerCase())?.meaning || "";
  }

  inMorphFolder(path) {
    const f = normalizePath(this.settings.morphFolder || "");
    return !!f && !!path && path.startsWith(f + "/");
  }

  morphFile(p) {
    const path = normalizePath(`${this.settings.morphFolder}/${morphNoteName(p.kind, p.key || p.text)}.md`);
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  // Ghi chú trong thư mục gốc từ -> mảnh tương ứng ("con-" tiền tố, "-ation" hậu tố, còn lại gốc)
  morphPartOf(file) {
    const name = file.basename;
    const loai = str(this.app.metadataCache.getFileCache(file)?.frontmatter?.loai).toLowerCase();
    const kind =
      name.endsWith("-") || loai.includes("tiền tố")
        ? "prefix"
        : name.startsWith("-") || loai.includes("hậu tố")
          ? "suffix"
          : "root";
    const key = name.replace(/^-+|-+$/g, "");
    return { kind, text: key, key: MORPH[kind].get(key.toLowerCase())?.key || key };
  }

  morphTag() {
    const cfg = this.activeFolders().find((f) => f.path === this.settings.dictFolder) || this.activeFolders()[0];
    return cfg?.tag || "";
  }

  async ensureMorphNote(p) {
    const existing = this.morphFile(p);
    if (existing) return existing;
    const folder = normalizePath(this.settings.morphFolder);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const name = morphNoteName(p.kind, p.key || p.text);
    const meaning = MORPH[p.kind]?.get((p.key || p.text).toLowerCase())?.meaning || "";
    const variants = [...MORPH[p.kind].entries()].filter(([f, v]) => v.key === p.key && f !== p.key).map(([f]) => f);
    const tag = this.morphTag();
    const withCard = !!(tag && meaning && this.settings.morphCards);
    const q = (v) => JSON.stringify(v);
    const content = [
      "---",
      `loai: ${q(MORPH_LABEL[p.kind])}`,
      `nghia: ${q(meaning)}`,
      `bien_the: [${variants.join(", ")}]`,
      `tags: [goc-tu${withCard ? ", " + tag : ""}]`,
      "---",
      "",
      "> Họ từ (các từ có mảnh này) được plugin hiện tự động ở đầu ghi chú.",
      "",
      ...(withCard ? [CARD_HEADING, "", `**${name}** (${MORPH_LABEL[p.kind]})::${meaning}`, ""] : []),
      "## Ghi chú",
      "",
    ].join("\n");
    return this.app.vault.create(normalizePath(`${folder}/${name}.md`), content);
  }

  async openPart(p, sourcePath) {
    if (p.kind === "word") {
      const e = this.getIndex().find((x) => normalize(x.term) === normalize(p.text));
      if (e) return this.openWord(e, sourcePath);
      return;
    }
    const file = await this.ensureMorphNote(p);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async openWord(e, sourcePath) {
    if (e.dict) {
      const file = await this.createFromDict(e);
      return this.app.workspace.getLeaf(false).openFile(file);
    }
    return this.app.workspace.openLinkText(e.term, sourcePath);
  }

  // Xác nhận cách tách: ghi phan_tich + thẻ "tách từ"
  async setPhanTich(file, text) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.phan_tich = text;
    });
    this.index = null;
    if (this.settings.morphCards) await this.addMissingCards([file], { phan_tich: text, quiet: true });
    new Notice(`Đã lưu cách tách: ${text}`);
  }

  // **inspire** (tách từ)::in- (vào trong) + spir (thở, thổi hơi) + e
  morphCard(term, parts) {
    if (!parts || parts.length < 2) return null;
    const desc = parts
      .map((p) => {
        if (p.kind === "link") return p.text;
        const t = p.kind === "prefix" ? `${p.text}-` : p.kind === "suffix" ? `-${p.text}` : p.text;
        const m = this.partMeaning(p);
        return m ? `${t} (${m})` : t;
      })
      .join(" + ");
    return `**${term}** (tách từ)::${desc}`;
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
          phanTich: str(fm.phan_tich),
          keys: [
            { text: file.basename, norm: normalize(file.basename), isAlias: false },
            ...aliases.map((a) => ({ text: a, norm: normalize(a), isAlias: true })),
            ...forms.map((f) => ({ text: f.text, norm: normalize(f.text), isForm: true, label: f.label })),
          ],
        };
      });
    // Từ điển: chỉ thêm những từ chưa có ghi chú (ghi chú của bạn luôn thắng)
    if (this.settings.dictEnabled) {
      const have = new Set(this.index.map((e) => normalize(e.term)));
      this.index = this.index.concat(dictEntries().filter((d) => !have.has(d.keys[0].norm)));
    }
    return this.index;
  }

  async createFromDict(entry) {
    const cfg =
      this.activeFolders().find((f) => f.path === this.settings.dictFolder) || {
        path: this.settings.dictFolder,
        tag: (this.activeFolders()[0] || DEFAULT_FOLDER).tag,
      };
    return this.createWordNote({ term: entry.term, ipa: entry.ipa, loai: entry.loai, nghia: entry.nghia, vidu: "" }, cfg);
  }

  async createWordNote({ term, ipa, loai, nghia, vidu, phan_tich }, cfg = this.activeFolders()[0]) {
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
      ...((phan_tich || "").trim() ? [`phan_tich: ${q(phan_tich)}`] : []),
      `tags: [tu-vung${withCard ? ", " + cfg.tag : ""}]`,
      "---",
      "",
      "## Ví dụ",
      examples || "- ",
      "",
      ...(withCard
        ? [
            CARD_HEADING,
            "",
            ...[
              ...cardLines({ term, ipa, loai, nghia }),
              this.settings.morphCards ? this.morphCard(term, parseParts(phan_tich)) : null,
            ]
              .filter(Boolean)
              .flatMap((l) => [l, ""]),
          ]
        : []),
      "## Ghi chú",
      "",
    ].join("\n");
    const file = await this.app.vault.create(path, content);
    this.index = null;
    new Notice(`Đã thêm "${term}"`);
    return file;
  }

  // Thêm thẻ ôn cho các ghi chú từ vựng chưa có (ví dụ ghi chú tự viết tay)
  // files: chỉ xét các file này; over: giá trị frontmatter vừa ghi (metadataCache chưa kịp cập nhật)
  async addMissingCards(files = this.app.vault.getMarkdownFiles(), over = {}) {
    let added = 0;
    for (const file of files) {
      const cfg = this.folderFor(file.path);
      if (!cfg || !cfg.tag) continue;
      const fm = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter || {}), ...over };
      if (!str(fm.nghia).trim()) continue;
      const text = await this.app.vault.read(file);
      // Chỉ thêm những dòng thẻ chưa có (so theo phần câu hỏi), giữ nguyên lịch ôn của thẻ cũ
      const data = { term: file.basename, ipa: str(fm.ipa), loai: str(fm.loai), nghia: str(fm.nghia) };
      const extra = [
        fm.khong_chia === true ? null : irregularCard(data.term, data.loai),
        this.settings.morphCards && fm.phan_tich ? this.morphCard(data.term, parseParts(fm.phan_tich)) : null,
      ];
      const wanted = text.includes(CARD_HEADING) ? extra : [cardLine(data), ...extra]; // đã có thẻ chính thì thôi
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
    if (!over.quiet) new Notice(`Đã thêm thẻ ôn cho ${added} từ`);
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
  dictCache = null; // biến thể của từ điển phụ thuộc bảng này
  userTriples = new Map();
  userNouns = new Map();
  const bad = [];
  (text || "").split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim(); // "# ..." là chú thích, kể cả cuối dòng
    if (!line) return;
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

  if (type.includes("động từ") && !type.includes("khuyết thiếu")) {
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
  const type = (loai || "").toLowerCase();
  if (!type.includes("động từ") || type.includes("khuyết thiếu")) return null;
  const [head, ...rest] = term.trim().split(/\s+/);
  const irr = verbForms(head);
  if (!irr) return null;
  const tail = rest.length ? " " + rest.join(" ") : "";
  const v2 = irr.v2.map((f) => f + tail).join("/");
  const v3 = irr.v3.map((f) => f + tail).join("/");
  return `**${term}** (V2 – V3)::${v2} – ${v3}`;
}

// ---------- Gốc từ, tiền tố, hậu tố ----------

// Mỗi dòng: loại|các dạng (dạng đầu là tên chính)|nghĩa. p = tiền tố, s = hậu tố, r = gốc từ
const MORPH_DATA = `
p|a|không, thiếu; hướng tới
p|ab/abs|rời xa
p|ad/ac/af/ag/al/ap/ar/as/at|hướng tới, thêm vào
p|anti|chống lại
p|auto|tự
p|bi|hai
p|con/com/co/col/cor|cùng nhau
p|contra/counter|ngược lại
p|de|xuống; tách ra, bỏ đi
p|dis/di/dif|không; tách rời
p|ex/e/ef|ra ngoài
p|en/em|làm cho; vào trong
p|extra|ngoài, vượt
p|fore|trước
p|in/im/il/ir|vào trong; không
p|inter|giữa
p|intro/intra|vào trong
p|micro|nhỏ
p|mis|sai
p|mono|một
p|multi|nhiều
p|non|không
p|ob/oc/of/op|chống; về phía
p|out|vượt hơn; ra ngoài
p|over|quá; ở trên
p|per|xuyên qua; trọn vẹn
p|post|sau
p|pre|trước
p|pro|về phía trước; ủng hộ
p|re|lại; trở lại
p|se|tách riêng
p|semi|một nửa
p|sub/suc/suf/sup/sus|dưới
p|super/sur|trên, vượt
p|sym/syn|cùng nhau
p|tele|xa
p|trans|xuyên qua, chuyển
p|tri|ba
p|un|không; ngược lại
p|under|dưới, chưa đủ
p|uni|một
s|able/ible|có thể (tính từ)
s|acy/cy|danh từ: trạng thái, hành vi
s|al/ial/ual|thuộc về (tính từ, danh từ)
s|ance/ence/ancy/ency|danh từ: tình trạng
s|ant/ent|người/vật làm; có tính
s|ary/ery/ory|nơi chốn; liên quan đến
s|ate|làm cho (động từ)
s|ation/ition/tion/sion/ion|danh từ: hành động, quá trình
s|ator/er/or|người/vật làm
s|atory|liên quan đến (tính từ)
s|dom|lĩnh vực, trạng thái
s|en|làm cho (động từ)
s|ful|đầy
s|genic|tạo ra, gây ra
s|hood|thời kỳ, trạng thái
s|ic/ical|thuộc về (tính từ)
s|ify/fy|làm cho (động từ)
s|ism|chủ nghĩa, hệ thống
s|ist|người theo, người làm
s|ity/ty|tính chất (danh từ)
s|ive|có tính (tính từ)
s|ize/ise|làm cho (động từ)
s|less|không có
s|logy|môn học
s|ly|một cách (trạng từ)
s|ment|kết quả, hành động (danh từ)
s|ness|tính chất (danh từ)
s|ous/ious/eous|có, đầy (tính từ)
s|ship|trạng thái, quan hệ
s|ure|hành động, kết quả (danh từ)
s|ward|hướng về
s|y|danh từ; tính từ
r|act/ag|làm, hành động
r|anim|sự sống, tâm hồn
r|aud|nghe
r|bio|sự sống
r|capt/cap/cept/ceiv/cip|lấy, nắm
r|cess/ceed/ced|đi, nhường
r|chron|thời gian
r|cis/cid|cắt; giết
r|claim/clam|kêu, la
r|clud/clus|đóng
r|cogn|biết
r|cord|tim, lòng
r|corp|cơ thể
r|cred|tin
r|curs/curr/cur|chạy
r|dict/dic|nói
r|doc|dạy
r|duct/duc|dẫn
r|equ|bằng nhau
r|fect/fact/fac/fic|làm
r|fer|mang
r|fid|tin tưởng
r|fin|kết thúc, giới hạn
r|flect/flex|uốn cong
r|flu/flux|chảy
r|form|hình dạng
r|fract/frag|vỡ
r|gen|sinh ra, loài
r|geo|đất
r|gress/grad|bước
r|graph/gram|viết, vẽ
r|hydr|nước
r|ject|ném
r|jud|phán xét
r|junct|nối
r|lect/leg|chọn; đọc
r|loc|nơi chốn
r|log|lời nói; lý lẽ
r|lum/luc|ánh sáng
r|manu/man|tay
r|mand|ra lệnh
r|mem|nhớ
r|ment|tâm trí
r|meter/metr|đo
r|min|nhỏ
r|miss/mit|gửi
r|mov/mot/mob|di chuyển
r|mort|chết
r|nat|sinh ra
r|nov|mới
r|path/pathet|cảm xúc, đau khổ; bệnh
r|ped/pod|chân
r|puls/pel|đẩy
r|pend/pens|treo; cân
r|phon|âm thanh
r|photo|ánh sáng
r|plic/ply|gấp
r|pos/pon/pound|đặt
r|port|mang
r|press|ép
r|prim|đầu tiên
r|prov/prob|thử, chứng minh
r|quest/quir/quis|hỏi, tìm
r|rupt|vỡ, đứt
r|scop|nhìn
r|script/scrib|viết
r|sect/sec|cắt
r|sens/sent|cảm thấy
r|sequ/secu|theo sau
r|sign|dấu hiệu
r|stat/sist/stit/sta|đứng
r|solv/solu|nới lỏng, giải
r|spect/spec/spic|nhìn
r|spir/spirit/pir|thở, thổi hơi; tinh thần
r|struct|xây dựng
r|tact/tang|chạm
r|tain/ten/tin|giữ
r|temp|thời gian
r|tend/tens/tent|kéo căng; hướng tới
r|terr|đất
r|therm|nhiệt
r|tract|kéo
r|trib|cho, ban
r|vac/van|trống rỗng
r|val/vail|mạnh; giá trị
r|vent/ven|đến
r|vers/vert|quay
r|vis/vid|nhìn
r|viv/vit|sống
r|voc/vok|gọi, giọng nói`;

const MORPH_KIND = { p: "prefix", s: "suffix", r: "root" };
const MORPH_LABEL = { prefix: "tiền tố", suffix: "hậu tố", root: "gốc từ", word: "từ", link: "" };

// form -> { kind, key, meaning }; key = dạng chính (con, ation, spir)
const MORPH = { prefix: new Map(), suffix: new Map(), root: new Map() };
const MORPH_FORMS = { prefix: [], suffix: [], root: [] };
for (const line of MORPH_DATA.split("\n")) {
  const [k, forms, meaning] = line.split("|");
  if (!meaning) continue;
  const kind = MORPH_KIND[k];
  const list = forms.split("/");
  for (const form of list) {
    if (!MORPH[kind].has(form)) MORPH[kind].set(form, { kind, key: list[0], meaning });
    MORPH_FORMS[kind].push(form);
  }
}
for (const kind in MORPH_FORMS) MORPH_FORMS[kind].sort((a, b) => b.length - a.length);

// Tên ghi chú của một mảnh: "con-", "-ation", "spir"
function morphNoteName(kind, key) {
  return kind === "prefix" ? `${key}-` : kind === "suffix" ? `-${key}` : key;
}

function prefixChain(s, depth = 0) {
  if (s === "") return [];
  if (depth > 1) return null;
  for (const form of MORPH_FORMS.prefix) {
    if (!s.startsWith(form)) continue;
    const rest = prefixChain(s.slice(form.length), depth + 1);
    if (rest) return [{ kind: "prefix", text: form, key: MORPH.prefix.get(form).key }, ...rest];
  }
  return null;
}

// Phần sau gốc từ: chuỗi hậu tố, cho phép một nguyên âm nối ("inspir-e", "spir-a-…")
function suffixChain(s, depth = 0) {
  if (s === "") return { parts: [], leftover: 0 };
  if (depth > 3) return null;
  let best = null;
  for (const form of MORPH_FORMS.suffix) {
    if (!s.startsWith(form)) continue;
    const r = suffixChain(s.slice(form.length), depth + 1);
    if (!r) continue;
    const c = { parts: [{ kind: "suffix", text: form, key: MORPH.suffix.get(form).key }, ...r.parts], leftover: r.leftover };
    if (!best || c.leftover < best.leftover || (c.leftover === best.leftover && c.parts.length < best.parts.length)) best = c;
  }
  if (!best && depth === 0 && /^[aeiou]/.test(s)) {
    if (s.length === 1) return { parts: [{ kind: "link", text: s }], leftover: 1 };
    const r = suffixChain(s.slice(1), depth + 1);
    if (r) best = { parts: [{ kind: "link", text: s[0] }, ...r.parts], leftover: r.leftover + 1 };
  }
  return best;
}

const analyzeCache = new Map();
// Trông giống nhưng không phải (empire ≠ em + pir + e; path = đường đi ≠ gốc path = cảm xúc)
const NO_SPLIT = new Set(["empire", "vampire", "umpire", "satire", "inch", "pension", "path"]);

// Đề xuất cách tách: tiền tố + gốc + hậu tố. Chỉ trả kết quả khi thấy gốc từ trong bảng,
// hoặc tiền tố + từ có thật (un + happy), hoặc từ có thật + hậu tố (spirit + ual).
function analyze(term) {
  const w = (term || "").toLowerCase();
  if (analyzeCache.has(w)) return analyzeCache.get(w);
  let result = null;
  if (/^[a-z]{4,}$/.test(w) && !NO_SPLIT.has(w)) {
    let best = null;
    for (const form of MORPH_FORMS.root) {
      for (let i = w.indexOf(form); i >= 0; i = w.indexOf(form, i + 1)) {
        const pre = prefixChain(w.slice(0, i));
        const suf = pre && suffixChain(w.slice(i + form.length));
        if (!suf) continue;
        const parts = [...pre, { kind: "root", text: form, key: MORPH.root.get(form).key }, ...suf.parts];
        // Cả từ chính là gốc (spirit, port): vẫn tính vào họ từ, nhưng không hiện dòng tách 1 mảnh
        const score = form.length * 10 - suf.leftover * 3 - parts.length;
        if (!best || score > best.score) best = { score, parts };
      }
    }
    if (best) result = best.parts;
    if (!result) {
      const isWord = (x) => x.length >= 3 && dictLookup(x);
      for (let i = 2; i < w.length - 2 && !result; i++) {
        const pre = prefixChain(w.slice(0, i));
        if (pre && isWord(w.slice(i))) result = [...pre, { kind: "word", text: w.slice(i) }];
      }
      for (let i = w.length - 2; i >= 3 && !result; i--) {
        const suf = suffixChain(w.slice(i));
        if (suf && !suf.leftover && suf.parts.length && isWord(w.slice(0, i))) {
          result = [{ kind: "word", text: w.slice(0, i) }, ...suf.parts];
        }
      }
    }
  }
  analyzeCache.set(w, result);
  return result;
}

// Chuỗi trong ghi chú: "in- + spir + e", "con- + spir + -acy", "un- + happy"
function formatParts(parts) {
  return parts
    .map((p) => (p.kind === "prefix" ? `${p.text}-` : p.kind === "suffix" ? `-${p.text}` : p.text))
    .join(" + ");
}

function parseParts(text) {
  if (!text) return null;
  const parts = String(text)
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      if (t.endsWith("-") && t.length > 1) {
        const text = t.slice(0, -1);
        return { kind: "prefix", text, key: MORPH.prefix.get(text.toLowerCase())?.key || text };
      }
      if (t.startsWith("-") && t.length > 1) {
        const text = t.slice(1);
        return { kind: "suffix", text, key: MORPH.suffix.get(text.toLowerCase())?.key || text };
      }
      const root = MORPH.root.get(t.toLowerCase());
      if (root) return { kind: "root", text: t, key: root.key };
      if (t.length <= 2) return { kind: "link", text: t };
      if (dictLookup(t)) return { kind: "word", text: t };
      return { kind: "root", text: t, key: t };
    });
  return parts.length ? parts : null;
}

// Hai mảnh cùng loại, cùng tên chính -> cùng họ
function samePart(a, b) {
  return a.kind === b.kind && a.kind !== "link" && (a.key || a.text).toLowerCase() === (b.key || b.text).toLowerCase();
}

// ---------- Từ điển có sẵn ----------

let dictCache = null;

// Mỗi dòng: từ|phiên âm (không có /)|từ loại|nghĩa
function dictEntries() {
  if (dictCache) return dictCache;
  dictCache = [];
  for (const line of DICT_DATA.split("\n")) {
    const [term, ipa, loai, nghia] = line.split("|").map((s) => (s || "").trim());
    if (!term || !nghia) continue;
    const forms = inflect(term, loai, []);
    dictCache.push({
      path: "dict:" + term,
      dict: true,
      folder: "",
      term,
      ipa: ipa ? `/${ipa}/` : "",
      loai,
      nghia,
      keys: [
        { text: term, norm: normalize(term), isAlias: false },
        ...forms.map((f) => ({ text: f.text, norm: normalize(f.text), isForm: true, label: f.label })),
      ],
    });
  }
  return dictCache;
}

function dictLookup(term) {
  const n = normalize(term || "");
  return n ? dictEntries().find((e) => e.keys[0].norm === n) : undefined;
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

// @@DICT_START: sinh tự động từ dict/*.txt bằng build.ps1, đừng sửa tay
const DICT_DATA = `a|ə|từ hạn định|một
abandon|əˈbændən|động từ|bỏ rơi, từ bỏ
ability|əˈbɪləti|danh từ|khả năng, năng lực
able|ˈeɪbəl|tính từ|có thể, có năng lực
about|əˈbaʊt|giới từ, trạng từ|về, khoảng
above|əˈbʌv|giới từ, trạng từ|ở trên, trên
abroad|əˈbrɔːd|trạng từ|ở nước ngoài
absence|ˈæbsəns|danh từ|sự vắng mặt
absent|ˈæbsənt|tính từ|vắng mặt
absolute|ˈæbsəluːt|tính từ|tuyệt đối
absolutely|ˈæbsəluːtli|trạng từ|hoàn toàn, tuyệt đối
absorb|əbˈzɔːrb|động từ|hấp thụ, thu hút
abstract|ˈæbstrækt|tính từ|trừu tượng
academic|ˌækəˈdemɪk|tính từ|thuộc học thuật
accept|əkˈsept|động từ|chấp nhận
acceptable|əkˈseptəbəl|tính từ|chấp nhận được
access|ˈækses|danh từ, động từ|sự truy cập; truy cập
accident|ˈæksɪdənt|danh từ|tai nạn; sự tình cờ
accommodation|əˌkɑːməˈdeɪʃən|danh từ|chỗ ở
accompany|əˈkʌmpəni|động từ|đi cùng, đệm nhạc
according to|əˈkɔːrdɪŋ tuː|giới từ|theo (như)
account|əˈkaʊnt|danh từ|tài khoản; sự giải thích
accurate|ˈækjərət|tính từ|chính xác
accuse|əˈkjuːz|động từ|buộc tội
achieve|əˈtʃiːv|động từ|đạt được
achievement|əˈtʃiːvmənt|danh từ|thành tựu
acid|ˈæsɪd|danh từ|axit
acknowledge|əkˈnɑːlɪdʒ|động từ|thừa nhận
acquire|əˈkwaɪər|động từ|thu được, đạt được
across|əˈkrɔːs|giới từ, trạng từ|ngang qua, bên kia
act|ækt|động từ, danh từ|hành động; đạo luật
action|ˈækʃən|danh từ|hành động
active|ˈæktɪv|tính từ|tích cực, năng động
activity|ækˈtɪvəti|danh từ|hoạt động
actor|ˈæktər|danh từ|nam diễn viên
actress|ˈæktrəs|danh từ|nữ diễn viên
actual|ˈæktʃuəl|tính từ|thực tế, thật sự
actually|ˈæktʃuəli|trạng từ|thật ra, thực sự
adapt|əˈdæpt|động từ|thích nghi, điều chỉnh
add|æd|động từ|thêm, cộng
addition|əˈdɪʃən|danh từ|sự thêm vào; phép cộng
additional|əˈdɪʃənəl|tính từ|thêm, bổ sung
address|ˈædres|danh từ, động từ|địa chỉ; giải quyết, phát biểu
adequate|ˈædɪkwət|tính từ|đủ, thích đáng
adjust|əˈdʒʌst|động từ|điều chỉnh
administration|ədˌmɪnɪˈstreɪʃən|danh từ|sự quản lý, chính quyền
admire|ədˈmaɪər|động từ|ngưỡng mộ
admit|ədˈmɪt|động từ|thừa nhận; cho vào
adopt|əˈdɑːpt|động từ|nhận nuôi; áp dụng
adult|əˈdʌlt|danh từ, tính từ|người lớn; trưởng thành
advance|ədˈvæns|danh từ, động từ|sự tiến bộ; tiến lên
advanced|ədˈvænst|tính từ|tiên tiến, nâng cao
advantage|ədˈvæntɪdʒ|danh từ|lợi thế
adventure|ədˈventʃər|danh từ|cuộc phiêu lưu
advertise|ˈædvərtaɪz|động từ|quảng cáo
advertisement|ˌædvərˈtaɪzmənt|danh từ|bài quảng cáo
advice|ədˈvaɪs|danh từ|lời khuyên
advise|ədˈvaɪz|động từ|khuyên
affair|əˈfer|danh từ|việc, sự vụ
affect|əˈfekt|động từ|ảnh hưởng
afford|əˈfɔːrd|động từ|có đủ khả năng (chi trả)
afraid|əˈfreɪd|tính từ|sợ, e rằng
after|ˈæftər|giới từ, liên từ|sau, sau khi
afternoon|ˌæftərˈnuːn|danh từ|buổi chiều
afterwards|ˈæftərwərdz|trạng từ|sau đó
again|əˈɡen|trạng từ|lại, lần nữa
against|əˈɡenst|giới từ|chống lại, dựa vào
age|eɪdʒ|danh từ|tuổi; thời đại
agency|ˈeɪdʒənsi|danh từ|đại lý, cơ quan
agenda|əˈdʒendə|danh từ|chương trình nghị sự
agent|ˈeɪdʒənt|danh từ|đại lý, nhân viên
aggressive|əˈɡresɪv|tính từ|hung hăng, xông xáo
ago|əˈɡoʊ|trạng từ|cách đây, trước đây
agree|əˈɡriː|động từ|đồng ý
agreement|əˈɡriːmənt|danh từ|sự đồng ý; hợp đồng
agriculture|ˈæɡrɪkʌltʃər|danh từ|nông nghiệp
ahead|əˈhed|trạng từ|phía trước
aid|eɪd|danh từ, động từ|sự giúp đỡ; giúp đỡ
aim|eɪm|danh từ, động từ|mục tiêu; nhắm tới
air|er|danh từ|không khí
aircraft|ˈerkræft|danh từ|máy bay
airline|ˈerlaɪn|danh từ|hãng hàng không
airport|ˈerpɔːrt|danh từ|sân bay
alarm|əˈlɑːrm|danh từ|báo động; đồng hồ báo thức
album|ˈælbəm|danh từ|album
alcohol|ˈælkəhɔːl|danh từ|rượu, cồn
alive|əˈlaɪv|tính từ|còn sống
all|ɔːl|từ hạn định, đại từ|tất cả
allow|əˈlaʊ|động từ|cho phép
almost|ˈɔːlmoʊst|trạng từ|gần như
alone|əˈloʊn|tính từ, trạng từ|một mình
along|əˈlɔːŋ|giới từ, trạng từ|dọc theo
already|ɔːlˈredi|trạng từ|đã, rồi
also|ˈɔːlsoʊ|trạng từ|cũng
alter|ˈɔːltər|động từ|thay đổi
alternative|ɔːlˈtɜːrnətɪv|danh từ, tính từ|sự lựa chọn khác; thay thế
although|ɔːlˈðoʊ|liên từ|mặc dù
altogether|ˌɔːltəˈɡeðər|trạng từ|hoàn toàn; tổng cộng
always|ˈɔːlweɪz|trạng từ|luôn luôn
amazing|əˈmeɪzɪŋ|tính từ|tuyệt vời, đáng kinh ngạc
ambition|æmˈbɪʃən|danh từ|hoài bão, tham vọng
ambulance|ˈæmbjələns|danh từ|xe cứu thương
among|əˈmʌŋ|giới từ|giữa, trong số
amount|əˈmaʊnt|danh từ|lượng, số lượng
analysis|əˈnæləsɪs|danh từ|sự phân tích
analyze|ˈænəlaɪz|động từ|phân tích
ancient|ˈeɪnʃənt|tính từ|cổ xưa
and|ænd|liên từ|và
anger|ˈæŋɡər|danh từ|sự tức giận
angle|ˈæŋɡəl|danh từ|góc; góc nhìn
angry|ˈæŋɡri|tính từ|tức giận
animal|ˈænɪməl|danh từ|động vật
anniversary|ˌænɪˈvɜːrsəri|danh từ|ngày kỷ niệm
announce|əˈnaʊns|động từ|thông báo
announcement|əˈnaʊnsmənt|danh từ|lời thông báo
annoy|əˈnɔɪ|động từ|làm phiền, làm bực mình
annual|ˈænjuəl|tính từ|hằng năm
another|əˈnʌðər|từ hạn định, đại từ|một cái khác
answer|ˈænsər|danh từ, động từ|câu trả lời; trả lời
anxiety|æŋˈzaɪəti|danh từ|sự lo âu
anxious|ˈæŋkʃəs|tính từ|lo lắng; nóng lòng
any|ˈeni|từ hạn định, đại từ|bất kỳ; nào
anybody|ˈenibɑːdi|đại từ|bất kỳ ai
anymore|ˌeniˈmɔːr|trạng từ|nữa (câu phủ định)
anyone|ˈeniwʌn|đại từ|bất kỳ ai
anything|ˈeniθɪŋ|đại từ|bất cứ thứ gì
anyway|ˈeniweɪ|trạng từ|dù sao đi nữa
anywhere|ˈeniwer|trạng từ|bất cứ đâu
apart|əˈpɑːrt|trạng từ|cách nhau, riêng ra
apartment|əˈpɑːrtmənt|danh từ|căn hộ
apologize|əˈpɑːlədʒaɪz|động từ|xin lỗi
apology|əˈpɑːlədʒi|danh từ|lời xin lỗi
app|æp|danh từ|ứng dụng
apparent|əˈpærənt|tính từ|rõ ràng; bề ngoài
apparently|əˈpærəntli|trạng từ|hình như, rõ ràng là
appeal|əˈpiːl|danh từ, động từ|lời kêu gọi; hấp dẫn; kháng cáo
appear|əˈpɪr|động từ|xuất hiện; có vẻ
appearance|əˈpɪrəns|danh từ|sự xuất hiện; vẻ ngoài
apple|ˈæpəl|danh từ|quả táo
application|ˌæplɪˈkeɪʃən|danh từ|đơn xin; ứng dụng
apply|əˈplaɪ|động từ|nộp đơn; áp dụng
appoint|əˈpɔɪnt|động từ|bổ nhiệm
appointment|əˈpɔɪntmənt|danh từ|cuộc hẹn; sự bổ nhiệm
appreciate|əˈpriːʃieɪt|động từ|trân trọng, cảm kích
approach|əˈproʊtʃ|danh từ, động từ|cách tiếp cận; tiến lại gần
appropriate|əˈproʊpriət|tính từ|thích hợp
approval|əˈpruːvəl|danh từ|sự chấp thuận
approve|əˈpruːv|động từ|chấp thuận, tán thành
approximately|əˈprɑːksɪmətli|trạng từ|xấp xỉ, khoảng
architect|ˈɑːrkɪtekt|danh từ|kiến trúc sư
architecture|ˈɑːrkɪtektʃər|danh từ|kiến trúc
area|ˈeriə|danh từ|khu vực; diện tích
argue|ˈɑːrɡjuː|động từ|tranh cãi, lập luận
argument|ˈɑːrɡjəmənt|danh từ|cuộc tranh cãi; lý lẽ
arise|əˈraɪz|động từ|nảy sinh
arm|ɑːrm|danh từ|cánh tay
army|ˈɑːrmi|danh từ|quân đội
around|əˈraʊnd|giới từ, trạng từ|xung quanh; khoảng
arrange|əˈreɪndʒ|động từ|sắp xếp
arrangement|əˈreɪndʒmənt|danh từ|sự sắp xếp
arrest|əˈrest|động từ, danh từ|bắt giữ; sự bắt giữ
arrival|əˈraɪvəl|danh từ|sự đến
arrive|əˈraɪv|động từ|đến nơi
art|ɑːrt|danh từ|nghệ thuật
article|ˈɑːrtɪkəl|danh từ|bài báo; mạo từ
artificial|ˌɑːrtɪˈfɪʃəl|tính từ|nhân tạo
artist|ˈɑːrtɪst|danh từ|nghệ sĩ, họa sĩ
as|æz|liên từ, giới từ|như, vì, khi
ashamed|əˈʃeɪmd|tính từ|xấu hổ
aside|əˈsaɪd|trạng từ|sang một bên
ask|æsk|động từ|hỏi; yêu cầu
asleep|əˈsliːp|tính từ|đang ngủ
aspect|ˈæspekt|danh từ|khía cạnh
assess|əˈses|động từ|đánh giá
assessment|əˈsesmənt|danh từ|sự đánh giá
asset|ˈæset|danh từ|tài sản
assignment|əˈsaɪnmənt|danh từ|bài tập; nhiệm vụ
assist|əˈsɪst|động từ|hỗ trợ
assistant|əˈsɪstənt|danh từ|trợ lý
associate|əˈsoʊʃieɪt|động từ|liên kết, liên tưởng
association|əˌsoʊsiˈeɪʃən|danh từ|hiệp hội; sự liên kết
assume|əˈsuːm|động từ|cho rằng; đảm nhận
assumption|əˈsʌmpʃən|danh từ|giả định
assure|əˈʃʊr|động từ|đảm bảo, cam đoan
at|æt|giới từ|ở, tại, lúc
atmosphere|ˈætməsfɪr|danh từ|bầu khí quyển; bầu không khí
attach|əˈtætʃ|động từ|gắn, đính kèm
attack|əˈtæk|danh từ, động từ|cuộc tấn công; tấn công
attempt|əˈtempt|danh từ, động từ|nỗ lực; cố gắng
attend|əˈtend|động từ|tham dự
attention|əˈtenʃən|danh từ|sự chú ý
attitude|ˈætɪtuːd|danh từ|thái độ
attract|əˈtrækt|động từ|thu hút
attraction|əˈtrækʃən|danh từ|sự hấp dẫn; điểm tham quan
attractive|əˈtræktɪv|tính từ|hấp dẫn
audience|ˈɔːdiəns|danh từ|khán giả
author|ˈɔːθər|danh từ|tác giả
authority|əˈθɔːrəti|danh từ|quyền lực; nhà chức trách
automatic|ˌɔːtəˈmætɪk|tính từ|tự động
autumn|ˈɔːtəm|danh từ|mùa thu
available|əˈveɪləbəl|tính từ|có sẵn; rảnh
average|ˈævərɪdʒ|tính từ, danh từ|trung bình; mức trung bình
avoid|əˈvɔɪd|động từ|tránh
awake|əˈweɪk|tính từ|thức, tỉnh
award|əˈwɔːrd|danh từ, động từ|giải thưởng; trao giải
aware|əˈwer|tính từ|nhận thức được, biết
away|əˈweɪ|trạng từ|xa, đi khỏi
awful|ˈɔːfəl|tính từ|kinh khủng, tồi tệ
awkward|ˈɔːkwərd|tính từ|vụng về; khó xử
baby|ˈbeɪbi|danh từ|em bé
back|bæk|danh từ, trạng từ|lưng; phía sau; trở lại
background|ˈbækɡraʊnd|danh từ|nền; lý lịch
backward|ˈbækwərd|trạng từ, tính từ|về phía sau; lạc hậu
bacteria|bækˈtɪriə|danh từ|vi khuẩn
bad|bæd|tính từ|xấu, tồi
badly|ˈbædli|trạng từ|tồi, nặng nề
bag|bæɡ|danh từ|túi, cặp
bake|beɪk|động từ|nướng (bánh)
balance|ˈbæləns|danh từ, động từ|sự cân bằng; số dư; cân bằng
ball|bɔːl|danh từ|quả bóng
ban|bæn|động từ, danh từ|cấm; lệnh cấm
banana|bəˈnænə|danh từ|quả chuối
band|bænd|danh từ|ban nhạc; dải
bank|bæŋk|danh từ|ngân hàng; bờ sông
bar|bɑːr|danh từ|quán bar; thanh
barrier|ˈbæriər|danh từ|rào cản
base|beɪs|danh từ, động từ|nền tảng, căn cứ; dựa trên
baseball|ˈbeɪsbɔːl|danh từ|bóng chày
basic|ˈbeɪsɪk|tính từ|cơ bản
basically|ˈbeɪsɪkli|trạng từ|về cơ bản
basis|ˈbeɪsɪs|danh từ|cơ sở, nền tảng
basket|ˈbæskɪt|danh từ|cái giỏ
basketball|ˈbæskɪtbɔːl|danh từ|bóng rổ
bath|bæθ|danh từ|sự tắm; bồn tắm
bathroom|ˈbæθruːm|danh từ|phòng tắm
battery|ˈbætəri|danh từ|pin
battle|ˈbætəl|danh từ|trận chiến
be|biː|động từ|thì, là, ở
beach|biːtʃ|danh từ|bãi biển
bean|biːn|danh từ|hạt đậu
bear|ber|danh từ, động từ|con gấu; chịu đựng
beat|biːt|động từ, danh từ|đánh; đánh bại; nhịp
beautiful|ˈbjuːtɪfəl|tính từ|đẹp
beauty|ˈbjuːti|danh từ|vẻ đẹp
because|bɪˈkɔːz|liên từ|bởi vì
become|bɪˈkʌm|động từ|trở thành
bed|bed|danh từ|giường
bedroom|ˈbedruːm|danh từ|phòng ngủ
beef|biːf|danh từ|thịt bò
beer|bɪr|danh từ|bia
before|bɪˈfɔːr|giới từ, liên từ|trước, trước khi
beg|beɡ|động từ|cầu xin, ăn xin
begin|bɪˈɡɪn|động từ|bắt đầu
beginning|bɪˈɡɪnɪŋ|danh từ|sự bắt đầu, phần đầu
behave|bɪˈheɪv|động từ|cư xử
behavior|bɪˈheɪvjər|danh từ|hành vi, cách cư xử
behind|bɪˈhaɪnd|giới từ, trạng từ|phía sau
belief|bɪˈliːf|danh từ|niềm tin
believe|bɪˈliːv|động từ|tin
bell|bel|danh từ|cái chuông
belong|bɪˈlɔːŋ|động từ|thuộc về
below|bɪˈloʊ|giới từ, trạng từ|bên dưới
belt|belt|danh từ|thắt lưng; vành đai
bench|bentʃ|danh từ|ghế dài
bend|bend|động từ|uốn cong, cúi xuống
beneath|bɪˈniːθ|giới từ|bên dưới
benefit|ˈbenɪfɪt|danh từ, động từ|lợi ích; có lợi
beside|bɪˈsaɪd|giới từ|bên cạnh
besides|bɪˈsaɪdz|giới từ, trạng từ|ngoài ra
best|best|tính từ, trạng từ|tốt nhất
bet|bet|động từ, danh từ|cá cược
better|ˈbetər|tính từ, trạng từ|tốt hơn
between|bɪˈtwiːn|giới từ|giữa (hai)
beyond|bɪˈjɑːnd|giới từ|vượt quá, bên kia
bicycle|ˈbaɪsɪkəl|danh từ|xe đạp
big|bɪɡ|tính từ|to, lớn
bike|baɪk|danh từ|xe đạp
bill|bɪl|danh từ|hóa đơn; dự luật
billion|ˈbɪljən|số từ|một tỷ
bind|baɪnd|động từ|buộc, ràng buộc
biology|baɪˈɑːlədʒi|danh từ|sinh học
bird|bɜːrd|danh từ|con chim
birth|bɜːrθ|danh từ|sự ra đời
birthday|ˈbɜːrθdeɪ|danh từ|sinh nhật
biscuit|ˈbɪskɪt|danh từ|bánh quy
bit|bɪt|danh từ|một chút, mẩu
bite|baɪt|động từ, danh từ|cắn; vết cắn
bitter|ˈbɪtər|tính từ|đắng; cay đắng
black|blæk|tính từ|màu đen
blame|bleɪm|động từ, danh từ|đổ lỗi; lỗi
blank|blæŋk|tính từ|trống, để trống
blanket|ˈblæŋkɪt|danh từ|cái chăn
blind|blaɪnd|tính từ|mù
block|blɑːk|danh từ, động từ|khối; dãy nhà; chặn
blog|blɑːɡ|danh từ|blog
blood|blʌd|danh từ|máu
blow|bloʊ|động từ, danh từ|thổi; cú đánh
blue|bluː|tính từ|màu xanh dương
board|bɔːrd|danh từ|tấm bảng; hội đồng
boat|boʊt|danh từ|con thuyền
body|ˈbɑːdi|danh từ|cơ thể
boil|bɔɪl|động từ|đun sôi, luộc
bomb|bɑːm|danh từ|quả bom
bond|bɑːnd|danh từ|mối liên kết; trái phiếu
bone|boʊn|danh từ|xương
bonus|ˈboʊnəs|danh từ|tiền thưởng
book|bʊk|danh từ, động từ|quyển sách; đặt chỗ
boost|buːst|động từ, danh từ|thúc đẩy, tăng cường
boot|buːt|danh từ|giày ống; khởi động (máy)
border|ˈbɔːrdər|danh từ|biên giới; đường viền
bored|bɔːrd|tính từ|chán
boring|ˈbɔːrɪŋ|tính từ|nhàm chán
born|bɔːrn|tính từ|được sinh ra
borrow|ˈbɑːroʊ|động từ|mượn
boss|bɔːs|danh từ|ông chủ, sếp
both|boʊθ|từ hạn định, đại từ|cả hai
bother|ˈbɑːðər|động từ|làm phiền; bận tâm
bottle|ˈbɑːtəl|danh từ|cái chai
bottom|ˈbɑːtəm|danh từ|đáy, phần dưới cùng
bound|baʊnd|tính từ|chắc chắn sẽ; bị ràng buộc
bowl|boʊl|danh từ|cái bát
box|bɑːks|danh từ|cái hộp
boy|bɔɪ|danh từ|con trai, cậu bé
boyfriend|ˈbɔɪfrend|danh từ|bạn trai
brain|breɪn|danh từ|não
branch|bræntʃ|danh từ|cành cây; chi nhánh
brand|brænd|danh từ|thương hiệu
brave|breɪv|tính từ|dũng cảm
bread|bred|danh từ|bánh mì
break|breɪk|động từ, danh từ|làm vỡ; giờ nghỉ
breakfast|ˈbrekfəst|danh từ|bữa sáng
breast|brest|danh từ|ngực
breath|breθ|danh từ|hơi thở
breathe|briːð|động từ|thở
breed|briːd|động từ, danh từ|sinh sản, nuôi; giống
brick|brɪk|danh từ|viên gạch
bridge|brɪdʒ|danh từ|cây cầu
brief|briːf|tính từ|ngắn gọn
briefly|ˈbriːfli|trạng từ|một cách ngắn gọn
bright|braɪt|tính từ|sáng; thông minh
brilliant|ˈbrɪljənt|tính từ|xuất sắc; rực rỡ
bring|brɪŋ|động từ|mang đến
broad|brɔːd|tính từ|rộng
broadcast|ˈbrɔːdkæst|động từ, danh từ|phát sóng; chương trình phát sóng
broken|ˈbroʊkən|tính từ|bị vỡ, hỏng
brother|ˈbrʌðər|danh từ|anh/em trai
brown|braʊn|tính từ|màu nâu
brush|brʌʃ|danh từ, động từ|bàn chải; chải
bubble|ˈbʌbəl|danh từ|bong bóng
budget|ˈbʌdʒɪt|danh từ|ngân sách
bug|bʌɡ|danh từ|con bọ; lỗi phần mềm
build|bɪld|động từ|xây dựng
building|ˈbɪldɪŋ|danh từ|tòa nhà
bullet|ˈbʊlɪt|danh từ|viên đạn
bunch|bʌntʃ|danh từ|chùm, bó, nhóm
burden|ˈbɜːrdən|danh từ|gánh nặng
burn|bɜːrn|động từ|đốt cháy, bỏng
burst|bɜːrst|động từ|nổ tung, vỡ
bury|ˈberi|động từ|chôn
bus|bʌs|danh từ|xe buýt
business|ˈbɪznəs|danh từ|kinh doanh; doanh nghiệp
businessman|ˈbɪznəsmæn|danh từ|doanh nhân
busy|ˈbɪzi|tính từ|bận rộn
but|bʌt|liên từ|nhưng
butter|ˈbʌtər|danh từ|bơ
button|ˈbʌtən|danh từ|cái nút
buy|baɪ|động từ|mua
buyer|ˈbaɪər|danh từ|người mua
by|baɪ|giới từ|bởi; bên cạnh; trước (thời hạn)
bye|baɪ|thán từ|tạm biệt
cabin|ˈkæbɪn|danh từ|cabin, nhà gỗ nhỏ
cabinet|ˈkæbɪnət|danh từ|tủ; nội các
cable|ˈkeɪbəl|danh từ|dây cáp
cafe|kæˈfeɪ|danh từ|quán cà phê
cake|keɪk|danh từ|bánh ngọt
calculate|ˈkælkjəleɪt|động từ|tính toán
calculation|ˌkælkjəˈleɪʃən|danh từ|sự tính toán
call|kɔːl|động từ, danh từ|gọi; cuộc gọi
calm|kɑːm|tính từ, động từ|bình tĩnh; làm dịu
camera|ˈkæmərə|danh từ|máy ảnh
camp|kæmp|danh từ, động từ|trại; cắm trại
campaign|kæmˈpeɪn|danh từ|chiến dịch
campus|ˈkæmpəs|danh từ|khuôn viên trường
can|kæn|động từ khuyết thiếu|có thể
cancel|ˈkænsəl|động từ|hủy bỏ
cancer|ˈkænsər|danh từ|ung thư
candidate|ˈkændɪdət|danh từ|ứng viên
candle|ˈkændəl|danh từ|cây nến
candy|ˈkændi|danh từ|kẹo
cap|kæp|danh từ|mũ lưỡi trai; nắp
capable|ˈkeɪpəbəl|tính từ|có khả năng
capacity|kəˈpæsəti|danh từ|sức chứa; năng lực
capital|ˈkæpɪtəl|danh từ|thủ đô; vốn; chữ hoa
captain|ˈkæptɪn|danh từ|thuyền trưởng; đội trưởng
capture|ˈkæptʃər|động từ|bắt giữ; ghi lại
car|kɑːr|danh từ|xe ô tô
carbon|ˈkɑːrbən|danh từ|các-bon
card|kɑːrd|danh từ|thẻ; thiệp
care|ker|danh từ, động từ|sự chăm sóc; quan tâm
career|kəˈrɪr|danh từ|sự nghiệp
careful|ˈkerfəl|tính từ|cẩn thận
carefully|ˈkerfəli|trạng từ|một cách cẩn thận
careless|ˈkerləs|tính từ|bất cẩn
carpet|ˈkɑːrpɪt|danh từ|tấm thảm
carrot|ˈkærət|danh từ|cà rốt
carry|ˈkæri|động từ|mang, vác
cartoon|kɑːrˈtuːn|danh từ|phim hoạt hình; tranh biếm họa
case|keɪs|danh từ|trường hợp; vụ án; cái hộp
cash|kæʃ|danh từ|tiền mặt
cast|kæst|danh từ, động từ|dàn diễn viên; ném
castle|ˈkæsəl|danh từ|lâu đài
cat|kæt|danh từ|con mèo
catch|kætʃ|động từ|bắt, chụp; bắt kịp
category|ˈkætəɡɔːri|danh từ|hạng mục, loại
cause|kɔːz|danh từ, động từ|nguyên nhân; gây ra
ceiling|ˈsiːlɪŋ|danh từ|trần nhà
celebrate|ˈselɪbreɪt|động từ|ăn mừng, kỷ niệm
celebration|ˌselɪˈbreɪʃən|danh từ|lễ kỷ niệm
celebrity|səˈlebrəti|danh từ|người nổi tiếng
cell|sel|danh từ|tế bào; phòng giam
cent|sent|danh từ|xu (1/100 đô la)
center|ˈsentər|danh từ|trung tâm
central|ˈsentrəl|tính từ|trung tâm, chính
century|ˈsentʃəri|danh từ|thế kỷ
ceremony|ˈserəmoʊni|danh từ|nghi lễ
certain|ˈsɜːrtən|tính từ|chắc chắn; nhất định
certainly|ˈsɜːrtənli|trạng từ|chắc chắn
chain|tʃeɪn|danh từ|dây xích; chuỗi
chair|tʃer|danh từ|cái ghế
chairman|ˈtʃermən|danh từ|chủ tịch
challenge|ˈtʃælɪndʒ|danh từ, động từ|thử thách; thách thức
champion|ˈtʃæmpiən|danh từ|nhà vô địch
championship|ˈtʃæmpiənʃɪp|danh từ|giải vô địch
chance|tʃæns|danh từ|cơ hội; khả năng
change|tʃeɪndʒ|động từ, danh từ|thay đổi; tiền thừa
channel|ˈtʃænəl|danh từ|kênh
chapter|ˈtʃæptər|danh từ|chương (sách)
character|ˈkærəktər|danh từ|tính cách; nhân vật; ký tự
characteristic|ˌkærəktəˈrɪstɪk|danh từ, tính từ|đặc điểm; đặc trưng
charge|tʃɑːrdʒ|danh từ, động từ|phí; sạc; tính phí; buộc tội
charity|ˈtʃærəti|danh từ|từ thiện
chart|tʃɑːrt|danh từ|biểu đồ
chase|tʃeɪs|động từ|đuổi theo
chat|tʃæt|động từ, danh từ|trò chuyện
cheap|tʃiːp|tính từ|rẻ
cheat|tʃiːt|động từ|gian lận, lừa dối
check|tʃek|động từ, danh từ|kiểm tra; tấm séc
cheek|tʃiːk|danh từ|má
cheese|tʃiːz|danh từ|phô mai
chef|ʃef|danh từ|đầu bếp
chemical|ˈkemɪkəl|danh từ, tính từ|hóa chất; thuộc hóa học
chemistry|ˈkemɪstri|danh từ|hóa học
chest|tʃest|danh từ|ngực; cái rương
chicken|ˈtʃɪkɪn|danh từ|con gà; thịt gà
chief|tʃiːf|danh từ, tính từ|người đứng đầu; chính
child|tʃaɪld|danh từ|đứa trẻ
childhood|ˈtʃaɪldhʊd|danh từ|thời thơ ấu
chip|tʃɪp|danh từ|vi mạch; khoai tây chiên; mảnh vụn
chocolate|ˈtʃɑːklət|danh từ|sô-cô-la
choice|tʃɔɪs|danh từ|sự lựa chọn
choose|tʃuːz|động từ|chọn
church|tʃɜːrtʃ|danh từ|nhà thờ
cigarette|ˈsɪɡəret|danh từ|điếu thuốc lá
cinema|ˈsɪnəmə|danh từ|rạp chiếu phim
circle|ˈsɜːrkəl|danh từ|hình tròn; vòng
circumstance|ˈsɜːrkəmstæns|danh từ|hoàn cảnh
citizen|ˈsɪtɪzən|danh từ|công dân
city|ˈsɪti|danh từ|thành phố
civil|ˈsɪvəl|tính từ|dân sự
claim|kleɪm|động từ, danh từ|tuyên bố; đòi; yêu cầu bồi thường
class|klæs|danh từ|lớp học; giai cấp
classic|ˈklæsɪk|tính từ, danh từ|kinh điển; tác phẩm kinh điển
classical|ˈklæsɪkəl|tính từ|cổ điển
classroom|ˈklæsruːm|danh từ|phòng học
clean|kliːn|tính từ, động từ|sạch; lau dọn
clear|klɪr|tính từ, động từ|rõ ràng; dọn sạch
clearly|ˈklɪrli|trạng từ|rõ ràng
clever|ˈklevər|tính từ|thông minh, khéo
click|klɪk|động từ, danh từ|nhấp chuột; tiếng tách
client|ˈklaɪənt|danh từ|khách hàng
climate|ˈklaɪmət|danh từ|khí hậu
climb|klaɪm|động từ|leo, trèo
clinic|ˈklɪnɪk|danh từ|phòng khám
clock|klɑːk|danh từ|đồng hồ
close|kloʊz, kloʊs|động từ, tính từ|đóng; gần, thân thiết
closed|kloʊzd|tính từ|đóng cửa
closely|ˈkloʊsli|trạng từ|chặt chẽ, sát sao
clothes|kloʊðz|danh từ|quần áo
cloud|klaʊd|danh từ|đám mây
club|klʌb|danh từ|câu lạc bộ
clue|kluː|danh từ|manh mối
coach|koʊtʃ|danh từ, động từ|huấn luyện viên; xe khách; huấn luyện
coal|koʊl|danh từ|than đá
coast|koʊst|danh từ|bờ biển
coat|koʊt|danh từ|áo khoác
code|koʊd|danh từ|mã; bộ luật
coffee|ˈkɔːfi|danh từ|cà phê
coin|kɔɪn|danh từ|đồng xu
cold|koʊld|tính từ, danh từ|lạnh; cảm lạnh
collapse|kəˈlæps|động từ, danh từ|sụp đổ
colleague|ˈkɑːliːɡ|danh từ|đồng nghiệp
collect|kəˈlekt|động từ|thu thập, sưu tầm
collection|kəˈlekʃən|danh từ|bộ sưu tập
college|ˈkɑːlɪdʒ|danh từ|trường cao đẳng, đại học
color|ˈkʌlər|danh từ|màu sắc
column|ˈkɑːləm|danh từ|cột; chuyên mục
combination|ˌkɑːmbɪˈneɪʃən|danh từ|sự kết hợp
combine|kəmˈbaɪn|động từ|kết hợp
come|kʌm|động từ|đến
comedy|ˈkɑːmədi|danh từ|hài kịch
comfort|ˈkʌmfərt|danh từ, động từ|sự thoải mái; an ủi
comfortable|ˈkʌmftəbəl|tính từ|thoải mái
command|kəˈmænd|danh từ, động từ|mệnh lệnh; lệnh; ra lệnh
comment|ˈkɑːment|danh từ, động từ|bình luận
commercial|kəˈmɜːrʃəl|tính từ, danh từ|thương mại; quảng cáo
commission|kəˈmɪʃən|danh từ|ủy ban; tiền hoa hồng
commit|kəˈmɪt|động từ|phạm (tội); cam kết
commitment|kəˈmɪtmənt|danh từ|sự cam kết
committee|kəˈmɪti|danh từ|ủy ban
common|ˈkɑːmən|tính từ|phổ biến; chung
communicate|kəˈmjuːnɪkeɪt|động từ|giao tiếp
communication|kəˌmjuːnɪˈkeɪʃən|danh từ|sự giao tiếp, truyền thông
community|kəˈmjuːnəti|danh từ|cộng đồng
company|ˈkʌmpəni|danh từ|công ty; sự bầu bạn
compare|kəmˈper|động từ|so sánh
comparison|kəmˈpærɪsən|danh từ|sự so sánh
compete|kəmˈpiːt|động từ|cạnh tranh, thi đấu
competition|ˌkɑːmpəˈtɪʃən|danh từ|cuộc thi; sự cạnh tranh
competitive|kəmˈpetətɪv|tính từ|cạnh tranh
complain|kəmˈpleɪn|động từ|phàn nàn
complaint|kəmˈpleɪnt|danh từ|lời phàn nàn
complete|kəmˈpliːt|tính từ, động từ|hoàn chỉnh; hoàn thành
completely|kəmˈpliːtli|trạng từ|hoàn toàn
complex|kəmˈpleks|tính từ|phức tạp
complicated|ˈkɑːmplɪkeɪtɪd|tính từ|phức tạp, rắc rối
component|kəmˈpoʊnənt|danh từ|thành phần, linh kiện
compose|kəmˈpoʊz|động từ|sáng tác; cấu thành
computer|kəmˈpjuːtər|danh từ|máy tính
concentrate|ˈkɑːnsəntreɪt|động từ|tập trung
concentration|ˌkɑːnsənˈtreɪʃən|danh từ|sự tập trung; nồng độ
concept|ˈkɑːnsept|danh từ|khái niệm
concern|kənˈsɜːrn|danh từ, động từ|mối lo ngại; liên quan
concerned|kənˈsɜːrnd|tính từ|lo lắng; có liên quan
concert|ˈkɑːnsərt|danh từ|buổi hòa nhạc
conclude|kənˈkluːd|động từ|kết luận; kết thúc
conclusion|kənˈkluːʒən|danh từ|kết luận
concrete|ˈkɑːŋkriːt|danh từ, tính từ|bê tông; cụ thể
condition|kənˈdɪʃən|danh từ|điều kiện; tình trạng
conduct|kənˈdʌkt|động từ|tiến hành; dẫn (điện)
conference|ˈkɑːnfərəns|danh từ|hội nghị
confidence|ˈkɑːnfɪdəns|danh từ|sự tự tin; lòng tin
confident|ˈkɑːnfɪdənt|tính từ|tự tin
confirm|kənˈfɜːrm|động từ|xác nhận
conflict|ˈkɑːnflɪkt|danh từ|xung đột
confuse|kənˈfjuːz|động từ|làm bối rối, nhầm lẫn
confused|kənˈfjuːzd|tính từ|bối rối
confusing|kənˈfjuːzɪŋ|tính từ|gây khó hiểu
connect|kəˈnekt|động từ|kết nối
connection|kəˈnekʃən|danh từ|sự kết nối; mối quan hệ
conscious|ˈkɑːnʃəs|tính từ|có ý thức, tỉnh táo
consequence|ˈkɑːnsəkwens|danh từ|hậu quả
conservative|kənˈsɜːrvətɪv|tính từ|bảo thủ
consider|kənˈsɪdər|động từ|xem xét, cân nhắc
considerable|kənˈsɪdərəbəl|tính từ|đáng kể
consideration|kənˌsɪdəˈreɪʃən|danh từ|sự cân nhắc
consist|kənˈsɪst|động từ|bao gồm (consist of)
consistent|kənˈsɪstənt|tính từ|nhất quán
constant|ˈkɑːnstənt|tính từ|liên tục; không đổi
constantly|ˈkɑːnstəntli|trạng từ|liên tục
construct|kənˈstrʌkt|động từ|xây dựng
construction|kənˈstrʌkʃən|danh từ|sự xây dựng; công trình
consult|kənˈsʌlt|động từ|tham khảo, hỏi ý kiến
consumer|kənˈsuːmər|danh từ|người tiêu dùng
consumption|kənˈsʌmpʃən|danh từ|sự tiêu thụ
contact|ˈkɑːntækt|danh từ, động từ|sự liên lạc; liên hệ
contain|kənˈteɪn|động từ|chứa
container|kənˈteɪnər|danh từ|thùng chứa
content|ˈkɑːntent|danh từ|nội dung
contest|ˈkɑːntest|danh từ|cuộc thi
context|ˈkɑːntekst|danh từ|ngữ cảnh, bối cảnh
continent|ˈkɑːntɪnənt|danh từ|lục địa
continue|kənˈtɪnjuː|động từ|tiếp tục
continuous|kənˈtɪnjuəs|tính từ|liên tục
contract|ˈkɑːntrækt|danh từ|hợp đồng
contrast|ˈkɑːntræst|danh từ|sự tương phản
contribute|kənˈtrɪbjuːt|động từ|đóng góp
contribution|ˌkɑːntrɪˈbjuːʃən|danh từ|sự đóng góp
control|kənˈtroʊl|danh từ, động từ|sự kiểm soát; điều khiển
controller|kənˈtroʊlər|danh từ|bộ điều khiển
convenient|kənˈviːniənt|tính từ|tiện lợi
conversation|ˌkɑːnvərˈseɪʃən|danh từ|cuộc trò chuyện
convert|kənˈvɜːrt|động từ|chuyển đổi
convince|kənˈvɪns|động từ|thuyết phục
cook|kʊk|động từ, danh từ|nấu ăn; đầu bếp
cookie|ˈkʊki|danh từ|bánh quy
cooking|ˈkʊkɪŋ|danh từ|việc nấu ăn
cool|kuːl|tính từ|mát; ngầu
cooperation|koʊˌɑːpəˈreɪʃən|danh từ|sự hợp tác
cope|koʊp|động từ|đối phó (cope with)
copy|ˈkɑːpi|danh từ, động từ|bản sao; sao chép
core|kɔːr|danh từ|lõi, cốt lõi; nhân (CPU)
corner|ˈkɔːrnər|danh từ|góc
corporate|ˈkɔːrpərət|tính từ|thuộc công ty
correct|kəˈrekt|tính từ, động từ|đúng; sửa
cost|kɔːst|danh từ, động từ|chi phí; tốn
cottage|ˈkɑːtɪdʒ|danh từ|nhà tranh
cotton|ˈkɑːtən|danh từ|bông, vải cotton
cough|kɔːf|động từ, danh từ|ho
could|kʊd|động từ khuyết thiếu|có thể (quá khứ của can)
council|ˈkaʊnsəl|danh từ|hội đồng
count|kaʊnt|động từ|đếm; tính đến
counter|ˈkaʊntər|danh từ|quầy; bộ đếm
country|ˈkʌntri|danh từ|đất nước; nông thôn
countryside|ˈkʌntrisaɪd|danh từ|vùng nông thôn
county|ˈkaʊnti|danh từ|hạt, quận
couple|ˈkʌpəl|danh từ|cặp đôi; vài
courage|ˈkɜːrɪdʒ|danh từ|lòng dũng cảm
course|kɔːrs|danh từ|khóa học; món ăn; hướng đi
court|kɔːrt|danh từ|tòa án; sân (thể thao)
cousin|ˈkʌzən|danh từ|anh chị em họ
cover|ˈkʌvər|động từ, danh từ|che phủ; bìa
cow|kaʊ|danh từ|con bò
crack|kræk|danh từ, động từ|vết nứt; làm nứt
craft|kræft|danh từ|nghề thủ công
crash|kræʃ|danh từ, động từ|vụ va chạm; đâm; treo (máy)
crazy|ˈkreɪzi|tính từ|điên, khùng
cream|kriːm|danh từ|kem
create|kriˈeɪt|động từ|tạo ra
creation|kriˈeɪʃən|danh từ|sự sáng tạo
creative|kriˈeɪtɪv|tính từ|sáng tạo
creature|ˈkriːtʃər|danh từ|sinh vật
credit|ˈkredɪt|danh từ|tín dụng; tín chỉ
crew|kruː|danh từ|phi hành đoàn, đội
crime|kraɪm|danh từ|tội phạm
criminal|ˈkrɪmɪnəl|danh từ, tính từ|tội phạm; thuộc hình sự
crisis|ˈkraɪsɪs|danh từ|khủng hoảng
criterion|kraɪˈtɪriən|danh từ|tiêu chí
critic|ˈkrɪtɪk|danh từ|nhà phê bình
critical|ˈkrɪtɪkəl|tính từ|quan trọng; phê phán
criticism|ˈkrɪtɪsɪzəm|danh từ|sự phê bình
criticize|ˈkrɪtɪsaɪz|động từ|phê bình, chỉ trích
crop|krɑːp|danh từ|vụ mùa; cây trồng
cross|krɔːs|động từ, danh từ|băng qua; dấu chéo
crowd|kraʊd|danh từ|đám đông
crowded|ˈkraʊdɪd|tính từ|đông đúc
crucial|ˈkruːʃəl|tính từ|cốt yếu
cruel|ˈkruːəl|tính từ|tàn nhẫn
cry|kraɪ|động từ|khóc; kêu
cultural|ˈkʌltʃərəl|tính từ|thuộc văn hóa
culture|ˈkʌltʃər|danh từ|văn hóa
cup|kʌp|danh từ|cái tách, cốc
cupboard|ˈkʌbərd|danh từ|tủ chén
cure|kjʊr|động từ, danh từ|chữa khỏi; cách chữa
curious|ˈkjʊriəs|tính từ|tò mò
currency|ˈkɜːrənsi|danh từ|tiền tệ
current|ˈkɜːrənt|tính từ, danh từ|hiện tại; dòng điện
currently|ˈkɜːrəntli|trạng từ|hiện nay
curtain|ˈkɜːrtən|danh từ|rèm cửa
custom|ˈkʌstəm|danh từ|phong tục
customer|ˈkʌstəmər|danh từ|khách hàng
cut|kʌt|động từ, danh từ|cắt; vết cắt
cute|kjuːt|tính từ|dễ thương
cycle|ˈsaɪkəl|danh từ, động từ|chu kỳ; đạp xe
dad|dæd|danh từ|bố
daily|ˈdeɪli|tính từ, trạng từ|hằng ngày
damage|ˈdæmɪdʒ|danh từ, động từ|thiệt hại; làm hư hại
dance|dæns|động từ, danh từ|nhảy múa; điệu nhảy
dancer|ˈdænsər|danh từ|vũ công
danger|ˈdeɪndʒər|danh từ|sự nguy hiểm
dangerous|ˈdeɪndʒərəs|tính từ|nguy hiểm
dare|der|động từ|dám
dark|dɑːrk|tính từ|tối
data|ˈdeɪtə|danh từ|dữ liệu
database|ˈdeɪtəbeɪs|danh từ|cơ sở dữ liệu
date|deɪt|danh từ|ngày tháng; cuộc hẹn hò
daughter|ˈdɔːtər|danh từ|con gái
day|deɪ|danh từ|ngày
dead|ded|tính từ|chết
deadline|ˈdedlaɪn|danh từ|hạn chót
deal|diːl|động từ, danh từ|giải quyết; thỏa thuận
dear|dɪr|tính từ|thân mến; đắt
death|deθ|danh từ|cái chết
debate|dɪˈbeɪt|danh từ, động từ|cuộc tranh luận; tranh luận
debt|det|danh từ|món nợ
decade|ˈdekeɪd|danh từ|thập kỷ
decide|dɪˈsaɪd|động từ|quyết định
decision|dɪˈsɪʒən|danh từ|quyết định
declare|dɪˈkler|động từ|tuyên bố; khai báo
decline|dɪˈklaɪn|động từ, danh từ|giảm; từ chối; sự suy giảm
decorate|ˈdekəreɪt|động từ|trang trí
decrease|dɪˈkriːs|động từ, danh từ|giảm; sự giảm
deep|diːp|tính từ|sâu
deeply|ˈdiːpli|trạng từ|sâu sắc
defeat|dɪˈfiːt|động từ, danh từ|đánh bại; thất bại
defend|dɪˈfend|động từ|phòng thủ, bảo vệ
defense|dɪˈfens|danh từ|sự phòng thủ
define|dɪˈfaɪn|động từ|định nghĩa
definite|ˈdefɪnət|tính từ|rõ ràng, chắc chắn
definitely|ˈdefɪnətli|trạng từ|chắc chắn
definition|ˌdefɪˈnɪʃən|danh từ|định nghĩa
degree|dɪˈɡriː|danh từ|độ; bằng cấp; mức độ
delay|dɪˈleɪ|danh từ, động từ|sự chậm trễ; trì hoãn
delete|dɪˈliːt|động từ|xóa
deliberately|dɪˈlɪbərətli|trạng từ|cố ý
delicious|dɪˈlɪʃəs|tính từ|ngon
delight|dɪˈlaɪt|danh từ|niềm vui sướng
deliver|dɪˈlɪvər|động từ|giao hàng; phát biểu
delivery|dɪˈlɪvəri|danh từ|sự giao hàng
demand|dɪˈmænd|danh từ, động từ|nhu cầu; yêu cầu
democracy|dɪˈmɑːkrəsi|danh từ|nền dân chủ
democratic|ˌdeməˈkrætɪk|tính từ|dân chủ
demonstrate|ˈdemənstreɪt|động từ|chứng minh; trình diễn
dentist|ˈdentɪst|danh từ|nha sĩ
deny|dɪˈnaɪ|động từ|phủ nhận; từ chối
department|dɪˈpɑːrtmənt|danh từ|phòng ban; khoa
departure|dɪˈpɑːrtʃər|danh từ|sự khởi hành
depend|dɪˈpend|động từ|phụ thuộc
deposit|dɪˈpɑːzɪt|danh từ, động từ|tiền đặt cọc; gửi tiền
depressed|dɪˈprest|tính từ|chán nản, trầm cảm
depth|depθ|danh từ|độ sâu
describe|dɪˈskraɪb|động từ|mô tả
description|dɪˈskrɪpʃən|danh từ|sự mô tả
desert|ˈdezərt|danh từ|sa mạc
deserve|dɪˈzɜːrv|động từ|xứng đáng
design|dɪˈzaɪn|danh từ, động từ|thiết kế
designer|dɪˈzaɪnər|danh từ|nhà thiết kế
desire|dɪˈzaɪər|danh từ, động từ|mong muốn
desk|desk|danh từ|bàn làm việc
desperate|ˈdespərət|tính từ|tuyệt vọng; liều lĩnh
despite|dɪˈspaɪt|giới từ|mặc dù
destination|ˌdestɪˈneɪʃən|danh từ|điểm đến
destroy|dɪˈstrɔɪ|động từ|phá hủy
destruction|dɪˈstrʌkʃən|danh từ|sự phá hủy
detail|ˈdiːteɪl|danh từ|chi tiết
detailed|ˈdiːteɪld|tính từ|chi tiết
detect|dɪˈtekt|động từ|phát hiện
detective|dɪˈtektɪv|danh từ|thám tử
determine|dɪˈtɜːrmɪn|động từ|xác định; quyết tâm
determined|dɪˈtɜːrmɪnd|tính từ|quyết tâm
develop|dɪˈveləp|động từ|phát triển
development|dɪˈveləpmənt|danh từ|sự phát triển
device|dɪˈvaɪs|danh từ|thiết bị
devote|dɪˈvoʊt|động từ|cống hiến
diagram|ˈdaɪəɡræm|danh từ|sơ đồ
dialogue|ˈdaɪəlɔːɡ|danh từ|hội thoại
diamond|ˈdaɪəmənd|danh từ|kim cương
diary|ˈdaɪəri|danh từ|nhật ký
dictionary|ˈdɪkʃəneri|danh từ|từ điển
die|daɪ|động từ|chết
diet|ˈdaɪət|danh từ|chế độ ăn
differ|ˈdɪfər|động từ|khác nhau
difference|ˈdɪfrəns|danh từ|sự khác biệt
different|ˈdɪfrənt|tính từ|khác
difficult|ˈdɪfɪkəlt|tính từ|khó
difficulty|ˈdɪfɪkəlti|danh từ|sự khó khăn
dig|dɪɡ|động từ|đào
digital|ˈdɪdʒɪtəl|tính từ|kỹ thuật số
dinner|ˈdɪnər|danh từ|bữa tối
direct|dəˈrekt|tính từ, động từ|trực tiếp; chỉ đạo
direction|dəˈrekʃən|danh từ|phương hướng; sự chỉ dẫn
directly|dəˈrektli|trạng từ|trực tiếp
director|dəˈrektər|danh từ|giám đốc; đạo diễn
dirty|ˈdɜːrti|tính từ|bẩn
disabled|dɪsˈeɪbəld|tính từ|khuyết tật; bị tắt
disadvantage|ˌdɪsədˈvæntɪdʒ|danh từ|bất lợi
disagree|ˌdɪsəˈɡriː|động từ|không đồng ý
disappear|ˌdɪsəˈpɪr|động từ|biến mất
disappointed|ˌdɪsəˈpɔɪntɪd|tính từ|thất vọng
disaster|dɪˈzæstər|danh từ|thảm họa
discipline|ˈdɪsəplɪn|danh từ|kỷ luật; ngành học
discount|ˈdɪskaʊnt|danh từ|giảm giá
discover|dɪˈskʌvər|động từ|khám phá
discovery|dɪˈskʌvəri|danh từ|sự khám phá
discuss|dɪˈskʌs|động từ|thảo luận
discussion|dɪˈskʌʃən|danh từ|cuộc thảo luận
disease|dɪˈziːz|danh từ|bệnh
dish|dɪʃ|danh từ|món ăn; cái đĩa
dismiss|dɪsˈmɪs|động từ|bác bỏ; sa thải
display|dɪˈspleɪ|danh từ, động từ|màn hình; trưng bày, hiển thị
distance|ˈdɪstəns|danh từ|khoảng cách
distant|ˈdɪstənt|tính từ|xa xôi
distinct|dɪˈstɪŋkt|tính từ|riêng biệt, rõ ràng
distinguish|dɪˈstɪŋɡwɪʃ|động từ|phân biệt
distribute|dɪˈstrɪbjuːt|động từ|phân phát, phân phối
distribution|ˌdɪstrɪˈbjuːʃən|danh từ|sự phân phối
district|ˈdɪstrɪkt|danh từ|quận, huyện
disturb|dɪˈstɜːrb|động từ|làm phiền
divide|dɪˈvaɪd|động từ|chia
division|dɪˈvɪʒən|danh từ|sự phân chia; phép chia
divorce|dɪˈvɔːrs|danh từ, động từ|ly hôn
do|duː|động từ|làm
doctor|ˈdɑːktər|danh từ|bác sĩ; tiến sĩ
document|ˈdɑːkjəmənt|danh từ|tài liệu
documentary|ˌdɑːkjəˈmentəri|danh từ|phim tài liệu
dog|dɔːɡ|danh từ|con chó
dollar|ˈdɑːlər|danh từ|đô la
domestic|dəˈmestɪk|tính từ|trong nước; gia đình
dominate|ˈdɑːmɪneɪt|động từ|thống trị
door|dɔːr|danh từ|cửa
double|ˈdʌbəl|tính từ, động từ|gấp đôi; tăng gấp đôi
doubt|daʊt|danh từ, động từ|sự nghi ngờ; nghi ngờ
down|daʊn|trạng từ, giới từ|xuống
download|ˌdaʊnˈloʊd|động từ, danh từ|tải xuống
downstairs|ˌdaʊnˈsterz|trạng từ|ở tầng dưới
dozen|ˈdʌzən|danh từ|tá (12)
draft|dræft|danh từ|bản nháp
drag|dræɡ|động từ|kéo, lê
drama|ˈdrɑːmə|danh từ|kịch; phim truyền hình
dramatic|drəˈmætɪk|tính từ|kịch tính
draw|drɔː|động từ|vẽ; kéo; rút ra
drawer|drɔːr|danh từ|ngăn kéo
drawing|ˈdrɔːɪŋ|danh từ|bức vẽ
dream|driːm|danh từ, động từ|giấc mơ; mơ
dress|dres|danh từ, động từ|váy; mặc quần áo
drink|drɪŋk|động từ, danh từ|uống; đồ uống
drive|draɪv|động từ, danh từ|lái xe; ổ đĩa
driver|ˈdraɪvər|danh từ|tài xế; trình điều khiển
drop|drɑːp|động từ, danh từ|làm rơi; giọt
drug|drʌɡ|danh từ|thuốc; ma túy
drum|drʌm|danh từ|cái trống
drunk|drʌŋk|tính từ|say rượu
dry|draɪ|tính từ, động từ|khô; làm khô
due|duː|tính từ|đến hạn; do (due to)
during|ˈdʊrɪŋ|giới từ|trong suốt
dust|dʌst|danh từ|bụi
duty|ˈduːti|danh từ|nhiệm vụ; thuế
each|iːtʃ|từ hạn định, đại từ|mỗi
eager|ˈiːɡər|tính từ|háo hức
ear|ɪr|danh từ|tai
early|ˈɜːrli|tính từ, trạng từ|sớm
earn|ɜːrn|động từ|kiếm (tiền)
earth|ɜːrθ|danh từ|trái đất; đất
earthquake|ˈɜːrθkweɪk|danh từ|động đất
ease|iːz|danh từ, động từ|sự dễ dàng; làm dịu
easily|ˈiːzəli|trạng từ|một cách dễ dàng
east|iːst|danh từ|phía đông
eastern|ˈiːstərn|tính từ|thuộc phía đông
easy|ˈiːzi|tính từ|dễ
eat|iːt|động từ|ăn
economic|ˌekəˈnɑːmɪk|tính từ|thuộc kinh tế
economy|ɪˈkɑːnəmi|danh từ|nền kinh tế
edge|edʒ|danh từ|cạnh, mép
edit|ˈedɪt|động từ|chỉnh sửa
edition|ɪˈdɪʃən|danh từ|ấn bản
editor|ˈedɪtər|danh từ|biên tập viên; trình soạn thảo
educate|ˈedʒukeɪt|động từ|giáo dục
education|ˌedʒuˈkeɪʃən|danh từ|giáo dục
effect|ɪˈfekt|danh từ|hiệu ứng, tác động
effective|ɪˈfektɪv|tính từ|hiệu quả
effectively|ɪˈfektɪvli|trạng từ|một cách hiệu quả
efficient|ɪˈfɪʃənt|tính từ|hiệu quả, năng suất
effort|ˈefərt|danh từ|nỗ lực
egg|eɡ|danh từ|quả trứng
either|ˈiːðər|từ hạn định, trạng từ|một trong hai; cũng (không)
elderly|ˈeldərli|tính từ|lớn tuổi
elect|ɪˈlekt|động từ|bầu chọn
election|ɪˈlekʃən|danh từ|cuộc bầu cử
electric|ɪˈlektrɪk|tính từ|thuộc điện
electrical|ɪˈlektrɪkəl|tính từ|thuộc điện
electricity|ɪˌlekˈtrɪsəti|danh từ|điện
electronic|ɪˌlekˈtrɑːnɪk|tính từ|điện tử
element|ˈelɪmənt|danh từ|yếu tố; phần tử; nguyên tố
elephant|ˈelɪfənt|danh từ|con voi
else|els|trạng từ|khác
elsewhere|ˈelswer|trạng từ|ở nơi khác
email|ˈiːmeɪl|danh từ, động từ|thư điện tử; gửi email
embarrassed|ɪmˈbærəst|tính từ|ngượng ngùng
emerge|ɪˈmɜːrdʒ|động từ|nổi lên, xuất hiện
emergency|ɪˈmɜːrdʒənsi|danh từ|tình trạng khẩn cấp
emotion|ɪˈmoʊʃən|danh từ|cảm xúc
emotional|ɪˈmoʊʃənəl|tính từ|thuộc cảm xúc; xúc động
emphasis|ˈemfəsɪs|danh từ|sự nhấn mạnh
emphasize|ˈemfəsaɪz|động từ|nhấn mạnh
empire|ˈempaɪər|danh từ|đế chế
employ|ɪmˈplɔɪ|động từ|thuê, tuyển dụng
employee|ɪmˈplɔɪiː|danh từ|nhân viên
employer|ɪmˈplɔɪər|danh từ|người chủ, nhà tuyển dụng
employment|ɪmˈplɔɪmənt|danh từ|việc làm
empty|ˈempti|tính từ|trống rỗng
enable|ɪˈneɪbəl|động từ|cho phép, kích hoạt
encounter|ɪnˈkaʊntər|động từ, danh từ|bắt gặp; cuộc gặp gỡ
encourage|ɪnˈkɜːrɪdʒ|động từ|khuyến khích
end|end|danh từ, động từ|kết thúc; phần cuối
ending|ˈendɪŋ|danh từ|đoạn kết
enemy|ˈenəmi|danh từ|kẻ thù
energy|ˈenərdʒi|danh từ|năng lượng
engage|ɪnˈɡeɪdʒ|động từ|tham gia; thu hút
engine|ˈendʒɪn|danh từ|động cơ
engineer|ˌendʒɪˈnɪr|danh từ|kỹ sư
engineering|ˌendʒɪˈnɪrɪŋ|danh từ|ngành kỹ thuật
enhance|ɪnˈhæns|động từ|nâng cao, cải thiện
enjoy|ɪnˈdʒɔɪ|động từ|thích, tận hưởng
enormous|ɪˈnɔːrməs|tính từ|khổng lồ
enough|ɪˈnʌf|từ hạn định, trạng từ|đủ
ensure|ɪnˈʃʊr|động từ|đảm bảo
enter|ˈentər|động từ|đi vào; nhập
entertainment|ˌentərˈteɪnmənt|danh từ|sự giải trí
enthusiasm|ɪnˈθuːziæzəm|danh từ|sự nhiệt tình
entire|ɪnˈtaɪər|tính từ|toàn bộ
entirely|ɪnˈtaɪərli|trạng từ|hoàn toàn
entrance|ˈentrəns|danh từ|lối vào
entry|ˈentri|danh từ|mục; sự đi vào
environment|ɪnˈvaɪrənmənt|danh từ|môi trường
environmental|ɪnˌvaɪrənˈmentəl|tính từ|thuộc môi trường
episode|ˈepɪsoʊd|danh từ|tập (phim)
equal|ˈiːkwəl|tính từ|bằng nhau, bình đẳng
equally|ˈiːkwəli|trạng từ|như nhau
equipment|ɪˈkwɪpmənt|danh từ|thiết bị
error|ˈerər|danh từ|lỗi
escape|ɪˈskeɪp|động từ, danh từ|trốn thoát; sự trốn thoát
especially|ɪˈspeʃəli|trạng từ|đặc biệt là
essay|ˈeseɪ|danh từ|bài luận
essential|ɪˈsenʃəl|tính từ|cần thiết, thiết yếu
establish|ɪˈstæblɪʃ|động từ|thành lập, thiết lập
estate|ɪˈsteɪt|danh từ|bất động sản; điền trang
estimate|ˈestɪmeɪt|động từ, danh từ|ước tính
etc|et ˈsetərə|trạng từ|vân vân
ethnic|ˈeθnɪk|tính từ|thuộc dân tộc
evaluate|ɪˈvæljueɪt|động từ|đánh giá
even|ˈiːvən|trạng từ, tính từ|thậm chí; bằng phẳng; chẵn
evening|ˈiːvnɪŋ|danh từ|buổi tối
event|ɪˈvent|danh từ|sự kiện
eventually|ɪˈventʃuəli|trạng từ|cuối cùng
ever|ˈevər|trạng từ|từng, bao giờ
every|ˈevri|từ hạn định|mỗi, mọi
everybody|ˈevribɑːdi|đại từ|mọi người
everyday|ˈevrideɪ|tính từ|hằng ngày
everyone|ˈevriwʌn|đại từ|mọi người
everything|ˈevriθɪŋ|đại từ|mọi thứ
everywhere|ˈevriwer|trạng từ|mọi nơi
evidence|ˈevɪdəns|danh từ|bằng chứng
evil|ˈiːvəl|tính từ, danh từ|xấu xa; cái ác
exact|ɪɡˈzækt|tính từ|chính xác
exactly|ɪɡˈzæktli|trạng từ|chính xác
exam|ɪɡˈzæm|danh từ|kỳ thi
examination|ɪɡˌzæmɪˈneɪʃən|danh từ|kỳ thi; sự kiểm tra
examine|ɪɡˈzæmɪn|động từ|kiểm tra, xem xét
example|ɪɡˈzæmpəl|danh từ|ví dụ
excellent|ˈeksələnt|tính từ|xuất sắc
except|ɪkˈsept|giới từ|ngoại trừ
exception|ɪkˈsepʃən|danh từ|ngoại lệ
exchange|ɪksˈtʃeɪndʒ|danh từ, động từ|sự trao đổi; trao đổi
excited|ɪkˈsaɪtɪd|tính từ|hào hứng
excitement|ɪkˈsaɪtmənt|danh từ|sự phấn khích
exciting|ɪkˈsaɪtɪŋ|tính từ|thú vị, hấp dẫn
exclude|ɪkˈskluːd|động từ|loại trừ
excuse|ɪkˈskjuːz|danh từ, động từ|lời bào chữa; tha lỗi
executive|ɪɡˈzekjətɪv|danh từ|giám đốc điều hành
exercise|ˈeksərsaɪz|danh từ, động từ|bài tập; tập thể dục
exhibition|ˌeksɪˈbɪʃən|danh từ|triển lãm
exist|ɪɡˈzɪst|động từ|tồn tại
existence|ɪɡˈzɪstəns|danh từ|sự tồn tại
existing|ɪɡˈzɪstɪŋ|tính từ|hiện có
exit|ˈeɡzɪt|danh từ, động từ|lối ra; thoát
expand|ɪkˈspænd|động từ|mở rộng
expansion|ɪkˈspænʃən|danh từ|sự mở rộng
expect|ɪkˈspekt|động từ|mong đợi
expectation|ˌekspekˈteɪʃən|danh từ|sự kỳ vọng
expense|ɪkˈspens|danh từ|chi phí
expensive|ɪkˈspensɪv|tính từ|đắt
experience|ɪkˈspɪriəns|danh từ, động từ|kinh nghiệm; trải qua
experiment|ɪkˈsperɪmənt|danh từ|thí nghiệm
expert|ˈekspɜːrt|danh từ|chuyên gia
explain|ɪkˈspleɪn|động từ|giải thích
explanation|ˌekspləˈneɪʃən|danh từ|lời giải thích
explode|ɪkˈsploʊd|động từ|nổ
explore|ɪkˈsplɔːr|động từ|khám phá
explosion|ɪkˈsploʊʒən|danh từ|vụ nổ
export|ˈekspɔːrt|danh từ, động từ|xuất khẩu
expose|ɪkˈspoʊz|động từ|phơi bày
express|ɪkˈspres|động từ|bày tỏ, diễn đạt
expression|ɪkˈspreʃən|danh từ|sự biểu đạt; biểu thức
extend|ɪkˈstend|động từ|mở rộng, kéo dài
extension|ɪkˈstenʃən|danh từ|sự mở rộng; phần mở rộng
extent|ɪkˈstent|danh từ|mức độ
external|ɪkˈstɜːrnəl|tính từ|bên ngoài
extra|ˈekstrə|tính từ|thêm
extraordinary|ɪkˈstrɔːrdəneri|tính từ|phi thường
extreme|ɪkˈstriːm|tính từ|cực độ
extremely|ɪkˈstriːmli|trạng từ|cực kỳ
eye|aɪ|danh từ|mắt
face|feɪs|danh từ, động từ|khuôn mặt; đối mặt
facility|fəˈsɪləti|danh từ|cơ sở vật chất, tiện nghi
fact|fækt|danh từ|sự thật
factor|ˈfæktər|danh từ|yếu tố; thừa số
factory|ˈfæktəri|danh từ|nhà máy
fail|feɪl|động từ|thất bại; trượt
failure|ˈfeɪljər|danh từ|sự thất bại; sự cố
fair|fer|tính từ, danh từ|công bằng; hội chợ
fairly|ˈferli|trạng từ|khá; công bằng
faith|feɪθ|danh từ|niềm tin, đức tin
fall|fɔːl|động từ, danh từ|ngã, rơi; mùa thu
false|fɔːls|tính từ|sai
familiar|fəˈmɪljər|tính từ|quen thuộc
family|ˈfæməli|danh từ|gia đình
famous|ˈfeɪməs|tính từ|nổi tiếng
fan|fæn|danh từ|người hâm mộ; cái quạt
fancy|ˈfænsi|tính từ, động từ|sang trọng; thích
fantastic|fænˈtæstɪk|tính từ|tuyệt vời
far|fɑːr|trạng từ, tính từ|xa
fare|fer|danh từ|giá vé
farm|fɑːrm|danh từ|nông trại
farmer|ˈfɑːrmər|danh từ|nông dân
fashion|ˈfæʃən|danh từ|thời trang
fast|fæst|tính từ, trạng từ|nhanh
fat|fæt|tính từ, danh từ|béo; chất béo
father|ˈfɑːðər|danh từ|bố, cha
fault|fɔːlt|danh từ|lỗi
favor|ˈfeɪvər|danh từ|ân huệ, sự giúp đỡ
favorite|ˈfeɪvərɪt|tính từ|yêu thích
fear|fɪr|danh từ, động từ|nỗi sợ; sợ
feature|ˈfiːtʃər|danh từ, động từ|đặc điểm, tính năng; có điểm nổi bật
fee|fiː|danh từ|phí
feed|fiːd|động từ|cho ăn
feedback|ˈfiːdbæk|danh từ|phản hồi
feel|fiːl|động từ|cảm thấy
feeling|ˈfiːlɪŋ|danh từ|cảm giác, cảm xúc
fellow|ˈfeloʊ|danh từ|bạn, đồng chí
female|ˈfiːmeɪl|tính từ, danh từ|nữ, giống cái
fence|fens|danh từ|hàng rào
festival|ˈfestɪvəl|danh từ|lễ hội
fever|ˈfiːvər|danh từ|cơn sốt
few|fjuː|từ hạn định|ít, vài
field|fiːld|danh từ|cánh đồng; lĩnh vực; trường (dữ liệu)
fight|faɪt|động từ, danh từ|đánh nhau, chiến đấu; trận đánh
figure|ˈfɪɡjər|danh từ, động từ|con số; hình dáng; nhân vật; hiểu ra
file|faɪl|danh từ|tập tin, hồ sơ
fill|fɪl|động từ|làm đầy, điền
film|fɪlm|danh từ|bộ phim
final|ˈfaɪnəl|tính từ, danh từ|cuối cùng; trận chung kết
finally|ˈfaɪnəli|trạng từ|cuối cùng
finance|ˈfaɪnæns|danh từ|tài chính
financial|faɪˈnænʃəl|tính từ|thuộc tài chính
find|faɪnd|động từ|tìm thấy
finding|ˈfaɪndɪŋ|danh từ|phát hiện, kết quả nghiên cứu
fine|faɪn|tính từ, danh từ|tốt, ổn; tiền phạt
finger|ˈfɪŋɡər|danh từ|ngón tay
finish|ˈfɪnɪʃ|động từ|hoàn thành, kết thúc
fire|faɪər|danh từ, động từ|lửa; sa thải; bắn
firm|fɜːrm|danh từ, tính từ|công ty; chắc chắn
first|fɜːrst|số từ, trạng từ|thứ nhất; đầu tiên
firstly|ˈfɜːrstli|trạng từ|thứ nhất là
fish|fɪʃ|danh từ, động từ|con cá; câu cá
fit|fɪt|động từ, tính từ|vừa; khỏe mạnh
fitness|ˈfɪtnəs|danh từ|sự khỏe mạnh, thể hình
fix|fɪks|động từ|sửa chữa; cố định
fixed|fɪkst|tính từ|cố định
flag|flæɡ|danh từ|lá cờ
flame|fleɪm|danh từ|ngọn lửa
flash|flæʃ|danh từ, động từ|tia sáng; bộ nhớ flash; lóe sáng
flat|flæt|tính từ, danh từ|phẳng; căn hộ
flavor|ˈfleɪvər|danh từ|hương vị
flexible|ˈfleksəbəl|tính từ|linh hoạt
flight|flaɪt|danh từ|chuyến bay
float|floʊt|động từ, danh từ|nổi; số thực (float)
flood|flʌd|danh từ, động từ|lũ lụt; tràn ngập
floor|flɔːr|danh từ|sàn nhà; tầng
flow|floʊ|danh từ, động từ|dòng chảy; chảy
flower|ˈflaʊər|danh từ|bông hoa
flu|fluː|danh từ|bệnh cúm
fly|flaɪ|động từ, danh từ|bay; con ruồi
focus|ˈfoʊkəs|động từ, danh từ|tập trung; tiêu điểm
fold|foʊld|động từ|gấp
folk|foʊk|danh từ|người; dân gian
follow|ˈfɑːloʊ|động từ|theo dõi, đi theo
following|ˈfɑːloʊɪŋ|tính từ|sau đây, tiếp theo
food|fuːd|danh từ|thức ăn
foot|fʊt|danh từ|bàn chân; foot (đơn vị đo)
football|ˈfʊtbɔːl|danh từ|bóng đá
for|fɔːr|giới từ|cho; trong (khoảng thời gian)
force|fɔːrs|danh từ, động từ|lực; lực lượng; ép buộc
forecast|ˈfɔːrkæst|danh từ, động từ|dự báo
foreign|ˈfɔːrən|tính từ|nước ngoài
forest|ˈfɔːrɪst|danh từ|rừng
forever|fərˈevər|trạng từ|mãi mãi
forget|fərˈɡet|động từ|quên
forgive|fərˈɡɪv|động từ|tha thứ
fork|fɔːrk|danh từ|cái nĩa
form|fɔːrm|danh từ, động từ|hình thức; mẫu đơn; hình thành
formal|ˈfɔːrməl|tính từ|trang trọng, chính thức
format|ˈfɔːrmæt|danh từ, động từ|định dạng
former|ˈfɔːrmər|tính từ|trước đây, cựu
formula|ˈfɔːrmjələ|danh từ|công thức
fortunately|ˈfɔːrtʃənətli|trạng từ|may mắn thay
fortune|ˈfɔːrtʃən|danh từ|tài sản lớn; vận may
forward|ˈfɔːrwərd|trạng từ, động từ|về phía trước; chuyển tiếp
found|faʊnd|động từ|thành lập
foundation|faʊnˈdeɪʃən|danh từ|nền móng; quỹ
frame|freɪm|danh từ|khung
free|friː|tính từ|tự do; miễn phí; rảnh
freedom|ˈfriːdəm|danh từ|sự tự do
freeze|friːz|động từ|đóng băng; đơ (máy)
frequency|ˈfriːkwənsi|danh từ|tần số
frequent|ˈfriːkwənt|tính từ|thường xuyên
frequently|ˈfriːkwəntli|trạng từ|thường xuyên
fresh|freʃ|tính từ|tươi
fridge|frɪdʒ|danh từ|tủ lạnh
friend|frend|danh từ|bạn bè
friendly|ˈfrendli|tính từ|thân thiện
friendship|ˈfrendʃɪp|danh từ|tình bạn
frightened|ˈfraɪtənd|tính từ|sợ hãi
from|frʌm|giới từ|từ
front|frʌnt|danh từ|phía trước
fruit|fruːt|danh từ|trái cây
frustrated|ˈfrʌstreɪtɪd|tính từ|bực bội, nản
fry|fraɪ|động từ|chiên, rán
fuel|ˈfjuːəl|danh từ|nhiên liệu
full|fʊl|tính từ|đầy; no
fully|ˈfʊli|trạng từ|đầy đủ, hoàn toàn
fun|fʌn|danh từ, tính từ|niềm vui; vui
function|ˈfʌŋkʃən|danh từ, động từ|chức năng; hàm; hoạt động
fund|fʌnd|danh từ, động từ|quỹ; tài trợ
fundamental|ˌfʌndəˈmentəl|tính từ|cơ bản, nền tảng
funny|ˈfʌni|tính từ|buồn cười
furniture|ˈfɜːrnɪtʃər|danh từ|đồ nội thất
further|ˈfɜːrðər|trạng từ, tính từ|xa hơn; thêm nữa
future|ˈfjuːtʃər|danh từ|tương lai
gain|ɡeɪn|động từ, danh từ|đạt được, tăng; lợi ích; độ lợi
gallery|ˈɡæləri|danh từ|phòng trưng bày
game|ɡeɪm|danh từ|trò chơi; trận đấu
gap|ɡæp|danh từ|khoảng trống
garage|ɡəˈrɑːʒ|danh từ|nhà để xe; gara
garbage|ˈɡɑːrbɪdʒ|danh từ|rác
garden|ˈɡɑːrdən|danh từ|khu vườn
gas|ɡæs|danh từ|khí ga; xăng
gate|ɡeɪt|danh từ|cổng
gather|ˈɡæðər|động từ|tập hợp, thu thập
gear|ɡɪr|danh từ|bánh răng; đồ nghề
general|ˈdʒenərəl|tính từ, danh từ|chung, tổng quát; tướng
generally|ˈdʒenərəli|trạng từ|nói chung
generate|ˈdʒenəreɪt|động từ|tạo ra, phát ra
generation|ˌdʒenəˈreɪʃən|danh từ|thế hệ; sự tạo ra
generous|ˈdʒenərəs|tính từ|hào phóng
gentle|ˈdʒentəl|tính từ|nhẹ nhàng, hiền
gentleman|ˈdʒentəlmən|danh từ|quý ông
genuine|ˈdʒenjuɪn|tính từ|thật, chân thành
geography|dʒiˈɑːɡrəfi|danh từ|địa lý
get|ɡet|động từ|nhận được; trở nên; đến
ghost|ɡoʊst|danh từ|con ma
giant|ˈdʒaɪənt|tính từ, danh từ|khổng lồ; người khổng lồ
gift|ɡɪft|danh từ|món quà
girl|ɡɜːrl|danh từ|cô gái
girlfriend|ˈɡɜːrlfrend|danh từ|bạn gái
give|ɡɪv|động từ|cho, tặng
glad|ɡlæd|tính từ|vui mừng
glass|ɡlæs|danh từ|thủy tinh; cái cốc
glasses|ˈɡlæsɪz|danh từ|kính mắt
global|ˈɡloʊbəl|tính từ|toàn cầu
glove|ɡlʌv|danh từ|găng tay
go|ɡoʊ|động từ|đi
goal|ɡoʊl|danh từ|mục tiêu; bàn thắng
god|ɡɑːd|danh từ|thần, Chúa
gold|ɡoʊld|danh từ|vàng
golden|ˈɡoʊldən|tính từ|bằng vàng; quý giá
golf|ɡɑːlf|danh từ|môn golf
good|ɡʊd|tính từ|tốt
goodbye|ɡʊdˈbaɪ|thán từ|tạm biệt
goods|ɡʊdz|danh từ|hàng hóa
govern|ˈɡʌvərn|động từ|cai trị, quản lý
government|ˈɡʌvərnmənt|danh từ|chính phủ
grab|ɡræb|động từ|chộp lấy
grade|ɡreɪd|danh từ|điểm; lớp; cấp độ
gradually|ˈɡrædʒuəli|trạng từ|dần dần
graduate|ˈɡrædʒuət|danh từ, động từ|người tốt nghiệp; tốt nghiệp
grain|ɡreɪn|danh từ|hạt ngũ cốc
grammar|ˈɡræmər|danh từ|ngữ pháp
grand|ɡrænd|tính từ|lớn, hoành tráng
grandfather|ˈɡrænfɑːðər|danh từ|ông
grandmother|ˈɡrænmʌðər|danh từ|bà
grant|ɡrænt|danh từ, động từ|khoản trợ cấp; cấp, cho
graph|ɡræf|danh từ|đồ thị
grass|ɡræs|danh từ|cỏ
grateful|ˈɡreɪtfəl|tính từ|biết ơn
great|ɡreɪt|tính từ|tuyệt vời; lớn
greatly|ˈɡreɪtli|trạng từ|rất nhiều
green|ɡriːn|tính từ|màu xanh lá
grey|ɡreɪ|tính từ|màu xám
grocery|ˈɡroʊsəri|danh từ|tạp hóa
ground|ɡraʊnd|danh từ|mặt đất; nối đất (GND)
group|ɡruːp|danh từ|nhóm
grow|ɡroʊ|động từ|lớn lên; trồng
growth|ɡroʊθ|danh từ|sự tăng trưởng
guarantee|ˌɡærənˈtiː|danh từ, động từ|sự bảo đảm; bảo đảm
guard|ɡɑːrd|danh từ, động từ|người bảo vệ; canh gác
guess|ɡes|động từ, danh từ|đoán; sự phỏng đoán
guest|ɡest|danh từ|khách
guidance|ˈɡaɪdəns|danh từ|sự hướng dẫn
guide|ɡaɪd|danh từ, động từ|hướng dẫn viên; sách hướng dẫn; dẫn đường
guilty|ˈɡɪlti|tính từ|có tội; cảm thấy có lỗi
guitar|ɡɪˈtɑːr|danh từ|đàn ghi-ta
gun|ɡʌn|danh từ|khẩu súng
guy|ɡaɪ|danh từ|anh chàng
gym|dʒɪm|danh từ|phòng tập thể hình
habit|ˈhæbɪt|danh từ|thói quen
hair|her|danh từ|tóc
half|hæf|danh từ, tính từ|một nửa
hall|hɔːl|danh từ|hội trường; hành lang
hand|hænd|danh từ, động từ|bàn tay; đưa
handle|ˈhændəl|động từ, danh từ|xử lý; tay cầm
hang|hæŋ|động từ|treo; treo (máy)
happen|ˈhæpən|động từ|xảy ra
happiness|ˈhæpinəs|danh từ|niềm hạnh phúc
happy|ˈhæpi|tính từ|vui, hạnh phúc
hard|hɑːrd|tính từ, trạng từ|cứng; khó; chăm chỉ
hardly|ˈhɑːrdli|trạng từ|hầu như không
hardware|ˈhɑːrdwer|danh từ|phần cứng
harm|hɑːrm|danh từ, động từ|sự tổn hại; làm hại
harmful|ˈhɑːrmfəl|tính từ|có hại
hat|hæt|danh từ|cái mũ
hate|heɪt|động từ|ghét
have|hæv|động từ|có
he|hiː|đại từ|anh ấy, ông ấy
head|hed|danh từ, động từ|cái đầu; người đứng đầu; hướng tới
headache|ˈhedeɪk|danh từ|đau đầu
headline|ˈhedlaɪn|danh từ|tiêu đề báo
headquarters|ˈhedkwɔːrtərz|danh từ|trụ sở chính
health|helθ|danh từ|sức khỏe
healthy|ˈhelθi|tính từ|khỏe mạnh; lành mạnh
hear|hɪr|động từ|nghe thấy
hearing|ˈhɪrɪŋ|danh từ|thính giác; phiên điều trần
heart|hɑːrt|danh từ|trái tim
heat|hiːt|danh từ, động từ|nhiệt; làm nóng
heavily|ˈhevɪli|trạng từ|nặng nề
heavy|ˈhevi|tính từ|nặng
height|haɪt|danh từ|chiều cao
hello|həˈloʊ|thán từ|xin chào
help|help|động từ, danh từ|giúp đỡ; sự giúp đỡ
helpful|ˈhelpfəl|tính từ|hữu ích
her|hɜːr|đại từ, từ hạn định|cô ấy; của cô ấy
here|hɪr|trạng từ|ở đây
hero|ˈhɪroʊ|danh từ|anh hùng
hers|hɜːrz|đại từ|của cô ấy
herself|hɜːrˈself|đại từ|chính cô ấy
hesitate|ˈhezɪteɪt|động từ|do dự
hi|haɪ|thán từ|chào (thân mật)
hide|haɪd|động từ|trốn; giấu
high|haɪ|tính từ, trạng từ|cao
highlight|ˈhaɪlaɪt|động từ, danh từ|làm nổi bật; điểm nổi bật
highly|ˈhaɪli|trạng từ|rất, hết sức
hill|hɪl|danh từ|ngọn đồi
him|hɪm|đại từ|anh ấy (tân ngữ)
himself|hɪmˈself|đại từ|chính anh ấy
hire|haɪər|động từ|thuê
his|hɪz|từ hạn định, đại từ|của anh ấy
historic|hɪˈstɔːrɪk|tính từ|mang tính lịch sử
historical|hɪˈstɔːrɪkəl|tính từ|thuộc lịch sử
history|ˈhɪstəri|danh từ|lịch sử
hit|hɪt|động từ, danh từ|đánh, va; thành công lớn
hobby|ˈhɑːbi|danh từ|sở thích
hold|hoʊld|động từ|cầm, giữ; tổ chức
hole|hoʊl|danh từ|cái lỗ
holiday|ˈhɑːlədeɪ|danh từ|kỳ nghỉ, ngày lễ
hollow|ˈhɑːloʊ|tính từ|rỗng
holy|ˈhoʊli|tính từ|thiêng liêng
home|hoʊm|danh từ, trạng từ|nhà; về nhà
homework|ˈhoʊmwɜːrk|danh từ|bài tập về nhà
honest|ˈɑːnɪst|tính từ|trung thực
honestly|ˈɑːnɪstli|trạng từ|thành thật mà nói
honey|ˈhʌni|danh từ|mật ong; cưng
honor|ˈɑːnər|danh từ|danh dự, vinh dự
hope|hoʊp|động từ, danh từ|hy vọng
horrible|ˈhɔːrəbəl|tính từ|kinh khủng
horror|ˈhɔːrər|danh từ|sự kinh hoàng; kinh dị
horse|hɔːrs|danh từ|con ngựa
hospital|ˈhɑːspɪtəl|danh từ|bệnh viện
host|hoʊst|danh từ, động từ|chủ nhà; máy chủ; tổ chức
hot|hɑːt|tính từ|nóng
hotel|hoʊˈtel|danh từ|khách sạn
hour|aʊər|danh từ|giờ
house|haʊs|danh từ|ngôi nhà
household|ˈhaʊshoʊld|danh từ|hộ gia đình
housing|ˈhaʊzɪŋ|danh từ|nhà ở
how|haʊ|trạng từ|như thế nào
however|haʊˈevər|trạng từ|tuy nhiên
huge|hjuːdʒ|tính từ|khổng lồ
human|ˈhjuːmən|danh từ, tính từ|con người; thuộc con người
humor|ˈhjuːmər|danh từ|sự hài hước
hundred|ˈhʌndrəd|số từ|một trăm
hungry|ˈhʌŋɡri|tính từ|đói
hunt|hʌnt|động từ|săn bắn
hurry|ˈhɜːri|động từ, danh từ|vội vàng
hurt|hɜːrt|động từ, tính từ|làm đau; bị thương
husband|ˈhʌzbənd|danh từ|chồng
I|aɪ|đại từ|tôi
ice|aɪs|danh từ|băng, nước đá
idea|aɪˈdiːə|danh từ|ý tưởng
ideal|aɪˈdiːəl|tính từ|lý tưởng
identify|aɪˈdentɪfaɪ|động từ|xác định, nhận dạng
identity|aɪˈdentəti|danh từ|danh tính
if|ɪf|liên từ|nếu
ignore|ɪɡˈnɔːr|động từ|phớt lờ, bỏ qua
ill|ɪl|tính từ|ốm
illegal|ɪˈliːɡəl|tính từ|bất hợp pháp
illness|ˈɪlnəs|danh từ|bệnh tật
illustrate|ˈɪləstreɪt|động từ|minh họa
image|ˈɪmɪdʒ|danh từ|hình ảnh
imagination|ɪˌmædʒɪˈneɪʃən|danh từ|trí tưởng tượng
imagine|ɪˈmædʒɪn|động từ|tưởng tượng
immediate|ɪˈmiːdiət|tính từ|ngay lập tức
immediately|ɪˈmiːdiətli|trạng từ|ngay lập tức
impact|ˈɪmpækt|danh từ|tác động
implement|ˈɪmplɪment|động từ|thực hiện, triển khai
implication|ˌɪmplɪˈkeɪʃən|danh từ|hàm ý; hệ quả
imply|ɪmˈplaɪ|động từ|ngụ ý
import|ˈɪmpɔːrt|danh từ, động từ|nhập khẩu; nhập (dữ liệu)
importance|ɪmˈpɔːrtəns|danh từ|tầm quan trọng
important|ɪmˈpɔːrtənt|tính từ|quan trọng
impose|ɪmˈpoʊz|động từ|áp đặt
impossible|ɪmˈpɑːsəbəl|tính từ|không thể
impress|ɪmˈpres|động từ|gây ấn tượng
impression|ɪmˈpreʃən|danh từ|ấn tượng
impressive|ɪmˈpresɪv|tính từ|ấn tượng
improve|ɪmˈpruːv|động từ|cải thiện
improvement|ɪmˈpruːvmənt|danh từ|sự cải thiện
in|ɪn|giới từ|trong, ở
incident|ˈɪnsɪdənt|danh từ|sự cố, vụ việc
include|ɪnˈkluːd|động từ|bao gồm
including|ɪnˈkluːdɪŋ|giới từ|bao gồm cả
income|ˈɪnkʌm|danh từ|thu nhập
increase|ɪnˈkriːs|động từ, danh từ|tăng; sự tăng
increasingly|ɪnˈkriːsɪŋli|trạng từ|ngày càng
incredible|ɪnˈkredəbəl|tính từ|khó tin, tuyệt vời
indeed|ɪnˈdiːd|trạng từ|thật vậy
independent|ˌɪndɪˈpendənt|tính từ|độc lập
index|ˈɪndeks|danh từ|chỉ số; mục lục
indicate|ˈɪndɪkeɪt|động từ|chỉ ra, cho biết
indication|ˌɪndɪˈkeɪʃən|danh từ|dấu hiệu
individual|ˌɪndɪˈvɪdʒuəl|danh từ, tính từ|cá nhân; riêng lẻ
indoor|ˈɪndɔːr|tính từ|trong nhà
industrial|ɪnˈdʌstriəl|tính từ|thuộc công nghiệp
industry|ˈɪndəstri|danh từ|ngành công nghiệp
inevitable|ɪnˈevɪtəbəl|tính từ|không thể tránh khỏi
infection|ɪnˈfekʃən|danh từ|sự nhiễm trùng
influence|ˈɪnfluəns|danh từ, động từ|ảnh hưởng
inform|ɪnˈfɔːrm|động từ|thông báo
informal|ɪnˈfɔːrməl|tính từ|thân mật, không trang trọng
information|ˌɪnfərˈmeɪʃən|danh từ|thông tin
ingredient|ɪnˈɡriːdiənt|danh từ|nguyên liệu, thành phần
initial|ɪˈnɪʃəl|tính từ|ban đầu
initially|ɪˈnɪʃəli|trạng từ|ban đầu
initiative|ɪˈnɪʃətɪv|danh từ|sáng kiến
injure|ˈɪndʒər|động từ|làm bị thương
injury|ˈɪndʒəri|danh từ|vết thương, chấn thương
inner|ˈɪnər|tính từ|bên trong
innocent|ˈɪnəsənt|tính từ|vô tội; ngây thơ
innovation|ˌɪnəˈveɪʃən|danh từ|sự đổi mới
input|ˈɪnpʊt|danh từ|đầu vào
inquiry|ˈɪnkwəri|danh từ|sự điều tra; câu hỏi
insect|ˈɪnsekt|danh từ|côn trùng
inside|ɪnˈsaɪd|giới từ, trạng từ|bên trong
insight|ˈɪnsaɪt|danh từ|sự hiểu biết sâu sắc
insist|ɪnˈsɪst|động từ|khăng khăng, nhất quyết
inspect|ɪnˈspekt|động từ|kiểm tra
inspire|ɪnˈspaɪər|động từ|truyền cảm hứng
install|ɪnˈstɔːl|động từ|cài đặt, lắp đặt
instance|ˈɪnstəns|danh từ|ví dụ, trường hợp; thực thể
instant|ˈɪnstənt|tính từ|ngay lập tức
instead|ɪnˈsted|trạng từ|thay vào đó
institute|ˈɪnstɪtuːt|danh từ|viện
institution|ˌɪnstɪˈtuːʃən|danh từ|tổ chức, cơ quan
instruction|ɪnˈstrʌkʃən|danh từ|chỉ dẫn; lệnh (máy)
instrument|ˈɪnstrəmənt|danh từ|nhạc cụ; dụng cụ
insurance|ɪnˈʃʊrəns|danh từ|bảo hiểm
intelligence|ɪnˈtelɪdʒəns|danh từ|trí thông minh; tình báo
intelligent|ɪnˈtelɪdʒənt|tính từ|thông minh
intend|ɪnˈtend|động từ|dự định
intense|ɪnˈtens|tính từ|mãnh liệt, dữ dội
intention|ɪnˈtenʃən|danh từ|ý định
interest|ˈɪntrəst|danh từ, động từ|sự quan tâm; lãi suất; làm quan tâm
interested|ˈɪntrəstɪd|tính từ|quan tâm, thích thú
interesting|ˈɪntrəstɪŋ|tính từ|thú vị
interface|ˈɪntərfeɪs|danh từ|giao diện
internal|ɪnˈtɜːrnəl|tính từ|bên trong, nội bộ
international|ˌɪntərˈnæʃənəl|tính từ|quốc tế
internet|ˈɪntərnet|danh từ|mạng internet
interpret|ɪnˈtɜːrprɪt|động từ|giải thích; phiên dịch
interrupt|ˌɪntəˈrʌpt|động từ, danh từ|ngắt lời, làm gián đoạn; ngắt (interrupt)
interval|ˈɪntərvəl|danh từ|khoảng thời gian
interview|ˈɪntərvjuː|danh từ, động từ|cuộc phỏng vấn; phỏng vấn
into|ˈɪntuː|giới từ|vào trong
introduce|ˌɪntrəˈduːs|động từ|giới thiệu
introduction|ˌɪntrəˈdʌkʃən|danh từ|sự giới thiệu; phần mở đầu
invent|ɪnˈvent|động từ|phát minh
invention|ɪnˈvenʃən|danh từ|phát minh
invest|ɪnˈvest|động từ|đầu tư
investigate|ɪnˈvestɪɡeɪt|động từ|điều tra
investigation|ɪnˌvestɪˈɡeɪʃən|danh từ|cuộc điều tra
investment|ɪnˈvestmənt|danh từ|sự đầu tư
invitation|ˌɪnvɪˈteɪʃən|danh từ|lời mời
invite|ɪnˈvaɪt|động từ|mời
involve|ɪnˈvɑːlv|động từ|liên quan; bao gồm
involved|ɪnˈvɑːlvd|tính từ|có liên quan, tham gia
iron|ˈaɪərn|danh từ, động từ|sắt; bàn là; là (quần áo)
island|ˈaɪlənd|danh từ|hòn đảo
issue|ˈɪʃuː|danh từ, động từ|vấn đề; số báo; phát hành
it|ɪt|đại từ|nó
item|ˈaɪtəm|danh từ|món, mục
its|ɪts|từ hạn định|của nó
itself|ɪtˈself|đại từ|chính nó
jacket|ˈdʒækɪt|danh từ|áo khoác
jail|dʒeɪl|danh từ|nhà tù
jam|dʒæm|danh từ|mứt; sự tắc nghẽn
jeans|dʒiːnz|danh từ|quần bò
job|dʒɑːb|danh từ|công việc
join|dʒɔɪn|động từ|tham gia; nối
joint|dʒɔɪnt|tính từ, danh từ|chung; khớp nối
joke|dʒoʊk|danh từ, động từ|câu đùa; nói đùa
journal|ˈdʒɜːrnəl|danh từ|tạp chí; nhật ký
journalist|ˈdʒɜːrnəlɪst|danh từ|nhà báo
journey|ˈdʒɜːrni|danh từ|chuyến đi
joy|dʒɔɪ|danh từ|niềm vui
judge|dʒʌdʒ|danh từ, động từ|thẩm phán; đánh giá
judgment|ˈdʒʌdʒmənt|danh từ|sự phán đoán; phán quyết
juice|dʒuːs|danh từ|nước ép
jump|dʒʌmp|động từ|nhảy
junior|ˈdʒuːniər|tính từ|cấp dưới; ít tuổi hơn
just|dʒʌst|trạng từ, tính từ|chỉ; vừa mới; công bằng
justice|ˈdʒʌstɪs|danh từ|công lý
justify|ˈdʒʌstɪfaɪ|động từ|biện minh
keen|kiːn|tính từ|hăng hái, ham thích
keep|kiːp|động từ|giữ; tiếp tục
key|kiː|danh từ, tính từ|chìa khóa; phím; then chốt
keyboard|ˈkiːbɔːrd|danh từ|bàn phím
kick|kɪk|động từ|đá
kid|kɪd|danh từ, động từ|đứa trẻ; đùa
kill|kɪl|động từ|giết
kilometer|kɪˈlɑːmɪtər|danh từ|ki-lô-mét
kind|kaɪnd|danh từ, tính từ|loại; tử tế
king|kɪŋ|danh từ|vua
kiss|kɪs|động từ, danh từ|hôn; nụ hôn
kitchen|ˈkɪtʃɪn|danh từ|nhà bếp
knee|niː|danh từ|đầu gối
knife|naɪf|danh từ|con dao
knock|nɑːk|động từ|gõ (cửa)
know|noʊ|động từ|biết
knowledge|ˈnɑːlɪdʒ|danh từ|kiến thức
lab|læb|danh từ|phòng thí nghiệm
label|ˈleɪbəl|danh từ, động từ|nhãn; dán nhãn
labor|ˈleɪbər|danh từ|lao động
laboratory|ˈlæbrətɔːri|danh từ|phòng thí nghiệm
lack|læk|danh từ, động từ|sự thiếu; thiếu
lady|ˈleɪdi|danh từ|quý bà
lake|leɪk|danh từ|hồ
land|lænd|danh từ, động từ|đất liền; hạ cánh
landscape|ˈlændskeɪp|danh từ|phong cảnh; khổ ngang
language|ˈlæŋɡwɪdʒ|danh từ|ngôn ngữ
laptop|ˈlæptɑːp|danh từ|máy tính xách tay
large|lɑːrdʒ|tính từ|lớn
largely|ˈlɑːrdʒli|trạng từ|phần lớn
last|læst|tính từ, động từ|cuối cùng; trước; kéo dài
late|leɪt|tính từ, trạng từ|muộn
lately|ˈleɪtli|trạng từ|gần đây
later|ˈleɪtər|trạng từ|sau đó
latest|ˈleɪtɪst|tính từ|mới nhất
laugh|læf|động từ, danh từ|cười; tiếng cười
launch|lɔːntʃ|động từ, danh từ|ra mắt; phóng
law|lɔː|danh từ|luật
lawyer|ˈlɔːjər|danh từ|luật sư
lay|leɪ|động từ|đặt, để; đẻ (trứng)
layer|ˈleɪər|danh từ|lớp, tầng
lazy|ˈleɪzi|tính từ|lười
lead|liːd|động từ, danh từ|dẫn dắt; sự dẫn đầu
leader|ˈliːdər|danh từ|người lãnh đạo
leadership|ˈliːdərʃɪp|danh từ|sự lãnh đạo
leading|ˈliːdɪŋ|tính từ|hàng đầu
leaf|liːf|danh từ|chiếc lá
league|liːɡ|danh từ|liên đoàn, giải đấu
lean|liːn|động từ, tính từ|dựa; gầy
learn|lɜːrn|động từ|học
learning|ˈlɜːrnɪŋ|danh từ|sự học
least|liːst|từ hạn định, trạng từ|ít nhất
leather|ˈleðər|danh từ|da thuộc
leave|liːv|động từ, danh từ|rời đi; để lại; kỳ nghỉ phép
lecture|ˈlektʃər|danh từ|bài giảng
left|left|tính từ, danh từ|bên trái
leg|leɡ|danh từ|chân
legal|ˈliːɡəl|tính từ|hợp pháp
legend|ˈledʒənd|danh từ|truyền thuyết; huyền thoại
leisure|ˈliːʒər|danh từ|thời gian rảnh
lemon|ˈlemən|danh từ|quả chanh
lend|lend|động từ|cho mượn
length|leŋθ|danh từ|chiều dài, độ dài
less|les|từ hạn định, trạng từ|ít hơn
lesson|ˈlesən|danh từ|bài học
let|let|động từ|để, cho phép
letter|ˈletər|danh từ|lá thư; chữ cái
level|ˈlevəl|danh từ|mức, cấp độ
library|ˈlaɪbreri|danh từ|thư viện
licence|ˈlaɪsəns|danh từ|giấy phép
lie|laɪ|động từ, danh từ|nằm; nói dối; lời nói dối
life|laɪf|danh từ|cuộc sống
lifestyle|ˈlaɪfstaɪl|danh từ|lối sống
lift|lɪft|động từ, danh từ|nâng lên; thang máy
light|laɪt|danh từ, tính từ|ánh sáng; đèn; nhẹ
like|laɪk|động từ, giới từ|thích; giống như
likely|ˈlaɪkli|tính từ|có khả năng
limit|ˈlɪmɪt|danh từ, động từ|giới hạn
limited|ˈlɪmɪtɪd|tính từ|có hạn
line|laɪn|danh từ|đường; dòng; hàng
link|lɪŋk|danh từ, động từ|liên kết
lip|lɪp|danh từ|môi
liquid|ˈlɪkwɪd|danh từ, tính từ|chất lỏng; lỏng
list|lɪst|danh từ, động từ|danh sách; liệt kê
listen|ˈlɪsən|động từ|lắng nghe
literature|ˈlɪtərətʃər|danh từ|văn học
little|ˈlɪtəl|tính từ, từ hạn định|nhỏ; ít
live|lɪv|động từ|sống
lively|ˈlaɪvli|tính từ|sôi nổi
living|ˈlɪvɪŋ|danh từ, tính từ|sinh kế; đang sống
load|loʊd|danh từ, động từ|tải; chất lên; nạp
loan|loʊn|danh từ|khoản vay
local|ˈloʊkəl|tính từ|địa phương; cục bộ
locate|ˈloʊkeɪt|động từ|định vị, đặt ở
location|loʊˈkeɪʃən|danh từ|vị trí
lock|lɑːk|động từ, danh từ|khóa; ổ khóa
logic|ˈlɑːdʒɪk|danh từ|lô-gíc
logical|ˈlɑːdʒɪkəl|tính từ|hợp lý, lô-gíc
lonely|ˈloʊnli|tính từ|cô đơn
long|lɔːŋ|tính từ, trạng từ|dài; lâu
look|lʊk|động từ, danh từ|nhìn; trông có vẻ; cái nhìn
loose|luːs|tính từ|lỏng
lose|luːz|động từ|mất; thua
loss|lɔːs|danh từ|sự mất mát; thua lỗ
lost|lɔːst|tính từ|bị lạc, bị mất
lot|lɑːt|danh từ|nhiều (a lot of)
loud|laʊd|tính từ|to, ồn ào
love|lʌv|danh từ, động từ|tình yêu; yêu
lovely|ˈlʌvli|tính từ|đáng yêu
low|loʊ|tính từ|thấp
lower|ˈloʊər|động từ, tính từ|hạ thấp; thấp hơn
luck|lʌk|danh từ|vận may
lucky|ˈlʌki|tính từ|may mắn
lunch|lʌntʃ|danh từ|bữa trưa
luxury|ˈlʌkʃəri|danh từ|sự xa xỉ
machine|məˈʃiːn|danh từ|máy móc
mad|mæd|tính từ|điên; tức giận
magazine|ˌmæɡəˈziːn|danh từ|tạp chí
magic|ˈmædʒɪk|danh từ, tính từ|phép thuật; kỳ diệu
mail|meɪl|danh từ, động từ|thư; gửi thư
main|meɪn|tính từ|chính
mainly|ˈmeɪnli|trạng từ|chủ yếu
maintain|meɪnˈteɪn|động từ|duy trì; bảo trì
maintenance|ˈmeɪntənəns|danh từ|sự bảo trì
major|ˈmeɪdʒər|tính từ, danh từ|lớn, chủ yếu; chuyên ngành
majority|məˈdʒɔːrəti|danh từ|đa số
make|meɪk|động từ|làm, chế tạo
male|meɪl|tính từ, danh từ|nam, giống đực
mall|mɔːl|danh từ|trung tâm thương mại
man|mæn|danh từ|người đàn ông
manage|ˈmænɪdʒ|động từ|quản lý; xoay xở
management|ˈmænɪdʒmənt|danh từ|sự quản lý; ban quản lý
manager|ˈmænɪdʒər|danh từ|người quản lý
manner|ˈmænər|danh từ|cách thức; cách cư xử
manual|ˈmænjuəl|tính từ, danh từ|bằng tay; sách hướng dẫn
manufacture|ˌmænjəˈfæktʃər|động từ|sản xuất
manufacturer|ˌmænjəˈfæktʃərər|danh từ|nhà sản xuất
many|ˈmeni|từ hạn định|nhiều
map|mæp|danh từ|bản đồ
mark|mɑːrk|danh từ, động từ|dấu; điểm số; đánh dấu
market|ˈmɑːrkɪt|danh từ|chợ; thị trường
marketing|ˈmɑːrkɪtɪŋ|danh từ|tiếp thị
marriage|ˈmærɪdʒ|danh từ|hôn nhân
married|ˈmærid|tính từ|đã kết hôn
marry|ˈmæri|động từ|kết hôn
mass|mæs|danh từ, tính từ|khối lượng; đại chúng
massive|ˈmæsɪv|tính từ|to lớn
master|ˈmæstər|danh từ, động từ|bậc thầy; thạc sĩ; thành thạo
match|mætʃ|danh từ, động từ|trận đấu; que diêm; khớp
mate|meɪt|danh từ|bạn
material|məˈtɪriəl|danh từ|vật liệu; tài liệu
math|mæθ|danh từ|toán học
mathematics|ˌmæθəˈmætɪks|danh từ|toán học
matter|ˈmætər|danh từ, động từ|vấn đề; vật chất; quan trọng
maximum|ˈmæksɪməm|danh từ, tính từ|tối đa
may|meɪ|động từ khuyết thiếu|có thể, có lẽ
maybe|ˈmeɪbi|trạng từ|có lẽ
mayor|ˈmeɪər|danh từ|thị trưởng
me|miː|đại từ|tôi (tân ngữ)
meal|miːl|danh từ|bữa ăn
mean|miːn|động từ, tính từ|có nghĩa là; keo kiệt
meaning|ˈmiːnɪŋ|danh từ|ý nghĩa
means|miːnz|danh từ|phương tiện, cách thức
meanwhile|ˈmiːnwaɪl|trạng từ|trong khi đó
measure|ˈmeʒər|động từ, danh từ|đo; biện pháp
measurement|ˈmeʒərmənt|danh từ|sự đo lường
meat|miːt|danh từ|thịt
mechanism|ˈmekənɪzəm|danh từ|cơ chế
media|ˈmiːdiə|danh từ|phương tiện truyền thông
medical|ˈmedɪkəl|tính từ|thuộc y tế
medicine|ˈmedɪsən|danh từ|thuốc; y học
medium|ˈmiːdiəm|tính từ, danh từ|trung bình; phương tiện
meet|miːt|động từ|gặp
meeting|ˈmiːtɪŋ|danh từ|cuộc họp
member|ˈmembər|danh từ|thành viên
membership|ˈmembərʃɪp|danh từ|tư cách thành viên
memory|ˈmeməri|danh từ|trí nhớ; kỷ niệm; bộ nhớ
mental|ˈmentəl|tính từ|thuộc tinh thần
mention|ˈmenʃən|động từ, danh từ|đề cập
menu|ˈmenjuː|danh từ|thực đơn
mess|mes|danh từ|sự bừa bộn
message|ˈmesɪdʒ|danh từ|tin nhắn, thông điệp
metal|ˈmetəl|danh từ|kim loại
method|ˈmeθəd|danh từ|phương pháp
meter|ˈmiːtər|danh từ|mét; đồng hồ đo
middle|ˈmɪdəl|danh từ, tính từ|giữa
midnight|ˈmɪdnaɪt|danh từ|nửa đêm
might|maɪt|động từ khuyết thiếu|có thể (khả năng thấp)
mild|maɪld|tính từ|nhẹ, ôn hòa
mile|maɪl|danh từ|dặm
military|ˈmɪləteri|tính từ, danh từ|thuộc quân sự; quân đội
milk|mɪlk|danh từ|sữa
million|ˈmɪljən|số từ|một triệu
mind|maɪnd|danh từ, động từ|tâm trí; phiền
mine|maɪn|đại từ, danh từ|của tôi; mỏ
minimum|ˈmɪnɪməm|danh từ, tính từ|tối thiểu
minister|ˈmɪnɪstər|danh từ|bộ trưởng
minor|ˈmaɪnər|tính từ|nhỏ, thứ yếu
minority|maɪˈnɔːrəti|danh từ|thiểu số
minute|ˈmɪnɪt|danh từ|phút
mirror|ˈmɪrər|danh từ|cái gương
miss|mɪs|động từ|nhớ; bỏ lỡ; trượt
missing|ˈmɪsɪŋ|tính từ|bị thiếu, mất tích
mission|ˈmɪʃən|danh từ|nhiệm vụ, sứ mệnh
mistake|mɪˈsteɪk|danh từ|lỗi, sai lầm
mix|mɪks|động từ|trộn
mixture|ˈmɪkstʃər|danh từ|hỗn hợp
mobile|ˈmoʊbəl|tính từ|di động
mode|moʊd|danh từ|chế độ
model|ˈmɑːdəl|danh từ|mô hình; người mẫu; mẫu
modern|ˈmɑːdərn|tính từ|hiện đại
modify|ˈmɑːdɪfaɪ|động từ|sửa đổi
module|ˈmɑːdʒuːl|danh từ|mô-đun
mom|mɑːm|danh từ|mẹ
moment|ˈmoʊmənt|danh từ|khoảnh khắc
money|ˈmʌni|danh từ|tiền
monitor|ˈmɑːnɪtər|danh từ, động từ|màn hình; giám sát
month|mʌnθ|danh từ|tháng
mood|muːd|danh từ|tâm trạng
moon|muːn|danh từ|mặt trăng
moral|ˈmɔːrəl|tính từ|thuộc đạo đức
more|mɔːr|từ hạn định, trạng từ|nhiều hơn
moreover|mɔːrˈoʊvər|trạng từ|hơn nữa
morning|ˈmɔːrnɪŋ|danh từ|buổi sáng
mostly|ˈmoʊstli|trạng từ|chủ yếu
most|moʊst|từ hạn định, trạng từ|nhiều nhất; hầu hết
mother|ˈmʌðər|danh từ|mẹ
motion|ˈmoʊʃən|danh từ|chuyển động
motivation|ˌmoʊtɪˈveɪʃən|danh từ|động lực
motor|ˈmoʊtər|danh từ|động cơ
motorcycle|ˈmoʊtərsaɪkəl|danh từ|xe máy
mountain|ˈmaʊntən|danh từ|núi
mouse|maʊs|danh từ|con chuột
mouth|maʊθ|danh từ|miệng
move|muːv|động từ, danh từ|di chuyển; chuyển nhà; nước đi
movement|ˈmuːvmənt|danh từ|sự chuyển động; phong trào
movie|ˈmuːvi|danh từ|bộ phim
much|mʌtʃ|từ hạn định, trạng từ|nhiều
mud|mʌd|danh từ|bùn
multiple|ˈmʌltɪpəl|tính từ|nhiều
murder|ˈmɜːrdər|danh từ, động từ|vụ giết người; giết
muscle|ˈmʌsəl|danh từ|cơ bắp
museum|mjuˈziːəm|danh từ|bảo tàng
music|ˈmjuːzɪk|danh từ|âm nhạc
musical|ˈmjuːzɪkəl|tính từ|thuộc âm nhạc
musician|mjuˈzɪʃən|danh từ|nhạc sĩ
must|mʌst|động từ khuyết thiếu|phải
my|maɪ|từ hạn định|của tôi
myself|maɪˈself|đại từ|chính tôi
mystery|ˈmɪstəri|danh từ|điều bí ẩn
nail|neɪl|danh từ|móng tay; cái đinh
name|neɪm|danh từ, động từ|tên; đặt tên
narrow|ˈnæroʊ|tính từ|hẹp
nation|ˈneɪʃən|danh từ|quốc gia
national|ˈnæʃənəl|tính từ|thuộc quốc gia
native|ˈneɪtɪv|tính từ, danh từ|bản xứ; người bản xứ
natural|ˈnætʃərəl|tính từ|tự nhiên
naturally|ˈnætʃərəli|trạng từ|một cách tự nhiên
nature|ˈneɪtʃər|danh từ|thiên nhiên; bản chất
near|nɪr|giới từ, tính từ|gần
nearby|ˌnɪrˈbaɪ|tính từ, trạng từ|gần đó
nearly|ˈnɪrli|trạng từ|gần như
neat|niːt|tính từ|gọn gàng
necessary|ˈnesəseri|tính từ|cần thiết
neck|nek|danh từ|cổ
need|niːd|động từ, danh từ|cần; nhu cầu
negative|ˈneɡətɪv|tính từ|tiêu cực; âm
neighbor|ˈneɪbər|danh từ|hàng xóm
neighborhood|ˈneɪbərhʊd|danh từ|khu phố
neither|ˈniːðər|từ hạn định, trạng từ|không cái nào; cũng không
nephew|ˈnefjuː|danh từ|cháu trai
nerve|nɜːrv|danh từ|dây thần kinh
nervous|ˈnɜːrvəs|tính từ|lo lắng, hồi hộp
network|ˈnetwɜːrk|danh từ|mạng lưới; mạng máy tính
never|ˈnevər|trạng từ|không bao giờ
nevertheless|ˌnevərðəˈles|trạng từ|tuy nhiên
new|nuː|tính từ|mới
news|nuːz|danh từ|tin tức
newspaper|ˈnuːzpeɪpər|danh từ|tờ báo
next|nekst|tính từ, trạng từ|tiếp theo
nice|naɪs|tính từ|đẹp, tốt, dễ chịu
night|naɪt|danh từ|ban đêm
nine|naɪn|số từ|chín
no|noʊ|từ hạn định, thán từ|không
nobody|ˈnoʊbɑːdi|đại từ|không ai
noise|nɔɪz|danh từ|tiếng ồn; nhiễu
noisy|ˈnɔɪzi|tính từ|ồn ào
none|nʌn|đại từ|không ai, không cái nào
nor|nɔːr|liên từ|cũng không
normal|ˈnɔːrməl|tính từ|bình thường
normally|ˈnɔːrməli|trạng từ|thông thường
north|nɔːrθ|danh từ|phía bắc
northern|ˈnɔːrðərn|tính từ|thuộc phía bắc
nose|noʊz|danh từ|mũi
not|nɑːt|trạng từ|không
note|noʊt|danh từ, động từ|ghi chú; nốt nhạc; ghi lại
nothing|ˈnʌθɪŋ|đại từ|không có gì
notice|ˈnoʊtɪs|động từ, danh từ|chú ý; thông báo
novel|ˈnɑːvəl|danh từ|tiểu thuyết
now|naʊ|trạng từ|bây giờ
nowhere|ˈnoʊwer|trạng từ|không nơi nào
nuclear|ˈnuːkliər|tính từ|hạt nhân
number|ˈnʌmbər|danh từ|số
numerous|ˈnuːmərəs|tính từ|nhiều
nurse|nɜːrs|danh từ|y tá
nut|nʌt|danh từ|quả hạch; đai ốc
object|ˈɑːbdʒɪkt|danh từ|đồ vật; đối tượng; tân ngữ
objective|əbˈdʒektɪv|danh từ, tính từ|mục tiêu; khách quan
obligation|ˌɑːblɪˈɡeɪʃən|danh từ|nghĩa vụ
observe|əbˈzɜːrv|động từ|quan sát
obtain|əbˈteɪn|động từ|đạt được, thu được
obvious|ˈɑːbviəs|tính từ|hiển nhiên
obviously|ˈɑːbviəsli|trạng từ|rõ ràng là
occasion|əˈkeɪʒən|danh từ|dịp
occasionally|əˈkeɪʒənəli|trạng từ|thỉnh thoảng
occupy|ˈɑːkjəpaɪ|động từ|chiếm giữ
occur|əˈkɜːr|động từ|xảy ra
ocean|ˈoʊʃən|danh từ|đại dương
of|ʌv|giới từ|của
off|ɔːf|trạng từ, giới từ|tắt; rời khỏi
offense|əˈfens|danh từ|sự xúc phạm; hành vi phạm tội
offer|ˈɔːfər|động từ, danh từ|đề nghị; lời đề nghị
office|ˈɔːfɪs|danh từ|văn phòng
officer|ˈɔːfɪsər|danh từ|sĩ quan, viên chức
official|əˈfɪʃəl|tính từ, danh từ|chính thức; quan chức
often|ˈɔːfən|trạng từ|thường
oil|ɔɪl|danh từ|dầu
okay|ˌoʊˈkeɪ|tính từ, thán từ|ổn, được
old|oʊld|tính từ|già; cũ
on|ɑːn|giới từ, trạng từ|trên; bật
once|wʌns|trạng từ, liên từ|một lần; một khi
one|wʌn|số từ, đại từ|một
online|ˌɑːnˈlaɪn|tính từ, trạng từ|trực tuyến
only|ˈoʊnli|trạng từ, tính từ|chỉ; duy nhất
onto|ˈɑːntuː|giới từ|lên trên
open|ˈoʊpən|động từ, tính từ|mở; mở cửa
opening|ˈoʊpənɪŋ|danh từ|sự khai mạc; lỗ hổng
operate|ˈɑːpəreɪt|động từ|vận hành; phẫu thuật
operation|ˌɑːpəˈreɪʃən|danh từ|sự vận hành; ca phẫu thuật; phép toán
operator|ˈɑːpəreɪtər|danh từ|người vận hành; toán tử
opinion|əˈpɪnjən|danh từ|ý kiến
opponent|əˈpoʊnənt|danh từ|đối thủ
opportunity|ˌɑːpərˈtuːnəti|danh từ|cơ hội
oppose|əˈpoʊz|động từ|phản đối
opposite|ˈɑːpəzɪt|tính từ, giới từ|đối diện; ngược lại
option|ˈɑːpʃən|danh từ|lựa chọn; tùy chọn
or|ɔːr|liên từ|hoặc
orange|ˈɔːrɪndʒ|danh từ, tính từ|quả cam; màu cam
order|ˈɔːrdər|danh từ, động từ|thứ tự; đơn hàng; ra lệnh; đặt hàng
ordinary|ˈɔːrdəneri|tính từ|bình thường
organization|ˌɔːrɡənəˈzeɪʃən|danh từ|tổ chức
organize|ˈɔːrɡənaɪz|động từ|tổ chức, sắp xếp
origin|ˈɔːrɪdʒɪn|danh từ|nguồn gốc
original|əˈrɪdʒənəl|tính từ|nguyên bản; độc đáo
other|ˈʌðər|tính từ, đại từ|khác
otherwise|ˈʌðərwaɪz|trạng từ|nếu không thì
ought to|ˈɔːt tuː|động từ khuyết thiếu|nên
our|aʊər|từ hạn định|của chúng tôi
ours|aʊərz|đại từ|của chúng tôi
ourselves|aʊərˈselvz|đại từ|chính chúng tôi
out|aʊt|trạng từ|ra ngoài
outcome|ˈaʊtkʌm|danh từ|kết quả
outdoor|ˈaʊtdɔːr|tính từ|ngoài trời
output|ˈaʊtpʊt|danh từ|đầu ra; sản lượng
outside|ˌaʊtˈsaɪd|giới từ, trạng từ|bên ngoài
outstanding|aʊtˈstændɪŋ|tính từ|nổi bật
oven|ˈʌvən|danh từ|lò nướng
over|ˈoʊvər|giới từ, trạng từ|trên; hơn; qua; kết thúc
overall|ˌoʊvərˈɔːl|tính từ, trạng từ|tổng thể
overcome|ˌoʊvərˈkʌm|động từ|vượt qua
overseas|ˌoʊvərˈsiːz|tính từ, trạng từ|ở nước ngoài
owe|oʊ|động từ|nợ
own|oʊn|tính từ, động từ|riêng; sở hữu
owner|ˈoʊnər|danh từ|chủ sở hữu
oxygen|ˈɑːksɪdʒən|danh từ|ô-xi
pace|peɪs|danh từ|nhịp độ
pack|pæk|động từ, danh từ|đóng gói; gói
package|ˈpækɪdʒ|danh từ|gói hàng; gói phần mềm
page|peɪdʒ|danh từ|trang
pain|peɪn|danh từ|cơn đau
painful|ˈpeɪnfəl|tính từ|đau đớn
paint|peɪnt|danh từ, động từ|sơn; vẽ
painting|ˈpeɪntɪŋ|danh từ|bức tranh
pair|per|danh từ|đôi, cặp
palace|ˈpæləs|danh từ|cung điện
pale|peɪl|tính từ|nhợt nhạt
panel|ˈpænəl|danh từ|bảng điều khiển; ban
panic|ˈpænɪk|danh từ, động từ|sự hoảng loạn; hoảng sợ
paper|ˈpeɪpər|danh từ|giấy; bài báo khoa học
paragraph|ˈpærəɡræf|danh từ|đoạn văn
parameter|pəˈræmɪtər|danh từ|tham số
parent|ˈperənt|danh từ|cha mẹ
park|pɑːrk|danh từ, động từ|công viên; đỗ xe
parking|ˈpɑːrkɪŋ|danh từ|bãi đỗ xe; việc đỗ xe
part|pɑːrt|danh từ|phần; bộ phận
participant|pɑːrˈtɪsɪpənt|danh từ|người tham gia
participate|pɑːrˈtɪsɪpeɪt|động từ|tham gia
particular|pərˈtɪkjələr|tính từ|cụ thể, đặc biệt
particularly|pərˈtɪkjələrli|trạng từ|đặc biệt là
partly|ˈpɑːrtli|trạng từ|một phần
partner|ˈpɑːrtnər|danh từ|đối tác; bạn đời
party|ˈpɑːrti|danh từ|bữa tiệc; đảng
pass|pæs|động từ|đi qua; vượt qua (kỳ thi); chuyền
passage|ˈpæsɪdʒ|danh từ|đoạn văn; lối đi
passenger|ˈpæsɪndʒər|danh từ|hành khách
passion|ˈpæʃən|danh từ|niềm đam mê
passport|ˈpæspɔːrt|danh từ|hộ chiếu
password|ˈpæswɜːrd|danh từ|mật khẩu
past|pæst|danh từ, tính từ, giới từ|quá khứ; đã qua; qua
path|pæθ|danh từ|con đường; đường dẫn
patient|ˈpeɪʃənt|danh từ, tính từ|bệnh nhân; kiên nhẫn
pattern|ˈpætərn|danh từ|mẫu, khuôn mẫu
pause|pɔːz|động từ, danh từ|tạm dừng
pay|peɪ|động từ, danh từ|trả tiền; tiền lương
payment|ˈpeɪmənt|danh từ|sự thanh toán
peace|piːs|danh từ|hòa bình
peaceful|ˈpiːsfəl|tính từ|yên bình
peak|piːk|danh từ|đỉnh
pen|pen|danh từ|bút mực
pencil|ˈpensəl|danh từ|bút chì
people|ˈpiːpəl|danh từ|người, mọi người
pepper|ˈpepər|danh từ|hạt tiêu; ớt chuông
per|pɜːr|giới từ|mỗi
percent|pərˈsent|danh từ|phần trăm
percentage|pərˈsentɪdʒ|danh từ|tỷ lệ phần trăm
perfect|ˈpɜːrfɪkt|tính từ|hoàn hảo
perfectly|ˈpɜːrfɪktli|trạng từ|hoàn hảo
perform|pərˈfɔːrm|động từ|biểu diễn; thực hiện
performance|pərˈfɔːrməns|danh từ|màn trình diễn; hiệu suất
perhaps|pərˈhæps|trạng từ|có lẽ
period|ˈpɪriəd|danh từ|khoảng thời gian; chu kỳ; dấu chấm
permanent|ˈpɜːrmənənt|tính từ|vĩnh viễn
permission|pərˈmɪʃən|danh từ|sự cho phép
permit|pərˈmɪt|động từ, danh từ|cho phép; giấy phép
person|ˈpɜːrsən|danh từ|người
personal|ˈpɜːrsənəl|tính từ|cá nhân
personality|ˌpɜːrsəˈnæləti|danh từ|tính cách
personally|ˈpɜːrsənəli|trạng từ|cá nhân mà nói
perspective|pərˈspektɪv|danh từ|góc nhìn
persuade|pərˈsweɪd|động từ|thuyết phục
pet|pet|danh từ|thú cưng
phase|feɪz|danh từ|giai đoạn; pha
phenomenon|fəˈnɑːmɪnɑːn|danh từ|hiện tượng
philosophy|fəˈlɑːsəfi|danh từ|triết học
phone|foʊn|danh từ, động từ|điện thoại; gọi điện
photo|ˈfoʊtoʊ|danh từ|bức ảnh
photograph|ˈfoʊtəɡræf|danh từ|bức ảnh
photographer|fəˈtɑːɡrəfər|danh từ|nhiếp ảnh gia
phrase|freɪz|danh từ|cụm từ
physical|ˈfɪzɪkəl|tính từ|thuộc thể chất; vật lý
physics|ˈfɪzɪks|danh từ|vật lý học
piano|piˈænoʊ|danh từ|đàn piano
pick|pɪk|động từ|chọn; hái; nhặt
picture|ˈpɪktʃər|danh từ|bức tranh, hình ảnh
piece|piːs|danh từ|mảnh, miếng
pig|pɪɡ|danh từ|con lợn
pile|paɪl|danh từ|đống
pill|pɪl|danh từ|viên thuốc
pilot|ˈpaɪlət|danh từ|phi công
pin|pɪn|danh từ|ghim; chân (linh kiện)
pink|pɪŋk|tính từ|màu hồng
pipe|paɪp|danh từ|đường ống
pitch|pɪtʃ|danh từ|sân bóng; cao độ
place|pleɪs|danh từ, động từ|nơi chốn; đặt
plan|plæn|danh từ, động từ|kế hoạch; lên kế hoạch
plane|pleɪn|danh từ|máy bay; mặt phẳng
planet|ˈplænɪt|danh từ|hành tinh
plant|plænt|danh từ, động từ|cây; nhà máy; trồng
plastic|ˈplæstɪk|danh từ, tính từ|nhựa
plate|pleɪt|danh từ|cái đĩa; tấm
platform|ˈplætfɔːrm|danh từ|nền tảng; sân ga
play|pleɪ|động từ, danh từ|chơi; vở kịch
player|ˈpleɪər|danh từ|người chơi; máy phát
pleasant|ˈplezənt|tính từ|dễ chịu
please|pliːz|thán từ, động từ|làm ơn; làm hài lòng
pleased|pliːzd|tính từ|hài lòng
pleasure|ˈpleʒər|danh từ|niềm vui
plenty|ˈplenti|đại từ|nhiều, dư dả
plot|plɑːt|danh từ|cốt truyện; đồ thị; âm mưu
plus|plʌs|giới từ|cộng với
pocket|ˈpɑːkɪt|danh từ|túi quần áo
poem|ˈpoʊəm|danh từ|bài thơ
poet|ˈpoʊɪt|danh từ|nhà thơ
poetry|ˈpoʊətri|danh từ|thơ ca
point|pɔɪnt|danh từ, động từ|điểm; ý; chỉ
pointer|ˈpɔɪntər|danh từ|con trỏ
poison|ˈpɔɪzən|danh từ|chất độc
police|pəˈliːs|danh từ|cảnh sát
policy|ˈpɑːləsi|danh từ|chính sách
polite|pəˈlaɪt|tính từ|lịch sự
political|pəˈlɪtɪkəl|tính từ|thuộc chính trị
politician|ˌpɑːləˈtɪʃən|danh từ|chính trị gia
politics|ˈpɑːlətɪks|danh từ|chính trị
poll|poʊl|danh từ, động từ|cuộc thăm dò; hỏi vòng (polling)
pollution|pəˈluːʃən|danh từ|sự ô nhiễm
pool|puːl|danh từ|hồ bơi
poor|pʊr|tính từ|nghèo; kém
pop|pɑːp|danh từ, động từ|nhạc pop; bật ra; lấy ra (stack)
popular|ˈpɑːpjələr|tính từ|phổ biến, được ưa chuộng
population|ˌpɑːpjəˈleɪʃən|danh từ|dân số
port|pɔːrt|danh từ|cảng; cổng (kết nối)
portion|ˈpɔːrʃən|danh từ|phần
portrait|ˈpɔːrtrət|danh từ|chân dung; khổ dọc
pose|poʊz|động từ, danh từ|gây ra; tạo dáng
position|pəˈzɪʃən|danh từ|vị trí
positive|ˈpɑːzətɪv|tính từ|tích cực; dương
possess|pəˈzes|động từ|sở hữu
possession|pəˈzeʃən|danh từ|sự sở hữu; tài sản
possibility|ˌpɑːsəˈbɪləti|danh từ|khả năng
possible|ˈpɑːsəbəl|tính từ|có thể
possibly|ˈpɑːsəbli|trạng từ|có thể
post|poʊst|danh từ, động từ|bài đăng; bưu điện; đăng
poster|ˈpoʊstər|danh từ|áp phích
pot|pɑːt|danh từ|cái nồi; chậu
potato|pəˈteɪtoʊ|danh từ|khoai tây
potential|pəˈtenʃəl|tính từ, danh từ|tiềm năng; điện thế
pound|paʊnd|danh từ|bảng Anh; pao
pour|pɔːr|động từ|rót, đổ
poverty|ˈpɑːvərti|danh từ|sự nghèo đói
powder|ˈpaʊdər|danh từ|bột
power|ˈpaʊər|danh từ|quyền lực; năng lượng; công suất; nguồn điện
powerful|ˈpaʊərfəl|tính từ|mạnh mẽ
practical|ˈpræktɪkəl|tính từ|thực tế, thiết thực
practice|ˈpræktɪs|danh từ, động từ|sự thực hành; luyện tập
praise|preɪz|động từ, danh từ|khen ngợi
pray|preɪ|động từ|cầu nguyện
precise|prɪˈsaɪs|tính từ|chính xác
predict|prɪˈdɪkt|động từ|dự đoán
prediction|prɪˈdɪkʃən|danh từ|sự dự đoán
prefer|prɪˈfɜːr|động từ|thích hơn
preference|ˈprefərəns|danh từ|sự ưu tiên; tùy chọn
pregnant|ˈpreɡnənt|tính từ|có thai
premium|ˈpriːmiəm|danh từ, tính từ|phí bảo hiểm; cao cấp
preparation|ˌprepəˈreɪʃən|danh từ|sự chuẩn bị
prepare|prɪˈper|động từ|chuẩn bị
prescription|prɪˈskrɪpʃən|danh từ|đơn thuốc
presence|ˈprezəns|danh từ|sự có mặt
present|ˈprezənt, prɪˈzent|danh từ, tính từ, động từ|hiện tại; món quà; có mặt; trình bày
presentation|ˌpriːzenˈteɪʃən|danh từ|bài thuyết trình
preserve|prɪˈzɜːrv|động từ|bảo tồn
president|ˈprezɪdənt|danh từ|tổng thống; chủ tịch
press|pres|động từ, danh từ|nhấn; báo chí
pressure|ˈpreʃər|danh từ|áp lực; áp suất
pretend|prɪˈtend|động từ|giả vờ
pretty|ˈprɪti|tính từ, trạng từ|xinh; khá
prevent|prɪˈvent|động từ|ngăn chặn
previous|ˈpriːviəs|tính từ|trước đó
previously|ˈpriːviəsli|trạng từ|trước đây
price|praɪs|danh từ|giá
pride|praɪd|danh từ|niềm tự hào
priest|priːst|danh từ|linh mục
primary|ˈpraɪmeri|tính từ|chính; sơ cấp
prime|praɪm|tính từ|chính; nguyên tố (số)
prince|prɪns|danh từ|hoàng tử
princess|ˈprɪnses|danh từ|công chúa
principal|ˈprɪnsəpəl|tính từ, danh từ|chính; hiệu trưởng
principle|ˈprɪnsəpəl|danh từ|nguyên tắc, nguyên lý
print|prɪnt|động từ|in
printer|ˈprɪntər|danh từ|máy in
priority|praɪˈɔːrəti|danh từ|sự ưu tiên
prison|ˈprɪzən|danh từ|nhà tù
prisoner|ˈprɪzənər|danh từ|tù nhân
privacy|ˈpraɪvəsi|danh từ|sự riêng tư
private|ˈpraɪvət|tính từ|riêng tư; tư nhân
prize|praɪz|danh từ|giải thưởng
probably|ˈprɑːbəbli|trạng từ|có lẽ
problem|ˈprɑːbləm|danh từ|vấn đề
procedure|prəˈsiːdʒər|danh từ|thủ tục; thủ tục (hàm)
proceed|prəˈsiːd|động từ|tiến hành
process|ˈprɑːses|danh từ, động từ|quá trình; tiến trình; xử lý
produce|prəˈduːs|động từ|sản xuất
producer|prəˈduːsər|danh từ|nhà sản xuất
product|ˈprɑːdʌkt|danh từ|sản phẩm; tích (phép nhân)
production|prəˈdʌkʃən|danh từ|sự sản xuất
profession|prəˈfeʃən|danh từ|nghề nghiệp
professional|prəˈfeʃənəl|tính từ, danh từ|chuyên nghiệp; người chuyên nghiệp
professor|prəˈfesər|danh từ|giáo sư
profile|ˈproʊfaɪl|danh từ|hồ sơ
profit|ˈprɑːfɪt|danh từ|lợi nhuận
program|ˈproʊɡræm|danh từ, động từ|chương trình; lập trình
programming|ˈproʊɡræmɪŋ|danh từ|lập trình
progress|ˈprɑːɡres|danh từ|sự tiến bộ
project|ˈprɑːdʒekt|danh từ|dự án
promise|ˈprɑːmɪs|động từ, danh từ|hứa; lời hứa
promote|prəˈmoʊt|động từ|thăng chức; quảng bá
promotion|prəˈmoʊʃən|danh từ|sự thăng chức; khuyến mãi
prompt|prɑːmpt|tính từ, danh từ|nhanh chóng; lời nhắc
proof|pruːf|danh từ|bằng chứng
proper|ˈprɑːpər|tính từ|đúng đắn, thích hợp
properly|ˈprɑːpərli|trạng từ|đúng cách
property|ˈprɑːpərti|danh từ|tài sản; thuộc tính
proportion|prəˈpɔːrʃən|danh từ|tỷ lệ
proposal|prəˈpoʊzəl|danh từ|đề xuất
propose|prəˈpoʊz|động từ|đề xuất; cầu hôn
prospect|ˈprɑːspekt|danh từ|triển vọng
protect|prəˈtekt|động từ|bảo vệ
protection|prəˈtekʃən|danh từ|sự bảo vệ
protein|ˈproʊtiːn|danh từ|chất đạm
protest|ˈproʊtest|danh từ, động từ|cuộc biểu tình; phản đối
proud|praʊd|tính từ|tự hào
prove|pruːv|động từ|chứng minh
provide|prəˈvaɪd|động từ|cung cấp
province|ˈprɑːvɪns|danh từ|tỉnh
psychology|saɪˈkɑːlədʒi|danh từ|tâm lý học
public|ˈpʌblɪk|tính từ, danh từ|công cộng; công chúng
publication|ˌpʌblɪˈkeɪʃən|danh từ|ấn phẩm; sự xuất bản
publish|ˈpʌblɪʃ|động từ|xuất bản
pull|pʊl|động từ|kéo
pump|pʌmp|danh từ, động từ|máy bơm; bơm
punish|ˈpʌnɪʃ|động từ|trừng phạt
pupil|ˈpjuːpəl|danh từ|học sinh
purchase|ˈpɜːrtʃəs|động từ, danh từ|mua; sự mua
pure|pjʊr|tính từ|tinh khiết
purple|ˈpɜːrpəl|tính từ|màu tím
purpose|ˈpɜːrpəs|danh từ|mục đích
push|pʊʃ|động từ|đẩy
put|pʊt|động từ|đặt, để
puzzle|ˈpʌzəl|danh từ|câu đố
qualification|ˌkwɑːlɪfɪˈkeɪʃən|danh từ|bằng cấp; trình độ
qualified|ˈkwɑːlɪfaɪd|tính từ|đủ trình độ
quality|ˈkwɑːləti|danh từ|chất lượng
quantity|ˈkwɑːntəti|danh từ|số lượng
quarter|ˈkwɔːrtər|danh từ|một phần tư; quý
queen|kwiːn|danh từ|nữ hoàng
question|ˈkwestʃən|danh từ, động từ|câu hỏi; chất vấn
queue|kjuː|danh từ|hàng đợi
quick|kwɪk|tính từ|nhanh
quickly|ˈkwɪkli|trạng từ|một cách nhanh chóng
quiet|ˈkwaɪət|tính từ|yên tĩnh
quietly|ˈkwaɪətli|trạng từ|lặng lẽ
quit|kwɪt|động từ|bỏ, thoát
quite|kwaɪt|trạng từ|khá; hoàn toàn
quote|kwoʊt|động từ, danh từ|trích dẫn; báo giá
race|reɪs|danh từ, động từ|cuộc đua; chủng tộc; đua
racing|ˈreɪsɪŋ|danh từ|môn đua
radio|ˈreɪdioʊ|danh từ|đài phát thanh; sóng vô tuyến
rail|reɪl|danh từ|đường ray; thanh vịn
railway|ˈreɪlweɪ|danh từ|đường sắt
rain|reɪn|danh từ, động từ|mưa
raise|reɪz|động từ, danh từ|nâng lên; nuôi; sự tăng lương
random|ˈrændəm|tính từ|ngẫu nhiên
range|reɪndʒ|danh từ|phạm vi, dải
rank|ræŋk|danh từ, động từ|cấp bậc; xếp hạng
rapid|ˈræpɪd|tính từ|nhanh chóng
rapidly|ˈræpɪdli|trạng từ|nhanh chóng
rare|rer|tính từ|hiếm; tái (thịt)
rarely|ˈrerli|trạng từ|hiếm khi
rate|reɪt|danh từ, động từ|tỷ lệ; tốc độ; đánh giá
rather|ˈræðər|trạng từ|khá; thà
ratio|ˈreɪʃioʊ|danh từ|tỷ số
raw|rɔː|tính từ|thô, sống
reach|riːtʃ|động từ|đạt tới, với tới
react|riˈækt|động từ|phản ứng
reaction|riˈækʃən|danh từ|sự phản ứng
read|riːd|động từ|đọc
reader|ˈriːdər|danh từ|người đọc
reading|ˈriːdɪŋ|danh từ|việc đọc; số đo
ready|ˈredi|tính từ|sẵn sàng
real|ˈriːəl|tính từ|thật
realistic|ˌriːəˈlɪstɪk|tính từ|thực tế
reality|riˈæləti|danh từ|thực tế
realize|ˈriːəlaɪz|động từ|nhận ra
really|ˈriːəli|trạng từ|thật sự
reason|ˈriːzən|danh từ|lý do
reasonable|ˈriːzənəbəl|tính từ|hợp lý
recall|rɪˈkɔːl|động từ|nhớ lại; thu hồi
receipt|rɪˈsiːt|danh từ|biên lai
receive|rɪˈsiːv|động từ|nhận
receiver|rɪˈsiːvər|danh từ|bộ thu; người nhận
recent|ˈriːsənt|tính từ|gần đây
recently|ˈriːsəntli|trạng từ|gần đây
reception|rɪˈsepʃən|danh từ|quầy lễ tân; sự tiếp đón
recipe|ˈresəpi|danh từ|công thức nấu ăn
recognize|ˈrekəɡnaɪz|động từ|nhận ra, công nhận
recommend|ˌrekəˈmend|động từ|giới thiệu, khuyên
recommendation|ˌrekəmenˈdeɪʃən|danh từ|lời khuyên, sự giới thiệu
record|ˈrekərd, rɪˈkɔːrd|danh từ, động từ|hồ sơ; kỷ lục; bản ghi; ghi lại, thu âm
recover|rɪˈkʌvər|động từ|hồi phục; khôi phục
recovery|rɪˈkʌvəri|danh từ|sự hồi phục
red|red|tính từ|màu đỏ
reduce|rɪˈduːs|động từ|giảm
reduction|rɪˈdʌkʃən|danh từ|sự giảm
refer|rɪˈfɜːr|động từ|đề cập; tham khảo
reference|ˈrefərəns|danh từ|sự tham khảo; tham chiếu
reflect|rɪˈflekt|động từ|phản chiếu; phản ánh
reflection|rɪˈflekʃən|danh từ|sự phản chiếu; suy ngẫm
reform|rɪˈfɔːrm|danh từ, động từ|cải cách
refrigerator|rɪˈfrɪdʒəreɪtər|danh từ|tủ lạnh
refuse|rɪˈfjuːz|động từ|từ chối
regard|rɪˈɡɑːrd|động từ, danh từ|coi như; sự quan tâm
regarding|rɪˈɡɑːrdɪŋ|giới từ|về việc
region|ˈriːdʒən|danh từ|vùng
regional|ˈriːdʒənəl|tính từ|thuộc vùng
register|ˈredʒɪstər|động từ, danh từ|đăng ký; thanh ghi
regret|rɪˈɡret|động từ, danh từ|hối tiếc
regular|ˈreɡjələr|tính từ|thường xuyên, đều đặn
regularly|ˈreɡjələrli|trạng từ|thường xuyên
regulation|ˌreɡjəˈleɪʃən|danh từ|quy định; sự điều chỉnh
reject|rɪˈdʒekt|động từ|từ chối, bác bỏ
relate|rɪˈleɪt|động từ|liên quan
related|rɪˈleɪtɪd|tính từ|có liên quan
relation|rɪˈleɪʃən|danh từ|mối quan hệ
relationship|rɪˈleɪʃənʃɪp|danh từ|mối quan hệ
relative|ˈrelətɪv|danh từ, tính từ|họ hàng; tương đối
relatively|ˈrelətɪvli|trạng từ|tương đối
relax|rɪˈlæks|động từ|thư giãn
relaxed|rɪˈlækst|tính từ|thoải mái
release|rɪˈliːs|động từ, danh từ|thả; phát hành; bản phát hành
relevant|ˈreləvənt|tính từ|liên quan
reliable|rɪˈlaɪəbəl|tính từ|đáng tin cậy
relief|rɪˈliːf|danh từ|sự nhẹ nhõm; cứu trợ
religion|rɪˈlɪdʒən|danh từ|tôn giáo
religious|rɪˈlɪdʒəs|tính từ|thuộc tôn giáo
rely|rɪˈlaɪ|động từ|dựa vào
remain|rɪˈmeɪn|động từ|vẫn còn, ở lại
remaining|rɪˈmeɪnɪŋ|tính từ|còn lại
remarkable|rɪˈmɑːrkəbəl|tính từ|đáng chú ý
remember|rɪˈmembər|động từ|nhớ
remind|rɪˈmaɪnd|động từ|nhắc nhở
remote|rɪˈmoʊt|tính từ, danh từ|xa; từ xa; điều khiển từ xa
remove|rɪˈmuːv|động từ|loại bỏ, gỡ
rent|rent|danh từ, động từ|tiền thuê; thuê
repair|rɪˈper|động từ, danh từ|sửa chữa
repeat|rɪˈpiːt|động từ|lặp lại
replace|rɪˈpleɪs|động từ|thay thế
reply|rɪˈplaɪ|động từ, danh từ|trả lời; câu trả lời
report|rɪˈpɔːrt|danh từ, động từ|báo cáo
reporter|rɪˈpɔːrtər|danh từ|phóng viên
represent|ˌreprɪˈzent|động từ|đại diện; biểu diễn
representative|ˌreprɪˈzentətɪv|danh từ|người đại diện
reputation|ˌrepjəˈteɪʃən|danh từ|danh tiếng
request|rɪˈkwest|danh từ, động từ|yêu cầu
require|rɪˈkwaɪər|động từ|yêu cầu, đòi hỏi
requirement|rɪˈkwaɪərmənt|danh từ|yêu cầu
rescue|ˈreskjuː|động từ, danh từ|giải cứu
research|ˈriːsɜːrtʃ|danh từ, động từ|nghiên cứu
researcher|ˈriːsɜːrtʃər|danh từ|nhà nghiên cứu
reservation|ˌrezərˈveɪʃən|danh từ|sự đặt chỗ
reserve|rɪˈzɜːrv|động từ|đặt trước; dự trữ
reset|ˌriːˈset|động từ, danh từ|đặt lại, khởi động lại
resident|ˈrezɪdənt|danh từ|cư dân
resist|rɪˈzɪst|động từ|chống lại
resistance|rɪˈzɪstəns|danh từ|sự kháng cự; điện trở
resistor|rɪˈzɪstər|danh từ|điện trở (linh kiện)
resolution|ˌrezəˈluːʃən|danh từ|độ phân giải; nghị quyết
resolve|rɪˈzɑːlv|động từ|giải quyết
resource|ˈriːsɔːrs|danh từ|tài nguyên
respect|rɪˈspekt|danh từ, động từ|sự tôn trọng; tôn trọng
respond|rɪˈspɑːnd|động từ|phản hồi
response|rɪˈspɑːns|danh từ|sự phản hồi
responsibility|rɪˌspɑːnsəˈbɪləti|danh từ|trách nhiệm
responsible|rɪˈspɑːnsəbəl|tính từ|chịu trách nhiệm
rest|rest|danh từ, động từ|sự nghỉ ngơi; phần còn lại; nghỉ
restaurant|ˈrestərɑːnt|danh từ|nhà hàng
restore|rɪˈstɔːr|động từ|khôi phục
restrict|rɪˈstrɪkt|động từ|hạn chế
result|rɪˈzʌlt|danh từ|kết quả
retain|rɪˈteɪn|động từ|giữ lại
retire|rɪˈtaɪər|động từ|nghỉ hưu
retirement|rɪˈtaɪərmənt|danh từ|sự nghỉ hưu
return|rɪˈtɜːrn|động từ, danh từ|trở về; trả lại; giá trị trả về
reveal|rɪˈviːl|động từ|tiết lộ
revenue|ˈrevənuː|danh từ|doanh thu
review|rɪˈvjuː|danh từ, động từ|bài đánh giá; ôn tập; xem xét
revise|rɪˈvaɪz|động từ|ôn lại; sửa đổi
revolution|ˌrevəˈluːʃən|danh từ|cuộc cách mạng; vòng quay
reward|rɪˈwɔːrd|danh từ, động từ|phần thưởng; thưởng
rice|raɪs|danh từ|gạo, cơm
rich|rɪtʃ|tính từ|giàu
rid|rɪd|động từ|loại bỏ (get rid of)
ride|raɪd|động từ, danh từ|cưỡi, đi (xe); chuyến đi
right|raɪt|tính từ, danh từ|đúng; bên phải; quyền
ring|rɪŋ|danh từ, động từ|chiếc nhẫn; reo, gọi điện
rise|raɪz|động từ, danh từ|tăng lên; mọc; sự tăng
risk|rɪsk|danh từ|rủi ro
river|ˈrɪvər|danh từ|con sông
road|roʊd|danh từ|con đường
rob|rɑːb|động từ|cướp
robot|ˈroʊbɑːt|danh từ|người máy
rock|rɑːk|danh từ|hòn đá; nhạc rock
role|roʊl|danh từ|vai trò
roll|roʊl|động từ, danh từ|lăn; cuộn
romantic|roʊˈmæntɪk|tính từ|lãng mạn
roof|ruːf|danh từ|mái nhà
room|ruːm|danh từ|căn phòng; chỗ
root|ruːt|danh từ|gốc, rễ
rope|roʊp|danh từ|dây thừng
rough|rʌf|tính từ|thô ráp; gần đúng
roughly|ˈrʌfli|trạng từ|khoảng chừng
round|raʊnd|tính từ, danh từ|tròn; vòng
route|ruːt|danh từ|tuyến đường
routine|ruːˈtiːn|danh từ|thói quen hằng ngày; thủ tục
row|roʊ|danh từ|hàng
royal|ˈrɔɪəl|tính từ|thuộc hoàng gia
rubbish|ˈrʌbɪʃ|danh từ|rác
rude|ruːd|tính từ|thô lỗ
ruin|ˈruːɪn|động từ, danh từ|phá hỏng; tàn tích
rule|ruːl|danh từ, động từ|quy tắc; cai trị
run|rʌn|động từ, danh từ|chạy; điều hành; lần chạy
runner|ˈrʌnər|danh từ|người chạy
rural|ˈrʊrəl|tính từ|nông thôn
rush|rʌʃ|động từ, danh từ|vội vã; sự vội vàng
sad|sæd|tính từ|buồn
safe|seɪf|tính từ, danh từ|an toàn; két sắt
safety|ˈseɪfti|danh từ|sự an toàn
sail|seɪl|động từ, danh từ|đi thuyền buồm; cánh buồm
salad|ˈsæləd|danh từ|món sa lát
salary|ˈsæləri|danh từ|tiền lương
sale|seɪl|danh từ|sự bán hàng; đợt giảm giá
salt|sɔːlt|danh từ|muối
same|seɪm|tính từ, đại từ|giống nhau, cùng
sample|ˈsæmpəl|danh từ, động từ|mẫu; lấy mẫu
sand|sænd|danh từ|cát
sandwich|ˈsænwɪtʃ|danh từ|bánh mì kẹp
satellite|ˈsætəlaɪt|danh từ|vệ tinh
satisfaction|ˌsætɪsˈfækʃən|danh từ|sự hài lòng
satisfied|ˈsætɪsfaɪd|tính từ|hài lòng
satisfy|ˈsætɪsfaɪ|động từ|làm hài lòng; thỏa mãn
sauce|sɔːs|danh từ|nước sốt
save|seɪv|động từ|cứu; tiết kiệm; lưu
saving|ˈseɪvɪŋ|danh từ|khoản tiết kiệm
say|seɪ|động từ|nói
scale|skeɪl|danh từ|quy mô; tỷ lệ; cái cân
scan|skæn|động từ, danh từ|quét
scared|skerd|tính từ|sợ hãi
scary|ˈskeri|tính từ|đáng sợ
scenario|səˈnærioʊ|danh từ|kịch bản, tình huống
scene|siːn|danh từ|cảnh
schedule|ˈskedʒuːl|danh từ, động từ|lịch trình; lên lịch
scheme|skiːm|danh từ|kế hoạch; mưu đồ
scholarship|ˈskɑːlərʃɪp|danh từ|học bổng
school|skuːl|danh từ|trường học
science|ˈsaɪəns|danh từ|khoa học
scientific|ˌsaɪənˈtɪfɪk|tính từ|thuộc khoa học
scientist|ˈsaɪəntɪst|danh từ|nhà khoa học
scope|skoʊp|danh từ|phạm vi
score|skɔːr|danh từ, động từ|điểm số; ghi điểm
screen|skriːn|danh từ|màn hình
script|skrɪpt|danh từ|kịch bản; tập lệnh
sea|siː|danh từ|biển
search|sɜːrtʃ|động từ, danh từ|tìm kiếm
season|ˈsiːzən|danh từ|mùa
seat|siːt|danh từ|chỗ ngồi
second|ˈsekənd|số từ, danh từ|thứ hai; giây
secondary|ˈsekənderi|tính từ|thứ yếu; trung học
secret|ˈsiːkrət|danh từ, tính từ|bí mật
secretary|ˈsekrəteri|danh từ|thư ký; bộ trưởng
section|ˈsekʃən|danh từ|phần, mục
sector|ˈsektər|danh từ|khu vực, lĩnh vực
secure|səˈkjʊr|tính từ, động từ|an toàn; bảo đảm
security|səˈkjʊrəti|danh từ|sự an ninh, bảo mật
see|siː|động từ|nhìn thấy; hiểu
seed|siːd|danh từ|hạt giống
seek|siːk|động từ|tìm kiếm
seem|siːm|động từ|có vẻ
select|səˈlekt|động từ|chọn
selection|səˈlekʃən|danh từ|sự lựa chọn
self|self|danh từ|bản thân
sell|sel|động từ|bán
send|send|động từ|gửi
senior|ˈsiːniər|tính từ|cấp cao; lớn tuổi hơn
sense|sens|danh từ, động từ|giác quan; ý nghĩa; cảm nhận
sensitive|ˈsensətɪv|tính từ|nhạy cảm
sensor|ˈsensər|danh từ|cảm biến
sentence|ˈsentəns|danh từ|câu; bản án
separate|ˈsepərət|tính từ, động từ|riêng biệt; tách ra
series|ˈsɪriːz|danh từ|loạt, chuỗi
serious|ˈsɪriəs|tính từ|nghiêm trọng; nghiêm túc
seriously|ˈsɪriəsli|trạng từ|nghiêm túc
servant|ˈsɜːrvənt|danh từ|người hầu
serve|sɜːrv|động từ|phục vụ
server|ˈsɜːrvər|danh từ|máy chủ; người phục vụ
service|ˈsɜːrvɪs|danh từ|dịch vụ
session|ˈseʃən|danh từ|phiên, buổi
set|set|động từ, danh từ|đặt; thiết lập; bộ, tập hợp
setting|ˈsetɪŋ|danh từ|cài đặt; bối cảnh
settle|ˈsetəl|động từ|định cư; giải quyết
seven|ˈsevən|số từ|bảy
several|ˈsevrəl|từ hạn định|một vài
severe|səˈvɪr|tính từ|nghiêm trọng
sex|seks|danh từ|giới tính
shade|ʃeɪd|danh từ|bóng râm; sắc thái
shadow|ˈʃædoʊ|danh từ|cái bóng
shake|ʃeɪk|động từ|lắc, rung
shall|ʃæl|động từ khuyết thiếu|sẽ
shallow|ˈʃæloʊ|tính từ|nông
shame|ʃeɪm|danh từ|sự xấu hổ; điều đáng tiếc
shape|ʃeɪp|danh từ|hình dạng
share|ʃer|động từ, danh từ|chia sẻ; cổ phần
sharp|ʃɑːrp|tính từ|sắc, nhọn; đúng (giờ)
she|ʃiː|đại từ|cô ấy
sheet|ʃiːt|danh từ|tờ; tấm; ga trải giường
shelf|ʃelf|danh từ|cái kệ
shell|ʃel|danh từ|vỏ; trình shell
shelter|ˈʃeltər|danh từ|nơi trú ẩn
shift|ʃɪft|danh từ, động từ|ca làm việc; dịch chuyển
shine|ʃaɪn|động từ|chiếu sáng
ship|ʃɪp|danh từ, động từ|con tàu; giao hàng
shirt|ʃɜːrt|danh từ|áo sơ mi
shock|ʃɑːk|danh từ, động từ|cú sốc; làm sốc
shoe|ʃuː|danh từ|chiếc giày
shoot|ʃuːt|động từ|bắn; quay phim
shop|ʃɑːp|danh từ, động từ|cửa hàng; mua sắm
shopping|ˈʃɑːpɪŋ|danh từ|việc mua sắm
short|ʃɔːrt|tính từ|ngắn; thấp
shortly|ˈʃɔːrtli|trạng từ|ngay sau đó
shot|ʃɑːt|danh từ|phát bắn; cú sút; cảnh quay
should|ʃʊd|động từ khuyết thiếu|nên
shoulder|ˈʃoʊldər|danh từ|vai
shout|ʃaʊt|động từ|hét
show|ʃoʊ|động từ, danh từ|cho xem, hiển thị; chương trình
shower|ˈʃaʊər|danh từ|vòi sen; cơn mưa rào
shut|ʃʌt|động từ|đóng
shy|ʃaɪ|tính từ|nhút nhát
sick|sɪk|tính từ|ốm
side|saɪd|danh từ|bên, mặt
sight|saɪt|danh từ|thị lực; cảnh
sign|saɪn|danh từ, động từ|dấu hiệu; biển báo; ký tên
signal|ˈsɪɡnəl|danh từ|tín hiệu
signature|ˈsɪɡnətʃər|danh từ|chữ ký
significant|sɪɡˈnɪfɪkənt|tính từ|đáng kể, quan trọng
significantly|sɪɡˈnɪfɪkəntli|trạng từ|đáng kể
silence|ˈsaɪləns|danh từ|sự im lặng
silent|ˈsaɪlənt|tính từ|im lặng
silly|ˈsɪli|tính từ|ngớ ngẩn
silver|ˈsɪlvər|danh từ|bạc
similar|ˈsɪmələr|tính từ|tương tự
simple|ˈsɪmpəl|tính từ|đơn giản
simply|ˈsɪmpli|trạng từ|đơn giản là
since|sɪns|giới từ, liên từ|kể từ; vì
sing|sɪŋ|động từ|hát
singer|ˈsɪŋər|danh từ|ca sĩ
single|ˈsɪŋɡəl|tính từ|đơn; độc thân
sink|sɪŋk|động từ, danh từ|chìm; bồn rửa
sir|sɜːr|danh từ|thưa ông
sister|ˈsɪstər|danh từ|chị/em gái
sit|sɪt|động từ|ngồi
site|saɪt|danh từ|địa điểm; trang web
situation|ˌsɪtʃuˈeɪʃən|danh từ|tình huống
six|sɪks|số từ|sáu
size|saɪz|danh từ|kích thước
skill|skɪl|danh từ|kỹ năng
skin|skɪn|danh từ|da
skirt|skɜːrt|danh từ|chân váy
sky|skaɪ|danh từ|bầu trời
sleep|sliːp|động từ, danh từ|ngủ; giấc ngủ
slice|slaɪs|danh từ|lát
slide|slaɪd|động từ, danh từ|trượt; trang trình chiếu
slight|slaɪt|tính từ|nhẹ, nhỏ
slightly|ˈslaɪtli|trạng từ|hơi, một chút
slip|slɪp|động từ|trượt chân
slow|sloʊ|tính từ|chậm
slowly|ˈsloʊli|trạng từ|chậm rãi
small|smɔːl|tính từ|nhỏ
smart|smɑːrt|tính từ|thông minh
smell|smel|động từ, danh từ|ngửi; có mùi; mùi
smile|smaɪl|động từ, danh từ|mỉm cười; nụ cười
smoke|smoʊk|danh từ, động từ|khói; hút thuốc
smooth|smuːð|tính từ|trơn, mượt
snake|sneɪk|danh từ|con rắn
snow|snoʊ|danh từ, động từ|tuyết; tuyết rơi
so|soʊ|trạng từ, liên từ|vì vậy; rất
soap|soʊp|danh từ|xà phòng
soccer|ˈsɑːkər|danh từ|bóng đá
social|ˈsoʊʃəl|tính từ|thuộc xã hội
society|səˈsaɪəti|danh từ|xã hội
sock|sɑːk|danh từ|chiếc tất
soft|sɔːft|tính từ|mềm
software|ˈsɔːftwer|danh từ|phần mềm
soil|sɔɪl|danh từ|đất
solar|ˈsoʊlər|tính từ|thuộc mặt trời
soldier|ˈsoʊldʒər|danh từ|người lính
solid|ˈsɑːlɪd|tính từ, danh từ|rắn chắc; chất rắn
solution|səˈluːʃən|danh từ|giải pháp; dung dịch
solve|sɑːlv|động từ|giải quyết
some|sʌm|từ hạn định|một vài, một ít
somebody|ˈsʌmbɑːdi|đại từ|ai đó
somehow|ˈsʌmhaʊ|trạng từ|bằng cách nào đó
someone|ˈsʌmwʌn|đại từ|ai đó
something|ˈsʌmθɪŋ|đại từ|cái gì đó
sometimes|ˈsʌmtaɪmz|trạng từ|thỉnh thoảng
somewhat|ˈsʌmwʌt|trạng từ|hơi, phần nào
somewhere|ˈsʌmwer|trạng từ|ở đâu đó
son|sʌn|danh từ|con trai
song|sɔːŋ|danh từ|bài hát
soon|suːn|trạng từ|sớm
sorry|ˈsɑːri|tính từ|xin lỗi; tiếc
sort|sɔːrt|danh từ, động từ|loại; sắp xếp
soul|soʊl|danh từ|linh hồn
sound|saʊnd|danh từ, động từ|âm thanh; nghe có vẻ
soup|suːp|danh từ|súp, canh
source|sɔːrs|danh từ|nguồn
south|saʊθ|danh từ|phía nam
southern|ˈsʌðərn|tính từ|thuộc phía nam
space|speɪs|danh từ|không gian; khoảng trống
speak|spiːk|động từ|nói
speaker|ˈspiːkər|danh từ|người nói; loa
special|ˈspeʃəl|tính từ|đặc biệt
specialist|ˈspeʃəlɪst|danh từ|chuyên gia
species|ˈspiːʃiːz|danh từ|loài
specific|spəˈsɪfɪk|tính từ|cụ thể
specifically|spəˈsɪfɪkli|trạng từ|cụ thể là
speech|spiːtʃ|danh từ|bài phát biểu; lời nói
speed|spiːd|danh từ|tốc độ
spell|spel|động từ, danh từ|đánh vần; câu thần chú
spend|spend|động từ|tiêu (tiền); dành (thời gian)
spicy|ˈspaɪsi|tính từ|cay
spirit|ˈspɪrɪt|danh từ|tinh thần
split|splɪt|động từ|chia, tách
spoil|spɔɪl|động từ|làm hỏng; chiều hư
sponsor|ˈspɑːnsər|danh từ, động từ|nhà tài trợ; tài trợ
spoon|spuːn|danh từ|cái thìa
sport|spɔːrt|danh từ|thể thao
spot|spɑːt|danh từ, động từ|chỗ; đốm; phát hiện
spread|spred|động từ|lan rộng; trải
spring|sprɪŋ|danh từ|mùa xuân; lò xo; suối
square|skwer|danh từ, tính từ|hình vuông; quảng trường; bình phương
stable|ˈsteɪbəl|tính từ|ổn định
stack|stæk|danh từ, động từ|chồng; ngăn xếp; xếp chồng
staff|stæf|danh từ|nhân viên
stage|steɪdʒ|danh từ|sân khấu; giai đoạn
stair|ster|danh từ|bậc thang
stand|stænd|động từ, danh từ|đứng; chịu đựng; giá đỡ
standard|ˈstændərd|danh từ, tính từ|tiêu chuẩn
star|stɑːr|danh từ|ngôi sao
start|stɑːrt|động từ, danh từ|bắt đầu; sự khởi đầu
state|steɪt|danh từ, động từ|trạng thái; bang; phát biểu
statement|ˈsteɪtmənt|danh từ|lời tuyên bố; câu lệnh
station|ˈsteɪʃən|danh từ|nhà ga; trạm
statistic|stəˈtɪstɪk|danh từ|số liệu thống kê
status|ˈsteɪtəs|danh từ|tình trạng; địa vị
stay|steɪ|động từ, danh từ|ở lại; kỳ lưu trú
steady|ˈstedi|tính từ|đều đặn, vững
steal|stiːl|động từ|ăn trộm
steam|stiːm|danh từ|hơi nước
steel|stiːl|danh từ|thép
step|step|danh từ, động từ|bước; bậc; bước đi
stick|stɪk|động từ, danh từ|dính; que
still|stɪl|trạng từ, tính từ|vẫn; yên
stock|stɑːk|danh từ|hàng tồn kho; cổ phiếu
stomach|ˈstʌmək|danh từ|dạ dày, bụng
stone|stoʊn|danh từ|hòn đá
stop|stɑːp|động từ, danh từ|dừng; trạm dừng
storage|ˈstɔːrɪdʒ|danh từ|sự lưu trữ; bộ nhớ lưu trữ
store|stɔːr|danh từ, động từ|cửa hàng; lưu trữ
storm|stɔːrm|danh từ|cơn bão
story|ˈstɔːri|danh từ|câu chuyện; tầng nhà
straight|streɪt|tính từ, trạng từ|thẳng
strange|streɪndʒ|tính từ|lạ
stranger|ˈstreɪndʒər|danh từ|người lạ
strategy|ˈstrætədʒi|danh từ|chiến lược
stream|striːm|danh từ, động từ|dòng suối; luồng; phát trực tuyến
street|striːt|danh từ|đường phố
strength|streŋθ|danh từ|sức mạnh; điểm mạnh
stress|stres|danh từ, động từ|căng thẳng; trọng âm; nhấn mạnh
stretch|stretʃ|động từ|kéo dài, căng ra
strict|strɪkt|tính từ|nghiêm khắc
strike|straɪk|động từ, danh từ|đánh; đình công
string|strɪŋ|danh từ|dây; chuỗi ký tự
strong|strɔːŋ|tính từ|mạnh
strongly|ˈstrɔːŋli|trạng từ|mạnh mẽ
structure|ˈstrʌktʃər|danh từ|cấu trúc
struggle|ˈstrʌɡəl|động từ, danh từ|vật lộn; cuộc đấu tranh
student|ˈstuːdənt|danh từ|học sinh, sinh viên
studio|ˈstuːdioʊ|danh từ|phòng thu; xưởng
study|ˈstʌdi|động từ, danh từ|học; việc học; nghiên cứu
stuff|stʌf|danh từ|đồ, thứ
stupid|ˈstuːpɪd|tính từ|ngu ngốc
style|staɪl|danh từ|phong cách
subject|ˈsʌbdʒɪkt|danh từ|môn học; chủ đề; chủ ngữ
submit|səbˈmɪt|động từ|nộp
subsequent|ˈsʌbsɪkwənt|tính từ|tiếp theo
substance|ˈsʌbstəns|danh từ|chất
succeed|səkˈsiːd|động từ|thành công
success|səkˈses|danh từ|sự thành công
successful|səkˈsesfəl|tính từ|thành công
such|sʌtʃ|từ hạn định|như thế
sudden|ˈsʌdən|tính từ|đột ngột
suddenly|ˈsʌdənli|trạng từ|đột nhiên
suffer|ˈsʌfər|động từ|chịu đựng, đau khổ
sufficient|səˈfɪʃənt|tính từ|đủ
sugar|ˈʃʊɡər|danh từ|đường
suggest|səɡˈdʒest|động từ|đề xuất, gợi ý
suggestion|səɡˈdʒestʃən|danh từ|lời gợi ý
suit|suːt|danh từ, động từ|bộ com-lê; phù hợp
suitable|ˈsuːtəbəl|tính từ|phù hợp
summer|ˈsʌmər|danh từ|mùa hè
sun|sʌn|danh từ|mặt trời
sunny|ˈsʌni|tính từ|nắng
super|ˈsuːpər|tính từ|tuyệt vời
supermarket|ˈsuːpərmɑːrkɪt|danh từ|siêu thị
supply|səˈplaɪ|danh từ, động từ|nguồn cung; nguồn (điện); cung cấp
support|səˈpɔːrt|động từ, danh từ|hỗ trợ; ủng hộ
supporter|səˈpɔːrtər|danh từ|người ủng hộ
suppose|səˈpoʊz|động từ|cho rằng
sure|ʃʊr|tính từ|chắc chắn
surely|ˈʃʊrli|trạng từ|chắc chắn
surface|ˈsɜːrfɪs|danh từ|bề mặt
surgery|ˈsɜːrdʒəri|danh từ|phẫu thuật
surprise|sərˈpraɪz|danh từ, động từ|sự ngạc nhiên; làm ngạc nhiên
surprised|sərˈpraɪzd|tính từ|ngạc nhiên
surprising|sərˈpraɪzɪŋ|tính từ|đáng ngạc nhiên
surround|səˈraʊnd|động từ|bao quanh
survey|ˈsɜːrveɪ|danh từ|cuộc khảo sát
survive|sərˈvaɪv|động từ|sống sót
suspect|səˈspekt|động từ, danh từ|nghi ngờ; nghi phạm
sweet|swiːt|tính từ|ngọt
swim|swɪm|động từ|bơi
swimming|ˈswɪmɪŋ|danh từ|môn bơi
switch|swɪtʃ|danh từ, động từ|công tắc; chuyển đổi
symbol|ˈsɪmbəl|danh từ|biểu tượng, ký hiệu
sympathy|ˈsɪmpəθi|danh từ|sự cảm thông
system|ˈsɪstəm|danh từ|hệ thống
table|ˈteɪbəl|danh từ|cái bàn; bảng
tablet|ˈtæblət|danh từ|máy tính bảng; viên thuốc
tail|teɪl|danh từ|cái đuôi
take|teɪk|động từ|lấy; mang; mất (thời gian)
tale|teɪl|danh từ|câu chuyện
talent|ˈtælənt|danh từ|tài năng
talk|tɔːk|động từ, danh từ|nói chuyện; bài nói
tall|tɔːl|tính từ|cao
tank|tæŋk|danh từ|bể chứa; xe tăng
tap|tæp|động từ, danh từ|gõ nhẹ, chạm; vòi nước
target|ˈtɑːrɡɪt|danh từ|mục tiêu
task|tæsk|danh từ|nhiệm vụ; tác vụ
taste|teɪst|danh từ, động từ|vị; khẩu vị; nếm
tax|tæks|danh từ|thuế
taxi|ˈtæksi|danh từ|xe taxi
tea|tiː|danh từ|trà
teach|tiːtʃ|động từ|dạy
teacher|ˈtiːtʃər|danh từ|giáo viên
teaching|ˈtiːtʃɪŋ|danh từ|việc giảng dạy
team|tiːm|danh từ|đội, nhóm
tear|ter, tɪr|động từ, danh từ|xé; nước mắt
technical|ˈteknɪkəl|tính từ|thuộc kỹ thuật
technique|tekˈniːk|danh từ|kỹ thuật, kỹ xảo
technology|tekˈnɑːlədʒi|danh từ|công nghệ
teenager|ˈtiːneɪdʒər|danh từ|thiếu niên
telephone|ˈtelɪfoʊn|danh từ|điện thoại
television|ˈtelɪvɪʒən|danh từ|ti vi
tell|tel|động từ|kể; bảo
temperature|ˈtemprətʃər|danh từ|nhiệt độ
temple|ˈtempəl|danh từ|ngôi đền
temporary|ˈtempəreri|tính từ|tạm thời
ten|ten|số từ|mười
tend|tend|động từ|có xu hướng
tendency|ˈtendənsi|danh từ|xu hướng
tennis|ˈtenɪs|danh từ|quần vợt
tension|ˈtenʃən|danh từ|sự căng thẳng; điện áp
tent|tent|danh từ|cái lều
term|tɜːrm|danh từ|thuật ngữ; kỳ học; điều khoản
terrible|ˈterəbəl|tính từ|khủng khiếp
territory|ˈterətɔːri|danh từ|lãnh thổ
terror|ˈterər|danh từ|sự khủng bố; nỗi kinh hoàng
test|test|danh từ, động từ|bài kiểm tra; kiểm tra
text|tekst|danh từ, động từ|văn bản; nhắn tin
than|ðæn|liên từ, giới từ|hơn
thank|θæŋk|động từ|cảm ơn
thanks|θæŋks|thán từ|cảm ơn
that|ðæt|từ hạn định, đại từ, liên từ|đó, kia; rằng
the|ðə|từ hạn định|(mạo từ xác định)
theater|ˈθiːətər|danh từ|nhà hát
their|ðer|từ hạn định|của họ
theirs|ðerz|đại từ|của họ
them|ðem|đại từ|họ (tân ngữ)
theme|θiːm|danh từ|chủ đề; giao diện
themselves|ðəmˈselvz|đại từ|chính họ
then|ðen|trạng từ|sau đó; khi đó
theory|ˈθɪri|danh từ|lý thuyết
therapy|ˈθerəpi|danh từ|liệu pháp
there|ðer|trạng từ|ở đó
therefore|ˈðerfɔːr|trạng từ|vì vậy
these|ðiːz|từ hạn định, đại từ|những cái này
they|ðeɪ|đại từ|họ
thick|θɪk|tính từ|dày
thief|θiːf|danh từ|tên trộm
thin|θɪn|tính từ|mỏng; gầy
thing|θɪŋ|danh từ|đồ vật, điều
think|θɪŋk|động từ|nghĩ
thinking|ˈθɪŋkɪŋ|danh từ|suy nghĩ, tư duy
third|θɜːrd|số từ|thứ ba
thirsty|ˈθɜːrsti|tính từ|khát
this|ðɪs|từ hạn định, đại từ|này, cái này
those|ðoʊz|từ hạn định, đại từ|những cái đó
though|ðoʊ|liên từ, trạng từ|mặc dù; tuy nhiên
thought|θɔːt|danh từ|ý nghĩ
thousand|ˈθaʊzənd|số từ|một nghìn
thread|θred|danh từ|sợi chỉ; luồng (thread)
threat|θret|danh từ|mối đe dọa
threaten|ˈθretən|động từ|đe dọa
three|θriː|số từ|ba
throat|θroʊt|danh từ|cổ họng
through|θruː|giới từ|xuyên qua; thông qua
throughout|θruːˈaʊt|giới từ|khắp; suốt
throw|θroʊ|động từ|ném
thus|ðʌs|trạng từ|do đó
ticket|ˈtɪkɪt|danh từ|vé
tidy|ˈtaɪdi|tính từ, động từ|gọn gàng; dọn dẹp
tie|taɪ|động từ, danh từ|buộc; cà vạt; hòa
tight|taɪt|tính từ|chặt; bó sát
till|tɪl|giới từ, liên từ|cho đến khi
time|taɪm|danh từ|thời gian; lần
timer|ˈtaɪmər|danh từ|bộ hẹn giờ
tiny|ˈtaɪni|tính từ|nhỏ xíu
tip|tɪp|danh từ|mẹo; tiền boa; đầu mút
tired|ˈtaɪərd|tính từ|mệt
title|ˈtaɪtəl|danh từ|tiêu đề; chức danh
to|tuː|giới từ|đến; để
today|təˈdeɪ|trạng từ, danh từ|hôm nay
toe|toʊ|danh từ|ngón chân
together|təˈɡeðər|trạng từ|cùng nhau
toilet|ˈtɔɪlət|danh từ|nhà vệ sinh
tomato|təˈmeɪtoʊ|danh từ|cà chua
tomorrow|təˈmɑːroʊ|trạng từ, danh từ|ngày mai
tone|toʊn|danh từ|giọng điệu; tông
tongue|tʌŋ|danh từ|cái lưỡi
tonight|təˈnaɪt|trạng từ|tối nay
too|tuː|trạng từ|quá; cũng
tool|tuːl|danh từ|công cụ
tooth|tuːθ|danh từ|cái răng
top|tɑːp|danh từ, tính từ|đỉnh; hàng đầu
topic|ˈtɑːpɪk|danh từ|chủ đề
total|ˈtoʊtəl|tính từ, danh từ|tổng cộng; tổng số
totally|ˈtoʊtəli|trạng từ|hoàn toàn
touch|tʌtʃ|động từ, danh từ|chạm; sự liên lạc
tough|tʌf|tính từ|khó khăn; cứng rắn
tour|tʊr|danh từ|chuyến du lịch
tourism|ˈtʊrɪzəm|danh từ|du lịch
tourist|ˈtʊrɪst|danh từ|khách du lịch
toward|tɔːrd|giới từ|về phía
towel|ˈtaʊəl|danh từ|khăn tắm
tower|ˈtaʊər|danh từ|tòa tháp
town|taʊn|danh từ|thị trấn
toy|tɔɪ|danh từ|đồ chơi
trace|treɪs|danh từ, động từ|dấu vết; truy vết
track|træk|danh từ, động từ|đường ray; bài hát; theo dõi
trade|treɪd|danh từ, động từ|thương mại; buôn bán
tradition|trəˈdɪʃən|danh từ|truyền thống
traditional|trəˈdɪʃənəl|tính từ|truyền thống
traffic|ˈtræfɪk|danh từ|giao thông; lưu lượng
train|treɪn|danh từ, động từ|tàu hỏa; huấn luyện
training|ˈtreɪnɪŋ|danh từ|sự đào tạo
transfer|trænsˈfɜːr|động từ, danh từ|chuyển; sự chuyển giao
transform|trænsˈfɔːrm|động từ|biến đổi
transistor|trænˈzɪstər|danh từ|tranzito
transition|trænˈzɪʃən|danh từ|sự chuyển tiếp
translate|trænsˈleɪt|động từ|dịch
translation|trænsˈleɪʃən|danh từ|bản dịch
transmit|trænsˈmɪt|động từ|truyền
transport|ˈtrænspɔːrt|danh từ, động từ|giao thông vận tải; vận chuyển
transportation|ˌtrænspərˈteɪʃən|danh từ|phương tiện vận chuyển
trap|træp|danh từ, động từ|cái bẫy; bẫy
travel|ˈtrævəl|động từ, danh từ|đi du lịch; sự đi lại
treat|triːt|động từ, danh từ|đối xử; điều trị; món quà
treatment|ˈtriːtmənt|danh từ|sự điều trị; cách đối xử
tree|triː|danh từ|cái cây
trend|trend|danh từ|xu hướng
trial|ˈtraɪəl|danh từ|phiên tòa; sự thử nghiệm
trick|trɪk|danh từ|mánh khóe; trò ảo thuật
trigger|ˈtrɪɡər|danh từ, động từ|cò súng; kích hoạt
trip|trɪp|danh từ|chuyến đi
troop|truːp|danh từ|quân lính
trouble|ˈtrʌbəl|danh từ|rắc rối
truck|trʌk|danh từ|xe tải
true|truː|tính từ|đúng, thật
truly|ˈtruːli|trạng từ|thật sự
trust|trʌst|động từ, danh từ|tin tưởng; lòng tin
truth|truːθ|danh từ|sự thật
try|traɪ|động từ, danh từ|cố gắng; thử
tube|tuːb|danh từ|ống
tune|tuːn|danh từ, động từ|giai điệu; điều chỉnh
tunnel|ˈtʌnəl|danh từ|đường hầm
turn|tɜːrn|động từ, danh từ|quay; rẽ; lượt
twice|twaɪs|trạng từ|hai lần
twin|twɪn|danh từ|sinh đôi
two|tuː|số từ|hai
type|taɪp|danh từ, động từ|loại; kiểu; gõ phím
typical|ˈtɪpɪkəl|tính từ|điển hình
typically|ˈtɪpɪkli|trạng từ|thông thường
ugly|ˈʌɡli|tính từ|xấu xí
ultimate|ˈʌltɪmət|tính từ|cuối cùng; tối thượng
ultimately|ˈʌltɪmətli|trạng từ|rốt cuộc
umbrella|ʌmˈbrelə|danh từ|cái ô
unable|ʌnˈeɪbəl|tính từ|không thể
uncle|ˈʌŋkəl|danh từ|chú, bác, cậu
uncomfortable|ʌnˈkʌmftəbəl|tính từ|không thoải mái
under|ˈʌndər|giới từ|dưới
undergo|ˌʌndərˈɡoʊ|động từ|trải qua
underground|ˈʌndərɡraʊnd|tính từ, danh từ|dưới lòng đất; tàu điện ngầm
understand|ˌʌndərˈstænd|động từ|hiểu
understanding|ˌʌndərˈstændɪŋ|danh từ|sự hiểu biết
unemployment|ˌʌnɪmˈplɔɪmənt|danh từ|nạn thất nghiệp
unexpected|ˌʌnɪkˈspektɪd|tính từ|bất ngờ
unfair|ʌnˈfer|tính từ|không công bằng
unfortunately|ʌnˈfɔːrtʃənətli|trạng từ|thật không may
unhappy|ʌnˈhæpi|tính từ|không vui
uniform|ˈjuːnɪfɔːrm|danh từ, tính từ|đồng phục; đồng đều
union|ˈjuːnjən|danh từ|liên minh; công đoàn
unique|juˈniːk|tính từ|độc nhất
unit|ˈjuːnɪt|danh từ|đơn vị; khối
unite|juˈnaɪt|động từ|đoàn kết, hợp nhất
universe|ˈjuːnɪvɜːrs|danh từ|vũ trụ
university|ˌjuːnɪˈvɜːrsəti|danh từ|trường đại học
unknown|ʌnˈnoʊn|tính từ|chưa biết
unless|ənˈles|liên từ|trừ khi
unlike|ʌnˈlaɪk|giới từ|không giống như
unlikely|ʌnˈlaɪkli|tính từ|không chắc
until|ənˈtɪl|giới từ, liên từ|cho đến khi
unusual|ʌnˈjuːʒuəl|tính từ|khác thường
up|ʌp|trạng từ, giới từ|lên
update|ˌʌpˈdeɪt|động từ, danh từ|cập nhật; bản cập nhật
upgrade|ˌʌpˈɡreɪd|động từ, danh từ|nâng cấp
upload|ˌʌpˈloʊd|động từ|tải lên
upon|əˈpɑːn|giới từ|trên; ngay khi
upper|ˈʌpər|tính từ|ở trên; chữ hoa
upset|ʌpˈset|tính từ, động từ|buồn bực; làm buồn
upstairs|ˌʌpˈsterz|trạng từ|ở tầng trên
urban|ˈɜːrbən|tính từ|thuộc đô thị
urge|ɜːrdʒ|động từ, danh từ|thúc giục; sự thôi thúc
urgent|ˈɜːrdʒənt|tính từ|khẩn cấp
us|ʌs|đại từ|chúng tôi (tân ngữ)
use|juːz, juːs|động từ, danh từ|sử dụng; việc sử dụng
used|juːzd|tính từ|đã qua sử dụng; quen (used to)
useful|ˈjuːsfəl|tính từ|hữu ích
useless|ˈjuːsləs|tính từ|vô dụng
user|ˈjuːzər|danh từ|người dùng
usual|ˈjuːʒuəl|tính từ|thông thường
usually|ˈjuːʒuəli|trạng từ|thường xuyên
vacation|veɪˈkeɪʃən|danh từ|kỳ nghỉ
valid|ˈvælɪd|tính từ|hợp lệ
valley|ˈvæli|danh từ|thung lũng
valuable|ˈvæljuəbəl|tính từ|có giá trị
value|ˈvæljuː|danh từ, động từ|giá trị; coi trọng
van|væn|danh từ|xe tải nhỏ
variable|ˈveriəbəl|danh từ, tính từ|biến; có thể thay đổi
variety|vəˈraɪəti|danh từ|sự đa dạng
various|ˈveriəs|tính từ|khác nhau, đa dạng
vary|ˈveri|động từ|thay đổi, khác nhau
vast|væst|tính từ|rộng lớn
vegetable|ˈvedʒtəbəl|danh từ|rau
vehicle|ˈviːəkəl|danh từ|phương tiện, xe cộ
version|ˈvɜːrʒən|danh từ|phiên bản
very|ˈveri|trạng từ|rất
via|ˈvaɪə|giới từ|qua, thông qua
victim|ˈvɪktɪm|danh từ|nạn nhân
victory|ˈvɪktəri|danh từ|chiến thắng
video|ˈvɪdioʊ|danh từ|video
view|vjuː|danh từ, động từ|quang cảnh; quan điểm; xem
viewer|ˈvjuːər|danh từ|người xem
village|ˈvɪlɪdʒ|danh từ|ngôi làng
violence|ˈvaɪələns|danh từ|bạo lực
violent|ˈvaɪələnt|tính từ|bạo lực
virtual|ˈvɜːrtʃuəl|tính từ|ảo
virus|ˈvaɪrəs|danh từ|vi-rút
visible|ˈvɪzəbəl|tính từ|có thể nhìn thấy
vision|ˈvɪʒən|danh từ|tầm nhìn; thị lực
visit|ˈvɪzɪt|động từ, danh từ|thăm; chuyến thăm
visitor|ˈvɪzɪtər|danh từ|khách tham quan
visual|ˈvɪʒuəl|tính từ|thuộc thị giác
vital|ˈvaɪtəl|tính từ|sống còn
voice|vɔɪs|danh từ|giọng nói
volume|ˈvɑːljuːm|danh từ|âm lượng; thể tích; tập
voltage|ˈvoʊltɪdʒ|danh từ|điện áp
volunteer|ˌvɑːlənˈtɪr|danh từ, động từ|tình nguyện viên; tình nguyện
vote|voʊt|động từ, danh từ|bỏ phiếu; lá phiếu
wage|weɪdʒ|danh từ|tiền công
wait|weɪt|động từ|chờ
waiter|ˈweɪtər|danh từ|bồi bàn
wake|weɪk|động từ|thức dậy; đánh thức
walk|wɔːk|động từ, danh từ|đi bộ; cuộc đi bộ
wall|wɔːl|danh từ|bức tường
wallet|ˈwɑːlɪt|danh từ|cái ví
want|wɑːnt|động từ|muốn
war|wɔːr|danh từ|chiến tranh
warm|wɔːrm|tính từ|ấm áp
warn|wɔːrn|động từ|cảnh báo
warning|ˈwɔːrnɪŋ|danh từ|lời cảnh báo
wash|wɑːʃ|động từ|rửa, giặt
waste|weɪst|danh từ, động từ|chất thải; sự lãng phí; lãng phí
watch|wɑːtʃ|động từ, danh từ|xem; đồng hồ đeo tay
water|ˈwɔːtər|danh từ, động từ|nước; tưới
wave|weɪv|danh từ, động từ|sóng; vẫy tay
way|weɪ|danh từ|đường; cách
we|wiː|đại từ|chúng tôi, chúng ta
weak|wiːk|tính từ|yếu
weakness|ˈwiːknəs|danh từ|điểm yếu
wealth|welθ|danh từ|sự giàu có
weapon|ˈwepən|danh từ|vũ khí
wear|wer|động từ|mặc, đeo
weather|ˈweðər|danh từ|thời tiết
web|web|danh từ|mạng; trang web
website|ˈwebsaɪt|danh từ|trang web
wedding|ˈwedɪŋ|danh từ|đám cưới
week|wiːk|danh từ|tuần
weekend|ˈwiːkend|danh từ|cuối tuần
weekly|ˈwiːkli|tính từ, trạng từ|hằng tuần
weigh|weɪ|động từ|cân; nặng
weight|weɪt|danh từ|cân nặng; trọng số
welcome|ˈwelkəm|thán từ, động từ|chào mừng
welfare|ˈwelfer|danh từ|phúc lợi
well|wel|trạng từ, tính từ|tốt; khỏe
west|west|danh từ|phía tây
western|ˈwestərn|tính từ|thuộc phía tây
wet|wet|tính từ|ướt
what|wʌt|đại từ, từ hạn định|cái gì
whatever|wʌtˈevər|đại từ|bất cứ cái gì
wheel|wiːl|danh từ|bánh xe
when|wen|trạng từ, liên từ|khi nào; khi
whenever|wenˈevər|liên từ|bất cứ khi nào
where|wer|trạng từ|ở đâu
whereas|werˈæz|liên từ|trong khi
wherever|werˈevər|liên từ|bất cứ đâu
whether|ˈweðər|liên từ|liệu, có... hay không
which|wɪtʃ|đại từ, từ hạn định|cái nào
while|waɪl|liên từ, danh từ|trong khi; một lúc
white|waɪt|tính từ|màu trắng
who|huː|đại từ|ai
whoever|huːˈevər|đại từ|bất cứ ai
whole|hoʊl|tính từ, danh từ|toàn bộ
whom|huːm|đại từ|ai (tân ngữ)
whose|huːz|đại từ|của ai
why|waɪ|trạng từ|tại sao
wide|waɪd|tính từ|rộng
widely|ˈwaɪdli|trạng từ|rộng rãi
width|wɪdθ|danh từ|chiều rộng
wife|waɪf|danh từ|vợ
wild|waɪld|tính từ|hoang dã
will|wɪl|động từ khuyết thiếu, danh từ|sẽ; ý chí; di chúc
willing|ˈwɪlɪŋ|tính từ|sẵn lòng
win|wɪn|động từ|thắng
wind|wɪnd|danh từ|gió
window|ˈwɪndoʊ|danh từ|cửa sổ
wine|waɪn|danh từ|rượu vang
wing|wɪŋ|danh từ|cánh
winner|ˈwɪnər|danh từ|người chiến thắng
winter|ˈwɪntər|danh từ|mùa đông
wire|waɪər|danh từ|dây điện
wireless|ˈwaɪərləs|tính từ|không dây
wise|waɪz|tính từ|khôn ngoan
wish|wɪʃ|động từ, danh từ|ước; điều ước
with|wɪð|giới từ|với
within|wɪˈðɪn|giới từ|trong vòng
without|wɪˈðaʊt|giới từ|không có
witness|ˈwɪtnəs|danh từ, động từ|nhân chứng; chứng kiến
woman|ˈwʊmən|danh từ|người phụ nữ
wonder|ˈwʌndər|động từ, danh từ|tự hỏi; điều kỳ diệu
wonderful|ˈwʌndərfəl|tính từ|tuyệt vời
wood|wʊd|danh từ|gỗ; rừng
wooden|ˈwʊdən|tính từ|bằng gỗ
word|wɜːrd|danh từ|từ
work|wɜːrk|động từ, danh từ|làm việc; hoạt động; công việc
worker|ˈwɜːrkər|danh từ|công nhân
working|ˈwɜːrkɪŋ|tính từ|đang làm việc; hoạt động được
world|wɜːrld|danh từ|thế giới
worried|ˈwɜːrid|tính từ|lo lắng
worry|ˈwɜːri|động từ, danh từ|lo lắng; mối lo
worse|wɜːrs|tính từ|tệ hơn
worst|wɜːrst|tính từ|tệ nhất
worth|wɜːrθ|tính từ, danh từ|đáng giá; giá trị
would|wʊd|động từ khuyết thiếu|sẽ (quá khứ của will)
wound|wuːnd|danh từ|vết thương
wrap|ræp|động từ|gói, bọc
write|raɪt|động từ|viết; ghi
writer|ˈraɪtər|danh từ|nhà văn
writing|ˈraɪtɪŋ|danh từ|việc viết; bài viết
wrong|rɔːŋ|tính từ|sai
yard|jɑːrd|danh từ|sân; thước Anh
yeah|jeə|thán từ|ừ, vâng
year|jɪr|danh từ|năm
yellow|ˈjeloʊ|tính từ|màu vàng
yes|jes|thán từ|có, vâng
yesterday|ˈjestərdeɪ|trạng từ, danh từ|hôm qua
yet|jet|trạng từ, liên từ|chưa; tuy nhiên
you|juː|đại từ|bạn
young|jʌŋ|tính từ|trẻ
your|jʊr|từ hạn định|của bạn
yours|jʊrz|đại từ|của bạn
yourself|jʊrˈself|đại từ|chính bạn
youth|juːθ|danh từ|tuổi trẻ; thanh niên
zero|ˈzɪroʊ|số từ|số không
zone|zoʊn|danh từ|khu vực
zoo|zuː|danh từ|sở thú
aunt|ænt|danh từ|cô, dì, bác gái
bee|biː|danh từ|con ong
bucket|ˈbʌkɪt|danh từ|cái xô
cabbage|ˈkæbɪdʒ|danh từ|bắp cải
calendar|ˈkælɪndər|danh từ|lịch
chin|tʃɪn|danh từ|cằm
cloth|klɔːθ|danh từ|vải
cloudy|ˈklaʊdi|tính từ|nhiều mây
coconut|ˈkoʊkənʌt|danh từ|quả dừa
comb|koʊm|danh từ|cái lược
crab|kræb|danh từ|con cua
cucumber|ˈkjuːkʌmbər|danh từ|dưa chuột
deer|dɪr|danh từ|con hươu
dolphin|ˈdɑːlfɪn|danh từ|cá heo
dragon|ˈdræɡən|danh từ|con rồng
duck|dʌk|danh từ|con vịt
eagle|ˈiːɡəl|danh từ|đại bàng
elbow|ˈelboʊ|danh từ|khuỷu tay
elevator|ˈelɪveɪtər|danh từ|thang máy
envelope|ˈenvəloʊp|danh từ|phong bì
feather|ˈfeðər|danh từ|lông vũ
flour|ˈflaʊər|danh từ|bột mì
fog|fɑːɡ|danh từ|sương mù
fox|fɑːks|danh từ|con cáo
frog|frɔːɡ|danh từ|con ếch
garlic|ˈɡɑːrlɪk|danh từ|tỏi
goat|ɡoʊt|danh từ|con dê
grape|ɡreɪp|danh từ|quả nho
greet|ɡriːt|động từ|chào hỏi
hammer|ˈhæmər|danh từ|cái búa
hug|hʌɡ|động từ, danh từ|ôm; cái ôm
jar|dʒɑːr|danh từ|cái lọ
kettle|ˈketəl|danh từ|ấm đun nước
kite|kaɪt|danh từ|con diều
ladder|ˈlædər|danh từ|cái thang
lamp|læmp|danh từ|cái đèn
lion|ˈlaɪən|danh từ|sư tử
luggage|ˈlʌɡɪdʒ|danh từ|hành lý
mango|ˈmæŋɡoʊ|danh từ|quả xoài
monkey|ˈmʌŋki|danh từ|con khỉ
mosquito|məˈskiːtoʊ|danh từ|con muỗi
nest|nest|danh từ|cái tổ
nod|nɑːd|động từ|gật đầu
noodle|ˈnuːdəl|danh từ|mì, bún, phở
onion|ˈʌnjən|danh từ|hành tây
owl|aʊl|danh từ|con cú
peach|piːtʃ|danh từ|quả đào
pear|per|danh từ|quả lê
pillow|ˈpɪloʊ|danh từ|cái gối
pineapple|ˈpaɪnæpəl|danh từ|quả dứa
pizza|ˈpiːtsə|danh từ|bánh pizza
pumpkin|ˈpʌmpkɪn|danh từ|quả bí ngô
rabbit|ˈræbɪt|danh từ|con thỏ
rainbow|ˈreɪnboʊ|danh từ|cầu vồng
ruler|ˈruːlər|danh từ|cái thước; người cai trị
scissors|ˈsɪzərz|danh từ|cái kéo
scream|skriːm|động từ|hét lên
shark|ʃɑːrk|danh từ|cá mập
sheep|ʃiːp|danh từ|con cừu
shrimp|ʃrɪmp|danh từ|con tôm
sigh|saɪ|động từ, danh từ|thở dài
snack|snæk|danh từ|đồ ăn vặt
sneeze|sniːz|động từ|hắt hơi
sofa|ˈsoʊfə|danh từ|ghế sô-pha
souvenir|ˌsuːvəˈnɪr|danh từ|quà lưu niệm
spider|ˈspaɪdər|danh từ|con nhện
strawberry|ˈstrɔːberi|danh từ|quả dâu tây
sweater|ˈswetər|danh từ|áo len
tiger|ˈtaɪɡər|danh từ|con hổ
turtle|ˈtɜːrtəl|danh từ|con rùa
whale|weɪl|danh từ|cá voi
whisper|ˈwɪspər|động từ|thì thầm
wolf|wʊlf|danh từ|con sói
yawn|jɔːn|động từ|ngáp
algorithm|ˈælɡərɪðəm|danh từ|thuật toán
array|əˈreɪ|danh từ|mảng
binary|ˈbaɪnəri|tính từ, danh từ|nhị phân
boolean|ˈbuːliən|danh từ, tính từ|kiểu đúng/sai
buffer|ˈbʌfər|danh từ|bộ đệm
byte|baɪt|danh từ|byte
capacitor|kəˈpæsɪtər|danh từ|tụ điện
circuit|ˈsɜːrkɪt|danh từ|mạch điện
compile|kəmˈpaɪl|động từ|biên dịch
compiler|kəmˈpaɪlər|danh từ|trình biên dịch
configuration|kənˌfɪɡjəˈreɪʃən|danh từ|cấu hình
configure|kənˈfɪɡjər|động từ|cấu hình
debug|ˌdiːˈbʌɡ|động từ|gỡ lỗi
decimal|ˈdesɪməl|tính từ, danh từ|thập phân
default|dɪˈfɔːlt|danh từ, tính từ|mặc định
diode|ˈdaɪoʊd|danh từ|đi-ốt
execute|ˈeksɪkjuːt|động từ|thực thi
firmware|ˈfɜːrmwer|danh từ|phần sụn, firmware
integer|ˈɪntɪdʒər|danh từ|số nguyên
iterate|ˈɪtəreɪt|động từ|lặp
loop|luːp|danh từ, động từ|vòng lặp; lặp
microcontroller|ˌmaɪkroʊkənˈtroʊlər|danh từ|vi điều khiển
oscillator|ˈɑːsɪleɪtər|danh từ|bộ dao động
packet|ˈpækɪt|danh từ|gói tin
peripheral|pəˈrɪfərəl|danh từ, tính từ|ngoại vi
protocol|ˈproʊtəkɑːl|danh từ|giao thức
pulse|pʌls|danh từ|xung; mạch đập
query|ˈkwɪri|danh từ, động từ|truy vấn
syntax|ˈsɪntæks|danh từ|cú pháp
toggle|ˈtɑːɡəl|động từ, danh từ|bật/tắt luân phiên; công tắc
inspiration|ˌɪnspəˈreɪʃən|danh từ|nguồn cảm hứng
inspirational|ˌɪnspəˈreɪʃənəl|tính từ|truyền cảm hứng
aspire|əˈspaɪər|động từ|khao khát, mong mỏi
aspiration|ˌæspəˈreɪʃən|danh từ|khát vọng, hoài bão
conspire|kənˈspaɪər|động từ|âm mưu, cùng mưu tính
conspiracy|kənˈspɪrəsi|danh từ|âm mưu
conspirator|kənˈspɪrətər|danh từ|kẻ chủ mưu, người tham gia âm mưu
expire|ɪkˈspaɪər|động từ|hết hạn
expiration|ˌekspəˈreɪʃən|danh từ|sự hết hạn
respire|rɪˈspaɪər|động từ|hô hấp, thở
respiration|ˌrespəˈreɪʃən|danh từ|sự hô hấp
respiratory|ˈrespərətɔːri|tính từ|thuộc hô hấp
perspire|pərˈspaɪər|động từ|đổ mồ hôi
perspiration|ˌpɜːrspəˈreɪʃən|danh từ|mồ hôi; sự đổ mồ hôi
transpire|trænˈspaɪər|động từ|hóa ra, lộ ra; xảy ra
spiritual|ˈspɪrɪtʃuəl|tính từ|thuộc tinh thần, tâm linh
spiritually|ˈspɪrɪtʃuəli|trạng từ|về mặt tinh thần
dispirit|dɪˈspɪrɪt|động từ|làm nản lòng
apathy|ˈæpəθi|danh từ|sự thờ ơ
antipathy|ænˈtɪpəθi|danh từ|sự ác cảm
empathy|ˈempəθi|danh từ|sự thấu cảm
telepathy|təˈlepəθi|danh từ|thần giao cách cảm
pathetic|pəˈθetɪk|tính từ|đáng thương; thảm hại
pathology|pəˈθɑːlədʒi|danh từ|bệnh lý học
sympathetic|ˌsɪmpəˈθetɪk|tính từ|thông cảm
disrupt|dɪsˈrʌpt|động từ|gây xáo trộn, làm gián đoạn
disruption|dɪsˈrʌpʃən|danh từ|sự gián đoạn
bankrupt|ˈbæŋkrʌpt|tính từ|phá sản
rupture|ˈrʌptʃər|danh từ, động từ|sự vỡ, rách; làm vỡ
abrupt|əˈbrʌpt|tính từ|đột ngột
corrupt|kəˈrʌpt|tính từ, động từ|tham nhũng, hư hỏng; làm hư hỏng
corruption|kəˈrʌpʃən|danh từ|sự tham nhũng
erupt|ɪˈrʌpt|động từ|phun trào, bùng phát
eruption|ɪˈrʌpʃən|danh từ|sự phun trào
interruption|ˌɪntəˈrʌpʃən|danh từ|sự gián đoạn`;
// @@DICT_END
