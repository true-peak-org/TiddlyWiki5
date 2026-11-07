/*\
title: $:/plugins/tiddlywiki/hive-storage/rawmarkup.js
type: application/javascript
module-type: library

Startup code injected as raw markup

\*/

// Need to initialise these because we run before bootprefix.js and boot.js
$tw = window.$tw || Object.create(null);
$tw.hooks = $tw.hooks || { names: {}};
$tw.boot = $tw.boot || {};
$tw.boot.preloadDirty = $tw.boot.preloadDirty || [];
// Hook the point in the startup process when the tiddlers have been loaded but plugins not unpacked
var hookName = "th-boot-tiddlers-loaded";
if(Object.prototype.hasOwnProperty.call($tw.hooks.names,hookName)) {
	$tw.hooks.names[hookName].push(hookBootTiddlersLoaded);
} else {
	$tw.hooks.names[hookName] = [hookBootTiddlersLoaded];
}

/*
Bootstrap a minimal hive storage instance so that the hook can read the
indexed database before the hive-storage startup module has created the
full instance that is used for saving
*/
function bootstrapHiveStorage() {
	if($tw.hiveStorage) {
		return;
	}
	$tw.hiveStorage = {
		databaseName: "tiddlywiki",
		storeName: "tiddlers",
		openDatabase: function(callback) {
			if(this.db) {
				return callback(null,this.db);
			}
			var self = this;
			var request = window.indexedDB.open(this.databaseName,1);
			request.onupgradeneeded = function(event) {
				var db = event.target.result;
				if(!db.objectStoreNames.contains(self.storeName)) {
					db.createObjectStore(self.storeName);
				}
			};
			request.onsuccess = function(event) {
				self.db = event.target.result;
				callback(null,self.db);
			};
			request.onerror = function(event) {
				callback(event.target.error);
			};
		},
		getAllTiddlersFromIndexedDB: function(callback) {
			var self = this;
			this.openDatabase(function(err,db) {
				if(err) {
					return callback(err);
				}
				var entries = [],
					tx = db.transaction(self.storeName,"readonly"),
					store = tx.objectStore(self.storeName),
					request = store.openCursor();
				request.onsuccess = function(event) {
					var cursor = event.target.result;
					if(cursor) {
						entries.push({title: cursor.key,value: cursor.value});
						cursor.continue();
					} else {
						callback(null,entries);
					}
				};
				request.onerror = function(event) {
					callback(event.target.error);
				};
			});
		}
	};
}

// Load tiddlers from the indexed database
function hookBootTiddlersLoaded() {
	bootstrapHiveStorage();
	var log = [];
	$tw.hiveStorage.getAllTiddlersFromIndexedDB(function(err,entries) {
		if(err) {
			return;
		}
		entries.forEach(function(entry) {
			var jsonData = entry.value;
			if(jsonData) {
				var json;
				try {
					json = JSON.parse(jsonData);
				} catch(e) {
					json = null;
				}
				if(json) {
					var incomingTiddler = new $tw.Tiddler(json);
					if(incomingTiddler) {
						var title = incomingTiddler.fields.title,
							existingTiddler = $tw.wiki.getTiddler(title);
						if(existingTiddler && existingTiddler.isEqual(incomingTiddler)) {
							// If the incoming tiddler is the same as the existing then we do nothing
						} else {
							$tw.wiki.addTiddler(incomingTiddler);
							log.push(title);
						}
					}
				}
			}
		});
		// Make sure that all the tiddlers we've loaded are marked as dirty at startup
		Array.prototype.push.apply($tw.boot.preloadDirty,log);
		// Save the log
		$tw.wiki.addTiddler({
			title: "$:/temp/HiveStorage/Log",
			text: $tw.utils.stringifyList(log)
		});
	});
}
