# A00 — học từ vựng tiếng Anh trong Obsidian

Gõ một từ, popup hiện các từ/cụm từ có trong thư mục từ vựng của bạn (kèm phiên âm, từ loại, nghĩa). Chọn một từ thì chữ đang gõ được thay bằng wikilink, ví dụ `[[hello]]` hoặc `[[look up]]`. Mỗi từ có thể tự sinh thẻ ôn cho plugin Spaced Repetition.

## Cài bằng BRAT

1. Cài plugin **BRAT** (Obsidian42 - BRAT) trong Community plugins.
2. Ctrl+P → **BRAT: Add a beta plugin for testing**.
3. Dán đường dẫn repo này, chọn phiên bản mới nhất → **Add plugin**.
4. Bật **A00** trong Settings → Community plugins.

Cập nhật: Ctrl+P → **BRAT: Check for updates to all beta plugins**.

## Từ điển có sẵn (3.000 từ)

Gõ từ chưa có ghi chú vẫn ra gợi ý (nhãn *từ điển*, kèm phiên âm Mỹ và nghĩa tiếng Việt). Chọn thì chèn link và **tự tạo ghi chú + thẻ ôn** — chỉ từ bạn dùng mới thành ghi chú.

- Từ điển gợi ý khi gõ ≥ 3 chữ, và không gợi ý trên dòng đang có chữ tiếng Việt (tránh nhầm khi gõ Telex: `con`, `the`…).
- Gồm từ thông dụng A–Z và một nhóm thuật ngữ lập trình/điện tử.
- Dữ liệu nằm trong `dict/*.txt`, mỗi dòng `từ|phiên âm|từ loại|nghĩa`. Sửa xong chạy `./build.ps1` để nhúng vào `main.js` (BRAT chỉ tải `main.js`, nên dữ liệu phải nằm trong đó).

## Học theo ngữ cảnh

- **Lưu câu gặp từ**: chọn từ trong popup → khi viết xong câu (`.` `!` `?` hoặc xuống dòng), câu được chép vào `## Ví dụ` của ghi chú từ (kèm link nguồn). Cần ≥ 3 từ tiếng Anh khác trong câu.
- **Thẻ điền chỗ trống**: mỗi câu ví dụ → `We need to ==sustain== growth.` (plugin Spaced Repetition đổi `==…==` thành thẻ cloze). Câu cũ: lệnh *Tạo thẻ ôn cho các từ chưa có thẻ* tìm từ và mọi biến thể trong câu.
- **Cụm từ đi kèm**: lệnh *Thêm cụm từ đi kèm* → dòng `- **sustain growth** — duy trì tăng trưởng` trong `## Cụm từ`, thẻ `**sustain growth**:::…`, và `cum_tu` trong frontmatter để popup gợi ý cụm (chèn `[[sustain|sustain growth]]`).
- Thẻ *gốc từ* / *tách từ* mặc định **tắt** — cấu tạo từ chỉ còn là gợi ý khi xem ghi chú.

## Gốc từ: tiền tố, gốc, hậu tố

Học theo họ từ (in- + **spir** + e = thổi hơi vào → truyền cảm hứng):

- Ghi chú từ có dòng **Phân tích** tô màu: tiền tố đỏ, gốc xanh, hậu tố cam, kèm nghĩa từng mảnh. Lưu trong `phan_tich: "in- + spir + e"` (tiền tố có `-` phía sau, hậu tố có `-` phía trước).
- Chưa có `phan_tich` thì hiện **Đề xuất tách** (tự đoán từ bảng ~40 tiền tố, ~35 hậu tố, ~90 gốc Latin/Hy Lạp) và nút **Dùng cách tách này**. Chỉ đề xuất khi thấy gốc từ trong bảng, hoặc tiền tố + từ có thật (un- + happy), hoặc từ + hậu tố (kind + -ness).
- **Cùng gốc**: các từ khác chung gốc (ghi chú + từ điển).
- Bấm một mảnh → mở/tạo ghi chú `Tiếng Anh/Gốc từ/spir.md` (`con-.md`, `-ation.md`), trong đó có khung **Họ từ** chia theo động từ / danh từ / tính từ / trạng từ. Từ chưa có ghi chú hiện viền nét đứt, bấm là tạo.
- Thẻ ôn: `**spir** (gốc từ)::thở, thổi hơi` và `**inspire** (tách từ)::in- (vào trong) + spir (thở) + e`.
- Khối ` ```goc-tu ``` ` trong ghi chú bất kỳ: để trống = **mục lục** mọi tiền tố / gốc / hậu tố (số từ, ví dụ); mỗi dòng `spir`, `con-`, `-ation` = **họ từ** của mảnh đó; dòng `tiền tố` / `gốc từ` / `hậu tố` = mục lục một loại. Lệnh *Mở mục lục gốc từ* tạo sẵn ghi chú `Tiếng Anh/Mục lục gốc từ.md`.
- Lệnh *Tách hàng loạt các từ chưa có phân tích*: danh sách đề xuất, sửa / bỏ chọn rồi lưu một lần.

## Phím trong popup

- <kbd>↑</kbd> <kbd>↓</kbd> chọn, <kbd>Enter</kbd> hoặc <kbd>Tab</kbd> chèn link, <kbd>Esc</kbd> đóng.
- <kbd>Enter</kbd> luôn chèn link (kể cả gõ trọn từ). Cài đặt **Enter khi đã gõ trọn từ → Xuống dòng** nếu muốn Enter xuống dòng khi chữ đã trùng khớp gợi ý đầu (lúc đó dùng <kbd>Tab</kbd> để chèn). Tuỳ chọn **Dấu cách cũng chèn link** (mặc định tắt).
- Không gợi ý trong frontmatter, khối code ` ``` ` và công thức `$$`.

## Ghi chú từ vựng

Mỗi từ là một ghi chú, tên file chính là từ đó (`hello.md`, `look up.md`, `GPIO.md`):

```markdown
---
ipa: "/həˈloʊ/"
loai: "thán từ"
nghia: "xin chào"
aliases: [hullo]
tags: [tu-vung, flashcards/tieng-anh]
---

## Ví dụ
- Hello, how are you? — Xin chào, bạn khỏe không?

## Thẻ ôn

**hello** /həˈloʊ/:::xin chào (thán từ)

## Ghi chú
```

- `aliases`: từ đồng nghĩa / cách viết khác (hullo) cũng gõ ra được.
- `## Thẻ ôn`: dòng `:::` tạo thẻ hai chiều cho Spaced Repetition.

## Biến thể (chia động từ, số nhiều, so sánh)

Chỉ cần một ghi chú cho dạng gốc. Plugin tự sinh biến thể theo `loai`, gõ biến thể sẽ ra gợi ý và link về dạng gốc nhưng giữ chữ đã chia:

```
Yesterday I wen   →   Yesterday I [[go|went]]
She gave u        →   She [[give up|gave up]]
two childr        →   two [[child|children]]
```

| `loai` chứa | Tự sinh |
|---|---|
| động từ (kể cả cụm động từ) | -s/-es, quá khứ, quá khứ phân từ, -ing; cụm động từ chia từ đầu (look up → looked up) |
| danh từ | số nhiều (box → boxes, city → cities, child → children) |
| tính từ (ngắn) | so sánh hơn / nhất (big → bigger, biggest; happy → happier) |

- Biến thể không ghi vào file; mở ghi chú từ vựng sẽ thấy dòng **Biến thể: goes · went · gone · going** dưới tiêu đề (tắt được trong cài đặt).
- Kèm sẵn bảng ~150 động từ bất quy tắc (go-went-gone, take-took-taken…).
- Động từ bất quy tắc có thêm thẻ `**go** (V2 – V3)::went – gone`.
- Quy tắc sai/thiếu (prefer → preferred): thêm vào `bien_the: [preferred, preferring]`.
- Từ bất quy tắc không có trong bảng: Cài đặt → **Bảng bất quy tắc bổ sung**, mỗi dòng một từ, áp dụng cho mọi ghi chú:

  ```
  dwell dwelt dwelt          # 3 từ: động từ V1 V2 V3 (hoặc tính từ gốc/hơn/nhất)
  crisis crises              # 2 từ: danh từ số nhiều
  cactus cacti/cactuses      # dạng thay thế cách nhau bằng /
  sheep sheep                # số nhiều giống số ít -> không sinh "sheeps"
  ```
- Không muốn chia (thuật ngữ, tên riêng): `khong_chia: true`. Có thể kết hợp với `bien_the` để dùng đúng danh sách của bạn thay cho phần tự sinh (lie = nói dối: `khong_chia: true`, `bien_the: [lies, lied, lying]`). Từ có chữ hoa hoặc ký tự `_`, số (GPIO, HAL_…) tự động không chia.

## Cài đặt

- **Thư mục từ vựng**: danh sách nhiều thư mục, mỗi thư mục có tag bộ thẻ ôn riêng (`flashcards/tieng-anh`, `flashcards/stm32`…), bật/tắt hoặc xoá được. Để trống tag nếu không muốn tạo thẻ.
- Hiện popup phía trên hay dưới con trỏ, số ký tự tối thiểu, số từ tối đa của cụm, số gợi ý tối đa.

## Lệnh

- **Thêm từ vựng mới**: mở hộp thoại nhập từ, phiên âm, nghĩa, ví dụ; chữ đang bôi đen được thay bằng link.
- **Tạo thẻ ôn cho các từ chưa có thẻ**: dành cho ghi chú tự viết tay.
- **Bật/tắt gợi ý khi gõ**.

## Phát hành bản mới

1. Tăng `version` trong `manifest.json` và thêm dòng vào `versions.json`.
2. Commit, push.
3. Tạo release có tag đúng bằng version, đính kèm `main.js`, `manifest.json`, `styles.css`:

```bash
gh release create 0.2.1 main.js manifest.json styles.css --title 0.2.1 --notes "..."
```
