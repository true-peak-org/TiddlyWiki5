/*\
title: $:/plugins/tiddlywiki/hive/hivekeychain.js
type: application/javascript
module-type: library

A thin wrapper around the Hive Keychain browser extension.

The extension injects a `hive_keychain` object into the page that exposes a
small RPC style API. The newer wallets use `window.hive` instead, with the
same method shapes. Only the calls needed by this plugin are used here:

	window.hive_keychain.requestHandshake(callback)
	window.hive_keychain.requestSignBuffer(account,message,key,callback,rpc,title)
	window.hive_keychain.requestBroadcast(account,operations,key,callback,rpc)

The response of a request is an object with a `success` flag, a `result`
property and, when something went wrong, an `error` property.

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	/*
Construct a Keychain client
*/
	function HiveKeychain(options) {
		options = options || {};
		this.logger = options.logger || null;
		this.rpc = options.rpc || null;
	}

	/*
Return the extension's api object, or null if it is not installed
*/
	HiveKeychain.prototype.getApi = function() {
		if($tw.browser && typeof window !== "undefined") {
			if(window.hive_keychain) {
				return window.hive_keychain;
			}
			if(window.hive) {
				return window.hive;
			}
		}
		return null;
	};

	/*
Check whether the Keychain extension is available. The callback is invoked
with (err) where err is null if the extension responded to the handshake
*/
	HiveKeychain.prototype.isInstalled = function(callback) {
		var api = this.getApi();
		if(!api) {
			return callback("The Hive Keychain browser extension was not found");
		}
		try {
			api.requestHandshake(function(response) {
				if(response && response.error) {
					return callback("Hive Keychain handshake failed: " + (response.error.message || response.error));
				}
				if(response && response.success === false) {
					return callback("Hive Keychain handshake failed");
				}
				callback(null);
			});
		} catch(e) {
			callback("Hive Keychain handshake failed: " + e.message);
		}
	};

	/*
Return the error of a Keychain response, or null if the response is
successful
*/
	HiveKeychain.prototype.getResponseError = function(response) {
		if(!response) {
			return "Hive Keychain did not return a response";
		}
		if(response.error) {
			return "Hive Keychain: " + (response.error.message || response.error.description || response.error);
		}
		if(response.success === false) {
			return "Hive Keychain: " + (response.message || "the request was refused");
		}
		return null;
	};

	/*
Ask Keychain to sign an arbitrary message with the posting key of an
account. The callback is invoked with (err,response) where response holds
the signature and the public key that was used
*/
	HiveKeychain.prototype.signBuffer = function(username,message,method,callback,title) {
		var api = this.getApi(),
			self = this;
		if(!api) {
			return callback("The Hive Keychain browser extension was not found");
		}
		try {
			api.requestSignBuffer(username,message,method || "Posting",function(response) {
				var err = self.getResponseError(response);
				if(err) {
					return callback(err);
				}
				callback(null,response.result || response);
			},this.rpc,title);
		} catch(e) {
			callback("Hive Keychain refused to sign: " + e.message);
		}
	};

	/*
Ask Keychain to sign and broadcast a set of operations. The operations are
given as objects with a `type` property, and are converted into the array
form that the extension expects. The callback is invoked with (err,result)
*/
	HiveKeychain.prototype.broadcast = function(username,operations,method,callback) {
		var api = this.getApi(),
			self = this,
			wireOperations;
		if(!api) {
			return callback("The Hive Keychain browser extension was not found");
		}
		try {
			wireOperations = operations.map(function(operation) {
				var payload = {};
				Object.keys(operation).forEach(function(name) {
					if(name !== "type") {
						payload[name] = operation[name];
					}
				});
				return [operation.type,payload];
			});
			api.requestBroadcast(username,wireOperations,method || "Posting",function(response) {
				var err = self.getResponseError(response);
				if(err) {
					return callback(err);
				}
				callback(null,response.result || response);
			},this.rpc);
		} catch(e) {
			callback("Hive Keychain could not broadcast the transaction: " + e.message);
		}
	};

	HiveKeychain.prototype.log = function(message) {
		if(this.logger) {
			this.logger.log(message);
		}
	};

	exports.HiveKeychain = HiveKeychain;

})();
