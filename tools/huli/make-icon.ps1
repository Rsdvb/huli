# Huli's app icon: a rounded square in warm fox colours with the character 狐, written to
# build/icon.png (1024 px) and build/icon.ico (16-256 px). Run from the repository root.
Add-Type -AssemblyName System.Drawing

function New-HuliBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [float]($size * 0.22)
  $pad = [float]($size * 0.04)
  $w = [float]($size - 2 * $pad)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($pad, $pad, 2 * $r, 2 * $r, 180, 90)
  $path.AddArc($pad + $w - 2 * $r, $pad, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($pad + $w - 2 * $r, $pad + $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $path.AddArc($pad, $pad + $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()
  $rect = New-Object System.Drawing.RectangleF $pad, $pad, $w, $w
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 255, 153, 51)), ([System.Drawing.Color]::FromArgb(255, 214, 72, 28)), 45
  $g.FillPath($brush, $path)
  $font = New-Object System.Drawing.Font 'Microsoft YaHei UI', ([float]($size * 0.52)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $textRect = New-Object System.Drawing.RectangleF 0, ([float]($size * 0.02)), $size, $size
  $g.DrawString([string][char]0x72D0, $font, [System.Drawing.Brushes]::White, $textRect, $fmt)
  $g.Dispose()
  return $bmp
}

$root = (Get-Location).Path
$big = New-HuliBitmap 1024
$big.Save((Join-Path $root 'build\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

# ICO with PNG-compressed entries, largest first.
$sizes = 256, 128, 64, 48, 32, 16
$images = foreach ($s in $sizes) {
  $b = New-HuliBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
  , $ms.ToArray()
}
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $images[$i].Length
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$len); $bw.Write([uint32]$offset)
  $offset += $len
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $root 'build\icon.ico'), $out.ToArray())
Write-Output "icon: build\icon.png and build\icon.ico written"
