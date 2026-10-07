// static-apps.js -- registers simple link-out apps (no fetch/render logic
// of their own). A template for the simplest possible integration.
import { registerApp } from './core.js';
import { HOST_IP } from './config.js';

registerApp('pihole', {
  title: '&#x1F6E1; Pi-hole',
  bodyHtml: `
    <p style="color:#888;">Network-wide ad blocking and DNS.</p>
    <a class="goto-btn" href="http://${HOST_IP}:8080/admin" target="_blank">Open Pi-hole &rarr;</a>
  `,
});

