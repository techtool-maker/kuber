# Static file server for local preview of Kuber.
# ES modules require a real HTTP origin, so file:// will not work — use this.
$port = 5600
$root = Join-Path $PSScriptRoot "www"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $path = $req.Url.LocalPath
    if ($path -eq "/") { $path = "/index.html" }
    $file = Join-Path $root ($path.TrimStart("/"))
    if (Test-Path $file -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      if ($file.EndsWith(".html")) { $res.ContentType = "text/html; charset=utf-8" }
      elseif ($file.EndsWith(".js")) { $res.ContentType = "application/javascript; charset=utf-8" }
      elseif ($file.EndsWith(".css")) { $res.ContentType = "text/css; charset=utf-8" }
      elseif ($file.EndsWith(".json")) { $res.ContentType = "application/json; charset=utf-8" }
      elseif ($file.EndsWith(".svg")) { $res.ContentType = "image/svg+xml" }
      # No caching during development, so edits show up on reload.
      $res.Headers.Add("Cache-Control", "no-store")
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
    $res.OutputStream.Close()
  } catch { }
}
