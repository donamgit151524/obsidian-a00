# Gợi ý tiếng Anh (Obsidian plugin)

Gõ một từ, popup hiện các từ/cụm từ có trong thư mục từ vựng của bạn (kèm phiên âm, từ loại, nghĩa). Chọn một từ thì chữ đang gõ được thay bằng wikilink, ví dụ `[[hello]]` hoặc `[[look up]]`. Mỗi từ có thể tự sinh thẻ ôn cho plugin Spaced Repetition.

## Cài bằng BRAT

1. Cài plugin **BRAT** (Obsidian42 - BRAT) trong Community plugins.
2. Ctrl+P → **BRAT: Add a beta plugin for testing**.
3. Dán đường dẫn repo này, chọn phiên bản mới nhất → **Add plugin**.
4. Bật **Gợi ý tiếng Anh** trong Settings → Community plugins.

Cập nhật: Ctrl+P → **BRAT: Check for updates to all beta plugins**.

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

- `aliases`: các dạng khác (looked up, looking up…) cũng gõ ra được.
- `## Thẻ ôn`: dòng `:::` tạo thẻ hai chiều cho Spaced Repetition.

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
