param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\public')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $OutputDirectory)) {
  New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
}

function New-ChatLlmBitmap {
  param([int]$Size)

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#111827'))

  $scale = $Size / 512.0
  $bubble = [System.Drawing.RectangleF]::new(72 * $scale, 86 * $scale, 368 * $scale, 284 * $scale)
  $bubbleBrush = [System.Drawing.SolidBrush]::new(
    [System.Drawing.ColorTranslator]::FromHtml('#4F46E5')
  )
  $cornerRadius = [System.Drawing.SizeF]::new(54 * $scale, 54 * $scale)
  $graphics.FillRoundedRectangle($bubbleBrush, $bubble, $cornerRadius)

  $tail = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $tail.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(176 * $scale, 356 * $scale),
    [System.Drawing.PointF]::new(176 * $scale, 438 * $scale),
    [System.Drawing.PointF]::new(268 * $scale, 356 * $scale)
  ))
  $graphics.FillPath($bubbleBrush, $tail)

  $linePen = [System.Drawing.Pen]::new(
    [System.Drawing.ColorTranslator]::FromHtml('#C7D2FE'),
    [Math]::Max(2, 18 * $scale)
  )
  $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($linePen, 164 * $scale, 216 * $scale, 256 * $scale, 266 * $scale)
  $graphics.DrawLine($linePen, 256 * $scale, 266 * $scale, 348 * $scale, 216 * $scale)

  $nodeBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  foreach ($point in @(@(164, 216), @(256, 266), @(348, 216))) {
    $diameter = 48 * $scale
    $graphics.FillEllipse(
      $nodeBrush,
      ($point[0] * $scale) - ($diameter / 2),
      ($point[1] * $scale) - ($diameter / 2),
      $diameter,
      $diameter
    )
  }

  $nodeBrush.Dispose()
  $linePen.Dispose()
  $tail.Dispose()
  $bubbleBrush.Dispose()
  $graphics.Dispose()
  return $bitmap
}

foreach ($icon in @(
  @{ Name = 'apple-touch-icon.png'; Size = 180 },
  @{ Name = 'pwa-192x192.png'; Size = 192 },
  @{ Name = 'pwa-512x512.png'; Size = 512 }
)) {
  $bitmap = New-ChatLlmBitmap -Size $icon.Size
  try {
    $path = Join-Path $OutputDirectory $icon.Name
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
}

$faviconBitmap = New-ChatLlmBitmap -Size 64
$iconHandle = $faviconBitmap.GetHicon()
$favicon = [System.Drawing.Icon]::FromHandle($iconHandle)
$stream = [System.IO.File]::Create((Join-Path $OutputDirectory 'favicon.ico'))
try {
  $favicon.Save($stream)
} finally {
  $stream.Dispose()
  $favicon.Dispose()
  $faviconBitmap.Dispose()
}
