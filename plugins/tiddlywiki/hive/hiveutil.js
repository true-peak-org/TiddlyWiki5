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
Maximum number of operations in a single transaction
*/
	exports.MAX_OPS_PER_TRANSACTION = 10;

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
Convert a string into something that is safe to use within a permlink
*/
	exports.slugify = function(text,maxLength) {
		var result = "",
			i,
			charCode;
		maxLength = maxLength || 40;
		text = String(text);
		for(i = 0; i < text.length; i++) {
			charCode = text.charCodeAt(i);
			if((charCode >= 48 && charCode <= 57) || (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
				result += text.charAt(i);
			} else if(charCode === 32 || charCode === 45 || charCode === 95) {
				result += "-";
			} else {
				result += "-";
			}
		}
		while(result.length > 1 && result.charAt(result.length - 1) === "-") {
			result = result.substring(0,result.length - 1);
		}
		while(result.length > 1 && result.charAt(0) === "-") {
			result = result.substring(1);
		}
		if(result.length > maxLength) {
			result = result.substring(0,maxLength);
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
				created: tiddler.fields.created || "",
				modified: tiddler.fields.modified || ""
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
		// Inline code
		result = result.replace(/\{\{\{([\s\S]*?)\}\}\}/g,function(match,content) {
			return stash("`" + content + "`");
		});
		// Links
		result = result.replace(/\[\[([^\]\|]*)\|([^\]]*)\]\]/g,function(match,label,target) {
			var url = linkResolver ? linkResolver(target) : null;
			return stash("[" + exports.plainText(label) + "](" + (url || target) + ")");
		});
		result = result.replace(/\[\[([^\]]*)\]\]/g,function(match,target) {
			var url = linkResolver ? linkResolver(target) : null;
			if(url) {
				return stash("[" + exports.plainText(target) + "](" + url + ")");
			}
			return stash("<" + target + ">");
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
Return the body of a post for a tiddler. The body is a human readable
markdown rendering of the tiddler, the canonical text is kept in the
json_metadata of the post
*/
	exports.makeTiddlerBody = function(payload,options) {
		options = options || {};
		var lines = [],
			markdown = exports.wikitextToMarkdown(payload.text,options.linkResolver);
		lines.push("> **Note:** This post is part of a wiki published from [TiddlyWiki5](" + (options.frontEnd || "https://tiddlywiki.com") + ").");
		lines.push("> The canonical text of the tiddler is stored in the `tw5` metadata of this post, and the");
		lines.push("> tiddler is best read in a TiddlyWiki5 reader.");
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
Return the body of the root post of a wiki, an index of the tiddlers
*/
	exports.makeRootBody = function(root,options) {
		options = options || {};
		var lines = [],
			indent = 0;
		lines.push("> **Note:** This post is the root of a wiki published from [TiddlyWiki5](" + (options.frontEnd || "https://tiddlywiki.com") + ").");
		lines.push("> Each tiddler of the wiki is stored as a reply to this post.");
		lines.push("");
		lines.push("# " + root.wikititle);
		lines.push("");
		if(root.description) {
			lines.push(root.description);
			lines.push("");
		}
		lines.push("## Contents");
		lines.push("");
		root.index.forEach(function(entry) {
			lines.push(new Array(indent + 1).join("  ") + "- [" + exports.plainText(entry.title) + "](" + entry.url + ")");
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
