/*\
title: $:/plugins/tiddlywiki/hive/hiveutil.js
type: application/javascript
module-type: library

Helper functions for the Hive storage plugin: hashing, permlink generation,
tiddler payload serialisation and a lightweight wikitext to markdown
converter.

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	/*
Maximum size of a post body. Hive accepts bodies of up to 65536 bytes, we
stay comfortably below that so that we do not have to worry about the exact
accounting of multi byte characters
*/
	exports.MAX_BODY_LENGTH = 60000;

	/*
Maximum length of a post title. Hive accepts titles of up to 256 bytes
*/
	exports.MAX_TITLE_LENGTH = 200;

	/*
Maximum number of operations in a single transaction. The chain rejects a
transaction that creates more than one comment with the reply interval
assert, so comments are broadcast one per transaction and this limit only
applies to future non comment operation types
*/
	exports.MAX_OPS_PER_TRANSACTION = 1;

	/*
Maximum total size of the operations in a single transaction. The blockchain
rejects transactions whose serialized form is longer than 65536 bytes
(including the signature), so we keep the JSON form of the operations well
below that figure
*/
	/*
Maximum total size of the operations in a single transaction. The blockchain
rejects transactions whose serialized form is longer than 65536 bytes
(including the signature), so we keep the JSON form of the operations well
below that figure. Every comment operation is broadcast in its own
transaction anyway, because the chain rejects transactions that create
more than one comment
*/
	exports.MAX_TRANSACTION_LENGTH = 60000;

	/*
Minimum pause in milliseconds between two comments of the same account.
The chain enforces HIVE_MIN_REPLY_INTERVAL of 3 seconds between the
comments, and the check applies to the operations of a single transaction
as well, so a transaction may not create more than one comment. The chain
timestamps have a resolution of one second, so we wait 4 seconds to stay
clear of the limit
*/
	exports.MIN_REPLY_INTERVAL = 4000;

	/*
Return the wire form of an operation. The extension expects operations as
["type",{...}] pairs, without the internal type property in the payload
*/
	exports.getWireOperation = function(operation) {
		var payload = {};
		Object.keys(operation).forEach(function(name) {
			if(name !== "type") {
				payload[name] = operation[name];
			}
		});
		return [operation.type,payload];
	};

	/*
Return the approximate size in characters of the wire form of an operation
*/
	exports.getOperationSize = function(operation) {
		return JSON.stringify(exports.getWireOperation(operation)).length;
	};

	/*
Return the total size in characters of the wire form of a set of operations
*/
	exports.getBatchSize = function(operations) {
		return (operations || []).reduce(function(size,operation) {
			return size + exports.getOperationSize(operation);
		},0);
	};

	/*
Tag that marks a tiddler that is a proposed change or a comment
*/
	exports.COMMENT_TAG = "Proposed";

	/*
Fields that are not copied into the payload of a tiddler because they are
either stored explicitly or are local bookkeeping
*/
	var EXCLUDED_FIELDS = ["title","text","tags","created","modified","creator","modifier","revision","draft.of","draft.title"];

	/*
Return a 16 character hexadecimal hash of a string. This is not a
cryptographic hash, it is only used to detect changes and to make permlinks
unique
*/
	exports.hashString = function(text) {
		var h1 = 0x811c9dc5,
			h2 = 0x9e3779b9,
			i,
			charCode;
		text = String(text);
		for(i = 0; i < text.length; i++) {
			charCode = text.charCodeAt(i);
			h1 = Math.imul(h1 ^ charCode,16777619) >>> 0;
			h2 = Math.imul(h2 ^ charCode,2246822519) >>> 0;
			h2 = (h2 ^ (h2 >>> 13)) >>> 0;
		}
		return exports.padHex(h1) + exports.padHex(h2);
	};

	/*
Left pad a number to eight hexadecimal digits
*/
	exports.padHex = function(value) {
		var text = (value >>> 0).toString(16);
		while(text.length < 8) {
			text = "0" + text;
		}
		return text;
	};

	/*
Return a random identifier of 32 hexadecimal characters
*/
	exports.generateId = function() {
		var text = "",
			i;
		for(i = 0; i < 4; i++) {
			text += exports.padHex(Math.floor(Math.random() * 4294967296));
		}
		return text;
	};

	/*
Convert a string into something that is safe to use within a permlink.
The Hive blockchain only allows the lowercase letters, the digits and the
hyphen in permlinks (an underscore is rejected with an assert exception),
so words are separated by hyphens and every other character is replaced
by a hyphen as well. The hash suffix of the generated permlinks keeps the
results unique even when different titles collapse to the same slug
*/
	exports.slugify = function(text,maxLength) {
		var result = String(text === undefined || text === null ? "" : text);
		maxLength = maxLength || 40;
		result = result.toLowerCase();
		result = result.replace(/[^a-z0-9]+/g,"-");
		result = result.replace(/-+/g,"-");
		while(result.charAt(result.length - 1) === "-") {
			result = result.substring(0,result.length - 1);
		}
		while(result.charAt(0) === "-") {
			result = result.substring(1);
		}
		if(result.length > maxLength) {
			result = result.substring(0,maxLength);
		}
		while(result.charAt(result.length - 1) === "-") {
			result = result.substring(0,result.length - 1);
		}
		if(!result) {
			result = "tiddler";
		}
		return result;
	};

	/*
Return the permlink used for the root post of a wiki
*/
	exports.getRootPermlink = function(wikiId,wikiTitle) {
		return "tw5-" + exports.slugify(wikiTitle || "wiki") + "-" + exports.hashString(wikiId);
	};

	/*
Return the permlink used for the reply that holds a tiddler
*/
	exports.getTiddlerPermlink = function(wikiId,title) {
		return "tw5-" + exports.slugify(title) + "-" + exports.hashString(wikiId + "|" + title);
	};

	/*
Return the permlink used for one part of a tiddler that had to be split
over several replies
*/
	exports.getPartPermlink = function(permlink,part) {
		return permlink + "-p" + part;
	};

	/*
Return the permlink used for a proposal of a tiddler. The proposal is a
reply that a non owner of the wiki broadcasts to propose a change, and it
carries the hash of the proposed content, so that every proposal of a
tiddler has its own permlink
*/
	exports.getProposalPermlink = function(tiddlerPermlink,hash) {
		return tiddlerPermlink + "-prop-" + exports.hashString(hash).substring(0,16);
	};

	/*
Return the JSON representation of a value with the object keys sorted so
that the result is stable
*/
	exports.canonicalJSON = function(value) {
		var result = [],
			keys;
		if(value === null || typeof value !== "object") {
			return JSON.stringify(value);
		}
		if($tw.utils.isArray(value)) {
			for(var i = 0; i < value.length; i++) {
				result.push(exports.canonicalJSON(value[i]));
			}
			return "[" + result.join(",") + "]";
		}
		keys = Object.keys(value);
		keys.sort();
		for(var k = 0; k < keys.length; k++) {
			result.push(JSON.stringify(keys[k]) + ":" + exports.canonicalJSON(value[keys[k]]));
		}
		return "{" + result.join(",") + "}";
	};

	/*
Return the payload of a tiddler: the canonical representation that is
stored in the json_metadata of a Hive reply
*/
	exports.getTiddlerPayload = function(tiddler) {
		var fields = {},
			payload = {
				title: tiddler.fields.title,
				text: tiddler.fields.text || "",
				fields: fields,
				tags: [],
				// The dates are normalized to the 17-digit datestamps of
				// TiddlyWiki, because the created and modified fields are
				// parsed into dates when the tiddlers are read back
				created: exports.toTiddlerDate(tiddler.fields.created),
				modified: exports.toTiddlerDate(tiddler.fields.modified)
			};
		Object.keys(tiddler.fields).forEach(function(name) {
			if(EXCLUDED_FIELDS.indexOf(name) === -1) {
				fields[name] = tiddler.fields[name];
			}
		});
		if(tiddler.fields.tags) {
			payload.tags = $tw.utils.isArray(tiddler.fields.tags) ? tiddler.fields.tags.slice(0) : [tiddler.fields.tags];
		}
		return payload;
	};

	/*
Return the hash of a payload, used to detect whether a tiddler has changed
*/
	exports.getPayloadHash = function(payload) {
		return exports.hashString(exports.canonicalJSON(payload));
	};

	/*
Whether the tw5 metadata of a post identifies it as a reply that carries
the content of a tiddler. The current versions of the plugin write a type
attribute, earlier saves did not, so the presence of the tiddler payload
attributes is accepted as well. Proposals and comments always carry their
type explicitly and are not matched
*/
	exports.isTiddlerMetadata = function(tw5) {
		return Boolean(tw5 && (tw5.type === "tiddler" || (!tw5.type && tw5.title && tw5.parts)));
	};

	/*
Whether the tw5 metadata of a post identifies it as the root post of a
wiki. The current versions of the plugin write a type attribute, earlier
saves did not, so the presence of the wiki attributes is accepted as well
*/
	exports.isRootMetadata = function(tw5) {
		return Boolean(tw5 && (tw5.type === "root" || (!tw5.type && tw5.wikiid && tw5.index)));
	};

	/*
Parse a reference to a Hive post. The accepted forms are the bare
permlink, @author/permlink, author/permlink and the full urls of the
frontends such as https://hive.blog/@author/permlink. Returns an object
with the permlink and, when an author is given, the author, or null when
nothing can be parsed
*/
	exports.parsePermlink = function(text) {
		text = String(text === undefined || text === null ? "" : text).trim();
		if(!text) {
			return null;
		}
		// Strip a full url, if any, keeping the last two path segments
		var match = /^https?:\/\/[^/]+\/(?:.*\/)?@?([^/@]+)\/([^/?#]+)/.exec(text);
		if(match) {
			text = match[1] + "/" + match[2];
		}
		// Strip a leading @ of the author, if any
		text = text.replace(/^@/,"");
		match = /^([^/]+)\/([^/]+)$/.exec(text);
		if(match) {
			return {author: match[1].toLowerCase(),permlink: match[2]};
		}
		// A bare permlink
		if(/^[a-z0-9-]+$/.test(text)) {
			return {author: null,permlink: text};
		}
		return null;
	};

	/*
Return a date of a tiddler as the 17-digit UTC datestamp that TiddlyWiki
uses to store the created and modified fields. The dates arrive as Date
objects, as 17-digit datestamps or as the ISO timestamps of the chain
such as 2026-11-13T02:41:21, which is utc without a timezone suffix.
A date that cannot be parsed is returned as an empty string, so that the
field module of the created and modified fields, which parses every value
into a date, does not show a wrong date
*/
	exports.toTiddlerDate = function(value) {
		if(value instanceof Date) {
			return $tw.utils.stringifyDate(value);
		}
		value = String(value === undefined || value === null ? "" : value);
		if(!value) {
			return "";
		}
		if(/^[0-9]{17}$/.test(value)) {
			return value;
		}
		// The chain timestamps are utc, without a timezone suffix
		var parsed = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : value + "Z");
		if(isNaN(parsed)) {
			return "";
		}
		return $tw.utils.stringifyDate(new Date(parsed));
	};

	/*
Return the payload of a tiddler as a tiddler object that can be added to
the wiki
*/
	exports.payloadToTiddler = function(payload) {
		var fields = {
			title: payload.title,
			text: payload.text || ""
		};
		Object.keys(payload.fields || {}).forEach(function(name) {
			fields[name] = payload.fields[name];
		});
		if(payload.tags && payload.tags.length) {
			fields.tags = payload.tags.slice(0);
		}
		if(payload.created) {
			fields.created = payload.created;
		}
		if(payload.modified) {
			fields.modified = payload.modified;
		}
		return new $tw.Tiddler(fields);
	};

	/*
Return true when the given text is authored in markdown rather than in
TiddlyWiki wikitext. Hive originated content such as comments and
proposals is usually authored in markdown
*/
	exports.isMarkdown = function(text) {
		var lines = String(text === undefined || text === null ? "" : text).split("\n");
		for(var i = 0; i < lines.length; i++) {
			if(/^#{1,6}\s+/.test(lines[i]) || /^```/.test(lines[i])) {
				return true;
			}
		}
		return false;
	};

	/*
Convert a markdown document into TiddlyWiki wikitext. The markdown of hive
originated content such as proposals is converted into the tiddlywiki
syntax when the content is approved and stored as an official tiddler
*/
	exports.markdownToTiddlyWiki = function(markdown) {
		var lines = String(markdown === undefined || markdown === null ? "" : markdown).split("\n"),
			out = [],
			i = 0;
		while(i < lines.length) {
			var line = lines[i];
			var fenceMatch = /^```([^\n]*)$/.exec(line);
			if(fenceMatch) {
				var codeLines = [];
				i++;
				while(i < lines.length && !/^```\s*$/.test(lines[i])) {
					codeLines.push(lines[i]);
					i++;
				}
				i++;
				out.push("{{{");
				out.push(codeLines.join("\n"));
				out.push("}}}");
				continue;
			}
			var headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
			if(headingMatch) {
				out.push(new Array(headingMatch[1].length + 1).join("!") + " " + headingMatch[2]);
				i++;
				continue;
			}
			var linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(line);
			if(linkMatch) {
				out.push("[[" + linkMatch[2] + "|" + linkMatch[1] + "]]");
				i++;
				continue;
			}
			var boldMatch = /^\*\*(.+)\*\*$/.exec(line);
			if(boldMatch) {
				out.push("''" + boldMatch[1] + "''");
				i++;
				continue;
			}
			var italicMatch = /^_(.+)_$/.exec(line);
			if(italicMatch) {
				out.push("//" + italicMatch[1] + "//");
				i++;
				continue;
			}
			out.push(line);
			i++;
		}
		return out.join("\n");
	};

	/*
Convert a wikitext tiddler into markdown. The optional linkResolver
callback is passed the target of a link and should return the URL to use
or null to leave the link alone
*/
	exports.wikitextToMarkdown = function(text,linkResolver) {
		var lines = String(text === undefined || text === null ? "" : text).split("\n"),
			output = [],
			index = 0,
			codeLines = null,
			codeLang = "";
		while(index < lines.length) {
			var line = lines[index];
			// Code blocks
			var codeMatch = /^<<<\s*([^\s]*)\s*$/.exec(line);
			if(codeMatch) {
				codeLang = codeMatch[1] || "";
				codeLines = [];
				index++;
				while(index < lines.length && !/^<<<\s*$/.test(lines[index])) {
					codeLines.push(lines[index]);
					index++;
				}
				index++;
				output.push("```" + codeLang);
				output.push(codeLines.join("\n"));
				output.push("```");
				continue;
			}
			// Headings
			var headingMatch = /^(!{1,6})\s*(.*)$/.exec(line);
			if(headingMatch) {
				output.push(new Array(headingMatch[1].length + 1).join("#") + " " + exports.inlineToMarkdown(headingMatch[2],linkResolver));
				index++;
				continue;
			}
			// Horizontal rules
			if(/^\s*---\s*$/.test(line)) {
				output.push("---");
				index++;
				continue;
			}
			// Block quotes
			var quoteMatch = /^"""\s*(.*)$/.exec(line);
			if(quoteMatch) {
				output.push("> " + exports.inlineToMarkdown(quoteMatch[1],linkResolver));
				index++;
				continue;
			}
			// Lists
			var listMatch = /^(\s*)([*#]+)\s*(.*)$/.exec(line);
			if(listMatch) {
				var level = listMatch[2].length,
					marker = listMatch[2].charAt(0) === "#" ? "1." : "-",
					indent = "";
				for(var l = 1; l < level; l++) {
					indent += "  ";
				}
				output.push(indent + marker + " " + exports.inlineToMarkdown(listMatch[3],linkResolver));
				index++;
				continue;
			}
			// Everything else
			output.push(exports.inlineToMarkdown(line,linkResolver));
			index++;
		}
		return output.join("\n");
	};

	/*
Convert the inline markup of a single line of wikitext into markdown
*/
	exports.inlineToMarkdown = function(text,linkResolver) {
		var result = String(text === undefined || text === null ? "" : text),
			placeholders = [];
		/*
	Code and links are stashed away, so that the replacements of the
	emphasis markup cannot mess them up
	*/
		function stash(value) {
			placeholders.push(value);
			return "\u0000" + (placeholders.length - 1) + "\u0000";
		}
		// Inline code (triple braces in TW5) - don't convert to markdown code in a way that breaks things
		result = result.replace(/\{\{\{([\s\S]*?)\}\}\}/g,function(match,content) {
			return stash("`" + exports.plainText(content) + "`");
		});
		// Links - [[label|target]] and [[target]]. A target that a link
		// resolver cannot resolve is only kept as a link when it is a
		// url on its own, otherwise the link would point out of the wiki
		// and dead ends are shown as plain text
		result = result.replace(/\[\[([^\]\|]*)\|([^\]]*)\]\]/g,function(match,label,target) {
			var url = linkResolver ? linkResolver(target) : null;
			if(url) {
				return stash("[" + exports.plainText(label) + "](" + url + ")");
			}
			if(/^(?:https?:)?\/\//.test(target) || /^\//.test(target)) {
				return stash("[" + exports.plainText(label) + "](" + target.replace(/\s+/g,"%20") + ")");
			}
			return stash(exports.plainText(label));
		});
		result = result.replace(/\[\[([^\]]*)\]\]/g,function(match,target) {
			var url = linkResolver ? linkResolver(target) : null;
			if(url) {
				return stash("[" + exports.plainText(target) + "](" + url + ")");
			}
			if(/^(?:https?:)?\/\//.test(target) || /^\//.test(target)) {
				return stash("[" + exports.plainText(target) + "](" + target.replace(/\s+/g,"%20") + ")");
			}
			return stash(exports.plainText(target));
		});
		// Bold and italic
		result = result.replace(/''(.*?)''/g,"**$1**");
		result = result.replace(/\/\/(.*?)\/\//g,"*$1*");
		result = result.replace(/__(.*?)__/g,"<u>$1</u>");
		// Strip remaining wiki markup that has no markdown equivalent
		result = result.replace(/\{\{([^{}]*)\}\}/g,"{{$1}}");
		// Put the code and the links back
		result = result.replace(/\u0000(\d+)\u0000/g,function(match,index) {
			return placeholders[index];
		});
		return result;
	};

	/*
Remove the most common wiki markup from a piece of text so that it can be
used as the label of a markdown link
*/
	exports.plainText = function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/''/g,"")
			.replace(/\/\//g,"")
			.replace(/__/g,"")
			.replace(/\{\{([^{}]*)\}\}/g,"$1");
	};

	/*
Convert hivelink procedure calls into markdown links to the Hive
front-end. The space call syntax is

	<<hivelink accountId permlink "Caption">>

and is published as `[Caption](https://hive.blog/accountId/permlink)`
so that the blog post shows a normal link to the Hive post
*/
	exports.expandHiveLinks = function(text,frontEnd) {
		frontEnd = frontEnd || "https://hive.blog";
		var re = /<<hivelink\s+([^\s>"'=]+)\s+([^\s>"'=]+)\s*(?:(?:"([^"]*)"|'([^']*)'|\[\[([^\]]*)\]\]))?[^>]*?>>/g;
		return String(text === undefined || text === null ? "" : text).replace(re,function(match,account,permlink,dq,sq,bracket) {
			var caption = dq || sq || bracket || permlink;
			account = String(account).replace(/^@/,"");
			return "[" + caption + "](" + frontEnd + "/" + account + "/" + permlink + ")";
		});
	};

	/*
Return the body of a post for a tiddler. The body is a human readable
markdown rendering of the tiddler, the canonical text is kept in the
json_metadata of the post
*/
	exports.makeTiddlerBody = function(payload,options) {
		options = options || {};
		var lines = [],
			markdown = "",
			binary = false;
		if(options.tiddler) {
			// Binary tiddlers such as images keep their data in the metadata of
			// the post, the body of the post stays free of the encoded data
			var contentTypeInfo = $tw.config.contentTypeInfo[options.tiddler.fields.type || "text/vnd.tiddlywiki"];
			binary = !!(contentTypeInfo && contentTypeInfo.encoding === "base64");
		}
		if(!binary) {
			// TiddlyWiki originated content is converted into markdown, hive
			// originated content such as comments and proposals is usually
			// authored in markdown already
			markdown = exports.isMarkdown(payload.text) ? String(payload.text || "") : exports.wikitextToMarkdown(payload.text,options.linkResolver);
		}
		markdown = exports.expandHiveLinks(markdown,options.frontEnd);
		lines.push("> **Note:** This post is part of a wiki published from [TiddlyWiki5](https://tiddlywiki.com).");
		lines.push("> The canonical text of the tiddler is stored in the `tw5` metadata of this post, and the");
		if(options.canonicalUrl) {
			lines.push("> tiddler is best read in a [TiddlyWiki5 reader](" + options.canonicalUrl + ").");
		} else {
			lines.push("> tiddler is best read in a TiddlyWiki5 reader.");
		}
		lines.push("");
		lines.push("# " + payload.title);
		lines.push("");
		if(markdown) {
			lines.push(markdown);
		}
		var body = lines.join("\n");
		if(body.length > exports.MAX_BODY_LENGTH) {
			body = body.substring(0,exports.MAX_BODY_LENGTH) + "\n\n> *(the body of this post was truncated, the complete text is in the metadata)*";
		}
		return body;
	};

	/*
Return the body of a proposal reply. The proposal is a reply that a non
owner of a wiki broadcasts to propose a change to a tiddler, the proposed
content is kept in the json_metadata of the reply
*/
	exports.makeProposalBody = function(title,options) {
		options = options || {};
		var lines = [];
		lines.push("> **Note:** This reply proposes a change to the tiddler **" + title + "** of a wiki published from [TiddlyWiki5](https://tiddlywiki.com).");
		lines.push("> The proposed content is stored in the `tw5` metadata of this reply. Only the owner of the wiki");
		if(options.canonicalUrl) {
			lines.push("> can publish it; this wiki can be read in a [TiddlyWiki5 reader](" + options.canonicalUrl + ").");
		} else {
			lines.push("> can publish it; this wiki can be read in a TiddlyWiki5 reader.");
		}
		return lines.join("\n");
	};

	/*
Return the body of the root post of a wiki, an index of the tiddlers.
The root post is the entry point for a Hive wiki presence: the app
(standalone HTML) can load this post and follow its replies.
*/
	exports.makeRootBody = function(root,options) {
		options = options || {};
		var lines = [],
			appUrl = options.appUrl || "";
		lines.push("> **Note:** This post is the root of a wiki published from [TiddlyWiki5](https://tiddlywiki.com).");
		lines.push("> Each tiddler of the wiki is stored as a reply to this post.");
		if(options.canonicalUrl) {
			lines.push("> Read this wiki in a [TiddlyWiki5 reader](" + options.canonicalUrl + ").");
		}
		if(appUrl) {
			lines.push("> Open the app: [" + appUrl + "](" + appUrl + ")");
		}
		lines.push("");
		lines.push("# " + root.wikititle);
		lines.push("");
		if(root.description) {
			lines.push(exports.expandHiveLinks(root.description,options.frontEnd));
			lines.push("");
		}
		lines.push("## Contents");
		lines.push("");
		root.index.forEach(function(entry) {
			lines.push("- [" + exports.plainText(entry.title) + "](" + entry.url + ")");
		});
		return lines.join("\n");
	};

	/*
Return the tiddler title of a post, truncated to the maximum length
*/
	exports.makeTitle = function(title) {
		title = String(title === undefined || title === null ? "" : title);
		if(title.length <= exports.MAX_TITLE_LENGTH) {
			return title;
		}
		return title.substring(0,exports.MAX_TITLE_LENGTH - 11) + "..." + exports.hashString(title).substring(0,8);
	};

})();
