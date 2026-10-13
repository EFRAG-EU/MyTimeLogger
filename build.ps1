$ErrorActionPreference = 'Stop'

$script = [IO.File]::ReadAllText("$PSScriptRoot\mytimelogger.user.js", [Text.Encoding]::UTF8)
$version = [regex]::Match($script, '@version\s+(\S+)').Groups[1].Value

$wrapped = "(()=>{if(location.hostname!=='efrag.myprotime.eu'){alert('Open https://efrag.myprotime.eu and log in, then click Time Logger again.');return;}`n" +
    $script +
    "`ndocument.getElementById('mytimelogger').dispatchEvent(new Event('mytimelogger:toggle'));})();void 0"
$bookmarklet = 'javascript:' + [Uri]::EscapeDataString($wrapped)

$template = [IO.File]::ReadAllText("$PSScriptRoot\install.template.html", [Text.Encoding]::UTF8)
$html = $template.Replace('{{BOOKMARKLET}}', $bookmarklet).Replace('{{VERSION}}', $version)
[IO.File]::WriteAllText("$PSScriptRoot\install.html", $html, (New-Object Text.UTF8Encoding $false))

Write-Host "install.html built: version $version, bookmarklet $($bookmarklet.Length) characters"
