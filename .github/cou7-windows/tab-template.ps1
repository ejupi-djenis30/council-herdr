function Get-Cou7TabPlan([Drawing.Bitmap]$frame,[Drawing.Bitmap]$template,[int]$windowLeft,[int]$windowTop) {
  if ($frame.Width -ne 1008 -or $frame.Height -ne 696 -or $template.Width -ne 96 -or $template.Height -ne 24) {
    return @{ matched=$false; reason='unexpected_geometry'; point=$null }
  }
  [long]$difference=0
  for($y=0;$y -lt $template.Height;$y++) {
    for($x=0;$x -lt $template.Width;$x++) {
      $a=$template.GetPixel($x,$y); $b=$frame.GetPixel($x+326,$y+218)
      $difference += [Math]::Abs([int]$a.R-[int]$b.R)+[Math]::Abs([int]$a.G-[int]$b.G)+[Math]::Abs([int]$a.B-[int]$b.B)
    }
  }
  $score=$difference/($template.Width*$template.Height*3)
  if ($score -gt 3.0) { return @{ matched=$false; reason='template_mismatch'; score=$score; point=$null } }
  return @{ matched=$true; score=$score; local=@(375,230); origin=@(($windowLeft+16),($windowTop+16)); point=@(($windowLeft+16+375),($windowTop+16+230)) }
}
