// static-apps.js -- registers simple link-out apps (no fetch/render logic
// of their own). A template for the simplest possible integration.
import { registerApp } from './core.js';
// Read as a global, not a static `import` from config.js -- see the
// matching comment in mealie.js for why.
const HOST_IP = window.HOST_IP || location.hostname;

registerApp('pihole', {
  title: '&#x1F6E1; Pi-hole',
  bodyHtml: `
    <p style="color:#888;">Network-wide ad blocking and DNS.</p>
    <a class="goto-btn" href="http://${HOST_IP}:8080/admin" target="_blank">Open Pi-hole &rarr;</a>
  `,
});

