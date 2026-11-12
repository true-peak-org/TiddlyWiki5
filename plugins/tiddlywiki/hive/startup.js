/*\
title: $:/plugins/tiddlywiki/hive/startup
type: application/javascript
module-type: startup

Load the wiki from the Hive chain when the wiki file is served in a
rooted mode such as /hive/wiki/@author/permlink. The boot parser of the
wiki shell recognises those paths and stores the root post in
$tw.boot.hiveRoot

\*/

"use strict";

exports.name = "hive-root";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	var root = $tw.boot.hiveRoot;
	if(!root) {
		return;
	}
	var HiveStore = require("$:/plugins/tiddlywiki/hive/hivestore.js").HiveStore,
		HiveApi = require("$:/plugins/tiddlywiki/hive/hiveapi.js").HiveApi,
		store = new HiveStore({wiki: $tw.wiki}),
		config = store.getConfig();
	store.api = new HiveApi({rpc: config.rpc});
	// Snapshot the non system tiddlers that the shell was packaged with,
	// so that after the load the defaults that the published wiki does
	// not contain can be removed
	var preloaded = [];
	$tw.wiki.allTitles().forEach(function(title) {
		if(title.charAt(0) === "$") {
			return;
		}
		var tiddler = $tw.wiki.getTiddler(title);
		if(tiddler) {
			preloaded.push({title: title,tiddler: tiddler});
		}
	});
	// The keychain is not needed for loading
	store.load("@" + root.author + "/" + root.permlink,function(err) {
		if(err) {
			store.setStatus("Error: " + err);
			$tw.utils.error("Hive: " + err);
			return;
		}
		// Remove the packaged defaults that the chain load did not
		// overwrite, so that the rooted view shows the published wiki
		// instead of the demo tiddlers of the shell
		preloaded.forEach(function(entry) {
			var current = $tw.wiki.getTiddler(entry.title);
			if(current && current.isEqual(entry.tiddler)) {
				$tw.wiki.deleteTiddler(entry.title);
			}
		});
		// The doc tiddlers of the plugin cannot be deleted because they
		// live inside the plugin, but the story of the shell opens them.
		// Open the home of the published wiki instead
		var open = $tw.wiki.getTiddler("Home") ? ["Home"] : [];
		$tw.wiki.addTiddler({title: "$:/DefaultTiddlers",text: $tw.utils.stringifyList(open)});
		$tw.wiki.addTiddler({title: "$:/StoryList",list: open});
		$tw.utils.log("Hive: " + store.getStatusText());
	});
};
