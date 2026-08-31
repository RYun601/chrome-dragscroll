# 生成扩展图标（128/48/16 PNG）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = $size / 128.0
  $p = { param($v) [float]($v * $s) }

  $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 61, 123, 255))
  $radius = & $p 30
  $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $rect = New-Object System.Drawing.RectangleF((& $p 6), (& $p 6), (& $p 116), (& $p 116))
  $path2.AddArc($rect.X, $rect.Y, $radius*2, $radius*2, 180, 90)
  $path2.AddArc($rect.X + $rect.Width - $radius*2, $rect.Y, $radius*2, $radius*2, 270, 90)
  $path2.AddArc($rect.X + $rect.Width - $radius*2, $rect.Y + $rect.Height - $radius*2, $radius*2, $radius*2, 0, 90)
  $path2.AddArc($rect.X, $rect.Y + $rect.Height - $radius*2, $radius*2, $radius*2, 90, 90)
  $path2.CloseFigure()
  $g.FillPath($blue, $path2)

  $white = New-Object System.Drawing.Pen ([System.Drawing.Color]::White, [float](& $p 4))
  $selRect = New-Object System.Drawing.RectangleF((& $p 28), (& $p 30), (& $p 72), (& $p 44))
  $g.DrawRectangle($white, $selRect.X, $selRect.Y, $selRect.Width, $selRect.Height)

  $cross = New-Object System.Drawing.Pen ([System.Drawing.Color]::White, [float](& $p 3))
  $cx = & $p 64; $cy = & $p 52
  $g.DrawLine($cross, $cx - (& $p 10), $cy, $cx + (& $p 10), $cy)
  $g.DrawLine($cross, $cx, $cy - (& $p 10), $cx, $cy + (& $p 10))

  $arrPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White, [float](& $p 5))
  $arrPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $arrPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $ax = & $p 64; $ay = & $p 84
  $g.DrawLine($arrPen, $ax - (& $p 10), $ay - (& $p 4), $ax, $ay + (& $p 6))
  $g.DrawLine($arrPen, $ax + (& $p 10), $ay - (& $p 4), $ax, $ay + (& $p 6))

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "saved: $path ($size x $size)"
}

New-Icon 128 (Join-Path $dir 'icon128.png')
New-Icon 48  (Join-Path $dir 'icon48.png')
New-Icon 16  (Join-Path $dir 'icon16.png')
Get-ChildItem $dir | Select-Object Name, Length
