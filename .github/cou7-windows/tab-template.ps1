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
function Get-Cou7HandoffPlan([Drawing.Bitmap]$frame,[Drawing.Bitmap]$header,[Drawing.Bitmap]$guidance,[Drawing.Bitmap]$button,[int]$windowLeft,[int]$windowTop) {
  if ($frame.Width -ne 1008 -or $frame.Height -ne 696 -or $header.Width -ne 155 -or $header.Height -ne 24 -or $guidance.Width -ne 370 -or $guidance.Height -ne 39 -or $button.Width -ne 143 -or $button.Height -ne 23) {
    return @{matched=$false;reason='unexpected_geometry';point=$null}
  }
  $headerScore=Get-Cou7RegionScore $frame $header 84 143
  $guidanceScore=Get-Cou7RegionScore $frame $guidance 84 229
  $buttonScore=Get-Cou7RegionScore $frame $button 777 141
  if($headerScore -gt 3.0 -or $guidanceScore -gt 3.0 -or $buttonScore -gt 3.0) {return @{matched=$false;reason='handoff_template_mismatch';headerScore=$headerScore;guidanceScore=$guidanceScore;buttonScore=$buttonScore;point=$null}}
  return @{matched=$true;headerScore=$headerScore;guidanceScore=$guidanceScore;buttonScore=$buttonScore;local=@(850,153);origin=@(($windowLeft+16),($windowTop+16));point=@(($windowLeft+16+850),($windowTop+16+153))}
}
function Get-Cou7DelegationPlan([Drawing.Bitmap]$frame,[Drawing.Bitmap]$criteria,[Drawing.Bitmap]$button,[Drawing.Bitmap]$capture,[int]$windowLeft,[int]$windowTop) {
  if ($frame.Width -ne 1008 -or $frame.Height -ne 696 -or $criteria.Width -ne 187 -or $criteria.Height -ne 18 -or $button.Width -ne 129 -or $button.Height -ne 27 -or $capture.Width -ne 157 -or $capture.Height -ne 23) { return @{matched=$false;reason='unexpected_geometry';point=$null} }
  $criteriaScore=Get-Cou7RegionScore $frame $criteria 85 254
  $buttonScore=Get-Cou7RegionScore $frame $button 86 413
  $captureScore=Get-Cou7RegionScore $frame $capture 366 578
  if($criteriaScore -gt 3.0 -or $buttonScore -gt 3.0 -or $captureScore -gt 3.0) { return @{matched=$false;reason='delegation_template_mismatch';criteriaScore=$criteriaScore;buttonScore=$buttonScore;captureScore=$captureScore;point=$null} }
  return @{matched=$true;criteriaScore=$criteriaScore;buttonScore=$buttonScore;captureScore=$captureScore;local=@(150,426);origin=@(($windowLeft+16),($windowTop+16));point=@(($windowLeft+166),($windowTop+442))}
}
function Get-Cou7ConfirmPlan([Drawing.Bitmap]$frame,[Drawing.Bitmap]$title,[Drawing.Bitmap]$role,[Drawing.Bitmap]$button,[int]$windowLeft,[int]$windowTop) {
  if($frame.Width -ne 1008 -or $frame.Height -ne 696 -or $title.Width -ne 275 -or $title.Height -ne 22 -or $role.Width -ne 110 -or $role.Height -ne 18 -or $button.Width -ne 146 -or $button.Height -ne 30) {return @{matched=$false;reason='unexpected_geometry';point=$null}}
  $titleScore=Get-Cou7RegionScore $frame $title 70 128
  $roleScore=Get-Cou7RegionScore $frame $role 85 280
  $buttonScore=Get-Cou7RegionScore $frame $button 85 410
  if($titleScore -gt 3.0 -or $roleScore -gt 3.0 -or $buttonScore -gt 3.0) {return @{matched=$false;reason='confirm_template_mismatch';titleScore=$titleScore;roleScore=$roleScore;buttonScore=$buttonScore;point=$null}}
  return @{matched=$true;titleScore=$titleScore;roleScore=$roleScore;buttonScore=$buttonScore;local=@(158,425);origin=@(($windowLeft+16),($windowTop+16));point=@(($windowLeft+174),($windowTop+441))}
}
