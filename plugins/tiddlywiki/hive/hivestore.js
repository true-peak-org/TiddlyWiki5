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
		REMOTE_TIDDLER = "$:/config/tiddlywiki/hive/remote",
		// The record of the proposals of the wiki: one entry per proposal
		// reply with its status. The statuses are kept in this tiddler so
		// that the curation of the owner survives a reload, and the
		// decisions are broadcast to the chain as well
		PROPOSALS_TIDDLER = "$:/config/tiddlywiki/hive/proposals",
		// The generated listing of the proposals, regenerated whenever the
		// record changes
		PROPOSAL_LIST_TIDDLER = "Hive proposals";

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
		// Configuration tiddlers store single line values, strips any
		// trailing newlines that come with the stored text
		text = text.replace(/[\r\n]+$/,"");
		return text;
	};

	/*
Return the configuration of the plugin
*/
	HiveStore.prototype.getConfig = function() {
		var config = {
			account: this.getConfigText("account",""),
			rpc: this.getConfigText("rpc",HiveApi.DEFAULT_RPC),
			category: this.getConfigText("category","tiddlywiki"),
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
Return the list of tiddlers that exceeded the size limits of a Hive post
during the build of the operations of the last save
*/
	HiveStore.prototype.getOverLimitTiddlers = function() {
		return this.overLimitTitles || [];
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
	HiveStore.prototype.getUrl = function(config,permlink,author) {
		return config.frontEnd + "/@" + (author || config.account) + "/" + permlink;
	};

	/*
Return the canonical url of a wiki post: the base url of the wiki reader
followed by the author and permlink of the root post. Tiddler replies
additionally carry the tiddler title as the uri fragment of the root url
*/
	HiveStore.prototype.makeCanonicalUrl = function(config,rootPermlink,fragment,author) {
		var url = "https://shim.true-peak.org/hive/wiki/@" + (author || config.account) + "/" + rootPermlink;
		if(fragment) {
			url += "#" + encodeURIComponent(fragment);
		}
		return url;
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
			// The hash is computed before the type attribute is added, so
			// that replies published by earlier versions of the plugin that
			// did not write a type have the same hash
			part.hash = util.getPayloadHash(part);
			if(JSON.stringify({app: "tw5",tw5: part}).length > MAX_METADATA_LENGTH) {
			// The fields are too big to be stored in a single reply, drop them
				part.fields = {};
				part.hash = util.getPayloadHash(part);
			}
			part.type = "tiddler";
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
Prepare the operations for saving the wiki to Hive. The callback is
invoked with (err,operations,context). No keychain is required, so the
result can also be used to review the operations before broadcasting
them
*/
	HiveStore.prototype.prepareOperations = function(callback) {
		var self = this,
			config = this.getConfig();
		callback = callback || function() {};
		if(!config.account) {
			return callback("No Hive account name has been configured. Please enter your Hive account name in the control panel.");
		}
		// The wiki that is operated on is the wiki of the last load: its
		// root post belongs to the account that published it, which may
		// be a different account than the configured one. A wiki that has
		// never been loaded is the wiki of the configured account
		var remote = this.getRemoteState() || {},
			owner = remote.author || config.account,
			wikiId = remote.wikiid || this.getWikiId(),
			wikiTitle = this.getWikiTitle(),
			rootPermlink = remote.permlink || util.getRootPermlink(wikiId,wikiTitle),
			titles = this.getPublishTitles(config);
		this.setStatus("Reading the current state of the post " + rootPermlink + "...");
		this.api.getContent(owner,rootPermlink,function(err,rootContent) {
			if(err) {
				self.setStatus("");
				return callback(err);
			}
			self.getAllReplies(owner,rootPermlink,function(err,replies) {
				if(err) {
					self.setStatus("");
					return callback(err);
				}
				var chainAuthor = rootContent ? String(rootContent.author || "").toLowerCase() : null,
					// The author of the chain post is authoritative, but the
					// pinned author is kept when the chain has no root post,
					// for example when the wiki has not been published yet
					effectiveOwner = chainAuthor || owner;
				self.buildOperations(config,effectiveOwner,wikiId,wikiTitle,rootPermlink,rootContent,replies,titles,function(err,operations,mode) {
					if(err) {
						self.setStatus("");
						return callback(err);
					}
					callback(null,operations,{config: config,owner: effectiveOwner,wikiId: wikiId,wikiTitle: wikiTitle,rootPermlink: rootPermlink,titles: titles,mode: mode});
				});
			});
		});
	};

	/*
Save the wiki to Hive. The callback is invoked with (err,result)
*/
	HiveStore.prototype.save = function(callback) {
		var self = this;
		callback = callback || function() {};
		if(!this.keychain) {
			return callback("The Hive Keychain browser extension is not available");
		}
		this.prepareOperations(function(err,operations,context) {
			if(err) {
				return callback(err);
			}
			if(!operations.length) {
				self.setStatus("Nothing to save, the post " + context.rootPermlink + " is up to date");
				return callback(null,{permlink: context.rootPermlink,operations: 0});
			}
			self.broadcastOperations(context.config,operations,function(err,results) {
				if(err) {
					self.setStatus("");
					return callback(err);
				}
				if(context.mode === "propose") {
				// The changes were broadcast as proposals for the owner of
				// the wiki. Record them, so that a save that is retried
				// before the chain has indexed the proposals does not
				// propose the same content again. The state of the wiki
				// itself is not changed: the wiki still belongs to its owner
					var state = self.getRemoteState() || {};
					state.proposals = state.proposals || {};
					operations.forEach(function(operation) {
						var metadata = self.getTw5Metadata(operation);
						if(metadata && metadata.hash) {
							state.proposals[metadata.hash] = metadata.title;
						}
					});
					self.setRemoteState(state);
					var proposeText = "Proposed " + operations.length + " change(s) to the wiki of @" + context.owner + ". The owner can approve the proposals and publish them.";
					var proposeOverLimit = self.getOverLimitTiddlers() || [];
					if(proposeOverLimit.length) {
						proposeText += " The following tiddler(s) exceeded the limits of a Hive post and were truncated: " + proposeOverLimit.join(", ");
					}
					self.setStatus(proposeText);
					return callback(null,{permlink: context.rootPermlink,operations: operations.length,results: results,proposed: true,warnings: proposeOverLimit});
				}
				var state = self.getRemoteState() || {};
				state.wikiid = context.wikiId;
				state.permlink = context.rootPermlink;
				state.url = self.getUrl(context.config,context.rootPermlink);
				state.saved = $tw.utils.stringifyDate(new Date());
				state.tiddlers = self.getPublishedTiddlers(context.wikiId,context.titles);
				self.setRemoteState(state);
				var statusText = "Saved " + operations.length + " operation(s) to " + self.getUrl(context.config,context.rootPermlink);
				var overLimit = self.getOverLimitTiddlers() || [];
				if(overLimit.length) {
					// Warn about the tiddlers that would exceed the limits of a Hive post
					statusText += " The following tiddler(s) exceeded the limits of a Hive post and were truncated: " + overLimit.join(", ");
				}
				self.setStatus(statusText);
				callback(null,{permlink: context.rootPermlink,operations: operations.length,results: results,warnings: overLimit});
			});
		});
	};

	/*
Start a new wiki: forget the wiki that has been loaded or saved, so that
the next save publishes a new root post to the configured account. The
wiki id is regenerated, because a permlink of an account can only be used
once on the chain. The callback is invoked with (err)
*/
	HiveStore.prototype.newWiki = function(callback) {
		var config = this.getConfig();
		callback = callback || function() {};
		this.wiki.deleteTiddler(REMOTE_TIDDLER);
		this.wiki.deleteTiddler(CONFIG_PREFIX + "permalink");
		this.wiki.deleteTiddler(PROPOSALS_TIDDLER);
		this.wiki.deleteTiddler(PROPOSAL_LIST_TIDDLER);
		this.wiki.addTiddler(new $tw.Tiddler({title: CONFIG_PREFIX + "wiki-id",text: util.generateId()}));
		this.setStatus("New wiki: the next save publishes a new root post to the account " + (config.account || "(no account configured)"));
		callback(null,{account: config.account});
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
Build the list of operations that have to be broadcast. The owner is the
account that published the root post of the wiki. When the configured
account is not the owner, the changes are not broadcast as replies of the
wiki but as proposals, and the root post and the deletions are left to
the owner. The callback is invoked with (err,operations,mode)
*/
	HiveStore.prototype.buildOperations = function(config,owner,wikiId,wikiTitle,rootPermlink,rootContent,replies,titles,callback) {
		var self = this,
			operations = [],
			existing = {},
			index = {},
			proposed = {},
			// The configured account signs the transactions. When it is
			// not the owner of the wiki, the changes can only be proposed
			propose = Boolean(owner && String(owner).toLowerCase() !== String(config.account).toLowerCase()),
			state = this.getRemoteState() || {},
			published = state.tiddlers || {},
			proposalsRecorded = state.proposals || {},
			overLimit = [];
		(replies || []).forEach(function(reply) {
			existing[reply.permlink] = reply;
			// Record the proposals that the configured account has
			// already broadcast, so that a save does not propose the same
			// content again
			if(reply.author === config.account) {
				var metadata = self.getTw5Metadata(reply);
				if(metadata && metadata.type === "proposal" && metadata.hash && metadata.title) {
					proposed[metadata.hash] = metadata.title;
				}
			}
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
				parts = self.splitPayload(payload);
			if(JSON.stringify({app: "tw5",tw5: payload}).length > MAX_METADATA_LENGTH) {
				// The metadata of this tiddler would exceed the limit of a Hive post
				if(overLimit.indexOf(entry.title) === -1) {
					overLimit.push(entry.title);
				}
			}
			if(String(payload.text || "").length > util.MAX_BODY_LENGTH) {
				// The body of this tiddler would exceed the limit of a Hive post
				if(overLimit.indexOf(entry.title) === -1) {
					overLimit.push(entry.title);
				}
			}
			parts.forEach(function(part) {
				var permlink = part.parts > 1 ? util.getPartPermlink(entry.permlink,part.part) : entry.permlink,
					existingReply = existing[permlink],
					// The reader url of this tiddler: it is shared by all the parts
					// of the tiddler and carries the tiddler title as the fragment
					canonicalUrl = self.makeCanonicalUrl(config,rootPermlink,entry.title),
					// The body is rendered before the metadata, so that its
					// hash can be stored with the metadata: a body that the
					// current version of the app would render differently,
					// for example with the links of the tiddlers resolved to
					// their posts, is broadcast again even when the content
					// of the tiddler is unchanged
					body = util.makeTiddlerBody(part,{
						frontEnd: config.frontEnd,
						canonicalUrl: canonicalUrl,
						linkResolver: self.makeLinkResolver(config,entryList,wikiId),
						tiddler: tiddler
					});
				part.bh = util.hashString(body);
				var metadata = {app: "tw5",canonical_url: canonicalUrl,tw5: part},
					remoteHash = existingReply ? self.getTw5Metadata(existingReply) : null;
				index[entry.title] = {permlink: entry.permlink,parts: part.parts,hash: part.hash,part: part};
				if(remoteHash) {
					if(self.isReplyUpToDate(part,part.bh,remoteHash)) {
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
				if(propose) {
				// The configured account is not the owner of the wiki. The
				// change is broadcast as a proposal, which the owner can
				// approve. A proposal is a single reply that carries the
				// whole content of the tiddler, and it is addressed to the
				// reply of the tiddler, or to the root post when the
				// tiddler has no reply yet
					var payloadHash = util.getPayloadHash(payload);
					if(proposed[payloadHash] === entry.title || proposalsRecorded[payloadHash] === entry.title) {
					// This content has been proposed already
						return;
					}
					var proposalPermlink = util.getProposalPermlink(entry.permlink,payloadHash),
						// The reader url of the wiki of the owner, where the
						// proposal would be published
						proposalCanonicalUrl = self.makeCanonicalUrl(config,rootPermlink,entry.title,owner);
					operations.push({
						type: "comment",
						parent_author: owner,
						parent_permlink: existingReply ? existingReply.permlink : rootPermlink,
						author: config.account,
						permlink: proposalPermlink,
						title: util.makeTitle("Proposal: " + entry.title),
						body: util.makeProposalBody(entry.title,{frontEnd: config.frontEnd,canonicalUrl: proposalCanonicalUrl}),
						json_metadata: JSON.stringify({app: "tw5",canonical_url: proposalCanonicalUrl,tw5: {
							type: "proposal",
							title: entry.title,
							text: String(payload.text || ""),
							fields: payload.fields || {},
							tags: payload.tags || [],
							created: payload.created || "",
							modified: payload.modified || "",
							hash: payloadHash
						}})
					});
					return;
				}
				var metadataText = JSON.stringify(metadata);
				operations.push({
					type: "comment",
					parent_author: config.account,
					// All the tiddlers are replies to the root post of the wiki, the
					// hierarchy between the tiddlers is carried by the tags of the
					// tiddler that names its parent
					parent_permlink: rootPermlink,
					author: config.account,
					permlink: permlink,
					title: util.makeTitle(entry.title + (part.parts > 1 ? " (" + part.part + "/" + part.parts + ")" : "")),
					body: body,
					json_metadata: metadataText
				});
				if(body.length > util.MAX_BODY_LENGTH || metadataText.length > MAX_METADATA_LENGTH) {
					// The operation would exceed the limits of a Hive post, the
					// tiddler is reported as over the limit
					if(overLimit.indexOf(entry.title) === -1) {
						overLimit.push(entry.title);
					}
				}
			});
		});
		// The operations for the tiddlers that have been deleted. A non
		// owner cannot delete the tiddlers of a wiki, the owner has to do
		// that
		if(!propose) {
			Object.keys(existing).forEach(function(permlink) {
				var metadata = self.getTw5Metadata(existing[permlink]);
				if(!util.isTiddlerMetadata(metadata)) {
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
					json_metadata: JSON.stringify({app: "tw5",canonical_url: self.makeCanonicalUrl(config,rootPermlink,metadata.title),tw5: {
						type: "tiddler",
						title: metadata.title,
						deleted: true,
						part: metadata.part || 1,
						parts: metadata.parts || 1,
						hash: util.hashString("deleted|" + metadata.title)
					}})
				});
			});
		}
		// The operation for the root post
		var root = {
			type: "root",
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
		// A non owner never touches the root post of the wiki: the root
		// post can only be broadcast by the account that owns it
		if(!propose && (!rootContent || !remoteRoot || remoteRoot.hash !== root.hash)) {
			var canonicalUrl = self.makeCanonicalUrl(config,rootPermlink);
			// The root url carries no uri fragment
			operations.unshift({
				type: "comment",
				parent_author: "",
				parent_permlink: config.category,
				author: config.account,
				permlink: rootPermlink,
				title: util.makeTitle(wikiTitle),
				body: util.makeRootBody(root,{frontEnd: config.frontEnd, appUrl: this.getConfigText("app-url",""), canonicalUrl: canonicalUrl}),
				json_metadata: JSON.stringify({app: "tw5",canonical_url: canonicalUrl,tw5: root})
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
		self.overLimitTitles = overLimit;
		callback(null,ordered,propose ? "propose" : "publish");
	};

	/*
Return the title of the tiddler that an operation belongs to
*/
	HiveStore.prototype.getOperationTitle = function(operation,byTitle) {
		var permlink = operation.permlink,
			titles = Object.keys(byTitle);
		for(var i = 0; i < titles.length; i++) {
			if(permlink === byTitle[titles[i]].permlink || permlink.indexOf(byTitle[titles[i]].permlink + "-p") === 0) {
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
Return whether the reply on the chain already holds the given part of a
tiddler and the body that this version of the app renders for it. The
content is compared by its hash, and because the dates of a tiddler are
not part of the published content - the reader takes the dates of the
Hive post - the hash is also compared against the dates that the reply on
the chain carries. The body is compared by its own hash, so that a body
that the current version of the app would render differently, for example
with the tiddler links resolved, is broadcast again even when the content
of the tiddler is unchanged
*/
	HiveStore.prototype.isReplyUpToDate = function(part,bodyHash,remoteMetadata) {
		if(remoteMetadata.bh !== bodyHash) {
			return false;
		}
		if(remoteMetadata.hash === part.hash) {
			return true;
		}
		var base = {
				title: part.title,
				text: part.text,
				fields: part.fields,
				tags: part.tags,
				part: part.part,
				parts: part.parts
			},
			withDates = {};
		Object.keys(base).forEach(function(key) {
			withDates[key] = base[key];
		});
		withDates.created = remoteMetadata.created || "";
		withDates.modified = remoteMetadata.modified || "";
		return remoteMetadata.hash === util.getPayloadHash(withDates);
	};

	/*
Wait until the reply interval of the chain has elapsed since the last
comment of the account, so that the next transaction that creates a
comment is accepted. The chain rejects a comment when less than
HIVE_MIN_REPLY_INTERVAL of 3 seconds have passed since the previous one,
which also applies after a save that failed halfway through. The callback
is invoked when it is safe to broadcast
*/
	HiveStore.prototype.waitReplyInterval = function(config,callback) {
		var self = this;
		if(!this.api || !config.account) {
			return callback();
		}
		this.api.getAccounts([config.account],function(err,accounts) {
			var account = (!err && accounts && accounts.length) ? accounts[0] : null,
				text = account ? account.last_post : "",
				// The chain timestamps are utc, without a timezone suffix
				last = text ? Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(text) ? text : text + "Z") : NaN;
			if(isNaN(last)) {
				return callback();
			}
			var remaining = util.MIN_REPLY_INTERVAL - (Date.now() - last);
			if(remaining > 0) {
				self.setStatus("Waiting " + Math.ceil(remaining / 1000) + " second(s) until the chain accepts the next comment...");
				setTimeout(callback,remaining);
			} else {
				callback();
			}
		});
	};

	/*
Broadcast the operations, one transaction per operation: the chain rejects
a transaction that creates more than one comment with the reply interval
assert, so the operations cannot be packed together. Before each
transaction the last comment of the account is checked, so that a save
retried shortly after a failed one does not collide with it
*/
	HiveStore.prototype.broadcastOperations = function(config,operations,callback) {
		var self = this,
			index = 0,
			results = [];
		function next() {
			if(index >= operations.length) {
				return callback(null,results);
			}
			var operation = operations[index],
				size = util.getOperationSize(operation);
			if(size > util.MAX_TRANSACTION_LENGTH) {
				return callback("The operation " + operation.permlink + " is " + size + " characters long and does not fit into a Hive transaction");
			}
			self.waitReplyInterval(config,function() {
				index++;
				self.setStatus("Broadcasting transaction " + index + " of " + operations.length + "...");
				self.keychain.broadcast(config.account,[operation],"Posting",function(err,result) {
					if(err) {
						return callback(err);
					}
					results.push(result);
					// Wait for the reply interval of the chain before the
					// next transaction, and finish immediately after the
					// last one
					if(index < operations.length) {
						setTimeout(next,util.MIN_REPLY_INTERVAL);
					} else {
						next();
					}
				});
			});
		}
		next();
	};

	/*
Approve the proposals and the comments of other accounts: broadcast the
official replies that hold the approved content of the tiddlers, so that
the proposals become part of the wiki. Only the owner of the wiki can
approve, because the official replies are broadcast under the account that
signs the transactions. The replies that are approved are given as
replies, and the replies of the wiki as existing, so that replies whose
content is already broadcast are not broadcast again. The callback is
invoked with (err,result)
*/
	HiveStore.prototype.approve = function(replies,existing,callback) {
		var self = this,
			config = this.getConfig(),
			operations = [],
			remote = this.getRemoteState() || {},
			wikiId = remote.wikiid || this.getWikiId(),
			rootPermlink = remote.permlink || util.getRootPermlink(wikiId,this.getWikiTitle()),
			existingByPermlink = {};
		callback = callback || function() {};
		if(!config.account) {
			return callback("No Hive account name has been configured. Please enter your Hive account name in the control panel.");
		}
		if(remote.author && String(remote.author).toLowerCase() !== String(config.account).toLowerCase()) {
			return callback("Only the owner @" + remote.author + " of the wiki can approve the proposals");
		}
		if(!this.keychain) {
			return callback("The Hive Keychain browser extension is not available");
		}
		(existing || []).forEach(function(reply) {
			existingByPermlink[reply.permlink] = reply;
		});
		// The official replies are rendered with the links of the whole
		// published wiki, so that their bodies match the bodies that a
		// save of the owner renders and are not broadcast again
		var publishEntries = this.getPublishTitles(config).map(function(title) {
			return {title: title,permlink: util.getTiddlerPermlink(wikiId,title)};
		});
		(replies || []).forEach(function(reply) {
			var metadata = self.getTw5Metadata(reply);
			if(!metadata || (metadata.type !== "proposal" && metadata.type !== "comment")) {
				return;
			}
			// The content of the official tiddler is authored in tiddlywiki
			// syntax, the markdown of the hive reply is converted into it
			var text = util.isMarkdown(metadata.text) ? util.markdownToTiddlyWiki(metadata.text) : (metadata.text || ""),
				tiddlerPermlink = util.getTiddlerPermlink(wikiId,metadata.title),
				// The official replies hold exactly the content that a save
				// of the owner would broadcast, so that a save after the
				// approval does not broadcast the approved tiddlers again
				parts = self.splitPayload({
					title: metadata.title,
					text: text,
					fields: metadata.fields || {},
					tags: metadata.tags || [],
					created: util.toTiddlerDate(metadata.created),
					modified: util.toTiddlerDate(metadata.modified)
				});
			parts.forEach(function(part) {
				var permlink = part.parts > 1 ? util.getPartPermlink(tiddlerPermlink,part.part) : tiddlerPermlink,
					existingReply = existingByPermlink[permlink],
					canonicalUrl = self.makeCanonicalUrl(config,rootPermlink,part.title),
					// A tiddler that does not have a reply on the chain yet
					// is created as the answer of the proposal, so that the
					// reply shows who proposed it. A reply that exists is
					// edited in place, and an edit has to keep the parent of
					// the reply
					parentAuthor = existingReply ? (existingReply.parent_author || config.account) : reply.author,
					parentPermlink = existingReply ? (existingReply.parent_permlink || rootPermlink) : reply.permlink,
					body = util.makeTiddlerBody(part,{
						frontEnd: config.frontEnd,
						canonicalUrl: canonicalUrl,
						linkResolver: self.makeLinkResolver(config,publishEntries,wikiId)
					});
				part.bh = util.hashString(body);
				// The permlink of the proposal is kept in the metadata of
				// the official reply, so that the proposal is recognized as
				// accepted when the wiki is loaded
				part.approved = reply.permlink;
				if(existingReply) {
					var remoteMetadata = self.getTw5Metadata(existingReply);
					if(remoteMetadata && self.isReplyUpToDate(part,part.bh,remoteMetadata)) {
					// The approved content is broadcast already
						return;
					}
				}
				operations.push({
					type: "comment",
					parent_author: parentAuthor,
					parent_permlink: parentPermlink,
					author: config.account,
					permlink: permlink,
					title: util.makeTitle(part.title + (part.parts > 1 ? " (" + part.part + "/" + part.parts + ")" : "")),
					body: body,
					json_metadata: JSON.stringify({app: "tw5",canonical_url: canonicalUrl,tw5: part})
				});
			});
		});
		if(!operations.length) {
			return callback(null,{permlink: rootPermlink,operations: 0,results: []});
		}
		this.broadcastOperations(config,operations,function(err,results) {
			if(err) {
				return callback(err);
			}
			// Add the approved content to the wiki and record it as
			// published, so that a save that is retried before the chain
			// has indexed the approval does not broadcast it again
			var state = self.getRemoteState() || {};
			state.wikiid = state.wikiid || wikiId;
			state.permlink = state.permlink || rootPermlink;
			state.tiddlers = state.tiddlers || {};
			operations.forEach(function(operation) {
				var metadata = self.getTw5Metadata(operation),
					title = metadata.title;
				if(!util.isTiddlerMetadata(metadata)) {
					return;
				}
				self.wiki.addTiddler(util.payloadToTiddler({
					title: title,
					text: metadata.text,
					fields: metadata.fields,
					tags: metadata.tags,
					created: util.toTiddlerDate(metadata.created),
					modified: util.toTiddlerDate(metadata.modified)
				}));
				var record = state.tiddlers[title];
				if(!record) {
					record = state.tiddlers[title] = {permlink: util.getTiddlerPermlink(wikiId,title),hashes: {}};
				}
				record.hashes[metadata.part || 1] = metadata.hash;
				// The proposal that this official reply approves is marked
				// as accepted in the record of the proposals
				if(metadata.approved) {
					self.setProposalRecord(metadata.approved,{status: "accepted",updated: $tw.utils.stringifyDate(new Date())});
				}
			});
			self.setRemoteState(state);
			self.updateProposalList();
			self.setStatus("Approved " + operations.length + " reply(ies) as the owner of the wiki");
			callback(null,{permlink: rootPermlink,operations: operations.length,results: results});
		});
	};

	/*
Approve the pending proposals of the wiki that has been loaded last: read
the replies of its root post and approve the proposals and the comments
of the other accounts, keeping the latest proposal of a tiddler when
several accounts have proposed a change to the same tiddler. The callback
is invoked with (err,result)
*/
	HiveStore.prototype.approvePending = function(callback) {
		var self = this,
			config = this.getConfig(),
			remote = this.getRemoteState() || {},
			author = remote.author || config.account,
			permlink = remote.permlink;
		callback = callback || function() {};
		if(!config.account) {
			return callback("No Hive account name has been configured. Please enter your Hive account name in the control panel.");
		}
		if(remote.author && String(remote.author).toLowerCase() !== String(config.account).toLowerCase()) {
			return callback("Only the owner @" + remote.author + " of the wiki can approve the proposals");
		}
		if(!permlink) {
			return callback("There is no Hive wiki to approve. Please load a wiki first.");
		}
		this.setStatus("Reading the replies of the post " + permlink + "...");
		this.getAllReplies(author,permlink,function(err,replies) {
			if(err) {
				self.setStatus("");
				return callback(err);
			}
			replies = replies || [];
			// The replies that can be approved are the proposals and the
			// comments of the other accounts
			var pending = replies.filter(function(reply) {
				if(String(reply.author).toLowerCase() === String(config.account).toLowerCase()) {
					return false;
				}
				var metadata = self.getTw5Metadata(reply);
				return Boolean(metadata && (metadata.type === "proposal" || metadata.type === "comment"));
			});
			if(!pending.length) {
				self.setStatus("There are no proposals to approve");
				return callback(null,{operations: 0,pending: 0});
			}
			// Sync the record of the proposals, so that the approved
			// proposals are known in it
			self.syncProposals(replies);
			// When several replies propose a change to the same tiddler,
			// only the latest proposal is approved, because every approval
			// replaces the content of the tiddler
			var latest = {};
			pending.forEach(function(reply) {
				var metadata = self.getTw5Metadata(reply),
					existing = latest[metadata.title];
				if(!existing || String(reply.created || "") >= String(existing.created || "")) {
					latest[metadata.title] = reply;
				}
			});
			var selected = Object.keys(latest).map(function(title) {
				return latest[title];
			});
			self.approve(selected,replies,function(err,result) {
				if(err) {
					self.setStatus("");
					return callback(err);
				}
				if(result.operations === 0) {
					self.setStatus("The proposals are broadcast already, there is nothing to approve");
				}
				result.pending = selected.length;
				callback(null,result);
			});
		});
	};

	/*
Approve a single proposal by its permlink: read the replies of the wiki
that has been loaded last and approve the proposal. The callback is
invoked with (err,result)
*/
	HiveStore.prototype.approveProposal = function(permlink,callback) {
		var self = this,
			config = this.getConfig(),
			remote = this.getRemoteState() || {},
			author = remote.author || config.account,
			rootPermlink = remote.permlink;
		callback = callback || function() {};
		if(!config.account) {
			return callback("No Hive account name has been configured. Please enter your Hive account name in the control panel.");
		}
		if(remote.author && String(remote.author).toLowerCase() !== String(config.account).toLowerCase()) {
			return callback("Only the owner @" + remote.author + " of the wiki can approve the proposals");
		}
		if(!rootPermlink) {
			return callback("There is no Hive wiki to approve. Please load a wiki first.");
		}
		this.setStatus("Reading the replies of the post " + rootPermlink + "...");
		this.getAllReplies(author,rootPermlink,function(err,replies) {
			if(err) {
				self.setStatus("");
				return callback(err);
			}
			replies = replies || [];
			var proposal = null;
			replies.forEach(function(reply) {
				if(reply.permlink === permlink) {
					proposal = reply;
				}
			});
			if(!proposal) {
				self.setStatus("");
				return callback("Could not find the proposal " + permlink + " in the replies of the wiki. Please load the wiki first.");
			}
			// Sync the record of the proposals, so that the approved
			// proposal is known in it
			self.syncProposals(replies);
			self.approve([proposal],replies,function(err,result) {
				if(err) {
					self.setStatus("");
					return callback(err);
				}
				if(result.operations === 0) {
					self.setStatus("The proposal is broadcast already, there is nothing to approve");
				}
				callback(null,result);
			});
		});
	};

	/*
Return the record of the proposals of the wiki, which is kept in a tiddler
of the wiki so that the curation of the owner survives a reload
*/
	HiveStore.prototype.getProposalsRegistry = function() {
		var text = this.wiki.getTiddlerText(PROPOSALS_TIDDLER),
			registry = null;
		if(text) {
			try {
				registry = JSON.parse(text);
			} catch(e) {
				registry = null;
			}
		}
		if(!registry || !registry.proposals) {
			registry = {proposals: {}};
		}
		return registry;
	};

	HiveStore.prototype.setProposalsRegistry = function(registry) {
		this.wiki.addTiddler(new $tw.Tiddler({title: PROPOSALS_TIDDLER,type: "application/json",text: JSON.stringify(registry,null,2)}));
	};

	/*
Record a change of the status of a proposal. The statuses are
outstanding, accepted, merged and rejected
*/
	HiveStore.prototype.setProposalRecord = function(permlink,patch) {
		var registry = this.getProposalsRegistry(),
			entry = registry.proposals[permlink];
		if(!entry) {
			entry = registry.proposals[permlink] = {status: "outstanding",updated: ""};
		}
		Object.keys(patch).forEach(function(key) {
			entry[key] = patch[key];
		});
		this.setProposalsRegistry(registry);
	};

	/*
Sync the record of the proposals with the replies of the wiki: proposals
that are not in the record yet are added as outstanding, the statuses that
are broadcast on the chain as replies of the proposals are applied, and a
proposal whose approval is kept in the metadata of an official reply is
marked as accepted. The statuses that the owner decided locally are kept
when the chain does not hold a decision about the proposal
*/
	HiveStore.prototype.syncProposals = function(replies) {
		var self = this,
			registry = this.getProposalsRegistry(),
			chainStatus = {},
			accepted = {},
			proposals = {};
		(replies || []).forEach(function(reply) {
			var metadata = self.getTw5Metadata(reply);
			if(!metadata) {
				return;
			}
			if(metadata.type === "proposal") {
				proposals[reply.permlink] = {
					title: metadata.title,
					author: reply.author || "",
					created: reply.created || "",
					hash: metadata.hash || ""
				};
			} else if(metadata.type === "proposal-status" && metadata.proposal) {
				var existing = chainStatus[metadata.proposal];
				if(!existing || String(reply.created || "") >= String(existing.created || "")) {
					chainStatus[metadata.proposal] = {status: metadata.status,created: reply.created || ""};
				}
			} else if(util.isTiddlerMetadata(metadata) && metadata.approved) {
				accepted[metadata.approved] = true;
			}
		});
		Object.keys(proposals).forEach(function(permlink) {
			var proposal = proposals[permlink],
				entry = registry.proposals[permlink];
			if(!entry) {
				entry = registry.proposals[permlink] = {status: "outstanding",updated: ""};
			}
			entry.title = proposal.title;
			entry.author = proposal.author;
			entry.created = proposal.created;
			entry.hash = proposal.hash;
			if(chainStatus[permlink] && (chainStatus[permlink].status === "rejected" || chainStatus[permlink].status === "merged")) {
			// A decision that is broadcast on the chain is authoritative
				entry.status = chainStatus[permlink].status;
				entry.updated = chainStatus[permlink].created;
			} else if(accepted[permlink] && (!entry.status || entry.status === "outstanding")) {
				entry.status = "accepted";
				entry.updated = entry.updated || proposal.created;
			}
		});
		this.setProposalsRegistry(registry);
		this.updateProposalList();
	};

	/*
Regenerate the listing of the proposals from the record of the proposals.
The listing is a tiddler of the wiki that the owner can open, and it is
transcluded in the control panel. It carries a decision button for every
outstanding proposal
*/
	HiveStore.prototype.updateProposalList = function() {
		var registry = this.getProposalsRegistry(),
			remote = this.getRemoteState() || {},
			permlinks = Object.keys(registry.proposals),
			lines = [];
		permlinks.sort(function(a,b) {
			var entryA = registry.proposals[a],
				entryB = registry.proposals[b];
			return String(entryA.title).localeCompare(String(entryB.title)) || String(entryA.created).localeCompare(String(entryB.created));
		});
		lines.push("The proposals that other Hive accounts have broadcast as replies to the wiki of @" + (remote.author || "(unknown)") + ". The status of a proposal is kept in the [[" + PROPOSALS_TIDDLER + "]] tiddler, and the decisions of the owner are broadcast to the Hive as replies of the proposals. A proposal that is ''accepted'' is published to the chain by an approval, a proposal that is ''merged'' was incorporated into the wiki by the owner, and a proposal that is ''rejected'' was purposely left out.");
		lines.push("");
		if(!permlinks.length) {
			lines.push("There are no proposals.");
		} else {
			lines.push("|!Tiddler |!Proposer |!Proposed |!Status |!Decision |");
			permlinks.forEach(function(permlink) {
				var entry = registry.proposals[permlink],
					created = String(entry.created || "").replace("T"," ").substring(0,16),
					decision = "";
				if(entry.status === "outstanding") {
					decision = "<$button><$action-hiveapprove proposal=\"" + permlink + "\"/>Approve</$button> <$button><$action-hiveproposal permlink=\"" + permlink + "\" status=\"rejected\"/>Reject</$button> <$button><$action-hiveproposal permlink=\"" + permlink + "\" status=\"merged\"/>Merge</$button>";
				}
				lines.push("|[[" + entry.title + " (proposal by " + entry.author + ")]] |" + (entry.author || "") + " |" + created + " |" + (entry.status || "outstanding") + " |" + decision + " |");
			});
		}
		this.wiki.addTiddler(new $tw.Tiddler({title: PROPOSAL_LIST_TIDDLER,text: lines.join("\n")}));
	};

	/*
Broadcast the decision of the owner about a proposal, which is rejected or
merged. The decision is broadcast as a reply of the proposal, so that it
is kept on the chain and is visible to every device that loads the wiki,
and it is recorded in the record of the proposals. Only the owner of the
wiki can decide about proposals. The callback is invoked with (err,result)
*/
	HiveStore.prototype.setProposalStatus = function(permlink,status,callback) {
		var self = this,
			config = this.getConfig(),
			remote = this.getRemoteState() || {};
		callback = callback || function() {};
		if(status !== "rejected" && status !== "merged") {
			return callback("The status of a proposal has to be rejected or merged");
		}
		if(!config.account) {
			return callback("No Hive account name has been configured. Please enter your Hive account name in the control panel.");
		}
		if(remote.author && String(remote.author).toLowerCase() !== String(config.account).toLowerCase()) {
			return callback("Only the owner @" + remote.author + " of the wiki can decide about the proposals");
		}
		if(!this.keychain) {
			return callback("The Hive Keychain browser extension is not available");
		}
		var entry = this.getProposalsRegistry().proposals[permlink];
		if(!entry) {
			return callback("The proposal is not in the record of the proposals. Please load the wiki first.");
		}
		var operation = {
			type: "comment",
			parent_author: entry.author || remote.author || config.account,
			parent_permlink: permlink,
			author: config.account,
			permlink: permlink + "-status",
			title: util.makeTitle("Status: " + entry.title),
			body: "> **Note:** The proposal to change the tiddler **" + entry.title + "** was " + status + " by the owner of the wiki (@" + config.account + ").",
			json_metadata: JSON.stringify({app: "tw5",tw5: {
				type: "proposal-status",
				status: status,
				title: entry.title,
				proposal: permlink,
				author: entry.author || "",
				hash: entry.hash || ""
			}})
		};
		this.setStatus("Broadcasting the decision about the proposal to the tiddler " + entry.title + "...");
		this.broadcastOperations(config,[operation],function(err,results) {
			if(err) {
				self.setStatus("");
				return callback(err);
			}
			self.setProposalRecord(permlink,{status: status,updated: $tw.utils.stringifyDate(new Date())});
			self.updateProposalList();
			self.setStatus("The proposal to change the tiddler " + entry.title + " was " + status);
			callback(null,{operations: 1,results: results,status: status,proposal: permlink});
		});
	};

	/*
Load the wiki from Hive. The callback is invoked with (err,result)
*/
	HiveStore.prototype.load = function(permlink,callback) {
		var self = this,
			config = this.getConfig(),
			remote = this.getRemoteState() || {},
			// The permlink may be given as a bare permlink, as
			// @author/permlink or as a full url of the post. An author
			// given with the permlink is read instead of the configured
			// account, so that the wiki of another account can be loaded
			parsed = util.parsePermlink(permlink),
			author;
		callback = callback || function() {};
		if(parsed) {
			author = parsed.author || remote.author || config.account;
			permlink = parsed.permlink;
		} else {
			author = remote.author || config.account;
			permlink = remote.permlink;
		}
		if(!author) {
			return callback("No Hive account name has been configured. Please enter your Hive account name in the control panel.");
		}
		if(!permlink) {
			return callback("There is no Hive post to load. Please save the wiki first, or enter the permlink of the root post.");
		}
		this.setStatus("Reading the Hive post " + permlink + "...");
		this.api.getContent(author,permlink,function(err,rootContent) {
			if(err) {
				self.setStatus("");
				return callback(err);
			}
			if(!rootContent) {
				self.setStatus("");
				return callback("Could not find a Hive post with the permlink " + permlink);
			}
			var metadata = self.getTw5Metadata(rootContent);
			if(!metadata || !util.isRootMetadata(metadata)) {
				self.setStatus("");
				return callback("The Hive post " + permlink + " is not a TiddlyWiki5 wiki");
			}
			self.getAllReplies(author,permlink,function(err,replies) {
				if(err) {
					self.setStatus("");
					return callback(err);
				}
				self.applyReplies(config,metadata,replies,function(err,summary) {
					if(err) {
						self.setStatus("");
						return callback(err);
					}
					// Sync the record of the proposals with the replies
					self.syncProposals(replies);
					var previousState = self.getRemoteState() || {};
					self.setRemoteState({
						author: author,
						wikiid: metadata.wikiid,
						permlink: permlink,
						url: self.getUrl(config,permlink,author),
						saved: previousState.saved || "",
						tiddlers: previousState.wikiid === metadata.wikiid ? (previousState.tiddlers || {}) : {},
						proposals: previousState.proposals || {}
					});
					self.setStatus("Loaded " + summary.added + " tiddler(s) from " + self.getUrl(config,permlink,author));
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
			summary = {added: 0,updated: 0,removed: 0,skipped: 0,comments: 0},
			byTitle = {},
			comments = [];
		(replies || []).forEach(function(reply) {
			var metadata = self.getTw5Metadata(reply);
			if(!metadata) {
				return;
			}
			if(metadata.type === "comment" || metadata.type === "proposal") {
				// A reply that is a comment is a proposed change or a comment on
				// the tiddler that it replies to. It is loaded as a transient
				// tiddler that holds the replied to tiddler as a tag
				comments.push({reply: reply,metadata: metadata});
				return;
			}
			if(metadata.type !== "tiddler" && !util.isTiddlerMetadata(metadata)) {
				return;
			}
			// The permlink of the reply and the permlink of its parent are
			// needed to match the replies of proposals and comments with the
			// tiddlers that they reply to, and the dates of the post are
			// the dates of the published content
			metadata.replyPermlink = reply.permlink;
			metadata.parentPermlink = reply.parent_permlink;
			metadata.postCreated = reply.created || "";
			metadata.postModified = reply.last_update || reply.modified || reply.created || "";
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
				// The dates of the Hive post are the dates of the published
				// content: the reader takes them instead of the dates that
				// the tiddler carried in the wiki that published it, which
				// are often the dates of the demo content of the shell. The
				// dates are normalized to datestamps, because the created
				// and modified fields are parsed into dates when a tiddler
				// is constructed and the ISO timestamps of the chain cannot
				// be parsed by the field module
				created: util.toTiddlerDate(parts[0].postCreated || parts[0].created),
				modified: util.toTiddlerDate(parts[0].postModified || parts[0].modified)
			};
			if(existing) {
				summary.updated++;
			} else {
				summary.added++;
			}
			self.wiki.addTiddler(util.payloadToTiddler(payload));
		});
		// The comments and the proposals are loaded as transient tiddlers
		// that hold the tiddler that they reply to as a tag, and that hold
		// a tag that marks them as a proposed change or a comment
		var titlesByPermlink = {};
		Object.keys(byTitle).forEach(function(title) {
			byTitle[title].forEach(function(part) {
				titlesByPermlink[part.replyPermlink || ""] = title;
			});
		});
		comments.forEach(function(comment) {
			var metadata = comment.metadata,
				metadataTags = $tw.utils.isArray(metadata.tags) ? metadata.tags.slice(0) : (metadata.tags ? [metadata.tags] : []),
				transientTags = [],
				repliedTo = null;
			metadataTags.forEach(function(tag) {
				if(tag === util.COMMENT_TAG) {
					return;
				}
				if(!repliedTo) {
					// The first tag that is not a marker names the tiddler to reply to
					repliedTo = tag;
				}
				transientTags.push(tag);
			});
			if(!repliedTo && comment.reply.parent_permlink) {
				// A proposal names the tiddler that it proposes a change to
				// by the parent of its reply, or proposes a new tiddler when
				// it replies to the root post directly
				repliedTo = titlesByPermlink[comment.reply.parent_permlink] || null;
			}
			if(repliedTo) {
				transientTags.push(repliedTo);
			}
			transientTags.push(util.COMMENT_TAG);
			self.wiki.addTiddler(util.payloadToTiddler({
				title: metadata.title + (metadata.type === "proposal" ? " (proposal by " + (comment.reply.author || "unknown") + ")" : ""),
				text: metadata.text,
				fields: metadata.fields,
				tags: transientTags,
				created: util.toTiddlerDate(metadata.created),
				modified: util.toTiddlerDate(metadata.modified)
			}));
			summary.comments++;
		});
		callback(null,summary);
	};

	exports.HiveStore = HiveStore;
	exports.CONFIG_PREFIX = CONFIG_PREFIX;
	exports.DEFAULT_PREFIX = DEFAULT_PREFIX;
	exports.STATUS_TIDDLER = STATUS_TIDDLER;
	exports.REMOTE_TIDDLER = REMOTE_TIDDLER;
	exports.PROPOSALS_TIDDLER = PROPOSALS_TIDDLER;
	exports.PROPOSAL_LIST_TIDDLER = PROPOSAL_LIST_TIDDLER;

})();
