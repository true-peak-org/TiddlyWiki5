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
	// The keychain is not needed for loading
	store.load("@" + root.author + "/" + root.permlink,function(err) {
		if(err) {
			store.setStatus("Error: " + err);
			$tw.utils.error("Hive: " + err);
			return;
		}
		$tw.utils.log("Hive: " + store.getStatusText());
	});
};
