# CLAUDE.md — Gợi ý tiếng Anh (Obsidian plugin)

Tài liệu cho AI/lập trình viên tiếp quản plugin. Người dùng nói tiếng Việt; trả lời và viết UI bằng tiếng Việt.

## Plugin làm gì

Khi gõ trong Obsidian, popup (mặc định nằm **trên** con trỏ) gợi ý từ/cụm từ tiếng Anh kèm phiên âm, từ loại, nghĩa. Chọn → chữ đang gõ thành wikilink tới ghi chú từ vựng:

- `hel` → `[[hello]]`; `Hel` → `[[hello|Hello]]` (giữ chữ hoa)
- `look u` → `[[look up]]` (khớp cụm nhiều từ)
- `Yesterday I wen` → `Yesterday I [[go|went]]` (biến thể → dạng gốc)
- Từ chưa có ghi chú nhưng có trong **từ điển nhúng** (~3.000 từ) → chèn link **và tạo ghi chú + thẻ ôn** lúc đó.

Kèm: thẻ ôn cho plugin Spaced Repetition, dòng "Biến thể" dưới tiêu đề ghi chú, nhiều thư mục từ vựng (tiếng Anh, STM32…).

## File

| File | Vai trò |
|---|---|
| `main.js` | **Toàn bộ code**, JavaScript CommonJS thuần, không bundler, không npm. Cuối file là `DICT_DATA` sinh tự động. |
| `styles.css` | Style popup (`.gyta-*`), dòng biến thể, ô cài đặt. Dùng biến CSS của Obsidian. |
| `manifest.json` | `id: goi-y-tieng-anh`. Tăng `version` mỗi lần phát hành. |
| `versions.json` | version → minAppVersion. Thêm dòng mỗi lần phát hành. |
| `dict/*.txt` | Nguồn từ điển: `từ|phiên âm Mỹ (không có /)|từ loại|nghĩa`. `#` là chú thích. Từ trùng: giữ dòng đầu. |
| `build.ps1` | Nhúng `dict/*.txt` vào `main.js` giữa `// @@DICT_START` và `// @@DICT_END`. Báo dòng sai định dạng / trùng / ký tự cấm (`` ` `` `\` `${`). |
| `README.md` | Hướng dẫn cho người dùng. |

## Kiến trúc `main.js` (theo thứ tự trong file)

1. **Hằng số**: `DEFAULT_SETTINGS`, `DEFAULT_FOLDER`, `TOKEN_RE` (token ASCII, cho phép số `_ ' -`), `LETTER_RE`, `VIET_RE` (chữ có dấu tiếng Việt).
2. **`WordSuggest extends EditorSuggest`**
   - `onTrigger`: cắt các *đoạn đuôi* 1..`maxWords` từ trước con trỏ (`"u"`, `"look u"`…), bỏ qua khi trong `[[…]]`, trong `` `code` ``, hay token đứng sau chữ có dấu (`đi` ≠ `i`). Lưu `this.suffixes`, `this.vietLine`.
   - `getSuggestions`: duyệt `plugin.getIndex()`, khớp `key.norm.startsWith(suffix)`; đoạn đuôi dài ưu tiên. Mục từ điển (`entry.dict`) chỉ khi `!vietLine` và dài ≥ `dictMinChars`. Sắp xếp: số từ ↓, khớp chính xác, ghi chú trước từ điển, ngắn trước.
   - `patchKeys`: chèn Tab, Enter, Space lên **đầu** `this.scope.keys` (Obsidian chạy phím theo thứ tự). Enter mặc định luôn chọn; cài đặt `enterExact: "newline"` thì khi gợi ý đầu `exact` và chưa bấm ↑↓ → đóng popup rồi **gửi lại** `keydown Enter` vào `editor.cm.contentDOM` (CodeMirror đã nhường Enter cho popup nên trả `true` không đủ).
   - `inCodeOrFrontmatter`: không gợi ý trong frontmatter / ``` / `$$`.
   - `reposition`: **ghi đè API nội bộ** của Obsidian để đặt popup phía trên con trỏ.
   - `selectSuggestion`: thay đoạn đã gõ bằng `[[term]]` / `[[term|hiển thị]]`; nếu mục từ điển → `plugin.createFromDict`.
3. **`AddWordModal`**: hộp thoại "Thêm từ vựng mới"; điền sẵn từ `dictLookup`.
4. **`FolderSuggest extends AbstractInputSuggest`**: gợi ý thư mục trong ô cài đặt.
5. **`SettingTab`**: bật/tắt, vị trí popup, hiện biến thể, danh sách thư mục `{path, tag, enabled}`, từ điển, bảng bất quy tắc bổ sung, các thanh trượt.
6. **Plugin chính `GoiYTiengAnh`**
   - `onload`: nạp/chuyển đổi cài đặt (bản cũ có `folder` đơn → `folders[]`), `setUserIrregular`, đăng ký suggest, lệnh, sự kiện làm mới chỉ mục, `refreshForms`.
   - `getIndex()`: chỉ mục = ghi chú trong các thư mục đang bật (`{path, folder, term, ipa, loai, nghia, keys[]}`) + mục từ điển chưa có ghi chú. `keys` gồm tên file, `aliases`, biến thể (`isForm`, `label`). Cache ở `this.index`, đặt `null` để làm mới.
   - `refreshForms()`: chèn DOM `.gyta-forms` ("Biến thể: goes · went…") sau `.inline-title` ở cả chế độ soạn thảo và đọc. **Chỉ hiển thị, không ghi file.**
   - `createWordNote(data, cfg)`: tạo ghi chú với frontmatter `ipa, loai, nghia, aliases, bien_the, tags` + `## Ví dụ`, `## Thẻ ôn`, `## Ghi chú`.
   - `addMissingCards()`: thêm dòng thẻ còn thiếu (không nhân đôi thẻ chính, giữ lịch ôn).
7. **Thẻ ôn**: `cardLine` → `**term** /ipa/:::nghĩa (loại)` (`:::` = thẻ hai chiều của Spaced Repetition); `irregularCard` → `**go** (V2 – V3)::went – gone`.
8. **Biến thể**: `IRREGULAR_VERBS` (~150 động từ), `IRREGULAR_NOUNS`, `IRREGULAR_ADJ`, bảng người dùng (`userTriples`, `userNouns` từ `setUserIrregular`). Quy tắc: `thirdPerson`, `pastRegular`, `ing`, `plural`, `comparatives`, `doubles` (gấp đôi phụ âm chỉ khi 1 âm tiết CVC), `syllables` (bỏ `e` câm). `inflect(term, loai, extra)` chọn theo `loai` chứa "động từ" (trừ "khuyết thiếu"), "danh từ", "tính từ"; cụm động từ chia từ đầu.
9. **Gốc từ**: `MORPH_DATA` (`p|s|r` | các dạng, dạng đầu là tên chính | nghĩa) → `MORPH[kind]` (form → `{kind,key,meaning}`), `MORPH_FORMS` (dài trước). `analyze(term)` thử từng gốc trong từ: phần trước phải là chuỗi tiền tố (`prefixChain`), phần sau là chuỗi hậu tố có thể kèm 1 nguyên âm nối (`suffixChain`); không có gốc thì thử tiền tố + từ trong từ điển, hoặc từ + hậu tố. Luật chống tách bừa: hai tiền tố liền nhau phải dài ≥ 2 và khác nhau; gốc ≤ 3 chữ cần tiền/hậu tố ≥ 2 chữ; "tiền tố + từ" chỉ với `PRODUCTIVE_PREFIX`; "từ + hậu tố" cần từ ≥ 4 chữ (3 chữ nếu hậu tố trong `CLEAR_SUFFIX`, `-y` cần từ ≥ 6). `NO_SPLIT` chặn từ trông giống (empire, path, missing…). `MANUAL_SPLITS` (từ → chuỗi `"re- + ten + -tion"`) tách sẵn từ mà luật không đoán đúng, vd. gốc đổi dạng trùng gốc khác (retention thuộc `tain`, không phải `tend`); `analyze` dùng bảng này trước. Kiểm tra lại bằng cách chạy `analyze` trên toàn bộ từ điển và đọc danh sách. `formatParts` / `parseParts` chuyển qua lại chuỗi `"in- + spir + e"`; `partId` = `kind:key`. Trong plugin: `buildWordDeco` (Biến thể / Phân tích / Cùng gốc), `buildMorphDeco` + `renderFamily` (Họ từ), `family(part)` (bảng mảnh → từ, dựng lại khi `getIndex()` đổi), `renderMorphBlock` / `renderMorphIndex` (khối ```goc-tu```), `BulkSplitModal` + `bulkCandidates`, `openMorphIndex`, `ensureMorphNote`, `setPhanTich`, `morphCard`. Ghi chú mảnh: `morphFolder/` tên `con-`, `-ation`, `spir`.
10. **Từ điển**: `dictEntries()` parse `DICT_DATA` lười, cache `dictCache` (đặt `null` khi bảng bất quy tắc đổi); `dictLookup(term)`. `dict/17-ho-tu.txt`, `dict/18-ho-tu-tain-labor.txt` bổ sung các họ từ (spir, path, rupt, tain, labor — theo các video người dùng gửi) để khung Họ từ đủ thành viên. Thêm họ mới: thêm gốc vào `MORPH_DATA`, các từ vào `dict/`, từ khó vào `MANUAL_SPLITS`, rồi chạy `analyze` trên cả từ điển để so trước/sau.
11. **Học theo ngữ cảnh** (cách học chính; gốc từ chỉ còn là gợi ý, `morphCards` mặc định tắt): `queueSentence` (gọi trong `selectSuggestion`) → `checkPending` (editor-change, active-leaf-change, mỗi 10 giây) chờ câu xong (`.!?` sau link, rời dòng, hoặc 60 giây) → `sentenceAround` cắt câu chứa link (cần ≥ 3 từ tiếng Anh khác) → `addExample` thêm vào `## Ví dụ` (`addToSection`) + thẻ cloze `==từ==` (`insertCards`). `addPhrase` (lệnh *Thêm cụm từ đi kèm*, `AddPhraseModal`) ghi `## Cụm từ`, thẻ `:::`, và `cum_tu` (chỉ mục đọc thành key `isPhrase`, chèn `[[sustain|sustain growth]]`). `addMissingCards` sinh thêm thẻ từ `clozeCardsFrom` / `phraseCardsFrom`; `hasCard` chống trùng theo `câu hỏi::` — không theo chữ đậm, vì chữ đậm cũng nằm trong Ví dụ / Cụm từ. Mẫu ghi chú: `## Ví dụ`, `## Cụm từ`, `## Thẻ ôn`, `## Ghi chú`.
12. **`DICT_DATA`**: chuỗi sinh bởi `build.ps1` — **không sửa tay**.

## Dữ liệu trong vault của người dùng

- Ghi chú từ vựng: một file / từ, tên file = từ (`go.md`, `look up.md`). Frontmatter:
  `ipa` (có `/…/`), `loai`, `nghia`, `aliases`, `bien_the` (thêm dạng), `khong_chia: true` (tắt tự sinh, chỉ dùng `bien_the`), `phan_tich: "in- + spir + e"`, `tags: [tu-vung, flashcards/…]`.
- Ghi chú gốc từ: `Tiếng Anh/Gốc từ/` (`spir.md`, `con-.md`, `-ation.md`), frontmatter `loai` (tiền tố/gốc từ/hậu tố), `nghia`, `bien_the`, `tags: [goc-tu, …]`.
- Thư mục mặc định `Tiếng Anh/Từ vựng` (tag `flashcards/tieng-anh`); có thể thêm `Kiến Thức/STM32 Thuật ngữ` (tag `flashcards/stm32`).
- Plugin Spaced Repetition của người dùng nhận thẻ qua tag `#flashcards` (bộ con theo tag), `::` một chiều, `:::` hai chiều.

## Quy trình sửa & phát hành

> ⚠️ **Không sửa trực tiếp trong vault.** Vault nằm trong iCloud Drive (Windows); iCloud hay đổi tên file đang ghi liên tục thành `main 2.js`, `x(1).md` → plugin hỏng. Sửa ở repo này (`C:\Users\dovan\Projects\obsidian-goi-y-tieng-anh`), xong mới chép một lần.

1. Sửa `main.js` / `styles.css` / `dict/*.txt` trong repo.
2. Nếu đổi `dict/`: `./build.ps1` (PowerShell 5.1; file lưu UTF-8 **có BOM** để in tiếng Việt đúng).
3. Chép vào vault: `main.js`, `styles.css`, `manifest.json` → `<vault>/.obsidian/plugins/goi-y-tieng-anh/`. Vault: `C:\Users\dovan\iCloudDrive\iCloud~md~obsidian\T1026`.
4. Tải lại: `obsidian plugin:reload id=goi-y-tieng-anh` (Obsidian CLI, cần app đang mở).
5. Phát hành: tăng `version` (`manifest.json`) + thêm vào `versions.json`, commit (kèm dòng `Co-Authored-By` nếu là AI), `git push`, rồi
   `gh release create <version> main.js manifest.json styles.css --title <version> --notes "..."`.
   **BRAT chỉ tải đúng 3 file đó** — dữ liệu khác phải nằm trong `main.js`.
6. Người dùng cập nhật: Ctrl+P → *BRAT: Check for updates to all beta plugins*.

## Kiểm thử (không có test tự động)

Dùng Obsidian CLI từ PowerShell trong thư mục vault:

- `obsidian eval code="..."` chạy JS trong Obsidian, trả về kết quả. Viết script vào file rồi gộp một dòng; **tránh `//` chú thích và dấu `"`** trong script (bị cắt khi truyền qua PowerShell).
- Lấy suggest: `app.workspace.editorSuggest.suggests.find(x => x.plugin === app.plugins.plugins['goi-y-tieng-anh'])`, gọi `onTrigger({line:0,ch:n}, {getLine:()=>text})` rồi `getSuggestions()`.
- Chọn thật: đặt `s.context = {editor, start, end, query, file}` rồi `s.selectSuggestion(item)`.
- Gõ phím thật: `obsidian dev:cdp method=Input.insertText 'params={\"text\":\"u\"}'` (không có dấu cách trong text).
- `obsidian dev:screenshot path=...`, `obsidian dev:errors`, `obsidian dev:dom selector=... text`.
- Lỗi `pdf-plus ... firstElementChild` trong `dev:errors` là của plugin khác, bỏ qua.
- Dọn file thử sau khi test (`app.vault.trash(file, false)`).

## Quy ước

- Code giống phong cách hiện có: không thư viện ngoài, chú thích ngắn bằng tiếng Việt, class CSS tiền tố `gyta-`.
- Không ghi thêm vào file của người dùng khi không cần (mỗi lần ghi = một lần iCloud đồng bộ). Thứ chỉ để xem (biến thể) thì vẽ DOM.
- Không ghi đè dòng thẻ ôn đã có (mất lịch ôn của Spaced Repetition).
- Từ điển: nghĩa ngắn gọn 1–3 nghĩa chính, phiên âm Mỹ. Từ hai cách đọc gộp một dòng: `close|kloʊz, kloʊs|động từ, tính từ|đóng; gần`.
- Liên quan: plugin **Giữ tên file iCloud** (`obsidian-icloud-giu-ten`) xử lý việc iCloud đổi tên file; ghi chú hướng dẫn người dùng nằm ở `Tiếng Anh/HD Plugin (Hướng dẫn Gợi ý tiếng Anh).md` trong vault.
