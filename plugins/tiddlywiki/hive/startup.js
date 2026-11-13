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
	// The rooted view is a reader view of the published wiki, the sidebar
	// of the standalone shell is not part of it. Set before the load, so
	// that the sidebar does not flash while the chain is read
	$tw.wiki.addTiddler({title: "$:/state/sidebar",text: "no"});
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
		// Open the tiddler that the uri fragment of the rooted url
		// names - the core has opened it from the hash at startup, and
		// this callback would otherwise replace the story with the home
		// tiddler. Without a fragment, or when the tiddler of the
		// fragment was not published, the home tiddler is opened
		var target = null;
		if($tw.locationHash && $tw.locationHash.length > 1) {
			var hash = $tw.locationHash.substr(1),
				split = hash.indexOf(":");
			target = $tw.utils.decodeURIComponentSafe((split === -1 ? hash : hash.substr(0,split)).trim());
		}
		var open = target && $tw.wiki.getTiddler(target) ? [target] : ($tw.wiki.getTiddler("Home") ? ["Home"] : []);
		$tw.wiki.addTiddler({title: "$:/DefaultTiddlers",text: $tw.utils.stringifyList(open)});
		$tw.wiki.addTiddler({title: "$:/StoryList",list: open});
		// Pin the location of the wiki in the settings, so that a save
		// operates on this wiki and a load with an empty field reloads it
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/tiddlywiki/hive/permalink",text: "@" + root.author + "/" + root.permlink}));
		$tw.utils.log("Hive: " + store.getStatusText());
	});
};
