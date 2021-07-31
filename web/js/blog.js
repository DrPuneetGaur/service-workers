(function Blog(global){
	"use strict";

	var offlineIcon;
	var isOnline = navigator.onLine;
	var isLoggedIn = /isLoggedIn=1/.test(document.cookie.toString() || "");
	var serviceWorker;
	var serviceWorkerRegistration;
	var usingServiceWorker = ("serviceWorker" in navigator);

	if (usingServiceWorker) {
		initServiceWorker().catch(console.error);
	}

	global.isBlogOnline = isBlogOnline;

	document.addEventListener("DOMContentLoaded",ready,false);

	initServiceWorker()

	function ready() {
		offlineIcon = document.getElementById("connectivity-status");
		if(!isOnline){
			offlineIcon.classList.remove("hidden");
		}
		window.addEventListener("online", function online(){
			offlineIcon.classList.add("hidden");
			isOnline = true;
			sendStatusUpdate()
		});
		window.addEventListener("offline", function offline(){
			offlineIcon.classList.remove("hidden");
			isOnline = false;
			sendStatusUpdate()
		})
	}

	function isBlogOnline() {
		return isOnline;
	}

	async function initServiceWorker(){
		serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js', {
			updateViaCache: "none"
		});
		serviceWorker = serviceWorkerRegistration.installing || serviceWorkerRegistration.waiting || serviceWorkerRegistration.active;
		
		navigator.serviceWorker.addEventListener("controllerchange", function onControllerChange(){
			serviceWorker = navigator.serviceWorker.controller;	
			sendStatusUpdate(serviceWorker)
		})
		navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage, false);
	}

	function onServiceWorkerMessage(event){
		var { data } = event;
		if(data.requestStatusUpdate){
			console.log('Received status update request from service worker.')
			sendStatusUpdate(event.ports && event.ports[0]);
		}else if (data == "force-logout") {
			document.cookie = "isLoggedIn=";
			isLoggedIn = false;
			sendStatusUpdate();
		}
	}

	function sendStatusUpdate(target){
		sendServiceWorkerMessage({ statusUpdate: { isOnline, isLoggedIn }}, target);
	}

	async function sendServiceWorkerMessage(message, target){
		if(target){
			target.postMessage(message);
		}else if(serviceWorker){
			serviceWorker.postMessage(message);
		}else{
			navigator.serviceWorker.postMessage(message);
		}
	}
})(window);
