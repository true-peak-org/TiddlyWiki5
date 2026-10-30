/*\
title: $:/plugins/tiddlywiki/hive/hivestore.js
type: application/javascript
module-type: library

The Hive storage plugin: saving a wiki to Hive as a post with one reply per
tiddler, and loading it back again.

The canonical representation of a tiddler is stored in the json_metadata of
its reply. The body of the reply holds a markdown rendering of the tiddler
so that the wiki remains readable in a plain markdown viewer.

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	var util = require("$:/plugins/tiddlywiki/hive/hiveutil.js"),
		HiveApi = require("$:/plugins/tiddlywiki/hive/hiveapi.js").HiveApi;

	/*
Maximum size of the json_metadata of a post
*/
	var MAX_METADATA_LENGTH = 60000;

	/*
Maximum size of the text of a single part of a tiddler
*/
	var MAX_TEXT_LENGTH = 40000;

	var CONFIG_PREFIX = "$:/config/tiddlywiki/hive/",
		DEFAULT_PREFIX = "$:/plugins/tiddlywiki/hive/",
		STATUS_TIDDLER = "$:/state/tiddlywiki/hive/status",
		REMOTE_TIDDLER = "$:/config/tiddlywiki/hive/remote";

	/*
Construct a store
*/
	function HiveStore(options) {
		options = options || {};
		this.wiki = options.wiki;
		this.logger = options.logger || null;
		this.api = options.api || null;
		this.keychain = options.keychain || null;
	}

	/*
Return the value of a configuration item, falling back to the default
provided by the plugin
*/
	HiveStore.prototype.getConfigText = function(name,defaultValue) {
		var text = this.wiki.getTiddlerText(CONFIG_PREFIX + name);
		if(!text) {
			text = this.wiki.getTiddlerText(DEFAULT_PREFIX + name);
		}
		if(text === undefined || text === null || text === "") {
			text = defaultValue === undefined ? "" : defaultValue;
		}
		return text;
	};

	/*
Return the configuration of the plugin
*/
	HiveStore.prototype.getConfig = function() {
		var config = {
			account: this.getConfigText("account",""),
			rpc: this.getConfigText("rpc",HiveApi.DEFAULT_RPC),
			category: this.getConfigText("category","tiddlywiki5"),
			nesting: this.getConfigText("nesting","path"),
			publishFilter: this.getConfigText("publish-filter","[is[tiddler]] -[prefix[$:/]] +[sort[title]]"),
			frontEnd: this.getConfigText("front-end","https://hive.blog"),
			pullMode: this.getConfigText("pull-mode","overwrite")
		};
		return config;
	};

	/*
Return the identifier of this wiki. It is created the first time it is
needed and then kept in the wiki so that the permlinks of the posts stay
the same
*/
	HiveStore.prototype.getWikiId = function() {
		var id = this.wiki.getTiddlerText(CONFIG_PREFIX + "wiki-id");
		if(!id) {
			id = util.generateId();
			this.wiki.addTiddler(new $tw.Tiddler({title: CONFIG_PREFIX + "wiki-id",text: id}));
		}
		return id;
	};

	/*
Return the title of this wiki
*/
	HiveStore.prototype.getWikiTitle = function() {
		var title = this.wiki.getTiddlerText("$:/SiteTitle");
		if(!title) {
			title = this.wiki.getTiddlerText("title");
		}
		return title || "TiddlyWiki";
	};

	/*
Return the state of the last save, or null if the wiki has not been saved
*/
	HiveStore.prototype.getRemoteState = function() {
		var text = this.wiki.getTiddlerText(REMOTE_TIDDLER);
		if(!text) {
			return null;
		}
		try {
			return JSON.parse(text);
		} catch(e) {
			return null;
		}
	};

	/*
Return the text of the status tiddler
*/
	HiveStore.prototype.getStatusText = function() {
		return this.wiki.getTiddlerText(STATUS_TIDDLER) || "";
	};

	/*
Record the state of the last save
*/
	HiveStore.prototype.setRemoteState = function(state) {
		this.wiki.addTiddler(new $tw.Tiddler({
			title: REMOTE_TIDDLER,
			text: JSON.stringify(state,undefined,"  "),
			saved: state.saved || "",
			url: state.url || ""
		}));
	};

	/*
Update the status tiddler that is shown in the control panel
*/
	HiveStore.prototype.setStatus = function(text) {
		this.wiki.addTiddler(new $tw.Tiddler({title: STATUS_TIDDLER,text: text || ""}));
	};

	/*
Return the permlink of the root post of this wiki
*/
	HiveStore.prototype.getRootPermlink = function(wikiId,wikiTitle) {
		var remote = this.getRemoteState();
		if(remote && remote.wikiid === wikiId && remote.permlink) {
			return remote.permlink;
		}
		return util.getRootPermlink(wikiId,wikiTitle);
	};

	/*
Return the url of a post
*/
	HiveStore.prototype.getUrl = function(config,permlink) {
		return config.frontEnd + "/@" + config.account + "/" + permlink;
	};

	/*
Parse the json_metadata of a post
*/
	HiveStore.prototype.parseMetadata = function(content) {
		if(!content || !content.json_metadata) {
			return null;
		}
		var text = content.json_metadata;
		if(typeof text === "object") {
			return text;
		}
		try {
			return JSON.parse(text);
		} catch(e) {
			return null;
		}
	};

	/*
Return the tw5 metadata of a post, or null
*/
	HiveStore.prototype.getTw5Metadata = function(content) {
		var metadata = this.parseMetadata(content);
		if(!metadata || !metadata.tw5) {
			return null;
		}
		return metadata.tw5;
	};

	/*
Split a payload into parts that fit within the size limits of Hive
*/
	HiveStore.prototype.splitPayload = function(payload) {
		var parts = [],
			text = payload.text || "",
			chunkSize = MAX_TEXT_LENGTH,
			index,
			part;
		while(text.length > MAX_TEXT_LENGTH) {
			parts.push(text.substring(0,chunkSize));
			text = text.substring(chunkSize);
		}
		parts.push(text);
		for(index = 0; index < parts.length; index++) {
			part = {
				title: payload.title,
				text: parts[index],
				fields: payload.fields,
				tags: payload.tags,
				created: payload.created,
				modified: payload.modified,
				part: index + 1,
				parts: parts.length
			};
			part.hash = util.getPayloadHash(part);
			if(JSON.stringify({app: "tw5",tw5: part}).length > MAX_METADATA_LENGTH) {
			// The fields are too big to be stored in a single reply, drop them
				part.fields = {};
				part.hash = util.getPayloadHash(part);
			}
			parts[index] = part;
		}
		return parts;
	};

	/*
Return the list of tiddlers that should be published
*/
	HiveStore.prototype.getPublishTitles = function(config) {
		return this.wiki.filterTiddlers(config.publishFilter);
	};

	/*
Build the hierarchy of the published tiddlers so that replies can be
nested underneath their parents
*/
	HiveStore.prototype.buildTree = function(titles,config) {
		var self = this,
			byTitle = {},
			nodes = {};
		titles.forEach(function(title) {
			byTitle[title] = true;
			nodes[title] = {title: title,children: [],parent: null,depth: 0};
		});
		if(config.nesting === "path") {
			titles.forEach(function(title) {
				var tiddler = self.wiki.getTiddler(title),
					parentTitle = self.getParentTitle(tiddler,byTitle);
				if(parentTitle) {
					nodes[title].parent = nodes[parentTitle];
					nodes[parentTitle].children.push(nodes[title]);
				}
			});
		}
		// Compute the depth of each node
		function setDepth(node,depth) {
			node.depth = depth;
			node.children.forEach(function(child) {
				setDepth(child,depth + 1);
			});
		}
		titles.forEach(function(title) {
			if(!nodes[title].parent) {
				setDepth(nodes[title],0);
			}
		});
		return nodes;
	};

	/*
Return the tiddlers in an order in which parents come before their children
*/
	HiveStore.prototype.orderTitles = function(titles,config) {
		if(config.nesting !== "path") {
			return titles.slice(0);
		}
		var nodes = this.buildTree(titles,config),
			result = [];
		function visit(node) {
			result.push(node.title);
			node.children.forEach(visit);
		}
		titles.forEach(function(title) {
			if(!nodes[title].parent) {
				visit(nodes[title]);
			}
		});
		return result;
	};

	/*
Retrieve all the replies of a post, including the replies of the replies.
The Hive api only returns the direct replies of a post, so the replies that
have children of their own have to be fetched as well
*/
	HiveStore.prototype.getAllReplies = function(author,permlink,callback) {
		var self = this,
			all = [],
			pending = 0,
			failed = false;
		function finish(err) {
			if(err && !failed) {
				failed = true;
				return callback(err);
			}
			pending--;
			if(pending === 0 && !failed) {
				callback(null,all);
			}
		}
		function fetch(author,permlink) {
			pending++;
			self.api.getReplies(author,permlink,function(err,replies) {
				if(err) {
					return finish(err);
				}
				replies = replies || [];
				all = all.concat(replies);
				// Only the replies that have children of their own have to be
				// looked at
				replies.forEach(function(reply) {
					if(reply.children && reply.children > 0) {
						fetch(reply.author,reply.permlink);
					}
				});
				finish();
			});
		}
		fetch(author,permlink);
	};

	/*
Save the wiki to Hive. The callback is invoked with (err,result)
*/
	HiveStore.prototype.save = function(callback) {
		var self = this,
			config = this.getConfig();
		callback = callback || function() {};
		if(!config.account) {
			return callback("No Hive account name has been configured. Please enter your Hive account name in the control panel.");
		}
		if(!this.keychain) {
			return callback("The Hive Keychain browser extension is not available");
		}
		var wikiId = this.getWikiId(),
			wikiTitle = this.getWikiTitle(),
			rootPermlink = this.getRootPermlink(wikiId,wikiTitle),
			titles = this.getPublishTitles(config);
		this.setStatus("Reading the current state of the post " + rootPermlink + "...");
		this.api.getContent(config.account,rootPermlink,function(err,rootContent) {
			if(err) {
				self.setStatus("");
				return callback(err);
			}
			self.getAllReplies(config.account,rootPermlink,function(err,replies) {
				if(err) {
					self.setStatus("");
					return callback(err);
				}
				self.buildOperations(config,wikiId,wikiTitle,rootPermlink,rootContent,replies,titles,function(err,operations) {
					if(err) {
						self.setStatus("");
						return callback(err);
					}
					if(!operations.length) {
						self.setStatus("Nothing to save, the post " + rootPermlink + " is up to date");
						return callback(null,{permlink: rootPermlink,operations: 0});
					}
					self.broadcastOperations(config,operations,function(err,results) {
						if(err) {
							self.setStatus("");
							return callback(err);
						}
						var state = self.getRemoteState() || {};
						state.wikiid = wikiId;
						state.permlink = rootPermlink;
						state.url = self.getUrl(config,rootPermlink);
						state.saved = $tw.utils.stringifyDate(new Date());
						state.tiddlers = self.getPublishedTiddlers(wikiId,titles);
						self.setRemoteState(state);
						self.setStatus("Saved " + operations.length + " operation(s) to " + self.getUrl(config,rootPermlink));
						callback(null,{permlink: rootPermlink,operations: operations.length,results: results});
					});
				});
			});
		});
	};

	/*
Return the record of the tiddlers that have been published, so that a
second save does not publish the same content again before the replies of
the first save have been indexed
*/
	HiveStore.prototype.getPublishedTiddlers = function(wikiId,titles) {
		var self = this,
			published = {};
		titles.forEach(function(title) {
			var tiddler = self.wiki.getTiddler(title);
			if(!tiddler) {
				return;
			}
			var payload = util.getTiddlerPayload(tiddler),
				parts = self.splitPayload(payload),
				hashes = {};
			parts.forEach(function(part) {
				hashes[part.part] = part.hash;
			});
			published[title] = {
				permlink: util.getTiddlerPermlink(wikiId,title),
				hashes: hashes
			};
		});
		return published;
	};

	/*
Return the title of the parent tiddler of the given tiddler, or null when
the tiddler has no parent. The parent is taken from the parent tag of the
tiddler or from its parent field and falls back to the path of the tiddler
title
*/
	HiveStore.prototype.getParentTitle = function(tiddler,entries) {
		var tags = [],
			rawTags = tiddler.fields.tags,
			parentTitle = null,
			i, tag, parts, index, candidate;
		if($tw.utils.isArray(rawTags)) {
			tags = rawTags.slice(0);
		} else if(rawTags) {
			tags = [rawTags];
		}
		for(i = 0; i < tags.length; i++) {
			tag = tags[i];
			if(entries[tag]) {
				parentTitle = tag;
				break;
			}
		}
		if(!parentTitle && tiddler.fields.parent && entries[tiddler.fields.parent]) {
			parentTitle = tiddler.fields.parent;
		}
		if(!parentTitle) {
			parts = String(tiddler.fields.title || "").split("/");
			for(index = 1; index < parts.length; index++) {
				candidate = parts.slice(0,index).join("/");
				if(entries[candidate]) {
					parentTitle = candidate;
				}
			}
		}
		return parentTitle;
	};

	/*
Return the permlink of the reply that a tiddler has to be nested underneath
*/
	HiveStore.prototype.getParentPermlink = function(tiddler,entries,config,rootPermlink) {
		if(config.nesting !== "path") {
			return rootPermlink;
		}
		var parentTitle = this.getParentTitle(tiddler,entries);
		if(!parentTitle) {
			return rootPermlink;
		}
		var parent = entries[parentTitle];
		return parent.parts > 1 ? util.getPartPermlink(parent.permlink,1) : parent.permlink;
	};

	/*
Build the list of operations that have to be broadcast
*/
	HiveStore.prototype.buildOperations = function(config,wikiId,wikiTitle,rootPermlink,rootContent,replies,titles,callback) {
		var self = this,
			operations = [],
			existing = {},
			index = {},
			state = this.getRemoteState() || {},
			published = state.tiddlers || {};
		(replies || []).forEach(function(reply) {
			existing[reply.permlink] = reply;
		});
		// Work out the content of each tiddler
		var entries = {},
			entryList = [];
		titles.forEach(function(title) {
			var tiddler = self.wiki.getTiddler(title);
			if(!tiddler) {
				return;
			}
			var payload = util.getTiddlerPayload(tiddler),
				permlink = util.getTiddlerPermlink(wikiId,title),
				parts = self.splitPayload(payload),
				entry = {title: title,payload: payload,permlink: permlink,parts: parts.length};
			entries[title] = entry;
			entryList.push(entry);
		});
		// The operations for the tiddlers themselves
		entryList.forEach(function(entry) {
			var tiddler = self.wiki.getTiddler(entry.title),
				payload = util.getTiddlerPayload(tiddler),
				parts = self.splitPayload(payload),
				parentPermlink = self.getParentPermlink(tiddler,entries,config,rootPermlink);
			parts.forEach(function(part) {
				var permlink = part.parts > 1 ? util.getPartPermlink(entry.permlink,part.part) : entry.permlink,
					existingReply = existing[permlink],
					metadata = {app: "tw5",tw5: part},
					remoteHash = existingReply ? self.getTw5Metadata(existingReply) : null;
				index[entry.title] = {permlink: entry.permlink,parts: part.parts,hash: part.hash,part: part};
				if(remoteHash) {
					if(remoteHash.hash === part.hash) {
					// Nothing has changed
						return;
					}
				} else {
				// The reply does not exist yet. It may have been published
				// by a previous save that has not been indexed yet
					var record = published[entry.title];
					if(record && record.hashes && record.hashes[part.part] === part.hash) {
						return;
					}
				}
				operations.push({
					type: "comment",
					parent_author: config.account,
					parent_permlink: parentPermlink,
					author: config.account,
					permlink: permlink,
					title: util.makeTitle(entry.title + (part.parts > 1 ? " (" + part.part + "/" + part.parts + ")" : "")),
					body: util.makeTiddlerBody(part,{
						frontEnd: config.frontEnd,
						linkResolver: self.makeLinkResolver(config,entryList,wikiId)
					}),
					json_metadata: JSON.stringify(metadata)
				});
			});
		});
		// The operations for the tiddlers that have been deleted
		Object.keys(existing).forEach(function(permlink) {
			var metadata = self.getTw5Metadata(existing[permlink]);
			if(!metadata || metadata.type !== "tiddler") {
				return;
			}
			if(index[metadata.title]) {
				return;
			}
			operations.push({
				type: "comment",
				parent_author: config.account,
				parent_permlink: rootPermlink,
				author: config.account,
				permlink: permlink,
				title: util.makeTitle(metadata.title + " (removed)"),
				body: "> **Note:** This tiddler has been removed from the wiki that this post belongs to.",
				json_metadata: JSON.stringify({app: "tw5",tw5: {
					type: "tiddler",
					title: metadata.title,
					deleted: true,
					part: metadata.part || 1,
					parts: metadata.parts || 1,
					hash: util.hashString("deleted|" + metadata.title)
				}})
			});
		});
		// The operation for the root post
		var root = {
			wikititle: wikiTitle,
			wikiid: wikiId,
			index: []
		};
		entryList.forEach(function(entry) {
			root.index.push({
				title: entry.title,
				permlink: entry.permlink,
				parts: entry.parts,
				url: self.getUrl(config,entry.permlink)
			});
		});
		root.hash = util.getPayloadHash(root.index);
		var remoteRoot = rootContent ? self.getTw5Metadata(rootContent) : null;
		if(!rootContent || !remoteRoot || remoteRoot.hash !== root.hash) {
			operations.unshift({
				type: "comment",
				parent_author: "",
				parent_permlink: config.category,
				author: config.account,
				permlink: rootPermlink,
				title: util.makeTitle(wikiTitle),
				body: util.makeRootBody(root,{frontEnd: config.frontEnd, appUrl: this.getConfigText("app-url","")}),
				json_metadata: JSON.stringify({app: "tw5",tw5: root})
			});
		}
		// Make sure that parents are broadcast before their children
		var ordered = [],
			byTitle = {};
		entryList.forEach(function(entry) {
			byTitle[entry.title] = entry;
		});
		var order = this.orderTitles(entryList.map(function(entry) { return entry.title; }),config);
		// Sort the operations so that the root comes first, followed by the
		// tiddlers in the order of the hierarchy
		var rootOperation = null,
			tiddlerOperations = [];
		operations.forEach(function(operation) {
			if(operation.permlink === rootPermlink && operation.parent_permlink === config.category) {
				rootOperation = operation;
			} else {
				tiddlerOperations.push(operation);
			}
		});
		tiddlerOperations.sort(function(a,b) {
			var aTitle = self.getOperationTitle(a,byTitle),
				bTitle = self.getOperationTitle(b,byTitle),
				aIndex = order.indexOf(aTitle),
				bIndex = order.indexOf(bTitle);
			// The operations of the tiddlers that have been removed come last
			if(aIndex === -1) {
				return bIndex === -1 ? 0 : 1;
			}
			if(bIndex === -1) {
				return -1;
			}
			return aIndex - bIndex;
		});
		ordered = rootOperation ? [rootOperation].concat(tiddlerOperations) : tiddlerOperations;
		callback(null,ordered);
	};

	/*
Return the title of the tiddler that an operation belongs to
*/
	HiveStore.prototype.getOperationTitle = function(operation,byTitle) {
		var permlink = operation.permlink,
			titles = Object.keys(byTitle);
		for(var i = 0; i < titles.length; i++) {
			if(permlink === byTitle[titles[i]].permlink || permlink.indexOf(byTitle[titles[i]].permlink + "_p") === 0) {
				return titles[i];
			}
		}
		return "";
	};

	/*
Return a function that resolves the target of a link to the url of the
corresponding reply
*/
	HiveStore.prototype.makeLinkResolver = function(config,entries,wikiId) {
		var map = {};
		entries.forEach(function(entry) {
			map[entry.title] = this.getUrl(config,entry.permlink);
		},this);
		return function(target) {
			return map[target] || null;
		};
	};

	/*
Broadcast the operations, in batches of a limited size
*/
	HiveStore.prototype.broadcastOperations = function(config,operations,callback) {
		var self = this,
			batches = [],
			index = 0;
		for(var i = 0; i < operations.length; i += util.MAX_OPS_PER_TRANSACTION) {
			batches.push(operations.slice(i,i + util.MAX_OPS_PER_TRANSACTION));
		}
		var results = [];
		function next() {
			if(index >= batches.length) {
				return callback(null,results);
			}
			var batch = batches[index];
			index++;
			self.setStatus("Broadcasting transaction " + index + " of " + batches.length + "...");
			self.keychain.broadcast(config.account,batch,"Posting",function(err,result) {
				if(err) {
					return callback(err);
				}
				results.push(result);
				next();
			});
		}
		next();
	};

	/*
Load the wiki from Hive. The callback is invoked with (err,result)
*/
	HiveStore.prototype.load = function(permlink,callback) {
		var self = this,
			config = this.getConfig();
		callback = callback || function() {};
		if(!config.account) {
			return callback("No Hive account name has been configured. Please enter your Hive account name in the control panel.");
		}
		permlink = permlink || (this.getRemoteState() || {}).permlink;
		if(!permlink) {
			return callback("There is no Hive post to load. Please save the wiki first, or enter the permlink of the root post.");
		}
		this.setStatus("Reading the Hive post " + permlink + "...");
		this.api.getContent(config.account,permlink,function(err,rootContent) {
			if(err) {
				self.setStatus("");
				return callback(err);
			}
			if(!rootContent) {
				self.setStatus("");
				return callback("Could not find a Hive post with the permlink " + permlink);
			}
			var metadata = self.getTw5Metadata(rootContent);
			if(!metadata || metadata.type !== "root") {
				self.setStatus("");
				return callback("The Hive post " + permlink + " is not a TiddlyWiki5 wiki");
			}
			self.getAllReplies(config.account,permlink,function(err,replies) {
				if(err) {
					self.setStatus("");
					return callback(err);
				}
				self.applyReplies(config,metadata,replies,function(err,summary) {
					if(err) {
						self.setStatus("");
						return callback(err);
					}
					var previousState = self.getRemoteState() || {};
					self.setRemoteState({
						wikiid: metadata.wikiid,
						permlink: permlink,
						url: self.getUrl(config,permlink),
						saved: previousState.saved || "",
						tiddlers: previousState.wikiid === metadata.wikiid ? (previousState.tiddlers || {}) : {}
					});
					self.setStatus("Loaded " + summary.added + " tiddler(s) from " + self.getUrl(config,permlink));
					callback(null,summary);
				});
			});
		});
	};

	/*
Add the tiddlers of the replies to the wiki
*/
	HiveStore.prototype.applyReplies = function(config,rootMetadata,replies,callback) {
		var self = this,
			summary = {added: 0,updated: 0,removed: 0,skipped: 0},
			byTitle = {};
		(replies || []).forEach(function(reply) {
			var metadata = self.getTw5Metadata(reply);
			if(!metadata || metadata.type !== "tiddler") {
				return;
			}
			if(!byTitle[metadata.title]) {
				byTitle[metadata.title] = [];
			}
			byTitle[metadata.title].push(metadata);
		});
		Object.keys(byTitle).forEach(function(title) {
			var parts = byTitle[title].sort(function(a,b) {
					return (a.part || 1) - (b.part || 1);
				}),
				deleted = parts.some(function(part) { return part.deleted; }),
				existing = self.wiki.getTiddler(title);
			if(deleted) {
				if(config.pullMode === "overwrite" && existing) {
					self.wiki.deleteTiddler(title);
					summary.removed++;
				}
				return;
			}
			if(config.pullMode !== "overwrite" && existing) {
				summary.skipped++;
				return;
			}
			var payload = {
				title: title,
				text: parts.map(function(part) { return part.text || ""; }).join(""),
				fields: parts[0].fields || {},
				tags: parts[0].tags || [],
				created: parts[0].created || "",
				modified: parts[0].modified || ""
			};
			if(existing) {
				summary.updated++;
			} else {
				summary.added++;
			}
			self.wiki.addTiddler(util.payloadToTiddler(payload));
		});
		callback(null,summary);
	};

	exports.HiveStore = HiveStore;
	exports.CONFIG_PREFIX = CONFIG_PREFIX;
	exports.DEFAULT_PREFIX = DEFAULT_PREFIX;
	exports.STATUS_TIDDLER = STATUS_TIDDLER;
	exports.REMOTE_TIDDLER = REMOTE_TIDDLER;

})();
