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
function Get-Cou7RegionScore([Drawing.Bitmap]$frame,[Drawing.Bitmap]$template,[int]$left,[int]$top) {
  [long]$difference=0
  for($y=0;$y -lt $template.Height;$y++) {
    for($x=0;$x -lt $template.Width;$x++) {
      $a=$template.GetPixel($x,$y);$b=$frame.GetPixel($left+$x,$top+$y)
      $difference += [Math]::Abs([int]$a.R-[int]$b.R)+[Math]::Abs([int]$a.G-[int]$b.G)+[Math]::Abs([int]$a.B-[int]$b.B)
    }
  }
  return $difference/($template.Width*$template.Height*3)
}
function Get-Cou7ItemPlan([Drawing.Bitmap]$frame,[Drawing.Bitmap]$title,[Drawing.Bitmap]$button,[int]$windowLeft,[int]$windowTop) {
  if ($frame.Width -ne 1008 -or $frame.Height -ne 696 -or $title.Width -ne 204 -or $title.Height -ne 18 -or $button.Width -ne 119 -or $button.Height -ne 22) {
    return @{ matched=$false; reason='unexpected_geometry'; point=$null }
  }
  $titleScore=Get-Cou7RegionScore $frame $title 85 476
  $buttonScore=Get-Cou7RegionScore $frame $button 89 563
  if ($titleScore -gt 3.0 -or $buttonScore -gt 3.0) { return @{matched=$false;reason='item_template_mismatch';titleScore=$titleScore;buttonScore=$buttonScore;point=$null} }
  return @{matched=$true;titleScore=$titleScore;buttonScore=$buttonScore;local=@(150,575);origin=@(($windowLeft+16),($windowTop+16));point=@(($windowLeft+16+150),($windowTop+16+575))}
}
