/*\
title: $:/plugins/tiddlywiki/hive/hiveapi.js
type: application/javascript
module-type: library

A small client for the Hive blockchain JSON-RPC API.

Only the handful of read methods needed by this plugin are implemented:

	condenser_api.get_content(author,permlink)
	condenser_api.get_content_replies(author,permlink)
	condenser_api.get_key_references(publicKeys)
	condenser_api.lookup_accounts(names)

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	var DEFAULT_RPC = "https://api.hive.blog";

	/*
Construct a Hive API client.

options.rpc: the JSON-RPC endpoint to talk to
options.logger: optional logger
*/
	function HiveApi(options) {
		options = options || {};
		this.rpc = options.rpc || DEFAULT_RPC;
		this.logger = options.logger || null;
	}

	/*
Change the endpoint that subsequent requests are sent to
*/
	HiveApi.prototype.setRpc = function(rpc) {
		if(rpc) {
			this.rpc = rpc;
		}
	};

	/*
Make a JSON-RPC call. The callback is invoked with (err,result)
*/
	HiveApi.prototype.request = function(method,params,callback) {
		var self = this,
			body = JSON.stringify({
				jsonrpc: "2.0",
				method: method,
				params: params,
				id: 1
			});
		this.log("Calling " + method);
		this.httpRequest(body,function(err,data) {
			var response = null;
			if(data) {
				try {
					response = JSON.parse(data);
				} catch(e) {
					response = null;
				}
			}
			// The error of the JSON-RPC call is more informative than the
			// status of the HTTP response
			if(response && response.error) {
				var error = response.error;
				return callback(error.message || (error.data && error.data.message) || JSON.stringify(error));
			}
			if(err) {
				return callback(err);
			}
			if(!response) {
				return callback("Could not parse the response from " + self.rpc);
			}
			callback(null,response.result);
		});
	};

	/*
Perform the underlying HTTP request. Uses $tw.utils.httpRequest in the browser
and the node https module on the server
*/
	HiveApi.prototype.httpRequest = function(body,callback) {
		if($tw.node) {
			return this.nodeHttpRequest(body,callback);
		}
		$tw.utils.httpRequest({
			url: this.rpc,
			type: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json"
			},
			data: body,
			callback: function(err,data) {
				callback(err,data);
			}
		});
	};

	/*
Node.js version of the HTTP request
*/
	HiveApi.prototype.nodeHttpRequest = function(body,callback) {
		var self = this,
			url = require("url").parse(this.rpc),
			options = {
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port,
				path: url.path,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Accept": "application/json",
					"Content-Length": Buffer.byteLength(body)
				}
			},
			request = require("https").request(options,function(response) {
				var data = "";
				response.on("data",function(chunk) {
					data += chunk;
				});
				response.on("end",function() {
					if(response.statusCode >= 200 && response.statusCode < 300) {
						callback(null,data);
					} else {
					// The body is passed on, because it holds the error of
					// the JSON-RPC call
						callback("HTTP error " + response.statusCode + " from " + self.rpc,data);
					}
				});
			});
		request.on("error",function(err) {
			callback(err.message);
		});
		request.write(body);
		request.end();
	};

	/*
Retrieve a single piece of content (a post or a reply). The callback is
invoked with (err,content) where content is null if it does not exist
*/
	HiveApi.prototype.getContent = function(author,permlink,callback) {
		this.request("condenser_api.get_content",[author,permlink],function(err,result) {
			if(err) {
			// A missing post is reported as an assertion exception
				if(/does not exist/i.test(err)) {
					return callback(null,null);
				}
				return callback(err);
			}
			callback(null,result);
		});
	};

	/*
Retrieve the replies to a piece of content. The callback is invoked with
(err,replies) where replies is an array of content objects. Only the direct
replies are returned, the replies of the replies have to be fetched
separately
*/
	HiveApi.prototype.getReplies = function(author,permlink,callback) {
		this.request("condenser_api.get_content_replies",[author,permlink],function(err,result) {
			if(err) {
			// A post that does not exist has no replies
				if(/does not exist/i.test(err)) {
					return callback(null,[]);
				}
				return callback(err);
			}
			callback(null,result || []);
		});
	};

	/*
Look up the accounts that a public key belongs to. The callback is invoked
with (err,accounts) where accounts is an array of arrays of account names
*/
	HiveApi.prototype.getKeyReferences = function(publicKey,callback) {
		this.request("condenser_api.get_key_references",[[publicKey]],function(err,result) {
			if(err) {
				return callback(err);
			}
			callback(null,(result && result.accounts) || []);
		});
	};

	/*
Look up an account. The callback is invoked with (err,account)
*/
	HiveApi.prototype.getAccount = function(account,callback) {
		this.request("condenser_api.lookup_accounts",[[account]],function(err,result) {
			if(err) {
				return callback(err);
			}
			var accounts = result && result.accounts;
			if(!accounts || !accounts.length) {
				return callback(null,null);
			}
			callback(null,accounts[0]);
		});
	};

	HiveApi.prototype.log = function(message) {
		if(this.logger) {
			this.logger.log(message);
		}
	};

	exports.DEFAULT_RPC = DEFAULT_RPC;
	exports.HiveApi = HiveApi;

})();
