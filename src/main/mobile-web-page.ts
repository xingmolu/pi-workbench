import { mobileClientScript } from './mobile-web-client'
import { mobilePageCss } from './mobile-web-css'

export function mobileManifest(): string {
  return JSON.stringify({
    name: 'Pi 远程对话',
    short_name: 'Pi',
    display: 'standalone',
    start_url: '/',
    background_color: '#0b0b0c',
    theme_color: '#0b0b0c',
    lang: 'zh-CN'
  })
}

export function mobilePageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <meta name="theme-color" content="#0b0b0c"/>
  <link rel="manifest" href="/manifest.webmanifest"/>
  <link rel="stylesheet" href="/mobile.css"/>
  <title>Pi 远程对话</title>
  <script>
    try {
      var t = localStorage.getItem('pi-mobile-theme');
      if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    } catch (e) {}
  </script>
</head>
<body>
  <div id="app"></div>
  <script src="/mobile.js" defer></script>
</body>
</html>`
}

export { mobileClientScript, mobilePageCss }
