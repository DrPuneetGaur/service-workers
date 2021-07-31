"use strict";
importScripts("/js/external/idb-keyval-iife.min.js");

const version = 8;
var isLoggedIn = false;
var isOnline = true;
var cacheName = `ramblings-${version}`;
var allPostsCaching = false;

var urlsToCache = {
    loggedOut: [
        "/",
        "/about",
        "/contact",
        "/login",
        "/404",
        "/offline",
        "/js/home.js",
        "/js/blog.js",
        "/js/login.js",
        "/js/add-post.js",
        "/js/external/idb-keyval-iife.min.js",
        "/css/style.css",
        "images/logo.gif",
        "images/offline.png"
    ]
}

self.addEventListener("install", onInstall);
self.addEventListener("activate", onActivate);
self.addEventListener("message", onMessage);
self.addEventListener("fetch",onFetch);

main().catch(console.error);

async function main(){
    await sendMessage( { requestStatusUpdate: true});
    await cacheLoggedOutFiles();
    console.log(`Service worker (${version}) is starting...`);
    return cacheAllPosts();
}

async function onInstall(event){
    console.log(`Service worker (${version}) installed`);
    self.skipWaiting();
}

async function onActivate(event){
    event.waitUntil(handleActivation());
}

async function handleActivation(){
    await clearCaches();
    await cacheLoggedOutFiles(true);
    await clients.claim();

    console.log(`Service worker (${version}) activated`);
	cacheAllPosts(true).catch(console.error);
}

async function clearCaches(){
    var cacheNames = await caches.keys();
    var oldCacheNames = cacheNames.filter(function matchOldCache(cacheName){
        if(/^ramblings-\d+$/.test(cacheName)){
            let [,cacheVersion] = cacheName.match(/^ramblings-(\d+)$/);
            cacheVersion  = (cacheVersion != null ) ? Number(cacheVersion) : cacheVersion;
            return (cacheVersion > 0 && cacheVersion !== version);
        }
    })
    return Promise.all(oldCacheNames.map(function deleteCacheName(cacheName){
        return caches.delete(cacheName);
    }))
}

async function cacheLoggedOutFiles(forceReload = false){
    var cache = await caches.open(cacheName);
    return Promise.all(urlsToCache.loggedOut.map(async function requestFile(url){
        try{
            let result;
            if(!forceReload){
                result = await cache.match(url);
                if(result){
                    return result;
                }
            }
            let fetchOptions = {
                method: 'GET',
                credentials: "omit",
                cache: "no-cache"
            }
            result = await fetch(url, fetchOptions);
            if(result.ok){
                await cache.put(url, result) //result.clone()
            }
        }catch(error){

        }
    }))
}

async function cacheAllPosts(forceReload = false) {
	// already caching the posts?
	if (allPostsCaching) {
		return;
	}
	allPostsCaching = true;
	await delay(5000);

	var cache = await caches.open(cacheName);
	var postIDs;

	try {
		if (isOnline) {
			let fetchOptions = {
				method: "GET",
				cache: "no-store",
				credentials: "omit"
			};
			let res = await fetch("/api/get-posts",fetchOptions);
			if (res && res.ok) {
				await cache.put("/api/get-posts",res.clone());
				postIDs = await res.json();
			}
		}
		else {
			let res = await cache.match("/api/get-posts");
			if (res) {
				let resCopy = res.clone();
				postIDs = await res.json();
			}
			// caching not started, try to start again (later)
			else {
				allPostsCaching = false;
				return cacheAllPosts(forceReload);
			}
		}
	}
	catch (err) {
		console.error(err);
	}

	if (postIDs?.length) {
		return cachePost(postIDs.shift());
	}
	else {
		allPostsCaching = false;
	}

	async function cachePost(postID) {
		var postURL = `/post/${postID}`;
		var needCaching = true;

		if (!forceReload) {
			let res = await cache.match(postURL);
			if (res) {
				needCaching = false;
			}
		}

		if (needCaching) {
			await delay(10000);
			if (isOnline) {
				try {
					let fetchOptions = {
						method: "GET",
						cache: "no-store",
						credentials: "omit"
					};
					let res = await fetch(postURL,fetchOptions);
					if (res && res.ok) {
						await cache.put(postURL,res.clone());
						needCaching = false;
					}
				}
				catch (err) {}
			}

			// failed, try caching this post again?
			if (needCaching) {
				return cachePost(postID);
			}
		}

		// any more posts to cache?
		if (postIDs.length) {
			return cachePost(postIDs.shift());
		}
		else {
			allPostsCaching = false;
		}
	}
}

function onMessage(event){
    const { data } = event;
    if(data.statusUpdate){
        console.log(data.statusUpdate);
        var { isOnline, isLoggedIn } = data.statusUpdate;
        console.log(`Service worker (${version}) status update... isOnline: ${isOnline} isLoggedIn: ${isLoggedIn}`);
    }
}

async function sendMessage(message){
    var allClients = await clients.matchAll({ includeUncontrolled: true });
    return Promise.all(
        allClients.map(function clientMessage(client){
            var channel = new MessageChannel();
            channel.port1.onmessage = onMessage;
            return client.postMessage(message, [channel.port2]);
        })
    )
}

function onFetch(event) {
	event.respondWith(router(event.request));
}

async function router(req) {
	var url = new URL(req.url);
	var reqURL = url.pathname;
	var cache = await caches.open(cacheName);

	// request for site's own URL?
	if (url.origin == location.origin) {
		// are we making an API request?
		if (/^\/api\/.+$/.test(reqURL)) {
			let fetchOptions = {
				credentials: "same-origin",
				cache: "no-store"
			};
			let res = await safeRequest(reqURL,req,fetchOptions,/*cacheResponse=*/false,/*checkCacheFirst=*/false,/*checkCacheLast=*/true,/*useRequestDirectly=*/true);
			if (res) {
				if (req.method == "GET") {
					await cache.put(reqURL,res.clone());
				}
				// clear offline-backup of successful post?
				else if (reqURL == "/api/add-post") {
					await idbKeyval.del("add-post-backup");
				}
				return res;
			}

			return notFoundResponse();
		}
		// are we requesting a page?
		else if (req.headers.get("Accept").includes("text/html")) {
			// login-aware requests?
			if (/^\/(?:login|logout|add-post)$/.test(reqURL)) {
				let res;

				if (reqURL == "/login") {
					if (isOnline) {
						let fetchOptions = {
							method: req.method,
							headers: req.headers,
							credentials: "same-origin",
							cache: "no-store",
							redirect: "manual"
						};
						res = await safeRequest(reqURL,req,fetchOptions);
						if (res) {
							if (res.type == "opaqueredirect") {
								return Response.redirect("/add-post",307);
							}
							return res;
						}
						if (isLoggedIn) {
							return Response.redirect("/add-post",307);
						}
						res = await cache.match("/login");
						if (res) {
							return res;
						}
						return Response.redirect("/",307);
					}
					else if (isLoggedIn) {
						return Response.redirect("/add-post",307);
					}
					else {
						res = await cache.match("/login");
						if (res) {
							return res;
						}
						return cache.match("/offline");
					}
				}
				else if (reqURL == "/logout") {
					if (isOnline) {
						let fetchOptions = {
							method: req.method,
							headers: req.headers,
							credentials: "same-origin",
							cache: "no-store",
							redirect: "manual"
						};
						res = await safeRequest(reqURL,req,fetchOptions);
						if (res) {
							if (res.type == "opaqueredirect") {
								return Response.redirect("/",307);
							}
							return res;
						}
						if (isLoggedIn) {
							isLoggedIn = false;
							await sendMessage("force-logout");
							await delay(100);
						}
						return Response.redirect("/",307);
					}
					else if (isLoggedIn) {
						isLoggedIn = false;
						await sendMessage("force-logout");
						await delay(100);
						return Response.redirect("/",307);
					}
					else {
						return Response.redirect("/",307);
					}
				}
				else if (reqURL == "/add-post") {
					if (isOnline) {
						let fetchOptions = {
							method: req.method,
							headers: req.headers,
							credentials: "same-origin",
							cache: "no-store"
						};
						res = await safeRequest(reqURL,req,fetchOptions,/*cacheResponse=*/true);
						if (res) {
							return res;
						}
						res = await cache.match(
							isLoggedIn ? "/add-post" : "/login"
						);
						if (res) {
							return res;
						}
						return Response.redirect("/",307);
					}
					else if (isLoggedIn) {
						res = await cache.match("/add-post");
						if (res) {
							return res;
						}
						return cache.match("/offline");
					}
					else {
						res = await cache.match("/login");
						if (res) {
							return res;
						}
						return cache.match("/offline");
					}
				}
			}
			// otherwise, just use "network-and-cache"
			else {
				let fetchOptions = {
					method: req.method,
					headers: req.headers,
					cache: "no-store"
				};
				let res = await safeRequest(reqURL,req,fetchOptions,/*cacheResponse=*/false,/*checkCacheFirst=*/false,/*checkCacheLast=*/true);
				if (res) {
					if (!res.headers.get("X-Not-Found")) {
						await cache.put(reqURL,res.clone());
					}
					else {
						await cache.delete(reqURL);
					}
					return res;
				}

				// otherwise, return an offline-friendly page
				return cache.match("/offline");
			}
		}
		// all other files use "cache-first"
		else {
			let fetchOptions = {
				method: req.method,
				headers: req.headers,
				cache: "no-store"
			};
			let res = await safeRequest(reqURL,req,fetchOptions,/*cacheResponse=*/true,/*checkCacheFirst=*/true);
			if (res) {
				return res;
			}

			// otherwise, force a network-level 404 response
			return notFoundResponse();
		}
	}
}

async function safeRequest(reqURL,req,options,cacheResponse = false,checkCacheFirst = false,checkCacheLast = false,useRequestDirectly = false) {
	var cache = await caches.open(cacheName);
	var res;

	if (checkCacheFirst) {
		res = await cache.match(reqURL);
		if (res) {
			return res;
		}
	}

	if (isOnline) {
		try {
			if (useRequestDirectly) {
				res = await fetch(req,options);
			}
			else {
				res = await fetch(req.url,options);
			}

			if (res && (res.ok || res.type == "opaqueredirect")) {
				if (cacheResponse) {
					await cache.put(reqURL,res.clone());
				}
				return res;
			}
		}
		catch (err) {}
	}

	if (checkCacheLast) {
		res = await cache.match(reqURL);
		if (res) {
			return res;
		}
	}
}

function notFoundResponse() {
	return new Response("",{
		status: 404,
		statusText: "Not Found"
	});
}

function delay(ms) {
	return new Promise(function c(res){
		setTimeout(res,ms);
	});
}