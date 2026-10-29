# Builds every mannequin pose for both fits, compresses them for the web and copies
# them into the Hydrogen app's public/models folder.
$ErrorActionPreference = "Stop"
$env:BLENDER_USER_RESOURCES = "E:\revex-3d-folder\tools\blender-user"
$T = "E:\revex-3d-folder\tools"
$C = "$T\assets\mh\clothes"
$Blender = "$T\blender-4.5.15-windows-x64\blender.exe"
$GT = "$T\gltf\node_modules\.bin\gltf-transform.cmd"
$Out = "E:\revex-3d-folder\revex-3d-repo\public\models"

$fits = @(
  @{ gender = "male"; shirt = "$C\elvs_crude_t-shirt_male\elvs_crude_t-shirt_male.mhclo";
     hair = "$T\assets\mh\hair\short02\short02.mhclo" },
  @{ gender = "female"; shirt = "$C\joepal_crude_t-shirt_female\joepal_crude_t-shirt_female.mhclo";
     hair = "$T\assets\mh\hair\ponytail01\ponytail01.mhclo" }
)
$poses = @("relaxed", "hand_on_hip", "pocket")
$pants = "$C\toigo_harem_pants\toigo_harem_pants.mhclo"

foreach ($fit in $fits) {
  foreach ($pose in $poses) {
    $name = "$($fit.gender)-$pose"
    $hairArgs = if ($fit.hair) { @("--hair", $fit.hair) } else { @() }
    & $Blender -b --factory-startup --python "$T\mannequin\build_mannequin.py" -- `
      --gender $fit.gender --pose $pose --shirt $fit.shirt --pants $pants @hairArgs `
      --out "$T\mannequin\$name.glb" 2>&1 | Select-String -Pattern "export\]|Traceback|Error"
    & $GT optimize "$T\mannequin\$name.glb" "$Out\mannequin-$name.glb" `
      --compress meshopt --join false --flatten false --simplify false `
      --texture-compress false --texture-size 512 --prune-attributes false 2>&1 | Select-String -Pattern "error"
  }
}
Get-ChildItem "$Out\*.glb" | Select-Object Name, @{n = 'KB'; e = { [math]::Round($_.Length / 1KB) } }
