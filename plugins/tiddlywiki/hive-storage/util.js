/*\
title: $:/plugins/tiddlywiki/hive-storage/util.js
type: application/javascript
module-type: library

Utility methods for the IndexedDB based Hive storage plugin

\*/

"use strict";

function HiveStorageUtil(wiki,options) {
	this.options = options || {};
	this.wiki = wiki;
	this.cachedTiddlers = [];
	this.QUOTA_EXCEEDED_ALERT_TITLE = "$:/config/HiveStorage/QuotaExceededAlert";
	this.DEFAULT_QUOTA_EXCEEDED_ALERT_PREFIX = "Quota exceeded attempting to store `";
	this.DEFAULT_QUOTA_EXCEEDED_ALERT_SUFFIX = "` in browser indexed database";
	this.databaseName = "tiddlywiki";
	this.storeName = "tiddlers";
}

/*
Return whether the plugin is enabled
*/
HiveStorageUtil.prototype.isEnabled = function() {
	return $tw.wiki.getTiddlerText(this.options.enabledTitle) === "yes";
};

/*
Return the tiddlers that have been marked for preloading
*/
HiveStorageUtil.prototype.cachePreloadTiddlers = function() {
	var self = this;
	$tw.utils.each($tw.boot.preloadDirty, function(item) {
		var tiddler = self.wiki.getTiddler(item);
		self.cachedTiddlers.push(tiddler);
	});
};

/*
Add the cached tiddlers to the wiki
*/
HiveStorageUtil.prototype.addCachedTiddlers = function() {
	var self = this;
	if(this.cachedTiddlers.length > 0) {
		$tw.utils.each(this.cachedTiddlers,function(tiddler) {
			self.wiki.addTiddler(tiddler);
		});
		this.cachedTiddlers.length = 0;
	}
};

/*
Open the database that holds the tiddlers
*/
HiveStorageUtil.prototype.openDatabase = function(callback) {
	var self = this;
	if(this.db) {
		return callback(null,this.db);
	}
	if(!window.indexedDB) {
		return callback("Indexed database is not available in this browser");
	}
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
};

/*
Save the tiddler under the given title, or mark it as deleted when there is
no tiddler to save
*/
HiveStorageUtil.prototype.saveTiddlerToIndexedDB = function(title,callback) {
	var self = this;
	this.openDatabase(function(err,db) {
		if(err) {
			return callback(err);
		}
		var tiddler = self.wiki.getTiddler(title);
		var tx = db.transaction(self.storeName,"readwrite");
		var store = tx.objectStore(self.storeName);
		if(tiddler) {
			if(self.wiki.tiddlerExists(title)) {
				store.put(JSON.stringify(tiddler.getFieldStrings()),title);
			} else {
				store.delete(title);
			}
		} else {
			// In the database use the special value of an empty string to mark the
			// tiddler as deleted. On future page loads, if the tiddler is already
			// missing from the wiki then the blank entry will be removed from the
			// database. Otherwise, the tiddler will be deleted.
			store.put("",title);
		}
		tx.oncomplete = function() {
			callback(null);
		};
		tx.onerror = function() {
			callback(tx.error);
		};
	});
};

/*
Remove the tiddler under the given title from the indexed database
*/
HiveStorageUtil.prototype.removeTiddlerFromIndexedDB = function(title) {
	var self = this;
	this.openDatabase(function(err,db) {
		if(err) {
			return;
		}
		var tx = db.transaction(self.storeName,"readwrite");
		tx.objectStore(self.storeName).delete(title);
		tx.oncomplete = function() {
			if(self.options.logger) {
				self.options.logger.log("Hive storage: removed " + title);
			}
		};
		tx.onerror = function() {
			if(self.options.logger) {
				self.options.logger.log("Hive storage: error removing " + title);
			}
		};
	});
};

/*
Return all the tiddlers that are stored in the indexed database
*/
HiveStorageUtil.prototype.getAllTiddlersFromIndexedDB = function(callback) {
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
};

/*
Clear the indexed database
*/
HiveStorageUtil.prototype.clearIndexedDB = function(callback) {
	var self = this;
	this.openDatabase(function(err,db) {
		if(err) {
			return callback(err);
		}
		var tx = db.transaction(self.storeName,"readwrite");
		tx.objectStore(self.storeName).clear();
		tx.oncomplete = function() {
			callback(null);
		};
		tx.onerror = function() {
			callback(tx.error);
		};
	});
};

exports.HiveStorageUtil = HiveStorageUtil;
