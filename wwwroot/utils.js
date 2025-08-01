// utils.js
export function log(msg) {
    const el = document.getElementById('log');
    if (!el) return;
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
}
