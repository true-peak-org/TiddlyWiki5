/*\
title: $:/plugins/tiddlywiki/hive/hivelink.js
type: application/javascript
module-type: library

Loading a single Hive post into the wiki as a tiddler. Used by the
<<hivelink(accountId,permlink)>> procedure, which renders a button
displayed as a hyperlink that loads the post when it is clicked.

The loaded tiddler carries the tag $:/hive/external, which the publish
filter excludes, so that saving the wiki to Hive ignores it. The
``last_update`` attribute of the part posts is remembered on the tiddler so
that a reload only re-applies the tiddler when the post was updated
afterwards.

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	var HiveApi = require("$:/plugins/tiddlywiki/hive/hiveapi.js").HiveApi,
		util = require("$:/plugins/tiddlywiki/hive/hiveutil.js");

	/*
	The tag of tiddlers that were loaded from a Hive post. Tiddlers with this
	tag are ignored when the wiki is saved to Hive
	*/
	exports.EXTERNAL_TAG = "$:/hive/external";

	/*
	Parse the json_metadata field of a post, which may be an object or a
	string of json
	*/
	function parseMetadata(content) {
		var text = content && content.json_metadata;
		if(!text) {
			return {};
		}
		if(typeof text === "object") {
			return text;
		}
		try {
			return JSON.parse(text) || {};
		} catch(e) {
			return {};
		}
	}

	/*
	Map the content type declared in the json_metadata of a post to a tiddler
	type. Markdown is the default, anything that declares html (mixed
	html/markdown included) is served as html
	*/
	function mapContentType(metadata) {
		var declared = String((metadata && (metadata.format || metadata.type)) || "").toLowerCase();
		if(declared.indexOf("html") !== -1) {
			return "text/html";
		}
		return "text/markdown";
	}

	/*
	Strip the "_p<digits>" suffix of a part permlink. Returns the base
	permlink and the part number
	*/
	function splitPartPermlink(permlink) {
		var match = /^(.*?)(?:_p(\d+))?$/.exec(permlink);
		if(!match || !match[2]) {
			return {base: permlink,part: 1};
		}
		return {base: match[1],part: parseInt(match[2],10)};
	}

	/*
	Copy the version revealing attributes of a Hive post into a wrapper record
	so that version tracking covers single and multi part posts
	*/
	function contentRecord(content) {
		content = content || {};
		return {
			metadata: parseMetadata(content),
			author: content.author,
			permlink: content.permlink,
			last_update: content.last_update || "",
			created: content.created || ""
		};
	}

	/*
	Fetch all the part replies of a tiddler that was split over several
	posts. The base permlink and the number of parts name the posts
	"_p1.._pN"
	*/
	function fetchParts(api,author,basePermlink,count,partsMetadata) {
		var permlinks = [];
		for(var p = 1; p <= count; p++) {
			permlinks.push(basePermlink + "_p" + p);
		}
		return new Promise(function(resolve) {
			var records = [],
				pending = permlinks.length;
			if(pending) {
				permlinks.forEach(function(partPermlink) {
					api.getContent(author,partPermlink,function(err,content) {
						if(!err && content && content.author) {
							records.push(contentRecord(content));
						}
						pending--;
						if(pending === 0) {
							resolve(records);
						}
					});
				});
			} else {
				resolve(records);
			}
		});
	}

	/*
	Build the tiddler for tw5 tiddler replies: the canonical payload of the
	reply carries the tiddler, the texts of the parts are joined
	*/
	function buildTw5Tiddler(records,basePermlink) {
		records = records.slice(0).sort(function(a,b) {
			var aTw5 = a.metadata.tw5 || {},
				bTw5 = b.metadata.tw5 || {};
			return (aTw5.part || 1) - (bTw5.part || 1);
		});
		var payloads = records.map(function(record) {
				return record.metadata.tw5;
			}),
			first = records[0] || {},
			payload = payloads[0] || {},
			fields = payload.fields || {},
			lastUpdates = records.map(function(record) {
				return record.last_update;
			}).join(" ");
		var tiddler = util.payloadToTiddler({
			title: payload.title,
			text: payloads.map(function(p) {
				return p.text || "";
			}).join(""),
			fields: fields,
			tags: (payload.tags || []).slice(0),
			created: payload.created || "",
			modified: payload.modified || ""
		});
		tiddler = new $tw.Tiddler(tiddler,{
			"hive.author": first.author,
			"hive.permlink": basePermlink,
			"hive.last-update": lastUpdates,
			"hive.canonical-url": (first.metadata.canonical_url) || ""
		});
		$tw.utils.pushTop(tiddler.fields.tags,exports.EXTERNAL_TAG);
		return tiddler;
	}

	/*
	Build the tiddler for a Hive post that is not part of a TiddlyWiki: the
	body of the post becomes the text of the tiddler, and its type is
	guided by the declared type of the json_metadata, defaulting to markdown
	*/
	function buildExternalTiddler(author,record) {
		var metadata = record.metadata,
			title = String(record.metadataTitle || "@" + author + "/" + record.permlink),
			tags = metadata.tags && metadata.tags.slice ? metadata.tags.slice(0) : [];
		var fields = {
			title: title,
			text: record.body || "",
			type: mapContentType(metadata),
			created: record.created,
			modified: record.last_update,
			"hive.author": author,
			"hive.permlink": record.permlink,
			"hive.last-update": record.last_update,
			"hive.canonical-url": metadata.canonical_url || "",
			"hive.format": String(metadata.format || metadata.type || "").toLowerCase(),
			tags: tags
		};
		$tw.utils.pushTop(fields.tags,exports.EXTERNAL_TAG);
		return new $tw.Tiddler(fields);
	}

	/*
	Build the tiddler of the content of a post. The tw5 metadata decides
	whether the post is a reply that carries a tiddler of a TiddlyWiki
	*/
	function buildTiddler(author,records,basePermlink,bodyOf) {
		var first = records[0] || {metadata: {}},
			tw5 = first.metadata.tw5;
		if(tw5 && tw5.type === "tiddler") {
			return buildTw5Tiddler(records,basePermlink);
		}
		return buildExternalTiddler(author,authorRecord(first,bodyOf));
	}

	/*
	Merge the body and the title of a Hive post into its wrapper record for
	the external path
	*/
	function authorRecord(record,bodyOf) {
		record.metadataTitle = bodyOf.title;
		record.body = bodyOf.body;
		return record;
	}

	/*
	Load a Hive post as a tiddler. options.wiki names the wiki to add the
	tiddler to, options.rpc the endpoint to talk to. The callback is invoked
	with (err,title)
	*/
	exports.loadPost = function(author,permlink,options,callback) {
		options = options || {};
		var wiki = options.wiki || $tw.wiki;
		author = String(author || "").replace(/^@/,"");
		permlink = String(permlink || "");
		if(!author || !permlink) {
			return callback("A Hive link needs an account and a permlink");
		}
		var api = new HiveApi({rpc: options.rpc});
		api.getContent(author,permlink,function(err,content) {
			if(err) {
				return callback(err);
			}
			if(!content || !content.author) {
				return callback("Could not find the Hive post @" + author + "/" + permlink);
			}
			var metadata = parseMetadata(content),
				tw5 = metadata.tw5,
				settings = splitPartPermlink(content.permlink),
				isTw5Tiddler = Boolean(tw5 && tw5.type === "tiddler"),
				parts = isTw5Tiddler ? Math.min(tw5.parts || 1,100) : 1,
				records = [];
			if(parts > 1) {
				fetchParts(api,author,settings.base,parts).then(function(fetched) {
					if(!fetched.length) {
						return callback("Could not find the parts of @" + author + "/" + permlink);
					}
					finish(fetched);
				});
			} else {
				records.push(contentRecord(content));
				finish(records);
			}
			function finish(records) {
				var tiddler = buildTiddler(author,records,settings.base,content),
					title = tiddler.fields.title,
					existing = wiki.getTiddler(title);
				if(existing) {
					var current = String(existing.fields["hive.last-update"] || ""),
						incoming = String(tiddler.fields["hive.last-update"] || "");
					if(current && incoming && current === incoming) {
						// The post has not been updated since it was loaded
						return callback(null,{title: title,unchanged: true});
					}
				}
				wiki.addTiddler(tiddler);
				callback(null,{title: title,unchanged: false,canonicalUrl: tiddler.fields["hive.canonical-url"]});
			}
		});
	};

})();
