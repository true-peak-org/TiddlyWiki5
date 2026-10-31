/*\
title: $:/plugins/tiddlywiki/hive-storage/startup
type: application/javascript
module-type: startup

Startup initialisation for the IndexedDB based Hive working storage

\*/

"use strict";

exports.name = "hive-storage";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;

var ENABLED_TITLE = "$:/config/HiveStorage/Enabled",
	SAVE_FILTER_TITLE = "$:/config/HiveStorage/SaveFilter",
	PERSISTED_STATE_TITLE = "$:/state/hive/storage/persisted";

var HiveStorageUtil = require("$:/plugins/tiddlywiki/hive-storage/util.js").HiveStorageUtil;

exports.startup = function() {
	// Make a logger
	var logger = new $tw.utils.Logger("hive-storage",{
		colour: "cyan"
	});
	// Add hiveStorage object to $tw
	$tw.hiveStorage = new HiveStorageUtil($tw.wiki,{
		enabledTitle: ENABLED_TITLE,
		logger: logger
	});
	// Function to compile the filter
	var filterFn,
		compileFilter = function() {
			filterFn = $tw.wiki.compileFilter($tw.wiki.getTiddlerText(SAVE_FILTER_TITLE));
		};
	compileFilter();
	// Listen for tm-clear-hive-storage messages
	$tw.rootWidget.addEventListener("tm-clear-hive-storage",function(event) {
		$tw.wiki.addTiddler({title: ENABLED_TITLE, text: "no"});
		$tw.hiveStorage.clearIndexedDB(function(err) {
			if(err) {
				console.log("Hive storage error:",err);
			}
		});
	});
	// Listen for tm-disable-hive-storage messages
	$tw.rootWidget.addEventListener("tm-disable-hive-storage",function(event) {
		$tw.wiki.addTiddler({title: ENABLED_TITLE, text: "no"});
	});
	// Helpers for protecting the database from eviction
	var setPersistedState = function(state) {
			$tw.wiki.addTiddler({title: PERSISTED_STATE_TITLE, text: state});
		},
		requestPersistence = function() {
			setPersistedState("requested");
			navigator.storage.persist().then(function(persisted) {
				console.log("Request for persisted storage " + (persisted ? "granted" : "denied"));
				setPersistedState(persisted ? "granted" : "denied");
			});
		},
		persistPermissionRequested = false,
		requestPersistenceOnFirstSave = function() {
			$tw.hooks.addHook("th-saving-tiddler", function(tiddler) {
				if(!persistPermissionRequested) {
					var filteredChanges = filterFn.call($tw.wiki, function(iterator) {
						iterator(tiddler,tiddler.getFieldString("title"));
					});
					if(filteredChanges.length > 0) {
						// The tiddler will be saved to the indexed database, so request persistence
						requestPersistence();
						persistPermissionRequested = true;
					}
				}
				return tiddler;
			});
		};
	// Request the browser to never evict the indexed database. Some browsers such as
	// firefox will prompt the user. We will make the decision easier for the user only
	// prompt them when they click the save button on a tiddler which will be stored to
	// the indexed database.
	if(navigator.storage && navigator.storage.persist) {
		navigator.storage.persisted().then(function(isPersisted) {
			if(!isPersisted) {
				setPersistedState("not requested yet");
				requestPersistenceOnFirstSave();
			} else {
				setPersistedState("granted");
			}
		});
	} else {
		setPersistedState("feature not available");
	}
	// Track tiddler changes
	$tw.wiki.addEventListener("change",function(changes) {
		// Bail if hive storage is disabled
		if($tw.wiki.getTiddlerText(ENABLED_TITLE) === "no") {
			return;
		}
		// Recompile the filter if it has changed
		if(changes[SAVE_FILTER_TITLE]) {
			compileFilter();
		}
		// Filter the changes
		var filteredChanges = filterFn.call($tw.wiki, function(iterator) {
			$tw.utils.each(changes, function(change,title) {
				var tiddler = $tw.wiki.getTiddler(title);
				iterator(tiddler,title);
			});
		});
		$tw.utils.each(filteredChanges, function(title) {
			// Don't try to save changes to our enabled status
			// (If it were enabled in the file but disabled in the database then we might not realise that distributing a copy of the file would have the database enabled for other users)
			if(title === ENABLED_TITLE) {
				return;
			}
			// This should always be queried from the browser, so don't store it in the indexed database
			if(title === PERSISTED_STATE_TITLE) {
				return;
			}
			// Save the tiddler
			$tw.hiveStorage.saveTiddlerToIndexedDB(title, function(err) {
				if(err) {
					console.log("Hive storage error:",err);
				}
			});
		});
	});
};
