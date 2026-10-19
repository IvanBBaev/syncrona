import '@servicenow/sdk/global'
import { UiPage } from '@servicenow/sdk/core'

UiPage({
    $id: Now.ID['page_min'],
    endpoint: 'x_snc_bprobe_minimal.do',
})

UiPage({
    $id: Now.ID['page_full'],
    endpoint: 'x_snc_bprobe_full.do',
    description: 'A full page',
    direct: true,
    category: 'general',
    html: `<?xml version="1.0" encoding="utf-8" ?>
<j:jelly trim="false" xmlns:j="jelly:core" xmlns:g="glide" xmlns:j2="null" xmlns:g2="null">
  <g:evaluate var="jvar_count">var n = 1 &lt; 2; n;</g:evaluate>
  <!-- a comment -- here -->
  <div class="a" id='b' data-x="1 &amp; 2">Hello &nbsp; \${jvar_count}</div>
  <br/>
  <script>if (a &lt; b &amp;&amp; c < d) { x(); }</script>
  <style>a > b { color: red; }</style>
  <textarea name="t">plain text</textarea>
  <span>007</span><span>1.50</span>
</j:jelly>`,
    clientScript: 'function onClick() { alert("hi"); }',
    processingScript: 'gs.info("processed");',
})

UiPage({
    $id: Now.ID['page_globals_full'],
    endpoint: 'x_snc_bprobe_globals_full.do',
    html: '<j:jelly xmlns:j="jelly:core" xmlns:g="glide"><sdk:now-ux-globals></sdk:now-ux-globals><div id="root"></div></j:jelly>',
    clientScript: '',
    processingScript: '',
})

UiPage({
    $id: Now.ID['page_globals_min'],
    endpoint: 'x_snc_bprobe_globals_min.do',
    html: '<j:jelly xmlns:j="jelly:core"><sdk:now-ux-globals mode="minimal" theme-id="abc123"/><div/></j:jelly>',
})

UiPage({
    $id: Now.ID['page_globals_theme'],
    endpoint: 'x_snc_bprobe_globals_theme.do',
    html: '<html><head><sdk:now-ux-globals theme-id="t1"/></head><body></body></html>',
    description: '',
    category: 'kb',
})

UiPage({
    $id: Now.ID['page_empty_html'],
    endpoint: 'x_snc_bprobe_empty.do',
    html: '',
})
