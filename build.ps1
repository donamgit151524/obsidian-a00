# Nhúng từ điển dict/*.txt vào main.js (giữa hai dòng @@DICT_START / @@DICT_END).
# BRAT chỉ tải main.js, manifest.json, styles.css nên dữ liệu phải nằm trong main.js.
#
# Mỗi dòng dict: từ|phiên âm (không có /)|từ loại|nghĩa
# Dòng trống và dòng bắt đầu bằng # bị bỏ qua. Từ trùng: giữ dòng đầu tiên.
param([string]$Target = (Join-Path $PSScriptRoot "main.js"))

$ErrorActionPreference = "Stop"
$utf8 = New-Object Text.UTF8Encoding $false

$seen = @{}
$lines = New-Object Collections.Generic.List[string]
$problems = New-Object Collections.Generic.List[string]

foreach ($file in Get-ChildItem (Join-Path $PSScriptRoot "dict") -Filter *.txt | Sort-Object Name) {
  $n = 0
  foreach ($raw in [IO.File]::ReadAllLines($file.FullName, $utf8)) {
    $n++
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $p = $line.Split("|")
    if ($p.Count -ne 4 -or -not $p[0].Trim() -or -not $p[3].Trim()) { $problems.Add("$($file.Name):$n sai định dạng: $line"); continue }
    if ($line -match '[`\\]' -or $line.Contains('${')) { $problems.Add("$($file.Name):$n có ký tự cấm (`` \ `${): $line"); continue }
    $key = $p[0].Trim().ToLowerInvariant()
    if ($seen.ContainsKey($key)) { $problems.Add("$($file.Name):$n trùng '$key' (đã có ở $($seen[$key]))"); continue }
    $seen[$key] = "$($file.Name):$n"
    $lines.Add((($p | ForEach-Object { $_.Trim() }) -join "|"))
  }
}

$text = [IO.File]::ReadAllText($Target, $utf8)
$pattern = '(?s)(// @@DICT_START[^\n]*\n).*?(\n// @@DICT_END)'
if ($text -notmatch $pattern) { throw "Không thấy @@DICT_START / @@DICT_END trong $Target" }
$data = "const DICT_DATA = ``" + ($lines -join "`n") + "``;"
$text = [regex]::Replace($text, $pattern, { param($m) $m.Groups[1].Value + $data + $m.Groups[2].Value })
[IO.File]::WriteAllText($Target, $text, $utf8)

"Đã nhúng $($lines.Count) từ vào $Target"
if ($problems.Count) { "Bỏ qua $($problems.Count) dòng:"; $problems | ForEach-Object { "  $_" } }
