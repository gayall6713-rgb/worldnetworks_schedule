// 현장스케줄 앱 서비스워커 — 화면 파일만 저장, 구글 연동 데이터는 항상 실시간으로 받음
// v2: 새로 올린 화면이 바로 보이도록 브라우저 임시 저장(캐시)을 건너뛰고 항상 서버에서 새로 받음
const CACHE = 'schedule-app-v2';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // 같은 사이트의 GET 요청만 처리 (구글 Apps Script·외부 라이브러리는 건드리지 않음)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // 항상 서버에서 최신 파일을 받음 (cache:'no-cache'), 인터넷이 안 될 때만 저장본 사용
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
