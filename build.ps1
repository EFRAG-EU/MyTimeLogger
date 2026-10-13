$ErrorActionPreference = 'Stop'

$script = [IO.File]::ReadAllText("$PSScriptRoot\mytimelogger.user.js", [Text.Encoding]::UTF8)
$version = [regex]::Match($script, '@version\s+(\S+)').Groups[1].Value
if ($script -notmatch "const VERSION = '$([regex]::Escape($version))';") {
    throw "@version $version and const VERSION in mytimelogger.user.js differ"
}

$wrapped = "(()=>{if(location.hostname!=='efrag.myprotime.eu'){alert('Open https://efrag.myprotime.eu and log in, then click Time Logger again.');return;}`n" +
    $script +
    "`ndocument.getElementById('mytimelogger').dispatchEvent(new Event('mytimelogger:toggle'));})();void 0"
$bookmarklet = 'javascript:' + [Uri]::EscapeDataString($wrapped)

$template = [IO.File]::ReadAllText("$PSScriptRoot\index.template.html", [Text.Encoding]::UTF8)
$html = $template.Replace('{{BOOKMARKLET}}', $bookmarklet).Replace('{{VERSION}}', $version)
[IO.File]::WriteAllText("$PSScriptRoot\index.html", $html, (New-Object Text.UTF8Encoding $false))

Write-Host "index.html built: version $version, bookmarklet $($bookmarklet.Length) characters"
