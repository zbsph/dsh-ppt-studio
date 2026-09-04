# 原始模板逐页 PNG 导出（保真对照用）：PowerPoint COM（本机有 Office 时可用）
param([string]$Src = 'C:\Users\11867\Desktop\ppt模板库', [string]$Out = 'C:\Users\11867\.dsh\ppt-studio\fidelity\orig')
$pp = New-Object -ComObject PowerPoint.Application
$pp.Visible = -1
foreach ($f in Get-ChildItem $Src -Filter '*.pptx') {
  $dir = Join-Path $Out $f.BaseName
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $pres = $pp.Presentations.Open($f.FullName, -1, 0, 0)
  $n = $pres.Slides.Count
  for ($i = 1; $i -le $n; $i++) {
    $pres.Slides.Item($i).Export((Join-Path $dir ('{0:D2}.png' -f $i)), 'PNG', 1920, 1080)
  }
  $pres.Close()
  Write-Output ("{0}: {1} slides" -f $f.Name, $n)
}
$pp.Quit()
Write-Output 'DONE'
