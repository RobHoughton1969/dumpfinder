/* sw.js — the service worker.
 *
 * A service worker is a small script the browser keeps running in the
 * background, separate from the page. Its job here is one thing only:
 * to sit between the app and the network and answer every request out
 * of a local copy, so the app opens and works with the phone in flight
 * mode.
 *
 * It has three moments in its life:
 *   install  — happens once, when a new version of this file appears.
 *              We use it to download and store every file the app needs.
 *   activate — happens when the new version takes over. We use it to
 *              throw away the previous version's stored copies.
 *   fetch    — happens on every single request the app makes. We answer
 *              from storage if we have it, and only go to the network
 *              if we don't.
 *
 * IMPORTANT: after you run fetch_points.py and replace points.json,
 * change the version number below (v1 -> v2 -> v3 ...). That is what
 * tells the phone "this is new, throw the old copies away and fetch
 * everything again". Without it the phone will happily keep serving
 * the old data forever, which is exactly what you want in the bush and
 * exactly what you don't want after an update.
 */

var CACHE_NAME = "dumpfinder-v6";

/* The files the app cannot run without. If any one of these fails to
   download, the whole install fails and the old version stays put —
   which is the behaviour we want, rather than a half-installed app. */
var CORE_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./leaflet.js",
  "./leaflet.css"
];

/* Map tiles live in their own store. They are not part of the app, they
   accumulate as you look around, and they must survive an app update —
   so they are kept apart from the versioned cache above and never
   deleted when the version number changes. */
var TILE_CACHE = "dumpfinder-tiles";
var TILE_HOSTS = ["tile.openstreetmap.org"];
var MAX_TILES = 3000;          // roughly 150 MB at worst; usually far less

/* points.json is handled separately because it might not exist yet —
   until you run the Python script the app falls back to its built-in
   sample data, and a missing file here must not break the install. */
var OPTIONAL_FILES = ["./points.json"];

self.addEventListener("install", function (event) {
  // waitUntil says "don't call the install finished until this is done".
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(CORE_FILES).then(function () {
        // Try the optional ones, but swallow any failure.
        return Promise.all(OPTIONAL_FILES.map(function (url) {
          return cache.add(url).catch(function () { return null; });
        }));
      });
    }).then(function () {
      // Take over straight away instead of waiting for every tab to close.
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        // Anything from an older version number gets deleted.
        return name === CACHE_NAME ? null : caches.delete(name);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;

  if (request.method !== "GET") return;

  var url = new URL(request.url);

  // Map tiles: serve a stored one if we have it, otherwise fetch and keep it.
  if (TILE_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(serveTile(request));
    return;
  }

  // Everything else: only our own files.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) return hit;                    // stored copy — no network needed

      return fetch(request).then(function (response) {
        // Quietly file away anything new we successfully fetched, so it
        // is there next time even if the next time is offline.
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        // Offline and not stored. For a page request, fall back to the
        // app shell so the user gets the app rather than a browser error.
        if (request.mode === "navigate") return caches.match("./index.html");
        return new Response("", { status: 504, statusText: "Offline" });
      });
    })
  );
});

/* Tiles are fetched from another website, so the browser hands them back
   as an "opaque" response — we can store and replay it but not look
   inside it. That is fine for a picture. It does mean we can't tell a
   real tile from an error page, so only responses that arrived without
   throwing get kept. */
function serveTile(request) {
  return caches.open(TILE_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;

      return fetch(request).then(function (response) {
        cache.put(request, response.clone());
        trimTiles(cache);
        return response;
      }).catch(function () {
        // No signal and no stored copy. Answer politely rather than
        // letting the failure bubble up as an unhandled error — the map
        // takes this as its cue to draw the rings instead.
        return new Response("", { status: 504, statusText: "No tile offline" });
      });
    });
  });
}

/* Keeps the tile store from growing without limit. Cache entries come
   back in the order they were added, so dropping the first ones drops
   the oldest. */
function trimTiles(cache) {
  cache.keys().then(function (keys) {
    if (keys.length <= MAX_TILES) return;
    var excess = keys.length - Math.floor(MAX_TILES * 0.8);
    for (var i = 0; i < excess; i++) cache.delete(keys[i]);
  });
}
